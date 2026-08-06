use crate::{
    models::ContainerFileTarget,
    registry::ClusterRegistry,
    terminal::{
        delete_node_shell_pod, node_shell_active_deadline_seconds, node_shell_image,
        sanitize_node_name_for_generate, wait_for_pod_running, DEFAULT_NODE_SHELL_NAMESPACE,
        NODE_SHELL_CONTAINER_NAME,
    },
};
use k8s_openapi::{
    api::core::v1::{
        Container, HostPathVolumeSource, Pod, PodSpec, SecurityContext, Toleration, Volume,
        VolumeMount,
    },
    apimachinery::pkg::apis::meta::v1::ObjectMeta,
};
use kube::api::{Api, ListParams, PostParams};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};
use tokio::sync::{Mutex as AsyncMutex, RwLock as AsyncRwLock};

/// Node file service: a short-lived privileged helper Pod on the target Node
/// whose `/` is mounted at `/host`. File operations then run with
/// `chroot /host`, so every path refers to the Node host filesystem.
///
/// The Pod is created on first use and shared (with a reference count) between
/// every open Node file explorer session. It is force-deleted once the last
/// session closes; if the client never disconnects cleanly, the
/// `activeDeadlineSeconds` TTL reaps the orphan (same contract as the node
/// terminal helper Pod).
const NODE_FILES_COMPONENT_LABEL: &str = "node-files";
const NODE_FILES_ANNOTATION: &str = "kubehive.io/node-files";

#[derive(Clone)]
struct NodeFileSession {
    cluster_id: String,
    node: String,
    namespace: String,
    pod: String,
    users: u32,
}

#[derive(Default)]
pub struct NodeFileSessionRegistry {
    sessions: AsyncRwLock<HashMap<String, NodeFileSession>>,
    locks: AsyncRwLock<HashMap<String, Arc<AsyncMutex<()>>>>,
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
        let node = node.trim();
        if node.is_empty() {
            return Err("A Node is required for the node file service".into());
        }
        let key = session_key(cluster_id, node);
        let lock = self.lock(&key).await;
        let guard = lock.lock().await;

        if let Some(existing) = self.sessions.read().await.get(&key).cloned() {
            let mut session = existing;
            session.users += 1;
            let target = session_target(&session);
            self.sessions.write().await.insert(key, session);
            drop(guard);
            drop(lock);
            return Ok(target);
        }

        let namespace = DEFAULT_NODE_SHELL_NAMESPACE.to_string();
        let client = clusters.streaming_client(cluster_id).await?;
        let pods: Api<Pod> = Api::namespaced(client, &namespace);
        let pod_name = match find_existing_helper_pod(&pods, node).await? {
            Some(name) => name,
            None => {
                let template = build_node_files_pod(node, &namespace);
                let created = pods
                    .create(&PostParams::default(), &template)
                    .await
                    .map_err(|error| {
                        format!("Unable to create the node file helper Pod on {node}: {error}")
                    })?;
                let name = created.metadata.name.ok_or_else(|| {
                    "The node file helper Pod was created without a name".to_string()
                })?;
                if let Err(error) =
                    wait_for_pod_running(&pods, &name, std::time::Duration::from_secs(90)).await
                {
                    let _ = delete_node_shell_pod(&pods, &name).await;
                    return Err(error);
                }
                name
            }
        };

        let session = NodeFileSession {
            cluster_id: cluster_id.to_string(),
            node: node.to_string(),
            namespace,
            pod: pod_name,
            users: 1,
        };
        let target = session_target(&session);
        self.sessions.write().await.insert(key, session);
        drop(guard);
        drop(lock);
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
        let guard = lock.lock().await;
        let Some(mut session) = self.sessions.read().await.get(&key).cloned() else {
            drop(guard);
            drop(lock);
            return;
        };
        session.users = session.users.saturating_sub(1);
        if session.users > 0 {
            self.sessions.write().await.insert(key, session);
            drop(guard);
            drop(lock);
            return;
        }
        self.sessions.write().await.remove(&key);
        let namespace = session.namespace.clone();
        let pod = session.pod.clone();
        drop(guard);
        drop(lock);

        if let Ok(client) = clusters.streaming_client(cluster_id).await {
            let pods: Api<Pod> = Api::namespaced(client, &namespace);
            let _ = delete_node_shell_pod(&pods, &pod).await;
        }
    }

    pub async fn stop_cluster(&self, clusters: &ClusterRegistry, cluster_id: &str) {
        let nodes = self
            .sessions
            .read()
            .await
            .values()
            .filter(|session| session.cluster_id == cluster_id)
            .map(|session| session.node.clone())
            .collect::<Vec<_>>();
        for node in nodes {
            self.stop(clusters, cluster_id, &node).await;
        }
    }
}

/// Reuses a healthy helper Pod left behind by an earlier session (for example
/// after the app restarted and the session registry was rebuilt) instead of
/// starting a fresh image pull.
async fn find_existing_helper_pod(pods: &Api<Pod>, node: &str) -> Result<Option<String>, String> {
    let selector =
        format!("app.kubernetes.io/component={NODE_FILES_COMPONENT_LABEL},kubehive.io/node={node}");
    let listed = pods
        .list(&ListParams::default().labels(&selector))
        .await
        .map_err(|error| format!("Unable to search for an existing node file Pod: {error}"))?;
    for pod in listed.items {
        if pod_running_ready(&pod) {
            if let Some(name) = pod.metadata.name {
                return Ok(Some(name));
            }
        }
    }
    Ok(None)
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
            users: 1,
        });
        assert!(target.host_root);
        assert_eq!(target.container.as_deref(), Some("shell"));
        assert_eq!(target.pod, "kubehive-node-files-node-1-abc");
    }
}
