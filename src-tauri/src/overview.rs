use crate::{
    models::{ClusterOverview, NodeUsage, OverviewEvent, ResourceRecord, WorkloadHealth},
    registry::ClusterRegistry,
};
use chrono::{DateTime, Utc};
use k8s_openapi::api::{
    apps::v1::{DaemonSet, Deployment, StatefulSet},
    core::v1::{Event, Node, PersistentVolume, Pod},
};
use kube::{
    api::{Api, DynamicObject, ListParams},
    core::{ApiResource, GroupVersionKind},
    ResourceExt,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

pub async fn cluster_overview(
    registry: &ClusterRegistry,
    cluster_id: &str,
) -> Result<ClusterOverview, String> {
    let client = registry.client(cluster_id).await?;
    let nodes_api: Api<Node> = Api::all(client.clone());
    let pods_api: Api<Pod> = Api::all(client.clone());
    let events_api: Api<Event> = Api::all(client.clone());
    let deployments_api: Api<Deployment> = Api::all(client.clone());
    let statefulsets_api: Api<StatefulSet> = Api::all(client.clone());
    let daemonsets_api: Api<DaemonSet> = Api::all(client.clone());
    let volumes_api: Api<PersistentVolume> = Api::all(client.clone());
    let list_params = ListParams::default();

    let (nodes, pods, events, deployments, statefulsets, daemonsets, volumes, version) = tokio::join!(
        nodes_api.list(&list_params),
        pods_api.list(&list_params),
        events_api.list(&list_params),
        deployments_api.list(&list_params),
        statefulsets_api.list(&list_params),
        daemonsets_api.list(&list_params),
        volumes_api.list(&list_params),
        client.apiserver_version(),
    );
    let nodes = nodes.map_err(|error| error.to_string())?.items;
    let pods = pods.map_err(|error| error.to_string())?.items;
    let events = events.map(|list| list.items).unwrap_or_default();
    let deployments = deployments.map(|list| list.items).unwrap_or_default();
    let statefulsets = statefulsets.map(|list| list.items).unwrap_or_default();
    let daemonsets = daemonsets.map(|list| list.items).unwrap_or_default();
    let volumes = volumes.map(|list| list.items).unwrap_or_default();
    let version = version
        .map(|info| info.git_version)
        .unwrap_or_else(|_| "unknown".into());

    let metrics = node_metrics(client).await.unwrap_or_default();
    let mut total_cpu = 0.0;
    let mut used_cpu = 0.0;
    let mut total_memory = 0.0;
    let mut used_memory = 0.0;
    let mut pod_capacity = 0u32;
    let mut node_usage = Vec::new();
    for node in &nodes {
        let capacity = node
            .status
            .as_ref()
            .and_then(|status| status.capacity.as_ref());
        let cpu_capacity = capacity
            .and_then(|values| values.get("cpu"))
            .and_then(|value| parse_cpu(&value.0));
        let memory_capacity = capacity
            .and_then(|values| values.get("memory"))
            .and_then(|value| parse_bytes(&value.0));
        pod_capacity += capacity
            .and_then(|values| values.get("pods"))
            .and_then(|value| value.0.parse::<u32>().ok())
            .unwrap_or(0);
        total_cpu += cpu_capacity.unwrap_or(0.0);
        total_memory += memory_capacity.unwrap_or(0.0);
        let usage = metrics.get(&node.name_any());
        let cpu_used = usage
            .and_then(|value| value.get("cpu"))
            .and_then(|value| parse_cpu(value));
        let memory_used = usage
            .and_then(|value| value.get("memory"))
            .and_then(|value| parse_bytes(value));
        used_cpu += cpu_used.unwrap_or(0.0);
        used_memory += memory_used.unwrap_or(0.0);
        node_usage.push(NodeUsage {
            name: node.name_any(),
            cpu_percent: ratio_percent(cpu_used, cpu_capacity),
            memory_percent: ratio_percent(memory_used, memory_capacity),
            ready: node_ready(node),
        });
    }
    node_usage.sort_by(|left, right| left.name.cmp(&right.name));

    let running_pods = pods
        .iter()
        .filter(|pod| {
            pod.status
                .as_ref()
                .and_then(|status| status.phase.as_deref())
                == Some("Running")
        })
        .count() as u32;
    let issues = pods
        .iter()
        .filter(|pod| pod_has_issue(pod))
        .take(20)
        .filter_map(|pod| record_from_typed(pod, "v1", "Pod", true))
        .collect::<Vec<_>>();
    let workload_health = workload_health(&deployments, &statefulsets, &daemonsets);
    let storage_capacity_bytes = volumes
        .iter()
        .filter_map(|volume| volume.spec.as_ref()?.capacity.as_ref()?.get("storage"))
        .filter_map(|quantity| parse_bytes(&quantity.0))
        .sum::<f64>() as u64;
    let storage_bytes = volumes
        .iter()
        .filter(|volume| {
            volume
                .status
                .as_ref()
                .and_then(|status| status.phase.as_deref())
                == Some("Bound")
        })
        .filter_map(|volume| volume.spec.as_ref()?.capacity.as_ref()?.get("storage"))
        .filter_map(|quantity| parse_bytes(&quantity.0))
        .sum::<f64>() as u64;

    let mut overview_events = events
        .into_iter()
        .map(event_to_overview)
        .collect::<Vec<_>>();
    overview_events.sort_by(|left, right| right.time.cmp(&left.time));
    overview_events.truncate(20);

    Ok(ClusterOverview {
        cluster_id: cluster_id.into(),
        version,
        nodes: nodes.len() as u32,
        ready_nodes: nodes.iter().filter(|node| node_ready(node)).count() as u32,
        cpu_percent: ratio_percent(Some(used_cpu), Some(total_cpu)),
        memory_percent: ratio_percent(Some(used_memory), Some(total_memory)),
        pods: pods.len() as u32,
        running_pods,
        pod_capacity,
        storage_bytes,
        storage_capacity_bytes,
        workload_health,
        node_usage,
        issues,
        events: overview_events,
        updated_at: Utc::now().to_rfc3339(),
    })
}

async fn node_metrics(
    client: kube::Client,
) -> Result<HashMap<String, HashMap<String, String>>, String> {
    let gvk = GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "NodeMetrics");
    let resource = ApiResource::from_gvk_with_plural(&gvk, "nodes");
    let api: Api<DynamicObject> = Api::all_with(client, &resource);
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|error| error.to_string())?;
    Ok(list
        .items
        .into_iter()
        .map(|item| {
            let usage = item
                .data
                .pointer("/usage")
                .and_then(Value::as_object)
                .map(|object| {
                    object
                        .iter()
                        .filter_map(|(key, value)| {
                            value.as_str().map(|value| (key.clone(), value.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            (item.name_any(), usage)
        })
        .collect())
}

fn workload_health(
    deployments: &[Deployment],
    statefulsets: &[StatefulSet],
    daemonsets: &[DaemonSet],
) -> WorkloadHealth {
    let mut health = WorkloadHealth::default();
    for item in deployments {
        let desired = item
            .spec
            .as_ref()
            .and_then(|spec| spec.replicas)
            .unwrap_or(1);
        let ready = item
            .status
            .as_ref()
            .and_then(|status| status.ready_replicas)
            .unwrap_or(0);
        record_health(
            &mut health,
            desired,
            ready,
            item.metadata.deletion_timestamp.is_some(),
        );
    }
    for item in statefulsets {
        let desired = item
            .spec
            .as_ref()
            .and_then(|spec| spec.replicas)
            .unwrap_or(1);
        let ready = item
            .status
            .as_ref()
            .and_then(|status| status.ready_replicas)
            .unwrap_or(0);
        record_health(
            &mut health,
            desired,
            ready,
            item.metadata.deletion_timestamp.is_some(),
        );
    }
    for item in daemonsets {
        let desired = item
            .status
            .as_ref()
            .map(|status| status.desired_number_scheduled)
            .unwrap_or(0);
        let ready = item
            .status
            .as_ref()
            .map(|status| status.number_ready)
            .unwrap_or(0);
        record_health(
            &mut health,
            desired,
            ready,
            item.metadata.deletion_timestamp.is_some(),
        );
    }
    health
}

fn record_health(health: &mut WorkloadHealth, desired: i32, ready: i32, deleting: bool) {
    health.total += 1;
    if deleting || (desired > 0 && ready == 0) {
        health.failed += 1;
    } else if ready < desired {
        health.degraded += 1;
    } else {
        health.healthy += 1;
    }
}

fn pod_has_issue(pod: &Pod) -> bool {
    let phase = pod
        .status
        .as_ref()
        .and_then(|status| status.phase.as_deref())
        .unwrap_or("Unknown");
    if !matches!(phase, "Running" | "Succeeded") {
        return true;
    }
    pod.status
        .as_ref()
        .and_then(|status| status.container_statuses.as_ref())
        .map(|statuses| statuses.iter().any(|status| !status.ready))
        .unwrap_or(false)
}

fn record_from_typed<T: Serialize + ResourceExt>(
    object: &T,
    api_version: &str,
    kind: &str,
    namespaced: bool,
) -> Option<ResourceRecord> {
    let name = object.name_any();
    let namespace = object.namespace().unwrap_or_else(|| "—".into());
    let metadata = object.meta();
    let created_at = metadata
        .creation_timestamp
        .as_ref()
        .map(|time| time.0.to_rfc3339());
    let age_seconds = metadata
        .creation_timestamp
        .as_ref()
        .map(|time| (Utc::now() - time.0).num_seconds().max(0));
    let mut value = serde_json::to_value(object).ok()?;
    if let Some(metadata) = value
        .pointer_mut("/metadata")
        .and_then(Value::as_object_mut)
    {
        metadata.remove("managedFields");
    }
    Some(ResourceRecord {
        key: if namespaced {
            format!("{namespace}/{name}")
        } else {
            name.clone()
        },
        name,
        namespace,
        uid: metadata.uid.clone(),
        resource_version: metadata.resource_version.clone(),
        api_version: api_version.into(),
        kind: kind.into(),
        created_at,
        age_seconds,
        object: value,
    })
}

fn event_to_overview(event: Event) -> OverviewEvent {
    let involved = &event.involved_object;
    let object = format!(
        "{}/{}",
        involved
            .kind
            .as_deref()
            .unwrap_or("Object")
            .to_ascii_lowercase(),
        involved.name.as_deref().unwrap_or("unknown")
    );
    let timestamp: Option<DateTime<Utc>> = event
        .event_time
        .map(|time| time.0)
        .or_else(|| event.last_timestamp.map(|time| time.0))
        .or_else(|| event.metadata.creation_timestamp.map(|time| time.0));
    OverviewEvent {
        level: if event.type_.as_deref() == Some("Warning") {
            "warning".into()
        } else {
            "normal".into()
        },
        reason: event.reason.unwrap_or_else(|| "Event".into()),
        object,
        message: event.message.unwrap_or_default(),
        time: timestamp.map(relative_time).unwrap_or_else(|| "now".into()),
    }
}

fn relative_time(time: DateTime<Utc>) -> String {
    let seconds = (Utc::now() - time).num_seconds().max(0);
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3600 {
        format!("{}m", seconds / 60)
    } else if seconds < 86_400 {
        format!("{}h", seconds / 3600)
    } else {
        format!("{}d", seconds / 86_400)
    }
}

fn node_ready(node: &Node) -> bool {
    node.status
        .as_ref()
        .and_then(|status| status.conditions.as_ref())
        .map(|conditions| {
            conditions
                .iter()
                .any(|condition| condition.type_ == "Ready" && condition.status == "True")
        })
        .unwrap_or(false)
}

fn ratio_percent(used: Option<f64>, total: Option<f64>) -> Option<u8> {
    let (Some(used), Some(total)) = (used, total) else {
        return None;
    };
    if total <= 0.0 {
        return None;
    }
    Some(((used / total) * 100.0).round().clamp(0.0, 100.0) as u8)
}

fn parse_cpu(value: &str) -> Option<f64> {
    if let Some(value) = value.strip_suffix('n') {
        return value
            .parse::<f64>()
            .ok()
            .map(|value| value / 1_000_000_000.0);
    }
    if let Some(value) = value.strip_suffix('u') {
        return value.parse::<f64>().ok().map(|value| value / 1_000_000.0);
    }
    if let Some(value) = value.strip_suffix('m') {
        return value.parse::<f64>().ok().map(|value| value / 1_000.0);
    }
    value.parse().ok()
}

fn parse_bytes(value: &str) -> Option<f64> {
    const UNITS: [(&str, f64); 10] = [
        ("Ei", 1_152_921_504_606_846_976.0),
        ("Pi", 1_125_899_906_842_624.0),
        ("Ti", 1_099_511_627_776.0),
        ("Gi", 1_073_741_824.0),
        ("Mi", 1_048_576.0),
        ("Ki", 1024.0),
        ("E", 1e18),
        ("P", 1e15),
        ("T", 1e12),
        ("G", 1e9),
    ];
    for (suffix, multiplier) in UNITS {
        if let Some(number) = value.strip_suffix(suffix) {
            return number.parse::<f64>().ok().map(|number| number * multiplier);
        }
    }
    if let Some(number) = value.strip_suffix('M') {
        return number.parse::<f64>().ok().map(|number| number * 1e6);
    }
    if let Some(number) = value.strip_suffix('K') {
        return number.parse::<f64>().ok().map(|number| number * 1e3);
    }
    value.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_kubernetes_quantities() {
        assert_eq!(parse_cpu("250m"), Some(0.25));
        assert_eq!(parse_cpu("100000000n"), Some(0.1));
        assert_eq!(parse_bytes("1Gi"), Some(1_073_741_824.0));
        assert_eq!(parse_bytes("512Mi"), Some(536_870_912.0));
    }

    #[test]
    fn percentages_are_bounded() {
        assert_eq!(ratio_percent(Some(8.0), Some(4.0)), Some(100));
        assert_eq!(ratio_percent(None, Some(4.0)), None);
    }
}
