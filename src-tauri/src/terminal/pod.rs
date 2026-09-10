use super::*;

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

pub(super) fn default_container_terminal_command() -> Vec<String> {
    vec![
        "sh".to_string(),
        "-lc".to_string(),
        interactive_shell_bootstrap(),
    ]
}

#[derive(Clone)]
struct ContainerTerminalHandle {
    cluster_id: String,
    controls: async_mpsc::UnboundedSender<TerminalControl>,
    cancellation: CancellationToken,
    /// Present only for node terminal sessions: the helper Pod this session
    /// owns, reported to the helper-Pod reaper so a live session is never
    /// swept.
    node_shell: Option<EphemeralNodeShell>,
}

#[derive(Default)]
pub struct ContainerTerminalRegistry {
    sessions: AsyncRwLock<HashMap<String, ContainerTerminalHandle>>,
}

impl ContainerTerminalRegistry {
    /// Opens a container terminal, or routes to the node shell when a node is supplied.
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

        let (namespace, pod) = validate_container_terminal_request(&request)?;
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

    pub(super) async fn attach_exec_session(
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
                node_shell: cleanup.as_ref().map(|(_, shell)| shell.clone()),
            },
        );

        send_event(&channel, &session_id, "connected", Some(connected_label));

        let task_session_id = session_id.clone();
        let task_registry = self.clone();
        tauri::async_runtime::spawn(async move {
            if let Some((pods, shell)) = cleanup.as_ref() {
                // Keep the helper Pod's session heartbeat alive for the whole
                // session so the orphan reaper never sweeps a live terminal.
                spawn_helper_heartbeat(pods.clone(), &shell.pod, cancellation.clone());
            }
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
                delete_node_shell_pod_logged(&pods, &shell.pod, "closing the terminal session")
                    .await;
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

    /// Namespaced names of the node terminal helper Pods this registry
    /// currently owns, for the helper-Pod reaper.
    pub async fn live_node_shell_pods(&self, cluster_id: &str) -> HashSet<(String, String)> {
        self.sessions
            .read()
            .await
            .iter()
            .filter(|(_, handle)| handle.cluster_id == cluster_id)
            .filter_map(|(_, handle)| handle.node_shell.as_ref())
            .map(|shell| (shell.namespace.clone(), shell.pod.clone()))
            .collect()
    }
}
