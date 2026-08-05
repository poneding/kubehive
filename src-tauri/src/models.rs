use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    pub name: &'static str,
    pub runtime: &'static str,
    pub kubernetes_client: &'static str,
    pub mode: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterSummary {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub region: String,
    pub version: String,
    pub status: String,
    pub nodes: u32,
    pub cpu: u8,
    pub memory: u8,
    pub context: String,
    pub server: String,
    pub default_namespace: String,
    pub imported: bool,
    pub source_path: Option<String>,
    pub disconnected: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportClusterRequest {
    pub display_name: Option<String>,
    pub kubeconfig_yaml: Option<String>,
    pub server: Option<String>,
    pub token: Option<String>,
    #[serde(default)]
    pub insecure_skip_tls_verify: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameClusterRequest {
    pub cluster_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameClusterResult {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ApiResourceDescriptor {
    pub api_version: String,
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub namespaced: bool,
    pub verbs: Vec<String>,
    #[serde(default)]
    pub categories: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceListRequest {
    pub cluster_id: String,
    pub resource: ApiResourceDescriptor,
    pub namespace: Option<String>,
    pub label_selector: Option<String>,
    pub field_selector: Option<String>,
    #[serde(default)]
    pub resource_version: Option<String>,
    #[serde(default)]
    pub compact: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodMetricsRequest {
    pub cluster_id: String,
    pub namespace: String,
    pub pod: String,
    pub range_hours: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodMetricPoint {
    pub timestamp: i64,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodMetricSeries {
    pub id: String,
    pub label: String,
    pub unit: String,
    pub points: Vec<PodMetricPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodMetricsResponse {
    pub provider: String,
    pub range_hours: u8,
    pub step_seconds: u32,
    pub series: HashMap<String, Vec<PodMetricSeries>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceTarget {
    pub cluster_id: String,
    pub resource: ApiResourceDescriptor,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRecord {
    pub key: String,
    pub name: String,
    pub namespace: String,
    pub uid: Option<String>,
    pub resource_version: Option<String>,
    pub api_version: String,
    pub kind: String,
    pub created_at: Option<String>,
    pub age_seconds: Option<i64>,
    pub object: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceListResponse {
    pub resource_version: String,
    pub items: Vec<ResourceRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDetail {
    #[serde(flatten)]
    pub record: ResourceRecord,
    pub manifest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceWatchEvent {
    pub event_type: String,
    pub resource: ResourceRecord,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceWatchMessage {
    pub subscription_id: String,
    pub event_type: String,
    pub events: Vec<ResourceWatchEvent>,
    pub resources: Vec<ResourceRecord>,
    pub resource_version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ManifestFormat {
    #[default]
    Yaml,
    Json,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyManifestRequest {
    pub cluster_id: String,
    pub manifest: String,
    #[serde(default)]
    pub format: ManifestFormat,
    pub resource: Option<ApiResourceDescriptor>,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResourceRequest {
    #[serde(flatten)]
    pub target: ResourceTarget,
    #[serde(default)]
    pub foreground: bool,
    #[serde(default)]
    pub grace_period_seconds: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaleResourceRequest {
    #[serde(flatten)]
    pub target: ResourceTarget,
    pub replicas: i32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvictPodRequest {
    pub cluster_id: String,
    pub namespace: String,
    pub pod: String,
    #[serde(default)]
    pub grace_period_seconds: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkDeleteResourcesRequest {
    pub targets: Vec<DeleteResourceRequest>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkEvictPodsRequest {
    pub pods: Vec<EvictPodRequest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkActionFailure {
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkActionResult {
    pub requested: usize,
    pub succeeded: usize,
    pub failures: Vec<BulkActionFailure>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodLogsRequest {
    pub cluster_id: String,
    pub namespace: String,
    pub pod: String,
    pub container: Option<String>,
    pub tail_lines: Option<i64>,
    pub since_seconds: Option<i64>,
    #[serde(default = "default_true")]
    pub timestamps: bool,
    #[serde(default)]
    pub previous: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadLogsRequest {
    pub content: String,
    pub pod: String,
    pub container: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecPodRequest {
    pub cluster_id: String,
    pub namespace: String,
    pub pod: String,
    pub container: Option<String>,
    pub command: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerFileTarget {
    pub cluster_id: String,
    pub namespace: String,
    pub pod: String,
    pub container: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerPathRequest {
    #[serde(flatten)]
    pub target: ContainerFileTarget,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerBatchPathRequest {
    #[serde(flatten)]
    pub target: ContainerFileTarget,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerWriteTextRequest {
    #[serde(flatten)]
    pub target: ContainerFileTarget,
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerUploadRequest {
    #[serde(flatten)]
    pub target: ContainerFileTarget,
    pub path: String,
    pub data: Vec<u8>,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRenameRequest {
    #[serde(flatten)]
    pub target: ContainerFileTarget,
    pub path: String,
    pub new_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerTransferRequest {
    #[serde(flatten)]
    pub target: ContainerFileTarget,
    pub source_path: String,
    pub destination_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDownloadRequest {
    #[serde(flatten)]
    pub target: ContainerFileTarget,
    pub path: String,
    #[serde(default)]
    pub directory: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerBatchDownloadRequest {
    #[serde(flatten)]
    pub target: ContainerFileTarget,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDirectoryContext {
    pub work_dir: String,
    pub home_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerFileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: i64,
    pub permissions: String,
    pub readable: bool,
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerTextFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTerminalRequest {
    pub cluster_id: String,
    pub namespace: Option<String>,
    pub pod: Option<String>,
    pub container: Option<String>,
    /// When set, open a privileged host shell on this Node instead of a container exec.
    pub node: Option<String>,
    #[serde(default)]
    pub command: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEvent {
    pub session_id: String,
    pub event_type: String,
    pub data: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewEvent {
    pub level: String,
    pub reason: String,
    pub object: String,
    pub message: String,
    pub time: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadHealth {
    pub total: u32,
    pub healthy: u32,
    pub degraded: u32,
    pub failed: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeUsage {
    pub name: String,
    pub cpu_percent: Option<u8>,
    pub memory_percent: Option<u8>,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterOverview {
    pub cluster_id: String,
    pub version: String,
    pub nodes: u32,
    pub ready_nodes: u32,
    pub cpu_percent: Option<u8>,
    pub memory_percent: Option<u8>,
    pub pods: u32,
    pub running_pods: u32,
    pub pod_capacity: u32,
    pub storage_bytes: u64,
    pub storage_capacity_bytes: u64,
    pub workload_health: WorkloadHealth,
    pub node_usage: Vec<NodeUsage>,
    pub issues: Vec<ResourceRecord>,
    pub events: Vec<OverviewEvent>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmChartSummary {
    pub name: String,
    pub repository: String,
    pub version: String,
    pub app_version: String,
    pub description: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    pub enabled: bool,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PortForwardTargetKind {
    Pod,
    Service,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartPortForwardRequest {
    pub cluster_id: String,
    pub namespace: String,
    pub target_kind: PortForwardTargetKind,
    pub target_name: String,
    /// `0` requests an automatically allocated local port.
    #[serde(default)]
    pub local_port: u16,
    /// `localhost` binds only to the loopback interface; `0.0.0.0` listens on all interfaces.
    #[serde(default = "default_port_forward_host")]
    pub host: String,
    /// `http` / `https` describes the URL the desktop client should open. It does not terminate TLS.
    #[serde(default = "default_port_forward_protocol")]
    pub protocol: String,
    /// Pod port for a Pod target; Service port for a Service target.
    pub remote_port: u16,
}

fn default_port_forward_host() -> String {
    "localhost".into()
}

fn default_port_forward_protocol() -> String {
    "http".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardSession {
    pub id: String,
    pub cluster_id: String,
    pub namespace: String,
    pub target_kind: PortForwardTargetKind,
    pub target_name: String,
    /// The Pod that owns the Kubernetes port-forward stream. For Service targets
    /// this is the ready endpoint selected when the session starts.
    pub pod: String,
    pub host: String,
    /// The URL scheme selected by the user. The TCP proxy itself is protocol agnostic.
    pub protocol: String,
    pub local_port: u16,
    /// The port on the selected Pod.
    pub remote_port: u16,
    /// The selected Service port when the target is a Service.
    pub service_port: Option<u16>,
    pub status: String,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor() -> serde_json::Value {
        serde_json::json!({
            "apiVersion": "apps/v1", "group": "apps", "version": "v1", "kind": "Deployment",
            "plural": "deployments", "namespaced": true, "verbs": ["patch", "delete"], "categories": []
        })
    }

    #[test]
    fn manifest_format_defaults_to_yaml_and_accepts_json() {
        let yaml: ApplyManifestRequest = serde_json::from_value(serde_json::json!({
            "clusterId": "cluster", "manifest": "apiVersion: v1", "resource": null
        }))
        .unwrap();
        assert_eq!(yaml.format, ManifestFormat::Yaml);

        let json: ApplyManifestRequest = serde_json::from_value(serde_json::json!({
            "clusterId": "cluster", "manifest": "{}", "format": "json", "resource": null
        }))
        .unwrap();
        assert_eq!(json.format, ManifestFormat::Json);

        assert!(
            serde_json::from_value::<ApplyManifestRequest>(serde_json::json!({
                "clusterId": "cluster", "manifest": "{}", "format": "toml", "resource": null
            }))
            .is_err()
        );
    }

    #[test]
    fn port_forward_payload_accepts_pod_and_service_targets() {
        let pod: StartPortForwardRequest = serde_json::from_value(serde_json::json!({
            "clusterId": "cluster", "namespace": "default", "targetKind": "pod",
            "targetName": "api-0", "localPort": 8080, "remotePort": 8080
        }))
        .unwrap();
        assert_eq!(pod.target_kind, PortForwardTargetKind::Pod);
        assert_eq!(pod.target_name, "api-0");
        assert_eq!(pod.host, "localhost");
        assert_eq!(pod.protocol, "http");

        let service: StartPortForwardRequest = serde_json::from_value(serde_json::json!({
            "clusterId": "cluster", "namespace": "default", "targetKind": "service",
            "targetName": "api", "localPort": 0, "host": "0.0.0.0", "protocol": "https", "remotePort": 80
        }))
        .unwrap();
        assert_eq!(service.target_kind, PortForwardTargetKind::Service);
        assert_eq!(service.host, "0.0.0.0");
        assert_eq!(service.protocol, "https");
        assert_eq!(service.remote_port, 80);
    }

    #[test]
    fn terminal_requests_support_local_container_and_node_sessions() {
        let local: StartTerminalRequest = serde_json::from_value(serde_json::json!({
            "clusterId": "cluster"
        }))
        .unwrap();
        assert_eq!(local.cluster_id, "cluster");
        assert_eq!(local.namespace, None);
        assert_eq!(local.pod, None);
        assert_eq!(local.node, None);

        let container: StartTerminalRequest = serde_json::from_value(serde_json::json!({
            "clusterId": "cluster", "namespace": "default", "pod": "api-abc", "container": "api", "command": ["sh"]
        }))
        .unwrap();
        assert_eq!(container.namespace.as_deref(), Some("default"));
        assert_eq!(container.pod.as_deref(), Some("api-abc"));
        assert_eq!(container.container.as_deref(), Some("api"));
        assert_eq!(container.node, None);
        assert_eq!(container.command, vec!["sh"]);

        let node: StartTerminalRequest = serde_json::from_value(serde_json::json!({
            "clusterId": "cluster", "node": "worker-1", "namespace": "default"
        }))
        .unwrap();
        assert_eq!(node.node.as_deref(), Some("worker-1"));
        assert_eq!(node.namespace.as_deref(), Some("default"));
        assert_eq!(node.pod, None);
    }

    #[test]
    fn flattened_action_payloads_match_typescript_ipc() {
        let delete: DeleteResourceRequest = serde_json::from_value(serde_json::json!({
            "clusterId": "cluster", "resource": descriptor(), "namespace": "default", "name": "api",
            "foreground": false, "gracePeriodSeconds": 5
        }))
        .unwrap();
        assert_eq!(delete.target.name, "api");
        assert_eq!(delete.grace_period_seconds, Some(5));

        let scale: ScaleResourceRequest = serde_json::from_value(serde_json::json!({
            "clusterId": "cluster", "resource": descriptor(), "namespace": "default", "name": "api", "replicas": 4
        })).unwrap();
        assert_eq!(scale.replicas, 4);
        assert_eq!(scale.target.resource.plural, "deployments");

        let eviction: EvictPodRequest = serde_json::from_value(serde_json::json!({
            "clusterId": "cluster", "namespace": "default", "pod": "api-abc", "gracePeriodSeconds": 30
        }))
        .unwrap();
        assert_eq!(eviction.pod, "api-abc");
        assert_eq!(eviction.grace_period_seconds, Some(30));

        let bulk_delete: BulkDeleteResourcesRequest = serde_json::from_value(serde_json::json!({
            "targets": [{
                "clusterId": "cluster", "resource": descriptor(), "namespace": "default", "name": "api",
                "foreground": false
            }]
        }))
        .unwrap();
        assert_eq!(bulk_delete.targets.len(), 1);
        assert_eq!(bulk_delete.targets[0].target.name, "api");

        let bulk_evict: BulkEvictPodsRequest = serde_json::from_value(serde_json::json!({
            "pods": [{"clusterId": "cluster", "namespace": "default", "pod": "api-abc"}]
        }))
        .unwrap();
        assert_eq!(bulk_evict.pods.len(), 1);
    }
}
