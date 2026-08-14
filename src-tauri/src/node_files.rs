use crate::{
    models::ContainerFileTarget,
    registry::ClusterRegistry,
    terminal::{
        delete_node_shell_pod, node_shell_active_deadline_seconds, node_shell_image,
        sanitize_node_name_for_generate, spawn_helper_heartbeat, wait_for_pod_running,
        DEFAULT_NODE_SHELL_NAMESPACE, NODE_SHELL_CONTAINER_NAME,
    },
};
use k8s_openapi::{
    api::core::v1::{
        Container, HostPathVolumeSource, Pod, PodSpec, SecurityContext, Toleration, Volume,
        VolumeMount,
    },
    apimachinery::pkg::apis::meta::v1::ObjectMeta,
};
use kube::api::{Api, DeleteParams, ListParams, PostParams, Preconditions};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::{Mutex as AsyncMutex, RwLock as AsyncRwLock};
use tokio_util::sync::CancellationToken;

/// Node file service: a short-lived privileged helper Pod on the target Node
/// whose `/` is mounted at `/host`. File operations then run with
/// `chroot /host`, so every path refers to the Node host filesystem.
///
/// The Pod is created on first use and shared (with a reference count) between
/// every open Node file explorer session. It is force-deleted once the last
/// session closes; if the client never disconnects cleanly, the
/// `activeDeadlineSeconds` TTL reaps the orphan (same contract as the node
/// terminal helper Pod) and the [`crate::reaper::HelperPodReaper`] deletes
/// the leftover finished Pod as soon as the cluster is reachable again.
const NODE_FILES_COMPONENT_LABEL: &str = "node-files";
const NODE_FILES_ANNOTATION: &str = "kubehive.io/node-files";

#[derive(Clone)]
struct NodeFileSession {
    cluster_id: String,
    node: String,
    namespace: String,
    pod: String,
    uid: String,
    users: u32,
    /// Stops the session heartbeat for this helper Pod when the last user
    /// closes (the Pod is force-deleted right after anyway).
    heartbeat: CancellationToken,
}

#[derive(Clone)]
struct NodeFileHelper {
    name: String,
    uid: String,
}

#[derive(Default)]
pub struct NodeFileSessionRegistry {
    sessions: AsyncRwLock<HashMap<String, NodeFileSession>>,
    locks: AsyncRwLock<HashMap<String, Arc<AsyncMutex<()>>>>,
    lifecycle: AsyncRwLock<()>,
    stopping_clusters: AsyncRwLock<HashSet<String>>,
    shutting_down: AtomicBool,
}

fn session_key(cluster_id: &str, node: &str) -> String {
    format!("{cluster_id}\u{0}{node}")
}

fn session_target(session: &NodeFileSession) -> ContainerFileTarget {
    ContainerFileTarget {
        cluster_id: session.cluster_id.clone(),
        namespace: session.namespace.clone(),
        pod: session.pod.clone(),
        container: Some(NODE_SHELL_CONTAINER_NAME.to_string()),
        host_root: true,
    }
}

impl NodeFileSessionRegistry {
    async fn lock(&self, key: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self.locks.write().await;
        locks
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    /// Opens (or reuses) the helper Pod for `node` and returns the resolved
    /// container target the file explorer should operate on. Every successful
    /// call must be paired with [`Self::stop`] when the explorer session closes.
    pub async fn start(
        &self,
        clusters: &ClusterRegistry,
        cluster_id: &str,
        node: &str,
    ) -> Result<ContainerFileTarget, String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("The node file service is shutting down".into());
        }
        let _lifecycle = self.lifecycle.read().await;
        if self.stopping_clusters.read().await.contains(cluster_id) {
            return Err(
                "The cluster is disconnecting; the node file service is unavailable".into(),
            );
        }

        let node = node.trim();
        if node.is_empty() {
            return Err("A Node is required for the node file service".into());
        }
        let key = session_key(cluster_id, node);
        let lock = self.lock(&key).await;
        let _guard = lock.lock().await;

        if let Some(existing) = self.sessions.read().await.get(&key).cloned() {
            let mut session = existing;
            session.users += 1;
            let target = session_target(&session);
            self.sessions.write().await.insert(key, session);
            return Ok(target);
        }

        let namespace = DEFAULT_NODE_SHELL_NAMESPACE.to_string();
        let client = clusters.streaming_client(cluster_id).await?;
        let pods: Api<Pod> = Api::namespaced(client, &namespace);
        let helper = match find_existing_helper_pod(&pods, node).await? {
            Some(helper) => helper,
            None => {
                let template = build_node_files_pod(node, &namespace);
                let created = pods
                    .create(&PostParams::default(), &template)
                    .await
                    .map_err(|error| {
                        format!("Unable to create the node file helper Pod on {node}: {error}")
                    })?;
                let name = created.metadata.name.clone().ok_or_else(|| {
                    "The node file helper Pod was created without a name".to_string()
                })?;
                let uid = match created.metadata.uid.clone() {
                    Some(uid) => uid,
                    None => {
                        let _ = delete_node_shell_pod(&pods, &name).await;
                        return Err("The node file helper Pod was created without a UID".into());
                    }
                };
                if let Err(error) =
                    wait_for_pod_running(&pods, &name, std::time::Duration::from_secs(90)).await
                {
                    let _ = delete_node_shell_pod(&pods, &name).await;
                    return Err(error);
                }
                NodeFileHelper { name, uid }
            }
        };

        let heartbeat = CancellationToken::new();
        spawn_helper_heartbeat(pods.clone(), &helper.name, heartbeat.clone());
        let session = NodeFileSession {
            cluster_id: cluster_id.to_string(),
            node: node.to_string(),
            namespace,
            pod: helper.name,
            uid: helper.uid,
            users: 1,
            heartbeat,
        };
        let target = session_target(&session);
        self.sessions.write().await.insert(key, session);
        Ok(target)
    }

    /// Releases one explorer session. The helper Pod is force-deleted when the
    /// last session for the Node closes.
    pub async fn stop(&self, clusters: &ClusterRegistry, cluster_id: &str, node: &str) {
        let node = node.trim();
        if node.is_empty() {
            return;
        }
        let key = session_key(cluster_id, node);
        let lock = self.lock(&key).await;
        let _guard = lock.lock().await;
        let Some(mut session) = self.sessions.read().await.get(&key).cloned() else {
            return;
        };
        session.users = session.users.saturating_sub(1);
        if session.users > 0 {
            self.sessions.write().await.insert(key, session);
            return;
        }
        self.sessions.write().await.remove(&key);
        session.heartbeat.cancel();
        delete_node_files_helper(clusters, &session).await;
    }

    /// Prevents new sessions for a disconnecting cluster and force-releases
    /// every helper, regardless of how many explorer tabs currently share it.
    pub async fn stop_cluster(&self, clusters: &ClusterRegistry, cluster_id: &str) {
        let _lifecycle = self.lifecycle.write().await;
        self.stopping_clusters
            .write()
            .await
            .insert(cluster_id.to_string());
        let sessions = self
            .take_sessions_matching(|session| session.cluster_id == cluster_id)
            .await;
        delete_node_files_helpers(clusters, sessions).await;
    }

    /// Re-enables starts after a successfully reconnected cluster becomes usable.
    pub async fn resume_cluster(&self, cluster_id: &str) {
        let _lifecycle = self.lifecycle.write().await;
        self.stopping_clusters.write().await.remove(cluster_id);
    }

    /// Stops every tracked helper during application shutdown.
    pub async fn shutdown(&self, clusters: &ClusterRegistry) {
        self.shutting_down.store(true, Ordering::Release);
        let _lifecycle = self.lifecycle.write().await;
        let sessions = self.take_sessions_matching(|_| true).await;
        delete_node_files_helpers(clusters, sessions).await;
    }

    async fn take_sessions_matching<F>(&self, matches: F) -> Vec<NodeFileSession>
    where
        F: Fn(&NodeFileSession) -> bool,
    {
        let keys = self
            .sessions
            .read()
            .await
            .iter()
            .filter(|(_, session)| matches(session))
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let mut removed = Vec::with_capacity(keys.len());
        for key in keys {
            let lock = self.lock(&key).await;
            let _guard = lock.lock().await;
            if let Some(session) = self.sessions.write().await.remove(&key) {
                session.heartbeat.cancel();
                removed.push(session);
            }
        }
        removed
    }

    /// Namespaced names of every live node file helper Pod for `cluster_id`,
    /// used by the helper-Pod reaper to protect in-use Pods.
    pub async fn live_pods(&self, cluster_id: &str) -> HashSet<(String, String)> {
        self.sessions
            .read()
            .await
            .iter()
            .filter(|(_, session)| session.cluster_id == cluster_id)
            .map(|(_, session)| (session.namespace.clone(), session.pod.clone()))
            .collect()
    }
}

/// Reuses a healthy helper Pod left behind by an earlier session (for example
/// after the app restarted and the session registry was rebuilt) instead of
/// starting a fresh image pull.
async fn find_existing_helper_pod(
    pods: &Api<Pod>,
    node: &str,
) -> Result<Option<NodeFileHelper>, String> {
    let selector =
        format!("app.kubernetes.io/component={NODE_FILES_COMPONENT_LABEL},kubehive.io/node={node}");
    let listed = pods
        .list(&ListParams::default().labels(&selector))
        .await
        .map_err(|error| format!("Unable to search for an existing node file Pod: {error}"))?;
    for pod in listed.items {
        if is_owned_node_files_helper(&pod, node) && pod_running_ready(&pod) {
            if let (Some(name), Some(uid)) = (pod.metadata.name.clone(), pod.metadata.uid.clone()) {
                return Ok(Some(NodeFileHelper { name, uid }));
            }
        }
    }
    Ok(None)
}

async fn delete_node_files_helpers(clusters: &ClusterRegistry, sessions: Vec<NodeFileSession>) {
    let mut deleted = HashSet::new();
    for session in sessions {
        let key = (
            session.cluster_id.clone(),
            session.namespace.clone(),
            session.pod.clone(),
            session.uid.clone(),
        );
        if deleted.insert(key) {
            delete_node_files_helper(clusters, &session).await;
        }
    }
}

async fn delete_node_files_helper(clusters: &ClusterRegistry, session: &NodeFileSession) {
    let Ok(client) = clusters.streaming_client(&session.cluster_id).await else {
        return;
    };
    let pods: Api<Pod> = Api::namespaced(client, &session.namespace);
    let Ok(Some(pod)) = pods.get_opt(&session.pod).await else {
        return;
    };
    if pod.metadata.uid.as_deref() != Some(session.uid.as_str())
        || !is_owned_node_files_helper(&pod, &session.node)
    {
        return;
    }
    let params = DeleteParams::default()
        .grace_period(0)
        .preconditions(Preconditions {
            resource_version: None,
            uid: Some(session.uid.clone()),
        });
    let _ = pods.delete(&session.pod, &params).await;
}

fn is_owned_node_files_helper(pod: &Pod, node: &str) -> bool {
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
    let labels_match = labels
        .get("app.kubernetes.io/name")
        .is_some_and(|value| value == "kubehive")
        && labels
            .get("app.kubernetes.io/component")
            .is_some_and(|value| value == NODE_FILES_COMPONENT_LABEL)
        && labels
            .get("app.kubernetes.io/managed-by")
            .is_some_and(|value| value == "kubehive")
        && labels
            .get("kubehive.io/node")
            .is_some_and(|value| value == node);
    let annotations_match = annotations
        .get(NODE_FILES_ANNOTATION)
        .is_some_and(|value| value == "true")
        && annotations
            .get("kubehive.io/node")
            .is_some_and(|value| value == node);
    let shell_matches = spec.containers.iter().find(|container| {
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

    labels_match
        && annotations_match
        && spec.node_name.as_deref() == Some(node)
        && shell_matches.is_some()
        && host_root_volume
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

fn build_node_files_pod(node: &str, namespace: &str) -> Pod {
    let mut labels = BTreeMap::new();
    labels.insert("app.kubernetes.io/name".into(), "kubehive".into());
    labels.insert(
        "app.kubernetes.io/component".into(),
        NODE_FILES_COMPONENT_LABEL.into(),
    );
    labels.insert("app.kubernetes.io/managed-by".into(), "kubehive".into());
    labels.insert("kubehive.io/node".into(), node.to_string());

    let mut annotations = BTreeMap::new();
    annotations.insert(NODE_FILES_ANNOTATION.into(), "true".into());
    annotations.insert("kubehive.io/node".into(), node.to_string());

    Pod {
        metadata: ObjectMeta {
            generate_name: Some(format!(
                "kubehive-node-files-{}-",
                sanitize_node_name_for_generate(node)
            )),
            namespace: Some(namespace.to_string()),
            labels: Some(labels),
            annotations: Some(annotations),
            ..Default::default()
        },
        spec: Some(PodSpec {
            node_name: Some(node.to_string()),
            restart_policy: Some("Never".into()),
            // Force-delete on session close is immediate; this only bounds orphans.
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
                // activeDeadlineSeconds reaps orphans.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_helper_pod_is_privileged_and_pinned_to_the_target_node() {
        let pod = build_node_files_pod("worker-1.example", "default");
        let meta = pod.metadata;
        assert_eq!(meta.namespace.as_deref(), Some("default"));
        assert!(meta
            .generate_name
            .as_deref()
            .unwrap_or_default()
            .starts_with("kubehive-node-files-worker-1-example-"));
        assert_eq!(
            meta.labels
                .as_ref()
                .and_then(|labels| labels.get("app.kubernetes.io/component"))
                .map(String::as_str),
            Some("node-files")
        );

        let spec = pod.spec.expect("node file pod must have a spec");
        assert_eq!(spec.node_name.as_deref(), Some("worker-1.example"));
        assert_eq!(spec.restart_policy.as_deref(), Some("Never"));
        assert_eq!(spec.termination_grace_period_seconds, Some(0));
        assert!(spec
            .tolerations
            .as_ref()
            .into_iter()
            .flatten()
            .any(|toleration| toleration.operator.as_deref() == Some("Exists")));

        let container = spec.containers.first().expect("file container");
        assert_eq!(container.name, NODE_SHELL_CONTAINER_NAME);
        assert_eq!(container.image.as_deref(), Some("busybox:1.36"));
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
    fn helper_identity_requires_kubehive_managed_host_root_pod() {
        let pod = build_node_files_pod("worker-1.example", "default");
        assert!(is_owned_node_files_helper(&pod, "worker-1.example"));

        let mut missing_owner_label = pod.clone();
        missing_owner_label
            .metadata
            .labels
            .as_mut()
            .unwrap()
            .remove("app.kubernetes.io/managed-by");
        assert!(!is_owned_node_files_helper(
            &missing_owner_label,
            "worker-1.example"
        ));

        let mut unprivileged = pod.clone();
        unprivileged.spec.as_mut().unwrap().containers[0]
            .security_context
            .as_mut()
            .unwrap()
            .privileged = Some(false);
        assert!(!is_owned_node_files_helper(
            &unprivileged,
            "worker-1.example"
        ));

        let mut wrong_node = pod;
        wrong_node.spec.as_mut().unwrap().node_name = Some("worker-2.example".into());
        assert!(!is_owned_node_files_helper(&wrong_node, "worker-1.example"));
    }

    #[tokio::test]
    async fn cluster_teardown_force_releases_all_shared_sessions() {
        let registry = NodeFileSessionRegistry::default();
        let first = session_key("cluster-a", "node-1");
        let second = session_key("cluster-a", "node-2");
        let other = session_key("cluster-b", "node-1");
        registry.sessions.write().await.extend([
            (
                first,
                NodeFileSession {
                    cluster_id: "cluster-a".into(),
                    node: "node-1".into(),
                    namespace: "default".into(),
                    pod: "helper-1".into(),
                    uid: "uid-1".into(),
                    users: 2,
                    heartbeat: CancellationToken::new(),
                },
            ),
            (
                second,
                NodeFileSession {
                    cluster_id: "cluster-a".into(),
                    node: "node-2".into(),
                    namespace: "default".into(),
                    pod: "helper-2".into(),
                    uid: "uid-2".into(),
                    users: 3,
                    heartbeat: CancellationToken::new(),
                },
            ),
            (
                other,
                NodeFileSession {
                    cluster_id: "cluster-b".into(),
                    node: "node-1".into(),
                    namespace: "default".into(),
                    pod: "helper-3".into(),
                    uid: "uid-3".into(),
                    users: 1,
                    heartbeat: CancellationToken::new(),
                },
            ),
        ]);

        let removed = registry
            .take_sessions_matching(|session| session.cluster_id == "cluster-a")
            .await;
        assert_eq!(removed.len(), 2);
        assert!(removed.iter().all(|session| session.users > 0));
        let sessions = registry.sessions.read().await;
        assert_eq!(sessions.len(), 1);
        assert!(sessions
            .values()
            .all(|session| session.cluster_id == "cluster-b"));
    }

    #[test]
    fn session_keys_are_unique_per_cluster_and_node() {
        assert_ne!(
            session_key("cluster-a", "node-1"),
            session_key("cluster-b", "node-1")
        );
        assert_ne!(
            session_key("cluster-a", "node-1"),
            session_key("cluster-a", "node-2")
        );
    }

    #[test]
    fn node_targets_always_use_the_host_root() {
        let target = session_target(&NodeFileSession {
            cluster_id: "cluster".into(),
            node: "node-1".into(),
            namespace: "default".into(),
            pod: "kubehive-node-files-node-1-abc".into(),
            uid: "uid-1".into(),
            users: 1,
            heartbeat: CancellationToken::new(),
        });
        assert!(target.host_root);
        assert_eq!(target.container.as_deref(), Some("shell"));
        assert_eq!(target.pod, "kubehive-node-files-node-1-abc");
    }
}
