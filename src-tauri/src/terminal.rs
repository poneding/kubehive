use crate::{
    models::{StartTerminalRequest, TerminalEvent},
    registry::ClusterRegistry,
};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::HashMap,
    ffi::OsString,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
        Arc, RwLock,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
use tempfile::TempPath;
use uuid::Uuid;

#[derive(Clone)]
struct TerminalHandle {
    cluster_id: String,
    controls: Sender<TerminalControl>,
    finished: Arc<AtomicBool>,
}

enum TerminalControl {
    Input(Vec<u8>),
    Resize { columns: u16, rows: u16 },
    Stop,
}

enum WorkerEvent {
    ReaderClosed,
    ReaderError(String),
    ProcessExited(String),
}

struct LocalShell {
    program: OsString,
    args: Vec<OsString>,
}

struct LocalPty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    reader: Box<dyn Read + Send>,
    child: Box<dyn Child + Send + Sync>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

pub struct TerminalRegistry {
    sessions: RwLock<HashMap<String, TerminalHandle>>,
}

impl Default for TerminalRegistry {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }
}

impl TerminalRegistry {
    pub async fn start(
        self: Arc<Self>,
        clusters: Arc<ClusterRegistry>,
        request: StartTerminalRequest,
        channel: Channel<TerminalEvent>,
    ) -> Result<String, String> {
        let kubeconfig = clusters.terminal_kubeconfig(&request.cluster_id).await?;
        let temp_kubeconfig = write_temp_kubeconfig(&kubeconfig)?;
        let kubeconfig_path = temp_kubeconfig.to_path_buf();
        let LocalPty {
            master,
            writer,
            reader,
            child,
            mut killer,
        } = spawn_local_shell(&kubeconfig_path)?;

        let session_id = Uuid::new_v4().to_string();
        let finished = Arc::new(AtomicBool::new(false));
        let (controls, control_rx) = mpsc::channel();
        self.sessions
            .write()
            .map_err(|_| "Terminal session registry is unavailable".to_string())?
            .insert(
                session_id.clone(),
                TerminalHandle {
                    cluster_id: request.cluster_id,
                    controls,
                    finished: finished.clone(),
                },
            );

        send_event(
            &channel,
            &session_id,
            "connected",
            Some("Local shell ready · KUBECONFIG is scoped to the active cluster".into()),
        );

        let worker_registry = self.clone();
        let worker_session_id = session_id.clone();
        let worker = thread::Builder::new()
            .name(format!("kubehive-terminal-{}", &session_id[..8]))
            .spawn(move || {
                run_terminal_session(
                    worker_registry,
                    worker_session_id,
                    channel,
                    control_rx,
                    master,
                    writer,
                    reader,
                    child,
                    &mut killer,
                    temp_kubeconfig,
                    finished,
                );
            });
        if let Err(error) = worker {
            self.remove_session(&session_id);
            return Err(format!("Unable to start local terminal worker: {error}"));
        }

        Ok(session_id)
    }

    pub async fn write(&self, session_id: &str, data: String) -> Result<(), String> {
        let handle = self
            .sessions
            .read()
            .map_err(|_| "Terminal session registry is unavailable".to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Terminal session is no longer available".to_string())?;
        handle
            .controls
            .send(TerminalControl::Input(data.into_bytes()))
            .map_err(|_| "Terminal session is no longer available".to_string())
    }

    pub async fn resize(&self, session_id: &str, columns: u16, rows: u16) -> Result<(), String> {
        let handle = self
            .sessions
            .read()
            .map_err(|_| "Terminal session registry is unavailable".to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Terminal session is no longer available".to_string())?;
        handle
            .controls
            .send(TerminalControl::Resize {
                columns: columns.clamp(20, 500),
                rows: rows.clamp(5, 300),
            })
            .map_err(|_| "Terminal session is no longer available".to_string())
    }

    pub async fn stop(&self, session_id: &str) -> bool {
        self.stop_session(session_id)
    }

    pub fn stop_cluster(&self, cluster_id: &str) {
        let handles = self
            .sessions
            .read()
            .ok()
            .map(|sessions| {
                sessions
                    .iter()
                    .filter(|(_, handle)| handle.cluster_id == cluster_id)
                    .map(|(id, handle)| (id.clone(), handle.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (_, handle) in handles {
            let _ = handle.controls.send(TerminalControl::Stop);
        }
    }

    pub fn shutdown(&self) {
        let handles = self
            .sessions
            .read()
            .ok()
            .map(|sessions| sessions.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for handle in &handles {
            let _ = handle.controls.send(TerminalControl::Stop);
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline
            && handles
                .iter()
                .any(|handle| !handle.finished.load(Ordering::Acquire))
        {
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn stop_session(&self, session_id: &str) -> bool {
        let handle = self
            .sessions
            .read()
            .ok()
            .and_then(|sessions| sessions.get(session_id).cloned());
        if let Some(handle) = handle {
            let _ = handle.controls.send(TerminalControl::Stop);
            true
        } else {
            false
        }
    }

    fn remove_session(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.write() {
            sessions.remove(session_id);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_terminal_session(
    registry: Arc<TerminalRegistry>,
    session_id: String,
    channel: Channel<TerminalEvent>,
    control_rx: mpsc::Receiver<TerminalControl>,
    master: Box<dyn MasterPty + Send>,
    mut writer: Box<dyn Write + Send>,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    killer: &mut Box<dyn ChildKiller + Send + Sync>,
    temp_kubeconfig: TempPath,
    finished_flag: Arc<AtomicBool>,
) {
    let (worker_tx, worker_rx) = mpsc::channel();
    let reader_tx = worker_tx.clone();
    let reader_session_id = session_id.clone();
    let reader_channel = channel.clone();
    let reader_thread = thread::spawn(move || {
        let mut buffer = vec![0_u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = reader_tx.send(WorkerEvent::ReaderClosed);
                    break;
                }
                Ok(read) => {
                    let output = String::from_utf8_lossy(&buffer[..read]).into_owned();
                    send_event(
                        &reader_channel,
                        &reader_session_id,
                        "output",
                        Some(output.clone()),
                    );
                }
                Err(error) => {
                    let _ = reader_tx.send(WorkerEvent::ReaderError(format!(
                        "Unable to read local terminal output: {error}"
                    )));
                    break;
                }
            }
        }
    });

    let wait_tx = worker_tx;
    let wait_thread = thread::spawn(move || {
        let outcome = match child.wait() {
            Ok(status) if status.success() => "Local shell exited".to_string(),
            Ok(status) => format!("Local shell exited: {status}"),
            Err(error) => format!("Unable to wait for local shell: {error}"),
        };
        let _ = wait_tx.send(WorkerEvent::ProcessExited(outcome));
    });

    let mut stopped = false;
    let mut stop_deadline = None;
    let mut reason = "Local terminal disconnected".to_string();
    let mut finished = false;

    while !finished {
        while let Ok(event) = worker_rx.try_recv() {
            match event {
                WorkerEvent::ReaderClosed => {}
                WorkerEvent::ReaderError(error) => {
                    send_event(&channel, &session_id, "error", Some(error.clone()));
                    reason = error;
                    request_stop(killer, &mut stopped, &mut stop_deadline);
                }
                WorkerEvent::ProcessExited(outcome) => {
                    if !stopped {
                        reason = outcome;
                    }
                    finished = true;
                }
            }
        }
        if finished {
            break;
        }

        match control_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(TerminalControl::Input(data)) => {
                if let Err(error) = writer.write_all(&data).and_then(|_| writer.flush()) {
                    let message = format!("Unable to write local terminal input: {error}");
                    send_event(&channel, &session_id, "error", Some(message.clone()));
                    reason = message;
                    request_stop(killer, &mut stopped, &mut stop_deadline);
                }
            }
            Ok(TerminalControl::Resize { columns, rows }) => {
                if let Err(error) = master.resize(PtySize {
                    rows,
                    cols: columns,
                    pixel_width: 0,
                    pixel_height: 0,
                }) {
                    send_event(
                        &channel,
                        &session_id,
                        "error",
                        Some(format!("Unable to resize local terminal: {error}")),
                    );
                }
            }
            Ok(TerminalControl::Stop) | Err(RecvTimeoutError::Disconnected) => {
                reason = "Local terminal disconnected".to_string();
                request_stop(killer, &mut stopped, &mut stop_deadline);
            }
            Err(RecvTimeoutError::Timeout) => {}
        }

        if stop_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            finished = true;
        }
    }

    drop(writer);
    drop(master);
    let _ = reader_thread.join();
    let _ = wait_thread.join();
    drop(temp_kubeconfig);
    registry.remove_session(&session_id);
    finished_flag.store(true, Ordering::Release);
    send_event(&channel, &session_id, "disconnected", Some(reason));
}

fn request_stop(
    killer: &mut Box<dyn ChildKiller + Send + Sync>,
    stopped: &mut bool,
    deadline: &mut Option<Instant>,
) {
    if *stopped {
        return;
    }
    *stopped = true;
    let _ = killer.kill();
    *deadline = Some(Instant::now() + Duration::from_secs(3));
}

fn write_temp_kubeconfig(contents: &str) -> Result<TempPath, String> {
    let mut file = tempfile::Builder::new()
        .prefix("kubehive-terminal-")
        .suffix(".yaml")
        .tempfile()
        .map_err(|error| format!("Unable to create temporary kubeconfig: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file_mut()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Unable to protect temporary kubeconfig: {error}"))?;
    }
    file.write_all(contents.as_bytes())
        .and_then(|_| file.flush())
        .map_err(|error| format!("Unable to write temporary kubeconfig: {error}"))?;
    Ok(file.into_temp_path())
}

fn spawn_local_shell(kubeconfig_path: &Path) -> Result<LocalPty, String> {
    let mut errors = Vec::new();
    for shell in local_shell_candidates() {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Unable to open local pseudo-terminal: {error}"))?;
        let mut command = CommandBuilder::new(&shell.program);
        command.args(&shell.args);
        command.env("KUBECONFIG", kubeconfig_path);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        match pty.slave.spawn_command(command) {
            Ok(child) => {
                let reader = pty
                    .master
                    .try_clone_reader()
                    .map_err(|error| format!("Unable to read local terminal: {error}"))?;
                let writer = pty
                    .master
                    .take_writer()
                    .map_err(|error| format!("Unable to write local terminal: {error}"))?;
                let killer = child.clone_killer();
                return Ok(LocalPty {
                    master: pty.master,
                    writer,
                    reader,
                    child,
                    killer,
                });
            }
            Err(error) => errors.push(format!("{}: {error}", shell.program.to_string_lossy())),
        }
    }
    Err(format!(
        "Unable to launch a local shell. Tried: {}",
        errors.join("; ")
    ))
}

#[cfg(unix)]
fn local_shell_candidates() -> Vec<LocalShell> {
    let mut programs = Vec::new();
    if let Some(shell) = std::env::var_os("SHELL").filter(|shell| !shell.is_empty()) {
        programs.push(shell);
    }
    programs.extend(["/bin/zsh", "/bin/bash", "/bin/sh"].map(OsString::from));
    let mut seen = Vec::<OsString>::new();
    programs
        .into_iter()
        .filter(|program| {
            if seen.contains(program) {
                false
            } else {
                seen.push(program.clone());
                true
            }
        })
        .map(|program| LocalShell {
            program,
            args: vec![OsString::from("-l")],
        })
        .collect()
}

#[cfg(windows)]
fn local_shell_candidates() -> Vec<LocalShell> {
    vec![
        LocalShell {
            program: OsString::from("pwsh.exe"),
            args: Vec::new(),
        },
        LocalShell {
            program: OsString::from("powershell.exe"),
            args: Vec::new(),
        },
        LocalShell {
            program: OsString::from("cmd.exe"),
            args: vec![OsString::from("/K")],
        },
    ]
}

fn send_event(
    channel: &Channel<TerminalEvent>,
    session_id: &str,
    event_type: &str,
    data: Option<String>,
) {
    let _ = channel.send(TerminalEvent {
        session_id: session_id.to_string(),
        event_type: event_type.to_string(),
        data,
    });
}
