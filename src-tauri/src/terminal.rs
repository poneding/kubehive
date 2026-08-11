use crate::{
    models::{StartTerminalRequest, TerminalEvent},
    registry::ClusterRegistry,
};
use futures::SinkExt;
use k8s_openapi::{
    api::core::v1::{
        Container, HostPathVolumeSource, Pod, PodSpec, SecurityContext, Toleration, Volume,
        VolumeMount,
    },
    apimachinery::pkg::apis::meta::v1::ObjectMeta,
};
use kube::api::{Api, AttachParams, DeleteParams, PostParams, TerminalSize};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::{BTreeMap, HashMap},
    env,
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
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{mpsc as async_mpsc, RwLock as AsyncRwLock},
};
use tokio_util::sync::CancellationToken;
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

#[derive(Clone)]
struct EphemeralNodeShell {
    pod: String,
}

#[derive(Clone)]
struct ContainerTerminalHandle {
    cluster_id: String,
    controls: async_mpsc::UnboundedSender<TerminalControl>,
    cancellation: CancellationToken,
}

#[derive(Default)]
pub struct ContainerTerminalRegistry {
    sessions: AsyncRwLock<HashMap<String, ContainerTerminalHandle>>,
}

impl ContainerTerminalRegistry {
    pub async fn start(
        self: Arc<Self>,
        clusters: Arc<ClusterRegistry>,
        request: StartTerminalRequest,
        channel: Channel<TerminalEvent>,
    ) -> Result<String, String> {
        if request
            .node
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            return self.start_node(clusters, request, channel).await;
        }

        let namespace = request
            .namespace
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "A namespace is required for a container terminal".to_string())?;
        let pod = request
            .pod
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "A Pod is required for a container terminal".to_string())?;
        let client = clusters.streaming_client(&request.cluster_id).await?;
        let pods: Api<Pod> = Api::namespaced(client, namespace);
        let command = if request.command.is_empty() {
            default_container_terminal_command()
        } else {
            request.command.clone()
        };
        let mut params = AttachParams::interactive_tty();
        params.max_stdin_buf_size = Some(16 * 1024);
        params.max_stdout_buf_size = Some(64 * 1024);
        if let Some(container) = request
            .container
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            params = params.container(container);
        }
        let process = pods
            .exec(pod, command, &params)
            .await
            .map_err(|error| format!("Unable to open terminal for {pod}: {error}"))?;
        let connected_label = format!(
            "{namespace}/{pod}{}",
            request
                .container
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(|value| format!(" · {value}"))
                .unwrap_or_default()
        );
        self.attach_exec_session(
            request.cluster_id,
            process,
            channel,
            connected_label,
            "Container terminal",
            None,
        )
        .await
    }

    pub async fn start_node(
        self: Arc<Self>,
        clusters: Arc<ClusterRegistry>,
        request: StartTerminalRequest,
        channel: Channel<TerminalEvent>,
    ) -> Result<String, String> {
        let node = request
            .node
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "A Node is required for a node terminal".to_string())?
            .to_string();
        let namespace = request
            .namespace
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_NODE_SHELL_NAMESPACE)
            .to_string();
        let client = clusters.streaming_client(&request.cluster_id).await?;
        let pods: Api<Pod> = Api::namespaced(client, &namespace);
        let pod_template = build_node_shell_pod(&node, &namespace);
        let created = pods
            .create(&PostParams::default(), &pod_template)
            .await
            .map_err(|error| {
                format!("Unable to create privileged node shell Pod on {node}: {error}")
            })?;
        let pod_name = created
            .metadata
            .name
            .clone()
            .ok_or_else(|| "The node shell Pod was created without a name".to_string())?;

        if let Err(error) = wait_for_pod_running(&pods, &pod_name, Duration::from_secs(90)).await {
            let _ = delete_node_shell_pod(&pods, &pod_name).await;
            return Err(error);
        }

        let command = if request.command.is_empty() {
            default_node_terminal_command()
        } else {
            request.command.clone()
        };
        let mut params = AttachParams::interactive_tty();
        params.max_stdin_buf_size = Some(16 * 1024);
        params.max_stdout_buf_size = Some(64 * 1024);
        params = params.container(NODE_SHELL_CONTAINER_NAME);

        let process = match pods.exec(&pod_name, command, &params).await {
            Ok(process) => process,
            Err(error) => {
                let _ = delete_node_shell_pod(&pods, &pod_name).await;
                return Err(format!(
                    "Unable to open node terminal on {node} via {namespace}/{pod_name}: {error}"
                ));
            }
        };

        self.attach_exec_session(
            request.cluster_id,
            process,
            channel,
            format!("Node {node} · host shell via {namespace}/{pod_name}"),
            "Node terminal",
            Some((pods, EphemeralNodeShell { pod: pod_name })),
        )
        .await
    }

    async fn attach_exec_session(
        self: Arc<Self>,
        cluster_id: String,
        mut process: kube::api::AttachedProcess,
        channel: Channel<TerminalEvent>,
        connected_label: String,
        kind_label: &'static str,
        cleanup: Option<(Api<Pod>, EphemeralNodeShell)>,
    ) -> Result<String, String> {
        let mut stdin = process
            .stdin()
            .ok_or_else(|| "The terminal stream did not provide stdin".to_string())?;
        let mut stdout = process
            .stdout()
            .ok_or_else(|| "The terminal stream did not provide stdout".to_string())?;
        let mut terminal_size = process.terminal_size();

        let session_id = Uuid::new_v4().to_string();
        let cancellation = CancellationToken::new();
        let (controls, mut control_rx) = async_mpsc::unbounded_channel();
        self.sessions.write().await.insert(
            session_id.clone(),
            ContainerTerminalHandle {
                cluster_id,
                controls,
                cancellation: cancellation.clone(),
            },
        );

        send_event(&channel, &session_id, "connected", Some(connected_label));

        let task_session_id = session_id.clone();
        let task_registry = self.clone();
        tauri::async_runtime::spawn(async move {
            let writer_cancellation = cancellation.clone();
            let writer_channel = channel.clone();
            let writer_session_id = task_session_id.clone();
            let writer = tauri::async_runtime::spawn(async move {
                let mut last_size = (80_u16, 24_u16);
                let mut keepalive = tokio::time::interval(Duration::from_secs(20));
                keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    tokio::select! {
                        _ = writer_cancellation.cancelled() => break,
                        _ = keepalive.tick(), if terminal_size.is_some() => {
                            let (width, height) = last_size;
                            if let Some(size) = terminal_size.as_mut() {
                                if let Err(error) = size.send(TerminalSize { width, height }).await {
                                    send_event(&writer_channel, &writer_session_id, "error", Some(format!("{kind_label} keepalive stopped: {error}")));
                                    terminal_size = None;
                                }
                            }
                        }
                        control = control_rx.recv() => match control {
                            Some(TerminalControl::Input(data)) => {
                                if let Err(error) = stdin.write_all(&data).await {
                                    send_event(&writer_channel, &writer_session_id, "error", Some(format!("Unable to write {} input: {error}", kind_label.to_lowercase())));
                                    writer_cancellation.cancel();
                                    break;
                                }
                                if let Err(error) = stdin.flush().await {
                                    send_event(&writer_channel, &writer_session_id, "error", Some(format!("Unable to flush {} input: {error}", kind_label.to_lowercase())));
                                    writer_cancellation.cancel();
                                    break;
                                }
                            }
                            Some(TerminalControl::Resize { columns, rows }) => {
                                last_size = (columns, rows);
                                if let Some(size) = terminal_size.as_mut() {
                                    if let Err(error) = size.send(TerminalSize { width: columns, height: rows }).await {
                                        send_event(&writer_channel, &writer_session_id, "error", Some(format!("Unable to resize {}: {error}", kind_label.to_lowercase())));
                                        terminal_size = None;
                                    }
                                }
                            }
                            Some(TerminalControl::Stop) | None => {
                                writer_cancellation.cancel();
                                break;
                            }
                        }
                    }
                }
            });

            let mut buffer = vec![0_u8; 16 * 1024];
            let mut disconnected_reason = loop {
                tokio::select! {
                    _ = cancellation.cancelled() => {
                        process.abort();
                        break format!("{kind_label} disconnected");
                    }
                    result = stdout.read(&mut buffer) => match result {
                        Ok(0) => break format!("{kind_label} stream was closed by the remote endpoint"),
                        Ok(read) => send_event(
                            &channel,
                            &task_session_id,
                            "output",
                            Some(String::from_utf8_lossy(&buffer[..read]).into_owned()),
                        ),
                        Err(error) => {
                            let reason = format!("{kind_label} stream failed: {error}");
                            send_event(&channel, &task_session_id, "error", Some(reason.clone()));
                            break reason;
                        }
                    }
                }
            };

            cancellation.cancel();
            let _ = writer.await;
            if let Err(error) = process.join().await {
                let generic = format!("{kind_label} session ended");
                if disconnected_reason == generic {
                    disconnected_reason =
                        format!("Remote {} closed: {error}", kind_label.to_lowercase());
                }
            }
            if let Some((pods, shell)) = cleanup {
                let _ = delete_node_shell_pod(&pods, &shell.pod).await;
            }
            task_registry
                .sessions
                .write()
                .await
                .remove(&task_session_id);
            send_event(
                &channel,
                &task_session_id,
                "disconnected",
                Some(disconnected_reason),
            );
        });

        Ok(session_id)
    }

    pub async fn write(&self, session_id: &str, data: String) -> Result<(), String> {
        let handle = self
            .sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Container terminal session is no longer available".to_string())?;
        handle
            .controls
            .send(TerminalControl::Input(data.into_bytes()))
            .map_err(|_| "Container terminal session is no longer available".to_string())
    }

    pub async fn resize(&self, session_id: &str, columns: u16, rows: u16) -> Result<(), String> {
        let handle = self
            .sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Container terminal session is no longer available".to_string())?;
        handle
            .controls
            .send(TerminalControl::Resize {
                columns: columns.clamp(20, 500),
                rows: rows.clamp(5, 300),
            })
            .map_err(|_| "Container terminal session is no longer available".to_string())
    }

    pub async fn stop(&self, session_id: &str) -> bool {
        let handle = self.sessions.read().await.get(session_id).cloned();
        if let Some(handle) = handle {
            handle.cancellation.cancel();
            let _ = handle.controls.send(TerminalControl::Stop);
            true
        } else {
            false
        }
    }

    pub async fn stop_cluster(&self, cluster_id: &str) {
        let handles = self
            .sessions
            .read()
            .await
            .values()
            .filter(|handle| handle.cluster_id == cluster_id)
            .cloned()
            .collect::<Vec<_>>();
        for handle in handles {
            handle.cancellation.cancel();
            let _ = handle.controls.send(TerminalControl::Stop);
        }
    }

    pub async fn shutdown(&self) {
        let handles = self
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for handle in handles {
            handle.cancellation.cancel();
            let _ = handle.controls.send(TerminalControl::Stop);
        }
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            while !self.sessions.read().await.is_empty() {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await;
    }
}

pub(crate) const DEFAULT_NODE_SHELL_NAMESPACE: &str = "default";
pub(crate) const NODE_SHELL_CONTAINER_NAME: &str = "shell";
const DEFAULT_NODE_SHELL_IMAGE: &str = "busybox:1.36";
/// Hard ceiling for orphaned helper Pods if the client never disconnects cleanly.
/// Normal session close force-deletes the Pod immediately (grace period 0).
const DEFAULT_NODE_SHELL_ACTIVE_DEADLINE_SECS: i64 = 4 * 60 * 60;

pub(crate) fn node_shell_image() -> String {
    env::var("KUBEHIVE_NODE_TERMINAL_IMAGE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_NODE_SHELL_IMAGE.to_string())
}

pub(crate) fn node_shell_active_deadline_seconds() -> i64 {
    env::var("KUBEHIVE_NODE_TERMINAL_TTL_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_NODE_SHELL_ACTIVE_DEADLINE_SECS)
}

pub(crate) fn sanitize_node_name_for_generate(node: &str) -> String {
    let mut cleaned = node
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    while cleaned.contains("--") {
        cleaned = cleaned.replace("--", "-");
    }
    let cleaned = cleaned.trim_matches('-').to_string();
    if cleaned.is_empty() {
        "node".to_string()
    } else {
        cleaned.chars().take(40).collect()
    }
}

fn build_node_shell_pod(node: &str, namespace: &str) -> Pod {
    let mut labels = BTreeMap::new();
    labels.insert("app.kubernetes.io/name".into(), "kubehive".into());
    labels.insert("app.kubernetes.io/component".into(), "node-terminal".into());
    labels.insert("app.kubernetes.io/managed-by".into(), "kubehive".into());

    let mut annotations = BTreeMap::new();
    annotations.insert("kubehive.io/node-terminal".into(), "true".into());
    annotations.insert("kubehive.io/node".into(), node.to_string());

    Pod {
        metadata: ObjectMeta {
            generate_name: Some(format!(
                "kubehive-node-{}-",
                sanitize_node_name_for_generate(node)
            )),
            namespace: Some(namespace.to_string()),
            labels: Some(labels),
            annotations: Some(annotations),
            ..Default::default()
        },
        spec: Some(PodSpec {
            node_name: Some(node.to_string()),
            host_network: Some(true),
            host_pid: Some(true),
            host_ipc: Some(true),
            dns_policy: Some("ClusterFirstWithHostNet".into()),
            restart_policy: Some("Never".into()),
            // Force-delete on session end is immediate; this only bounds orphans.
            active_deadline_seconds: Some(node_shell_active_deadline_seconds()),
            termination_grace_period_seconds: Some(0),
            tolerations: Some(vec![Toleration {
                operator: Some("Exists".into()),
                ..Default::default()
            }]),
            containers: vec![Container {
                name: NODE_SHELL_CONTAINER_NAME.into(),
                image: Some(node_shell_image()),
                image_pull_policy: Some("IfNotPresent".into()),
                // Keep-alive only. Session close force-deletes this Pod (grace 0);
                // activeDeadlineSeconds reaps orphans. Do not wait for sleep to end.
                command: Some(vec![
                    "sh".into(),
                    "-c".into(),
                    "while true; do sleep 3600; done".into(),
                ]),
                security_context: Some(SecurityContext {
                    privileged: Some(true),
                    ..Default::default()
                }),
                volume_mounts: Some(vec![VolumeMount {
                    name: "host-root".into(),
                    mount_path: "/host".into(),
                    ..Default::default()
                }]),
                stdin: Some(true),
                tty: Some(true),
                ..Default::default()
            }],
            volumes: Some(vec![Volume {
                name: "host-root".into(),
                host_path: Some(HostPathVolumeSource {
                    path: "/".into(),
                    type_: Some("Directory".into()),
                }),
                ..Default::default()
            }]),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn pod_running_ready(pod: &Pod) -> bool {
    let phase = pod
        .status
        .as_ref()
        .and_then(|status| status.phase.as_deref())
        .unwrap_or("");
    if phase != "Running" {
        return false;
    }
    pod.status
        .as_ref()
        .and_then(|status| status.container_statuses.as_ref())
        .map(|statuses| {
            statuses.iter().any(|status| {
                status.name == NODE_SHELL_CONTAINER_NAME
                    && status.ready
                    && status.started.unwrap_or(true)
            })
        })
        .unwrap_or(false)
}

fn pod_failure_message(pod: &Pod) -> Option<String> {
    let phase = pod
        .status
        .as_ref()
        .and_then(|status| status.phase.as_deref())
        .unwrap_or("");
    if matches!(phase, "Failed" | "Succeeded") {
        let reason = pod
            .status
            .as_ref()
            .and_then(|status| status.reason.clone())
            .unwrap_or_else(|| phase.to_string());
        let message = pod
            .status
            .as_ref()
            .and_then(|status| status.message.clone())
            .unwrap_or_default();
        return Some(if message.is_empty() {
            format!("Node shell Pod entered phase {reason}")
        } else {
            format!("Node shell Pod entered phase {reason}: {message}")
        });
    }

    let container = pod
        .status
        .as_ref()
        .and_then(|status| status.container_statuses.as_ref())
        .into_iter()
        .flatten()
        .find(|status| status.name == NODE_SHELL_CONTAINER_NAME)?;

    if let Some(waiting) = container
        .state
        .as_ref()
        .and_then(|state| state.waiting.as_ref())
    {
        let reason = waiting.reason.as_deref().unwrap_or("Waiting");
        if matches!(
            reason,
            "CrashLoopBackOff"
                | "ImagePullBackOff"
                | "ErrImagePull"
                | "CreateContainerConfigError"
                | "CreateContainerError"
                | "InvalidImageName"
        ) {
            let message = waiting.message.clone().unwrap_or_default();
            return Some(if message.is_empty() {
                format!("Node shell container is {reason}")
            } else {
                format!("Node shell container is {reason}: {message}")
            });
        }
    }

    if let Some(terminated) = container
        .state
        .as_ref()
        .and_then(|state| state.terminated.as_ref())
    {
        let reason = terminated
            .reason
            .clone()
            .unwrap_or_else(|| "Terminated".into());
        let message = terminated.message.clone().unwrap_or_default();
        return Some(if message.is_empty() {
            format!("Node shell container terminated ({reason})")
        } else {
            format!("Node shell container terminated ({reason}): {message}")
        });
    }

    None
}

pub(crate) async fn wait_for_pod_running(
    pods: &Api<Pod>,
    name: &str,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let pod = pods
            .get(name)
            .await
            .map_err(|error| format!("Unable to watch node shell Pod {name}: {error}"))?;
        if pod_running_ready(&pod) {
            return Ok(());
        }
        if let Some(failure) = pod_failure_message(&pod) {
            return Err(failure);
        }
        if Instant::now() >= deadline {
            let phase = pod
                .status
                .as_ref()
                .and_then(|status| status.phase.as_deref())
                .unwrap_or("Unknown");
            return Err(format!(
                "Timed out waiting for node shell Pod {name} to become Ready (phase: {phase})"
            ));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

pub(crate) async fn delete_node_shell_pod(pods: &Api<Pod>, name: &str) -> Result<(), String> {
    let params = DeleteParams {
        grace_period_seconds: Some(0),
        ..Default::default()
    };
    match pods.delete(name, &params).await {
        Ok(_) => Ok(()),
        Err(kube::Error::Api(error)) if error.code == 404 => Ok(()),
        Err(error) => Err(format!("Unable to delete node shell Pod {name}: {error}")),
    }
}

fn interactive_shell_bootstrap() -> String {
    r#"export TERM=${TERM:-xterm-256color}; export COLORTERM=${COLORTERM:-truecolor};
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) ;;
  *)
    if command -v locale >/dev/null 2>&1; then
      available_locales=$(locale -a 2>/dev/null || true)
      for utf8_locale in C.UTF-8 C.utf8 en_US.UTF-8 en_US.utf8; do
        if printf '%s
' "$available_locales" | grep -Fxiq "$utf8_locale"; then
          export LANG=$utf8_locale LC_CTYPE=$utf8_locale
          break
        fi
      done
    else
      export LANG=${LANG:-C.UTF-8} LC_CTYPE=${LC_CTYPE:-C.UTF-8}
    fi
    ;;
esac
if command -v bash >/dev/null 2>&1; then
  export HISTFILE=${HISTFILE:-/tmp/.kubehive_bash_history};
  exec bash -il;
elif command -v zsh >/dev/null 2>&1; then
  export HISTFILE=${HISTFILE:-/tmp/.kubehive_zsh_history};
  exec zsh -il;
elif command -v ash >/dev/null 2>&1; then
  export HISTFILE=${HISTFILE:-/tmp/.kubehive_ash_history};
  exec ash -i;
elif command -v sh >/dev/null 2>&1; then
  export HISTFILE=${HISTFILE:-/tmp/.kubehive_sh_history};
  exec sh -i;
else
  echo "No interactive shell was found." >&2;
  sleep 3600;
fi"#
    .to_string()
}

fn default_container_terminal_command() -> Vec<String> {
    vec![
        "sh".to_string(),
        "-lc".to_string(),
        interactive_shell_bootstrap(),
    ]
}

/// Enter the node host namespaces via nsenter (preferred) or chroot /host.
/// The helper Pod runs privileged with hostPID/hostNetwork/hostIPC and mounts `/` at `/host`.
fn default_node_terminal_command() -> Vec<String> {
    vec![
        "sh".to_string(),
        "-lc".to_string(),
        r#"export TERM=${TERM:-xterm-256color}; export COLORTERM=${COLORTERM:-truecolor};
if command -v nsenter >/dev/null 2>&1; then
  for host_shell in /bin/bash /usr/bin/bash /bin/zsh /usr/bin/zsh /bin/ash /bin/sh /usr/bin/sh; do
    if nsenter --target 1 --mount --uts --ipc --net -- test -x "$host_shell" 2>/dev/null; then
      case "$host_shell" in
        *bash) exec nsenter --target 1 --mount --uts --ipc --net -- "$host_shell" -il ;;
        *zsh) exec nsenter --target 1 --mount --uts --ipc --net -- "$host_shell" -il ;;
        *) exec nsenter --target 1 --mount --uts --ipc --net -- "$host_shell" -i ;;
      esac
    fi
  done
  exec nsenter --target 1 --mount --uts --ipc --net -- sh -i
fi
if [ -d /host ]; then
  for host_shell in /bin/bash /usr/bin/bash /bin/zsh /usr/bin/zsh /bin/ash /bin/sh /usr/bin/sh; do
    if [ -x "/host$host_shell" ]; then
      case "$host_shell" in
        *bash|*zsh) exec chroot /host "$host_shell" -il ;;
        *) exec chroot /host "$host_shell" -i ;;
      esac
    fi
  done
fi
echo "Unable to enter the node host namespaces. nsenter is missing and /host has no usable shell." >&2
echo "The privileged helper Pod is still running; inspect /host manually." >&2
exec sh -i"#
        .to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporary_kubeconfig_is_removed_when_its_guard_is_dropped() {
        let path = {
            let temp_path = write_temp_kubeconfig("apiVersion: v1\nkind: Config\n").unwrap();
            let path = temp_path.to_path_buf();
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                "apiVersion: v1\nkind: Config\n"
            );
            path
        };
        assert!(!path.exists());
    }

    #[test]
    fn local_shell_has_a_platform_fallback() {
        assert!(!local_shell_candidates().is_empty());
    }

    #[test]
    fn container_shell_configures_utf8_before_starting_the_interactive_shell() {
        let command = default_container_terminal_command().join("\n");
        let locale_setup = command.find("C.UTF-8").unwrap();
        let shell_start = command.find("exec bash -il").unwrap();
        assert!(locale_setup < shell_start);
    }

    #[test]
    fn node_shell_pod_is_privileged_and_pinned_to_the_target_node() {
        let pod = build_node_shell_pod("worker-1.example", "default");
        let meta = pod.metadata;
        assert_eq!(meta.namespace.as_deref(), Some("default"));
        assert!(meta
            .generate_name
            .as_deref()
            .unwrap_or_default()
            .starts_with("kubehive-node-worker-1-example-"));
        assert_eq!(
            meta.labels
                .as_ref()
                .and_then(|labels| labels.get("app.kubernetes.io/component"))
                .map(String::as_str),
            Some("node-terminal")
        );

        let spec = pod.spec.expect("node shell pod must have a spec");
        assert_eq!(spec.node_name.as_deref(), Some("worker-1.example"));
        assert_eq!(spec.host_network, Some(true));
        assert_eq!(spec.host_pid, Some(true));
        assert_eq!(spec.host_ipc, Some(true));
        assert_eq!(spec.restart_policy.as_deref(), Some("Never"));
        assert_eq!(spec.termination_grace_period_seconds, Some(0));
        assert_eq!(
            spec.active_deadline_seconds,
            Some(DEFAULT_NODE_SHELL_ACTIVE_DEADLINE_SECS)
        );
        assert_eq!(spec.dns_policy.as_deref(), Some("ClusterFirstWithHostNet"));
        assert!(spec
            .tolerations
            .as_ref()
            .into_iter()
            .flatten()
            .any(|toleration| toleration.operator.as_deref() == Some("Exists")));

        let container = spec.containers.first().expect("shell container");
        assert_eq!(container.name, NODE_SHELL_CONTAINER_NAME);
        assert_eq!(container.image.as_deref(), Some(DEFAULT_NODE_SHELL_IMAGE));
        assert_eq!(
            container.command.as_deref(),
            Some(
                [
                    "sh".to_string(),
                    "-c".to_string(),
                    "while true; do sleep 3600; done".to_string(),
                ]
                .as_slice()
            )
        );
        assert_eq!(
            container
                .security_context
                .as_ref()
                .and_then(|context| context.privileged),
            Some(true)
        );
        assert!(container
            .volume_mounts
            .as_ref()
            .into_iter()
            .flatten()
            .any(|mount| mount.name == "host-root" && mount.mount_path == "/host"));
        assert!(spec.volumes.as_ref().into_iter().flatten().any(|volume| {
            volume.name == "host-root"
                && volume
                    .host_path
                    .as_ref()
                    .map(|path| path.path == "/")
                    .unwrap_or(false)
        }));
    }

    #[test]
    fn node_terminal_command_enters_host_namespaces() {
        let command = default_node_terminal_command().join(" ");
        assert!(command.contains("nsenter"));
        assert!(command.contains("--target 1"));
        assert!(command.contains("--mount"));
        assert!(command.contains("chroot /host"));
    }

    #[test]
    fn node_name_sanitization_keeps_generate_name_safe() {
        assert_eq!(
            sanitize_node_name_for_generate("Worker_1.EXAMPLE"),
            "worker-1-example"
        );
        assert_eq!(sanitize_node_name_for_generate("---"), "node");
    }
}
