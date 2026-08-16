//! Orphan reaper for KubeHive helper Pods.
//!
//! Node terminals and the node file explorer run inside short-lived helper
//! Pods that are force-deleted when their session closes cleanly. When a
//! session never gets to close — app crash, force kill, OS shutdown without a
//! graceful exit, lost frontend — the Pod would otherwise keep running until
//! `activeDeadlineSeconds` expires and then linger forever as a `Failed` Pod
//! (nothing in the cluster ever deletes it).
//!
//! This module sweeps every connected cluster and deletes helper Pods that
//! are no longer owned by a live session:
//!
//! * finished Pods (`Failed`/`Succeeded`) are always reaped — a finished Pod
//!   cannot carry a live session;
//! * running Pods tracked by a live session registry are always kept;
//! * running Pods whose `kubehive.io/session-heartbeat` annotation went stale
//!   are reaped. Every live session refreshes the heartbeat every minute, so
//!   a stale one means the owning app instance died — this also protects
//!   sessions owned by a *different* running KubeHive instance, which the
//!   in-memory session registries cannot see;
//! * running Pods without any heartbeat (older app versions, or a session
//!   that is still starting up) are reaped only once they are old enough that
//!   they cannot be mid-startup.
//!
//! Sweeps are read-mostly and every failure is non-fatal: the next sweep
//! retries. The feature needs no extra cluster permissions beyond the Pod
//! list/delete the app already uses, no in-cluster resources, and no user
//! action.

use crate::{
    node_files::NodeFileSessionRegistry,
    registry::ClusterRegistry,
    terminal::{
        ContainerTerminalRegistry, NODE_SHELL_CONTAINER_NAME, SESSION_HEARTBEAT_ANNOTATION,
    },
};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, DeleteParams, ListParams};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::sync::RwLock as AsyncRwLock;
use tokio_util::sync::CancellationToken;

/// Selector matching every Pod KubeHive creates. Sweeps still run a strict
/// per-Pod ownership check before deleting anything.
const HELPER_LABEL_SELECTOR: &str = "app.kubernetes.io/managed-by=kubehive";
/// How often each connected cluster is swept for orphaned helper Pods.
const SWEEP_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// A Pod whose heartbeat stopped this long ago is considered orphaned. The
/// heartbeat fires every minute, so three missed beats are a safe margin.
const HEARTBEAT_STALE_AFTER: ChronoDuration = ChronoDuration::seconds(3 * 60);
/// Without any heartbeat, a running Pod is only reaped once it is this old.
/// Image pulls and the ready check can keep a brand-new session Pod silent
/// for a while, so young Pods are presumed to be starting up.
const UNHEARTBEATED_ORPHAN_AGE: ChronoDuration = ChronoDuration::seconds(5 * 60);

/// Runs the orphan sweep for every connected cluster.
#[derive(Clone)]
pub struct HelperPodReaper {
    inner: Arc<HelperPodReaperInner>,
}

struct HelperPodReaperInner {
    clusters: Arc<ClusterRegistry>,
    terminals: Arc<ContainerTerminalRegistry>,
    node_files: Arc<NodeFileSessionRegistry>,
    tasks: AsyncRwLock<HashMap<String, CancellationToken>>,
}

impl HelperPodReaper {
    pub fn new(
        clusters: Arc<ClusterRegistry>,
        terminals: Arc<ContainerTerminalRegistry>,
        node_files: Arc<NodeFileSessionRegistry>,
    ) -> Self {
        Self {
            inner: Arc::new(HelperPodReaperInner {
                clusters,
                terminals,
                node_files,
                tasks: AsyncRwLock::new(HashMap::new()),
            }),
        }
    }

    /// Starts sweeping `cluster_id` (idempotent). The first sweep runs
    /// immediately so leftovers from an earlier session (crashed app,
    /// interrupted cleanup) are removed as soon as the cluster is reachable
    /// again; later sweeps run on a fixed interval.
    pub async fn start(&self, cluster_id: &str) {
        if self.inner.tasks.read().await.contains_key(cluster_id) {
            return;
        }
        let token = CancellationToken::new();
        self.inner
            .tasks
            .write()
            .await
            .insert(cluster_id.to_string(), token.clone());
        let reaper = self.clone();
        let task_cluster_id = cluster_id.to_string();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(SWEEP_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = token.cancelled() => break,
                    _ = interval.tick() => {
                        reaper.sweep(&task_cluster_id).await;
                    }
                }
            }
        });
        // Reap leftovers synchronously, before the UI can open new sessions,
        // so a just-started session can never race this first sweep.
        self.sweep(cluster_id).await;
    }

    /// Stops sweeping `cluster_id` (cluster disconnect or removal).
    pub async fn stop(&self, cluster_id: &str) {
        if let Some(token) = self.inner.tasks.write().await.remove(cluster_id) {
            token.cancel();
        }
    }

    /// Stops every sweep task during application shutdown.
    pub async fn shutdown(&self) {
        let tokens = {
            let mut tasks = self.inner.tasks.write().await;
            tasks.drain().map(|(_, token)| token).collect::<Vec<_>>()
        };
        for token in tokens {
            token.cancel();
        }
    }

    async fn sweep(&self, cluster_id: &str) {
        let Ok(client) = self.inner.clusters.client(cluster_id).await else {
            return;
        };
        let pods: Api<Pod> = Api::all(client.clone());
        let listed = match pods
            .list(&ListParams::default().labels(HELPER_LABEL_SELECTOR))
            .await
        {
            Ok(listed) => listed,
            // Read-only failures (RBAC, transient API errors) are non-fatal:
            // the next sweep retries.
            Err(_) => return,
        };
        if listed.items.is_empty() {
            return;
        }
        let live = self.live_helper_pods(cluster_id).await;
        let now = Utc::now();
        for pod in &listed.items {
            if reap_decision(pod, &live, now) == ReapDecision::Delete {
                // Deletion failures are likewise left for the next sweep.
                let _ = delete_helper_pod(&client, pod).await;
            }
        }
    }

    /// Namespaced names of every helper Pod currently owned by a live session
    /// on this app instance, across both session registries.
    async fn live_helper_pods(&self, cluster_id: &str) -> HashSet<(String, String)> {
        let mut live = self.inner.terminals.live_node_shell_pods(cluster_id).await;
        live.extend(self.inner.node_files.live_pods(cluster_id).await);
        live
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ReapDecision {
    Delete,
    Keep,
}

/// Decides whether `pod` is an orphaned KubeHive helper Pod. Only Pods that
/// pass the full ownership check can ever be deleted.
fn reap_decision(pod: &Pod, live: &HashSet<(String, String)>, now: DateTime<Utc>) -> ReapDecision {
    if !is_kubehive_helper_pod(pod) {
        return ReapDecision::Keep;
    }
    let phase = pod
        .status
        .as_ref()
        .and_then(|status| status.phase.as_deref())
        .unwrap_or("");
    // A finished Pod cannot carry a live session; reaping it can never break
    // anything, even when its owner failed to clean it up.
    if matches!(phase, "Failed" | "Succeeded") {
        return ReapDecision::Delete;
    }
    let key = (
        pod.metadata.namespace.clone().unwrap_or_default(),
        pod.metadata.name.clone().unwrap_or_default(),
    );
    if live.contains(&key) {
        return ReapDecision::Keep;
    }
    let heartbeat = pod
        .metadata
        .annotations
        .as_ref()
        .and_then(|annotations| annotations.get(SESSION_HEARTBEAT_ANNOTATION))
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));
    match heartbeat {
        Some(heartbeat) if now.signed_duration_since(heartbeat) <= HEARTBEAT_STALE_AFTER => {
            ReapDecision::Keep
        }
        Some(_) => ReapDecision::Delete,
        None => match pod.metadata.creation_timestamp.as_ref() {
            Some(created) if now.signed_duration_since(created.0) > UNHEARTBEATED_ORPHAN_AGE => {
                ReapDecision::Delete
            }
            _ => ReapDecision::Keep,
        },
    }
}

/// Strict ownership check: the Pod must look exactly like a KubeHive helper
/// Pod (node terminal or node file explorer) — labels, annotations, pinned
/// Node, privileged shell container mounting the host root — and must not
/// already be terminating. A Pod that merely carries one of the labels is
/// never touched.
fn is_kubehive_helper_pod(pod: &Pod) -> bool {
    if pod.metadata.deletion_timestamp.is_some() {
        return false;
    }
    let Some(labels) = pod.metadata.labels.as_ref() else {
        return false;
    };
    let Some(annotations) = pod.metadata.annotations.as_ref() else {
        return false;
    };
    let Some(spec) = pod.spec.as_ref() else {
        return false;
    };
    if labels.get("app.kubernetes.io/name").map(String::as_str) != Some("kubehive")
        || labels
            .get("app.kubernetes.io/managed-by")
            .map(String::as_str)
            != Some("kubehive")
    {
        return false;
    }
    let component_matches = match labels
        .get("app.kubernetes.io/component")
        .map(String::as_str)
    {
        Some("node-terminal") => {
            annotations
                .get("kubehive.io/node-terminal")
                .map(String::as_str)
                == Some("true")
        }
        Some("node-files") => {
            annotations
                .get("kubehive.io/node-files")
                .map(String::as_str)
                == Some("true")
        }
        _ => false,
    };
    if !component_matches || spec.node_name.is_none() {
        return false;
    }
    let shell_matches = spec.containers.iter().any(|container| {
        container.name == NODE_SHELL_CONTAINER_NAME
            && container
                .security_context
                .as_ref()
                .and_then(|context| context.privileged)
                == Some(true)
            && container.volume_mounts.as_ref().is_some_and(|mounts| {
                mounts
                    .iter()
                    .any(|mount| mount.name == "host-root" && mount.mount_path == "/host")
            })
    });
    let host_root_volume = spec.volumes.as_ref().is_some_and(|volumes| {
        volumes.iter().any(|volume| {
            volume.name == "host-root"
                && volume
                    .host_path
                    .as_ref()
                    .is_some_and(|path| path.path == "/")
        })
    });
    shell_matches && host_root_volume
}

async fn delete_helper_pod(client: &kube::Client, pod: &Pod) -> Result<(), String> {
    let name = pod
        .metadata
        .name
        .clone()
        .ok_or_else(|| "helper Pod has no name".to_string())?;
    let namespace = pod
        .metadata
        .namespace
        .clone()
        .unwrap_or_else(|| "default".into());
    let pods: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let params = DeleteParams {
        grace_period_seconds: Some(0),
        ..Default::default()
    };
    match pods.delete(&name, &params).await {
        Ok(_) => Ok(()),
        Err(kube::Error::Api(error)) if error.code == 404 => Ok(()),
        Err(error) => Err(format!(
            "Unable to delete helper Pod {namespace}/{name}: {error}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, Time};
    use std::collections::BTreeMap;

    fn helper_pod(name: &str, namespace: &str, component: &str) -> Pod {
        let mut labels = BTreeMap::new();
        labels.insert("app.kubernetes.io/name".into(), "kubehive".into());
        labels.insert("app.kubernetes.io/component".into(), component.to_string());
        labels.insert("app.kubernetes.io/managed-by".into(), "kubehive".into());
        let mut annotations = BTreeMap::new();
        annotations.insert(format!("kubehive.io/{component}"), "true".into());
        Pod {
            metadata: ObjectMeta {
                name: Some(name.into()),
                namespace: Some(namespace.into()),
                labels: Some(labels),
                annotations: Some(annotations),
                creation_timestamp: Some(Time(Utc::now())),
                ..Default::default()
            },
            spec: Some(k8s_openapi::api::core::v1::PodSpec {
                node_name: Some("worker-1".into()),
                containers: vec![k8s_openapi::api::core::v1::Container {
                    name: NODE_SHELL_CONTAINER_NAME.into(),
                    security_context: Some(k8s_openapi::api::core::v1::SecurityContext {
                        privileged: Some(true),
                        ..Default::default()
                    }),
                    volume_mounts: Some(vec![k8s_openapi::api::core::v1::VolumeMount {
                        name: "host-root".into(),
                        mount_path: "/host".into(),
                        ..Default::default()
                    }]),
                    ..Default::default()
                }],
                volumes: Some(vec![k8s_openapi::api::core::v1::Volume {
                    name: "host-root".into(),
                    host_path: Some(k8s_openapi::api::core::v1::HostPathVolumeSource {
                        path: "/".into(),
                        type_: Some("Directory".into()),
                    }),
                    ..Default::default()
                }]),
                ..Default::default()
            }),
            status: Some(k8s_openapi::api::core::v1::PodStatus {
                phase: Some("Running".into()),
                ..Default::default()
            }),
        }
    }

    fn with_phase(mut pod: Pod, phase: &str) -> Pod {
        pod.status.as_mut().unwrap().phase = Some(phase.into());
        pod
    }

    fn with_heartbeat(mut pod: Pod, heartbeat: DateTime<Utc>) -> Pod {
        pod.metadata
            .annotations
            .as_mut()
            .unwrap()
            .insert(SESSION_HEARTBEAT_ANNOTATION.into(), heartbeat.to_rfc3339());
        pod
    }

    fn created_at(mut pod: Pod, created: DateTime<Utc>) -> Pod {
        pod.metadata.creation_timestamp = Some(Time(created));
        pod
    }

    fn live_key(pod: &Pod) -> (String, String) {
        (
            pod.metadata.namespace.clone().unwrap_or_default(),
            pod.metadata.name.clone().unwrap_or_default(),
        )
    }

    static NOW: std::sync::OnceLock<DateTime<Utc>> = std::sync::OnceLock::new();
    fn now() -> DateTime<Utc> {
        *NOW.get_or_init(Utc::now)
    }

    #[test]
    fn finished_helper_pods_are_always_reaped() {
        let now = now();
        let live = HashSet::new();
        for phase in ["Failed", "Succeeded"] {
            let pod = with_phase(helper_pod("orphan", "default", "node-terminal"), phase);
            // Even a freshly heartbeated, in-use-looking Pod is finished, so
            // it cannot be live and must go.
            let fresh = with_heartbeat(pod, now);
            assert_eq!(reap_decision(&fresh, &live, now), ReapDecision::Delete);
        }
    }

    #[test]
    fn live_helper_pods_are_never_reaped() {
        let now = now();
        let pod = created_at(
            helper_pod("kubehive-node-worker-1-abc", "default", "node-terminal"),
            now - ChronoDuration::hours(6),
        );
        let live = HashSet::from([live_key(&pod)]);
        // Old, no heartbeat, and not finished — but a live session owns it.
        assert_eq!(reap_decision(&pod, &live, now), ReapDecision::Keep);
    }

    #[test]
    fn fresh_heartbeat_protects_pods_from_other_instances() {
        let now = now();
        let pod = created_at(
            helper_pod("kubehive-node-worker-1-abc", "default", "node-terminal"),
            now - ChronoDuration::hours(3),
        );
        // A different KubeHive instance owns this session: not in our live
        // set, but its heartbeat is fresh.
        let fresh = with_heartbeat(pod.clone(), now - ChronoDuration::seconds(30));
        assert_eq!(
            reap_decision(&fresh, &HashSet::new(), now),
            ReapDecision::Keep
        );
        // Once that instance dies, the heartbeat goes stale and the Pod is
        // reaped without waiting for its active deadline.
        let stale = with_heartbeat(pod, now - ChronoDuration::minutes(10));
        assert_eq!(
            reap_decision(&stale, &HashSet::new(), now),
            ReapDecision::Delete
        );
    }

    #[test]
    fn unheartbeated_running_pods_need_to_be_old_enough() {
        let now = now();
        let pod = helper_pod("kubehive-node-files-worker-1-abc", "default", "node-files");
        // Still pulling its image / registering its session.
        let young = created_at(pod.clone(), now - ChronoDuration::seconds(30));
        assert_eq!(
            reap_decision(&young, &HashSet::new(), now),
            ReapDecision::Keep
        );
        // Left over from a crashed app run.
        let old = created_at(pod, now - ChronoDuration::hours(2));
        assert_eq!(
            reap_decision(&old, &HashSet::new(), now),
            ReapDecision::Delete
        );
    }

    #[test]
    fn non_kubehive_pods_are_never_reaped() {
        let now = now();
        let mut unrelated = helper_pod("user-app-123", "default", "node-terminal");
        unrelated
            .metadata
            .labels
            .as_mut()
            .unwrap()
            .insert("app.kubernetes.io/managed-by".into(), "helm".into());
        assert_eq!(
            reap_decision(&with_phase(unrelated, "Failed"), &HashSet::new(), now),
            ReapDecision::Keep
        );

        // Same labels but no matching annotation: not ours.
        let mut missing_annotation = helper_pod("fake", "default", "node-terminal");
        missing_annotation
            .metadata
            .annotations
            .as_mut()
            .unwrap()
            .clear();
        assert_eq!(
            reap_decision(
                &with_phase(missing_annotation, "Failed"),
                &HashSet::new(),
                now
            ),
            ReapDecision::Keep
        );
    }

    #[test]
    fn terminating_pods_are_left_to_the_kubelet() {
        let now = now();
        let mut pod = with_phase(helper_pod("orphan", "default", "node-terminal"), "Failed");
        pod.metadata.deletion_timestamp = Some(Time(now));
        assert_eq!(
            reap_decision(&pod, &HashSet::new(), now),
            ReapDecision::Keep
        );
    }

    #[test]
    fn ownership_requires_the_privileged_host_root_shell() {
        let pod = helper_pod("kubehive-node-worker-1-abc", "default", "node-terminal");
        assert!(is_kubehive_helper_pod(&pod));

        let mut unprivileged = pod.clone();
        unprivileged.spec.as_mut().unwrap().containers[0]
            .security_context
            .as_mut()
            .unwrap()
            .privileged = Some(false);
        assert!(!is_kubehive_helper_pod(&unprivileged));

        let mut no_host_root = pod.clone();
        no_host_root.spec.as_mut().unwrap().volumes = None;
        assert!(!is_kubehive_helper_pod(&no_host_root));

        let mut unknown_component = pod;
        unknown_component
            .metadata
            .labels
            .as_mut()
            .unwrap()
            .insert("app.kubernetes.io/component".into(), "node-terminal".into());
        unknown_component
            .metadata
            .annotations
            .as_mut()
            .unwrap()
            .insert("kubehive.io/node-terminal".into(), "false".into());
        assert!(!is_kubehive_helper_pod(&unknown_component));
    }

    #[test]
    fn parse_from_rfc3339_matches_heartbeat_format() {
        let now = now();
        let formatted = now.to_rfc3339();
        let parsed = DateTime::parse_from_rfc3339(&formatted)
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(parsed, now);
    }
}
