use crate::{
    models::{StartTerminalRequest, TerminalEvent},
    registry::ClusterRegistry,
};
use chrono::Utc;
use futures::SinkExt;
use k8s_openapi::{
    api::core::v1::{
        Container, HostPathVolumeSource, Pod, PodSpec, SecurityContext, Toleration, Volume,
        VolumeMount,
    },
    apimachinery::pkg::apis::meta::v1::ObjectMeta,
};
use kube::api::{Api, AttachParams, DeleteParams, Patch, PatchParams, PostParams, TerminalSize};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
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

mod local;
mod node_shell;
mod pod;

pub use local::TerminalRegistry;
#[cfg(test)]
use local::{local_shell_candidates, write_temp_kubeconfig};
#[cfg(test)]
use node_shell::{
    build_node_shell_pod, default_node_terminal_command, DEFAULT_NODE_SHELL_ACTIVE_DEADLINE_SECS,
    DEFAULT_NODE_SHELL_IMAGE,
};
pub(crate) use node_shell::{
    delete_node_shell_pod, delete_node_shell_pod_logged, node_shell_active_deadline_seconds,
    node_shell_image, sanitize_node_name_for_generate, spawn_helper_heartbeat,
    wait_for_pod_running, DEFAULT_NODE_SHELL_NAMESPACE, NODE_SHELL_CONTAINER_NAME,
    SESSION_HEARTBEAT_ANNOTATION,
};
#[cfg(test)]
use pod::default_container_terminal_command;
pub use pod::ContainerTerminalRegistry;

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

fn validate_container_terminal_request(
    request: &StartTerminalRequest,
) -> Result<(&str, &str), String> {
    let namespace = request
        .namespace
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "A namespace is required for a container terminal".to_string())?;
    let pod = request
        .pod
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "A Pod is required for a container terminal".to_string())?;
    Ok((namespace, pod))
}

fn validate_node_terminal_request(
    request: &StartTerminalRequest,
) -> Result<(String, String), String> {
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
    Ok((node, namespace))
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
    namespace: String,
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
