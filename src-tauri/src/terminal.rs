use crate::{
    models::{StartTerminalRequest, TerminalEvent},
    registry::ClusterRegistry,
};
use futures::SinkExt;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, AttachParams, TerminalSize};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, RwLock},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone)]
struct TerminalHandle {
    controls: mpsc::UnboundedSender<TerminalControl>,
    cancellation: CancellationToken,
}

enum TerminalControl {
    Input(Vec<u8>),
    Resize { columns: u16, rows: u16 },
    Stop,
}

#[derive(Default)]
pub struct TerminalRegistry {
    sessions: RwLock<HashMap<String, TerminalHandle>>,
}

impl TerminalRegistry {
    pub async fn start(
        self: Arc<Self>,
        clusters: Arc<ClusterRegistry>,
        request: StartTerminalRequest,
        channel: Channel<TerminalEvent>,
    ) -> Result<String, String> {
        if request.namespace.trim().is_empty() || request.pod.trim().is_empty() {
            return Err("A namespace and pod are required".into());
        }
        let client = clusters.client(&request.cluster_id).await?;
        let pods: Api<Pod> = Api::namespaced(client, &request.namespace);
        let command = if request.command.is_empty() {
            default_terminal_command()
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
        let mut process = pods
            .exec(&request.pod, command, &params)
            .await
            .map_err(|error| format!("Unable to open terminal for {}: {error}", request.pod))?;
        let mut stdin = process
            .stdin()
            .ok_or_else(|| "The terminal stream did not provide stdin".to_string())?;
        let mut stdout = process
            .stdout()
            .ok_or_else(|| "The terminal stream did not provide stdout".to_string())?;
        let mut terminal_size = process.terminal_size();

        let session_id = Uuid::new_v4().to_string();
        let cancellation = CancellationToken::new();
        let (controls, mut control_rx) = mpsc::unbounded_channel();
        self.sessions.write().await.insert(
            session_id.clone(),
            TerminalHandle {
                controls,
                cancellation: cancellation.clone(),
            },
        );

        send_event(
            &channel,
            &session_id,
            "connected",
            Some(format!(
                "{}/{}{}",
                request.namespace,
                request.pod,
                request
                    .container
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .map(|value| format!(" · {value}"))
                    .unwrap_or_default()
            )),
        );

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
                                    send_event(&writer_channel, &writer_session_id, "error", Some(format!("Terminal keepalive failed: {error}")));
                                    writer_cancellation.cancel();
                                    break;
                                }
                            }
                        }
                        control = control_rx.recv() => match control {
                            Some(TerminalControl::Input(data)) => {
                                if let Err(error) = stdin.write_all(&data).await {
                                    send_event(&writer_channel, &writer_session_id, "error", Some(format!("Unable to write terminal input: {error}")));
                                    writer_cancellation.cancel();
                                    break;
                                }
                                if let Err(error) = stdin.flush().await {
                                    send_event(&writer_channel, &writer_session_id, "error", Some(format!("Unable to flush terminal input: {error}")));
                                    writer_cancellation.cancel();
                                    break;
                                }
                            }
                            Some(TerminalControl::Resize { columns, rows }) => {
                                last_size = (columns, rows);
                                if let Some(size) = terminal_size.as_mut() {
                                    if let Err(error) = size.send(TerminalSize { width: columns, height: rows }).await {
                                        send_event(&writer_channel, &writer_session_id, "error", Some(format!("Unable to resize terminal: {error}")));
                                        writer_cancellation.cancel();
                                        break;
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
                        break "Terminal disconnected".to_string();
                    }
                    result = stdout.read(&mut buffer) => match result {
                        Ok(0) => {
                            break "Terminal stream was closed by the remote endpoint".to_string();
                        }
                        Ok(read) => send_event(
                            &channel,
                            &task_session_id,
                            "output",
                            Some(String::from_utf8_lossy(&buffer[..read]).into_owned()),
                        ),
                        Err(error) => {
                            let reason = format!("Terminal stream failed: {error}");
                            send_event(&channel, &task_session_id, "error", Some(reason.clone()));
                            break reason;
                        }
                    }
                }
            };

            cancellation.cancel();
            let _ = writer.await;
            if let Err(error) = process.join().await {
                if disconnected_reason == "Terminal session ended" {
                    disconnected_reason = format!("Remote terminal closed: {error}");
                }
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
            .await
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
        let handle = self.sessions.read().await.get(session_id).cloned();
        if let Some(handle) = handle {
            handle.cancellation.cancel();
            let _ = handle.controls.send(TerminalControl::Stop);
            true
        } else {
            false
        }
    }
}

fn default_terminal_command() -> Vec<String> {
    vec![
        "sh".to_string(),
        "-lc".to_string(),
        r#"export TERM=${TERM:-xterm-256color}; export COLORTERM=${COLORTERM:-truecolor};
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
  echo "No interactive shell was found in this container." >&2;
  sleep 3600;
fi"#
        .to_string(),
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
