use super::*;

impl ContainerTerminalRegistry {
    /// Creates the privileged helper Pod (host namespaces, `/` mounted at `/host`), waits for Ready,
    /// and attaches the host shell. The Pod is deleted when startup or exec fails.
    pub async fn start_node(
        self: Arc<Self>,
        clusters: Arc<ClusterRegistry>,
        request: StartTerminalRequest,
        channel: Channel<TerminalEvent>,
    ) -> Result<String, String> {
        let (node, namespace) = validate_node_terminal_request(&request)?;
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
            delete_node_shell_pod_logged(&pods, &pod_name, "waiting for it to become ready").await;
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
                delete_node_shell_pod_logged(&pods, &pod_name, "opening the exec stream").await;
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
            Some((
                pods,
                EphemeralNodeShell {
                    pod: pod_name,
                    namespace,
                },
            )),
        )
        .await
    }
}

pub(crate) const DEFAULT_NODE_SHELL_NAMESPACE: &str = "default";
pub(crate) const NODE_SHELL_CONTAINER_NAME: &str = "shell";
pub(crate) const DEFAULT_NODE_SHELL_IMAGE: &str = "busybox:1.36";
/// Hard ceiling for orphaned helper Pods if the client never disconnects cleanly.
/// Normal session close force-deletes the Pod immediately (grace period 0).
pub(crate) const DEFAULT_NODE_SHELL_ACTIVE_DEADLINE_SECS: i64 = 4 * 60 * 60;

/// Annotation holding the last heartbeat timestamp of a live helper-Pod
/// session (node terminals and node file explorers). The orphan reaper
/// deletes running helper Pods whose heartbeat went stale; Pods without a
/// heartbeat (older app versions, sessions still starting) are only reaped
/// once they are old enough that they cannot be mid-startup.
pub(crate) const SESSION_HEARTBEAT_ANNOTATION: &str = "kubehive.io/session-heartbeat";
const SESSION_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);

/// Refreshes `kubehive.io/session-heartbeat` on the helper Pod every minute
/// (immediately on the first tick) for as long as `cancellation` stays live.
/// Failures are ignored: the next beat retries, and the live-session registry
/// protects the Pod from the reaper within this app instance anyway — the
/// heartbeat mainly protects sessions owned by other app instances.
pub(crate) fn spawn_helper_heartbeat(
    pods: Api<Pod>,
    pod_name: &str,
    cancellation: CancellationToken,
) {
    let pod_name = pod_name.to_string();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(SESSION_HEARTBEAT_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => break,
                _ = interval.tick() => {
                    let heartbeat = Utc::now().to_rfc3339();
                    let patch = json!({
                        "metadata": {
                            "annotations": { SESSION_HEARTBEAT_ANNOTATION: heartbeat }
                        }
                    });
                    if let Err(error) = pods
                        .patch(&pod_name, &PatchParams::default(), &Patch::Strategic(&patch))
                        .await
                    {
                        eprintln!(
                            "Unable to refresh node shell Pod {pod_name} heartbeat: {error}"
                        );
                    }
                }
            }
        }
    });
}

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

pub(super) fn build_node_shell_pod(node: &str, namespace: &str) -> Pod {
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

pub(crate) async fn delete_node_shell_pod_logged(pods: &Api<Pod>, name: &str, context: &str) {
    if let Err(error) = delete_node_shell_pod(pods, name).await {
        eprintln!("{error} while {context}");
    }
}

/// Enter the node host namespaces via nsenter (preferred) or chroot /host.
/// The helper Pod runs privileged with hostPID/hostNetwork/hostIPC and mounts `/` at `/host`.
pub(super) fn default_node_terminal_command() -> Vec<String> {
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
