use crate::{
    models::{
        AddNodeTaintRequest, DrainNodeRequest, DrainNodeResult, NodeTaintInfo,
        RemoveNodeTaintRequest,
    },
    registry::ClusterRegistry,
};
use k8s_openapi::api::core::v1::{Node, Pod, Taint};
use kube::api::{Api, DeleteParams, EvictParams, ListParams, Patch, PatchParams};
use serde_json::json;
use std::time::{Duration, Instant};

const EVICTION_RETRY_DELAY: Duration = Duration::from_secs(5);
const DEFAULT_DRAIN_TIMEOUT_SECONDS: u32 = 300;
const MIRROR_POD_ANNOTATION: &str = "kubernetes.io/config.mirror";

fn kube_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Cordon (`unschedulable = true`) or uncordon (`unschedulable = false`) a Node.
pub async fn set_node_unschedulable(
    registry: &ClusterRegistry,
    cluster_id: &str,
    node: &str,
    unschedulable: bool,
) -> Result<(), String> {
    let node = node.trim();
    if node.is_empty() {
        return Err("A Node name is required".into());
    }
    let client = registry.client(cluster_id).await?;
    let nodes: Api<Node> = Api::all(client);
    let patch = json!({"spec": {"unschedulable": unschedulable}});
    nodes
        .patch(node, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .map_err(kube_error)?;
    Ok(())
}

/// Drains a Node following kubectl drain semantics: cordon the Node, filter
/// Pods (skipping mirror Pods and, when requested, DaemonSet-managed Pods),
/// evict or delete the rest, then wait for them to disappear. Like kubectl,
/// the Node stays cordoned after a successful drain — uncordon explicitly.
pub async fn drain_node(
    registry: &ClusterRegistry,
    request: DrainNodeRequest,
) -> Result<DrainNodeResult, String> {
    let node = request.node.trim();
    if node.is_empty() {
        return Err("A Node name is required".into());
    }
    set_node_unschedulable(registry, &request.cluster_id, node, true).await?;

    let client = registry.client(&request.cluster_id).await?;
    let pods: Api<Pod> = Api::all(client.clone());
    let listed = pods
        .list(&ListParams::default().fields(&format!("spec.nodeName={node}")))
        .await
        .map_err(kube_error)?;

    let (to_delete, skipped) = filter_pods_for_drain(&listed.items, &request)?;

    let mut failures = Vec::new();
    let mut evicted = 0_u32;
    let deadline = Instant::now()
        + Duration::from_secs(u64::from(
            request
                .timeout_seconds
                .unwrap_or(DEFAULT_DRAIN_TIMEOUT_SECONDS),
        ));
    for pod in &to_delete {
        match delete_or_evict_pod(&client, pod, &request, deadline).await {
            Ok(()) => evicted += 1,
            Err(error) => failures.push(format!(
                "{}/{}: {error}",
                pod.metadata.namespace.as_deref().unwrap_or(""),
                pod.metadata.name.as_deref().unwrap_or("")
            )),
        }
    }

    let remaining = if request.wait_for_deletion {
        wait_for_pods_gone(&client, &to_delete, deadline).await?
    } else {
        Vec::new()
    };

    Ok(DrainNodeResult {
        node: node.to_string(),
        evicted,
        skipped,
        failures,
        remaining,
    })
}

/// kubectl-compatible Pod filters. Returns the Pods to evict/delete and the
/// number of Pods intentionally skipped (DaemonSets when ignored, mirror Pods,
/// finished Pods). Any fatal condition aborts the drain, matching kubectl.
fn filter_pods_for_drain(
    items: &[Pod],
    request: &DrainNodeRequest,
) -> Result<(Vec<Pod>, u32), String> {
    let mut to_delete = Vec::new();
    let mut skipped = 0_u32;
    let mut fatal = Vec::new();
    for pod in items {
        match drain_pod_filter(pod, request) {
            DrainPodDecision::Delete => to_delete.push(pod.clone()),
            DrainPodDecision::Skip => skipped += 1,
            DrainPodDecision::Fatal(message) => fatal.push((message, pod)),
        }
    }
    if fatal.is_empty() {
        return Ok((to_delete, skipped));
    }
    let mut by_message: Vec<(String, Vec<String>)> = Vec::new();
    for (message, pod) in fatal {
        let names = format!(
            "{}/{}",
            pod.metadata.namespace.as_deref().unwrap_or(""),
            pod.metadata.name.as_deref().unwrap_or("")
        );
        if let Some(entry) = by_message
            .iter_mut()
            .find(|(existing, _)| *existing == message)
        {
            entry.1.push(names);
        } else {
            by_message.push((message, vec![names]));
        }
    }
    Err(by_message
        .into_iter()
        .map(|(message, names)| format!("cannot delete {message}: {}", names.join(", ")))
        .collect::<Vec<_>>()
        .join("; "))
}

enum DrainPodDecision {
    Delete,
    Skip,
    Fatal(String),
}

fn drain_pod_filter(pod: &Pod, request: &DrainNodeRequest) -> DrainPodDecision {
    let finished = pod
        .status
        .as_ref()
        .and_then(|status| status.phase.as_deref())
        .is_some_and(|phase| matches!(phase, "Succeeded" | "Failed"));

    let controller = pod
        .metadata
        .owner_references
        .as_ref()
        .into_iter()
        .flatten()
        .find(|owner| owner.controller == Some(true))
        .or_else(|| {
            pod.metadata
                .owner_references
                .as_ref()
                .into_iter()
                .flatten()
                .next()
        });

    if controller.is_some_and(|owner| owner.kind == "DaemonSet") && !finished {
        return if request.ignore_daemonsets {
            DrainPodDecision::Skip
        } else {
            DrainPodDecision::Fatal(
                "DaemonSet-managed Pods (use --ignore-daemonsets to ignore)".into(),
            )
        };
    }

    if pod
        .metadata
        .annotations
        .as_ref()
        .is_some_and(|annotations| annotations.contains_key(MIRROR_POD_ANNOTATION))
    {
        return DrainPodDecision::Skip;
    }

    let has_empty_dir = pod.spec.as_ref().is_some_and(|spec| {
        spec.volumes
            .iter()
            .flatten()
            .any(|volume| volume.empty_dir.is_some())
    });
    if has_empty_dir && !finished && !request.delete_emptydir_data && !request.force {
        return DrainPodDecision::Fatal(
            "Pods with local storage (use --delete-emptydir-data to override)".into(),
        );
    }

    if controller.is_none() && !finished && !request.force {
        return DrainPodDecision::Fatal(
            "cannot delete Pods that declare no controller (use --force to override)".into(),
        );
    }

    DrainPodDecision::Delete
}

async fn delete_or_evict_pod(
    client: &kube::Client,
    pod: &Pod,
    request: &DrainNodeRequest,
    deadline: Instant,
) -> Result<(), String> {
    let namespace = pod
        .metadata
        .namespace
        .clone()
        .unwrap_or_else(|| "default".into());
    let name = pod
        .metadata
        .name
        .clone()
        .ok_or_else(|| "Pod has no name".to_string())?;
    let namespaced: Api<Pod> = Api::namespaced(client.clone(), &namespace);

    let grace = request
        .grace_period_seconds
        .map(|seconds| DeleteParams::default().grace_period(seconds));

    loop {
        let outcome = if request.disable_eviction {
            let params = grace.clone().unwrap_or_default();
            match namespaced.delete(&name, &params).await {
                Ok(_) => Ok(()),
                Err(error) => Err(error),
            }
        } else {
            let params = EvictParams {
                delete_options: grace.clone(),
                ..Default::default()
            };
            match namespaced.evict(&name, &params).await {
                Ok(_) => Ok(()),
                Err(error) => Err(error),
            }
        };
        match outcome {
            Ok(()) => return Ok(()),
            Err(kube::Error::Api(response)) if response.code == 404 => return Ok(()),
            Err(kube::Error::Api(response))
                if response.code == 429 && Instant::now() < deadline =>
            {
                tokio::time::sleep(EVICTION_RETRY_DELAY).await;
            }
            Err(error) => return Err(kube_error(error)),
        }
    }
}

async fn wait_for_pods_gone(
    client: &kube::Client,
    selected: &[Pod],
    deadline: Instant,
) -> Result<Vec<String>, String> {
    let mut remaining: Vec<String> = selected
        .iter()
        .map(|pod| {
            format!(
                "{}/{}",
                pod.metadata.namespace.as_deref().unwrap_or(""),
                pod.metadata.name.as_deref().unwrap_or("")
            )
        })
        .collect();
    loop {
        if remaining.is_empty() || Instant::now() >= deadline {
            return Ok(remaining);
        }
        let mut still_here = Vec::new();
        for name in &remaining {
            let (namespace, pod_name) = name.split_once('/').unwrap_or(("", name.as_str()));
            let namespaced: Api<Pod> = Api::namespaced(client.clone(), namespace);
            let gone = pod_is_gone(namespaced.get_opt(pod_name).await.map_err(kube_error))
                .map_err(|error| {
                    format!("Unable to verify that Pod {name} was deleted: {error}")
                })?;
            if !gone {
                still_here.push(name.clone());
            }
        }
        remaining = still_here;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

fn pod_is_gone(result: Result<Option<Pod>, String>) -> Result<bool, String> {
    match result {
        Ok(None) => Ok(true),
        Ok(Some(_)) => Ok(false),
        Err(error) => Err(error),
    }
}

/// Reads the current taints of a Node as a plain, sorted list.
pub async fn list_node_taints(
    registry: &ClusterRegistry,
    cluster_id: &str,
    node: &str,
) -> Result<Vec<NodeTaintInfo>, String> {
    let node_object = get_node(registry, cluster_id, node).await?;
    Ok(taint_infos(&node_object))
}

/// Adds a taint (`key=value:effect`) unless an identical key/effect already
/// exists, and returns the updated taint list.
pub async fn add_node_taint(
    registry: &ClusterRegistry,
    request: AddNodeTaintRequest,
) -> Result<Vec<NodeTaintInfo>, String> {
    validate_taint(&request.key, &request.value, &request.effect)?;
    let node_object = get_node(registry, &request.cluster_id, &request.node).await?;
    let mut taints = node_object
        .spec
        .as_ref()
        .and_then(|spec| spec.taints.clone())
        .unwrap_or_default();
    if taints
        .iter()
        .any(|taint| taint.key == request.key && taint.effect == request.effect)
    {
        return Err(format!(
            "The Node already has taint {}{}:{}",
            request.key,
            if request.value.is_empty() {
                String::new()
            } else {
                format!("={}", request.value)
            },
            request.effect
        ));
    }
    taints.push(Taint {
        key: request.key.clone(),
        value: if request.value.is_empty() {
            None
        } else {
            Some(request.value.clone())
        },
        effect: request.effect,
        time_added: None,
    });
    let patched = patch_node_taints(registry, &request.cluster_id, &request.node, &taints).await?;
    Ok(taint_infos(&patched))
}

/// Removes a taint by key (optionally also matching its effect) and returns
/// the updated taint list.
pub async fn remove_node_taint(
    registry: &ClusterRegistry,
    request: RemoveNodeTaintRequest,
) -> Result<Vec<NodeTaintInfo>, String> {
    let node_object = get_node(registry, &request.cluster_id, &request.node).await?;
    let taints = node_object
        .spec
        .as_ref()
        .and_then(|spec| spec.taints.clone())
        .unwrap_or_default();
    let taints = retain_taints_for_removal(&taints, &request.key, request.effect.as_deref());
    if taints.len() == taints_before(&node_object) {
        return Err(format!(
            "The Node has no matching taint {}{}",
            request.key,
            request
                .effect
                .as_deref()
                .map(|effect| format!(":{effect}"))
                .unwrap_or_default()
        ));
    }
    let patched = patch_node_taints(registry, &request.cluster_id, &request.node, &taints).await?;
    Ok(taint_infos(&patched))
}

fn taints_before(node: &Node) -> usize {
    node.spec
        .as_ref()
        .and_then(|spec| spec.taints.as_ref())
        .map(|taints| taints.len())
        .unwrap_or(0)
}

/// Keeps every taint except those whose key matches `key` and, when `effect`
/// is set, whose effect also matches.
fn retain_taints_for_removal(taints: &[Taint], key: &str, effect: Option<&str>) -> Vec<Taint> {
    taints
        .iter()
        .filter(|taint| taint.key != key || effect.is_some_and(|effect| taint.effect != effect))
        .cloned()
        .collect()
}

async fn get_node(
    registry: &ClusterRegistry,
    cluster_id: &str,
    node: &str,
) -> Result<Node, String> {
    let node = node.trim();
    if node.is_empty() {
        return Err("A Node name is required".into());
    }
    let client = registry.client(cluster_id).await?;
    let nodes: Api<Node> = Api::all(client);
    nodes.get(node).await.map_err(kube_error)
}

async fn patch_node_taints(
    registry: &ClusterRegistry,
    cluster_id: &str,
    node: &str,
    taints: &[Taint],
) -> Result<Node, String> {
    let client = registry.client(cluster_id).await?;
    let nodes: Api<Node> = Api::all(client);
    let patch = json!({"spec": {"taints": taints}});
    nodes
        .patch(node, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .map_err(kube_error)
}

fn taint_infos(node: &Node) -> Vec<NodeTaintInfo> {
    let mut taints = node
        .spec
        .as_ref()
        .and_then(|spec| spec.taints.as_ref())
        .into_iter()
        .flatten()
        .map(|taint| NodeTaintInfo {
            key: taint.key.clone(),
            value: taint.value.clone().unwrap_or_default(),
            effect: taint.effect.clone(),
            time_added: taint.time_added.clone().map(|time| time.0.to_rfc3339()),
        })
        .collect::<Vec<_>>();
    taints.sort_by(|left, right| {
        left.key
            .cmp(&right.key)
            .then_with(|| left.effect.cmp(&right.effect))
    });
    taints
}

fn validate_taint(key: &str, value: &str, effect: &str) -> Result<(), String> {
    if !matches!(effect, "NoSchedule" | "PreferNoSchedule" | "NoExecute") {
        return Err(format!(
            "Taint effect must be NoSchedule, PreferNoSchedule or NoExecute, got {effect}"
        ));
    }
    validate_taint_key(key)?;
    if !value.is_empty() {
        validate_taint_value(value)?;
    }
    Ok(())
}

/// `prefix/name` where prefix is a DNS-1123 subdomain and name a DNS-1123
/// label (kubectl-compatible).
fn validate_taint_key(key: &str) -> Result<(), String> {
    let (prefix, name) = match key.split_once('/') {
        Some((prefix, name)) => (Some(prefix), name),
        None => (None, key),
    };
    if key.is_empty() || key.len() > 253 || name.is_empty() {
        return Err("Taint key must be `name` or `prefix/name` (at most 253 characters)".into());
    }
    if let Some(prefix) = prefix {
        if prefix.is_empty()
            || !prefix
                .split('.')
                .all(|segment| valid_label_segment(segment, 63))
        {
            return Err(format!(
                "Taint key prefix {prefix} is not a valid DNS subdomain"
            ));
        }
    }
    if !valid_label_segment(name, 63) {
        return Err(format!("Taint key name {name} is not a valid name segment"));
    }
    Ok(())
}

fn validate_taint_value(value: &str) -> Result<(), String> {
    let valid = value.len() <= 63
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'));
    if !valid {
        return Err(
            "Taint values are limited to 63 characters of letters, digits, '-', '_' and '.'".into(),
        );
    }
    Ok(())
}

fn valid_label_segment(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_filters_match_kubectl_semantics() {
        let request = DrainNodeRequest {
            cluster_id: "cluster".into(),
            node: "node-1".into(),
            ignore_daemonsets: true,
            delete_emptydir_data: false,
            force: false,
            grace_period_seconds: None,
            disable_eviction: false,
            wait_for_deletion: true,
            timeout_seconds: None,
        };
        let mirror = pod_with(
            Some("kube-system"),
            "mirror",
            None,
            None,
            "Running",
            Some("kubernetes.io/config.mirror"),
        );
        let daemon = pod_with(
            Some("default"),
            "daemon",
            Some("DaemonSet"),
            None,
            "Running",
            None,
        );
        let managed = pod_with(
            Some("default"),
            "managed",
            Some("Deployment"),
            None,
            "Running",
            None,
        );
        let finished = pod_with(Some("default"), "finished", None, None, "Succeeded", None);

        let (delete, skipped) =
            filter_pods_for_drain(&[mirror, daemon, managed, finished], &request).unwrap();
        assert_eq!(skipped, 2); // mirror + daemon
        let names = delete
            .iter()
            .map(|pod| pod.metadata.name.as_deref().unwrap_or("").to_string())
            .collect::<Vec<_>>();
        assert!(names.contains(&"managed".to_string()));
        assert!(names.contains(&"finished".to_string()));
        assert!(!names.contains(&"daemon".to_string()));
        assert!(!names.contains(&"mirror".to_string()));
    }

    #[test]
    fn drain_without_ignore_daemonsets_or_force_fails() {
        let request = DrainNodeRequest {
            cluster_id: "cluster".into(),
            node: "node-1".into(),
            ignore_daemonsets: false,
            delete_emptydir_data: false,
            force: false,
            grace_period_seconds: None,
            disable_eviction: false,
            wait_for_deletion: true,
            timeout_seconds: None,
        };
        let daemon = pod_with(
            Some("default"),
            "daemon",
            Some("DaemonSet"),
            None,
            "Running",
            None,
        );
        let error = filter_pods_for_drain(&[daemon], &request).unwrap_err();
        assert!(error.contains("DaemonSet-managed Pods"));
        assert!(error.contains("--ignore-daemonsets"));

        let request = DrainNodeRequest {
            force: false,
            delete_emptydir_data: false,
            ..request
        };
        let empty_dir = pod_with(
            Some("default"),
            "emptydir",
            Some("Deployment"),
            Some("empty-dir"),
            "Running",
            None,
        );
        let unmanaged = pod_with(Some("default"), "unmanaged", None, None, "Running", None);
        let error = filter_pods_for_drain(&[empty_dir, unmanaged], &request).unwrap_err();
        assert!(error.contains("local storage"));
        assert!(error.contains("--delete-emptydir-data"));
        assert!(error.contains("no controller"));
        assert!(error.contains("--force"));
    }

    #[test]
    fn force_and_flags_unblock_managed_emptydir_and_unmanaged_pods() {
        let request = DrainNodeRequest {
            cluster_id: "cluster".into(),
            node: "node-1".into(),
            ignore_daemonsets: true,
            delete_emptydir_data: true,
            force: true,
            grace_period_seconds: None,
            disable_eviction: false,
            wait_for_deletion: true,
            timeout_seconds: None,
        };
        let empty_dir = pod_with(
            Some("default"),
            "emptydir",
            Some("Deployment"),
            Some("empty-dir"),
            "Running",
            None,
        );
        let unmanaged = pod_with(Some("default"), "unmanaged", None, None, "Running", None);
        let (delete, skipped) = filter_pods_for_drain(&[empty_dir, unmanaged], &request).unwrap();
        assert_eq!(delete.len(), 2);
        assert_eq!(skipped, 0);
    }

    #[test]
    fn drain_observation_only_accepts_a_missing_pod_as_deleted() {
        assert!(pod_is_gone(Ok(None)).unwrap());
        assert!(!pod_is_gone(Ok(Some(Pod::default()))).unwrap());
        assert_eq!(
            pod_is_gone(Err("forbidden".into())).unwrap_err(),
            "forbidden"
        );
    }

    #[test]
    fn taint_key_and_value_validation() {
        assert!(validate_taint("app.example.com/dedicated", "", "NoSchedule").is_ok());
        assert!(validate_taint("dedicated", "gpu-1", "NoExecute").is_ok());
        assert!(validate_taint("", "", "NoSchedule").is_err());
        assert!(validate_taint("a/b/c", "", "NoSchedule").is_err());
        assert!(validate_taint("-leading", "", "NoSchedule").is_err());
        assert!(validate_taint("ok", "", "Sometimes").is_err());
        assert!(validate_taint("ok", "has space", "NoSchedule").is_err());
        assert!(validate_taint("ok", "", "NoSchedule").is_ok());
    }

    fn pod_with(
        namespace: Option<&str>,
        name: &str,
        owner_kind: Option<&str>,
        volume: Option<&str>,
        phase: &str,
        mirror_annotation: Option<&str>,
    ) -> Pod {
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, OwnerReference};
        use std::collections::BTreeMap;
        let mut annotations = BTreeMap::new();
        if let Some(value) = mirror_annotation {
            annotations.insert(value.to_string(), "true".into());
        }
        let volumes = volume.map(|name| {
            vec![k8s_openapi::api::core::v1::Volume {
                name: name.to_string(),
                empty_dir: Some(k8s_openapi::api::core::v1::EmptyDirVolumeSource::default()),
                ..Default::default()
            }]
        });
        Pod {
            metadata: ObjectMeta {
                namespace: namespace.map(str::to_string),
                name: Some(name.to_string()),
                annotations: Some(annotations),
                owner_references: owner_kind.map(|kind| {
                    vec![OwnerReference {
                        api_version: "apps/v1".into(),
                        kind: kind.into(),
                        name: format!("{name}-controller"),
                        uid: "uid-1".into(),
                        controller: Some(true),
                        block_owner_deletion: None,
                    }]
                }),
                ..Default::default()
            },
            spec: Some(k8s_openapi::api::core::v1::PodSpec {
                volumes,
                ..Default::default()
            }),
            status: Some(k8s_openapi::api::core::v1::PodStatus {
                phase: Some(phase.into()),
                ..Default::default()
            }),
        }
    }

    fn taint(key: &str, value: &str, effect: &str) -> Taint {
        Taint {
            key: key.into(),
            value: Some(value.into()),
            effect: effect.into(),
            time_added: None,
        }
    }

    #[test]
    fn taint_removal_filters_by_key_and_optional_effect() {
        let taints = vec![
            taint("dedicated", "gpu", "NoSchedule"),
            taint("dedicated", "gpu", "NoExecute"),
            taint("app", "", "NoSchedule"),
        ];
        // Effect omitted removes every taint with the key.
        let removed = retain_taints_for_removal(&taints, "dedicated", None);
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].key, "app");
        // Effect matched removes only the matching taint.
        let removed = retain_taints_for_removal(&taints, "dedicated", Some("NoSchedule"));
        assert_eq!(removed.len(), 2);
        assert!(removed
            .iter()
            .all(|taint| taint.key != "dedicated" || taint.effect == "NoExecute"));
        // Effect mismatched keeps every taint, so the caller reports "not found".
        let removed = retain_taints_for_removal(&taints, "dedicated", Some("PreferNoSchedule"));
        assert_eq!(removed.len(), taints.len());
        // Unknown key is a no-op.
        let removed = retain_taints_for_removal(&taints, "missing", None);
        assert_eq!(removed.len(), taints.len());
    }

    #[test]
    fn taint_info_rendering_is_sorted() {
        let node = Node {
            spec: Some(k8s_openapi::api::core::v1::NodeSpec {
                taints: Some(vec![
                    Taint {
                        key: "beta".into(),
                        value: Some("two".into()),
                        effect: "NoSchedule".into(),
                        time_added: None,
                    },
                    Taint {
                        key: "alpha".into(),
                        value: Some("one".into()),
                        effect: "NoExecute".into(),
                        time_added: None,
                    },
                ]),
                ..Default::default()
            }),
            ..Default::default()
        };
        let infos = taint_infos(&node);
        assert_eq!(infos[0].key, "alpha");
        assert_eq!(infos[0].effect, "NoExecute");
        assert_eq!(infos[1].key, "beta");
    }
}
