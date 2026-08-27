use crate::{
    models::{
        NodeMetricsRequest, NodeMetricsResponse, PodMetricPoint, PodMetricSeries,
        PodMetricsListRequest, PodMetricsListResponse, PodMetricsRequest, PodMetricsResponse,
        PodUsageEntry,
    },
    registry::ClusterRegistry,
};
use http::Request;
use kube::{
    api::{Api, ListParams},
    core::{ApiResource, DynamicObject, GroupVersionKind},
    Client, ResourceExt,
};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

const PROMETHEUS_PORT_NAMES: [&str; 3] = ["web", "http", "prometheus"];
const PROMETHEUS_CACHE_TTL: Duration = Duration::from_secs(60);

type ProviderCache = RwLock<HashMap<String, (Instant, Option<PrometheusService>)>>;

fn provider_cache() -> &'static Arc<ProviderCache> {
    static CACHE: std::sync::OnceLock<Arc<ProviderCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Arc::new(RwLock::new(HashMap::new())))
}

#[derive(Clone)]
struct PrometheusService {
    namespace: String,
    name: String,
    port: u16,
}

fn is_prometheus_service(service: &DynamicObject) -> bool {
    let labels = service.metadata.labels.as_ref();
    let app_name = labels
        .and_then(|values| values.get("app.kubernetes.io/name"))
        .map(String::as_str)
        .unwrap_or_default();
    let component = labels
        .and_then(|values| values.get("app.kubernetes.io/component"))
        .map(String::as_str)
        .unwrap_or_default();
    let managed_by = labels
        .and_then(|values| values.get("app.kubernetes.io/managed-by"))
        .map(String::as_str)
        .unwrap_or_default();
    let name = service.name_any().to_lowercase();
    app_name.eq_ignore_ascii_case("prometheus")
        || component.eq_ignore_ascii_case("prometheus")
        || name == "prometheus"
        || name == "prometheus-operated"
        || (managed_by.eq_ignore_ascii_case("prometheus-operator") && name.contains("prometheus"))
}

fn service_port(service: &DynamicObject) -> Option<u16> {
    service
        .data
        .pointer("/spec/ports")?
        .as_array()?
        .iter()
        .filter_map(|port| {
            let number = port
                .get("port")?
                .as_u64()
                .and_then(|value| u16::try_from(value).ok())?;
            let name = port.get("name").and_then(Value::as_str).unwrap_or_default();
            let preferred = PROMETHEUS_PORT_NAMES
                .iter()
                .any(|candidate| name.eq_ignore_ascii_case(candidate));
            Some((preferred, number))
        })
        .max_by_key(|(preferred, _)| *preferred)
        .map(|(_, port)| port)
}

async fn discover_prometheus(client: Client) -> Result<Option<PrometheusService>, String> {
    let gvk = GroupVersionKind::gvk("", "v1", "Service");
    let resource = ApiResource::from_gvk_with_plural(&gvk, "services");
    let api: Api<DynamicObject> = Api::all_with(client, &resource);
    let services = api
        .list(&ListParams::default())
        .await
        .map_err(|error| error.to_string())?;
    Ok(services.items.into_iter().find_map(|service| {
        if !is_prometheus_service(&service) {
            return None;
        }
        let namespace = service.namespace()?;
        let port = service_port(&service)?;
        Some(PrometheusService {
            namespace,
            name: service.name_any(),
            port,
        })
    }))
}

async fn cached_prometheus(
    client: Client,
    cluster_id: &str,
) -> Result<Option<PrometheusService>, String> {
    if let Some((created, provider)) = provider_cache().read().await.get(cluster_id) {
        if created.elapsed() < PROMETHEUS_CACHE_TTL {
            return Ok(provider.clone());
        }
    }
    let provider = discover_prometheus(client).await?;
    provider_cache()
        .write()
        .await
        .insert(cluster_id.to_string(), (Instant::now(), provider.clone()));
    Ok(provider)
}

fn query_escape(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char)
            }
            _ => result.push_str(&format!("%{byte:02X}")),
        }
    }
    result
}

async fn prometheus_query_range(
    client: &Client,
    service: &PrometheusService,
    query: &str,
    start: i64,
    end: i64,
    step: u32,
) -> Result<Value, String> {
    let path = format!(
        "/api/v1/namespaces/{}/services/http:{}:{}/proxy/api/v1/query_range?query={}&start={start}&end={end}&step={step}",
        service.namespace,
        service.name,
        service.port,
        query_escape(query),
    );
    let request = Request::builder()
        .uri(path)
        .body(Vec::new())
        .map_err(|error| error.to_string())?;
    client
        .request::<Value>(request)
        .await
        .map_err(|error| error.to_string())
}

fn parse_series(value: &Value, unit: &str) -> Vec<PodMetricSeries> {
    value
        .pointer("/data/result")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, item)| {
            let metric = item.get("metric").and_then(Value::as_object)?;
            let container = metric
                .get("container")
                .or_else(|| metric.get("device"))
                .or_else(|| metric.get("pod"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("Pod");
            let label = match (
                metric.get("direction").and_then(Value::as_str),
                metric.get("device").and_then(Value::as_str),
            ) {
                (Some(direction), Some(device)) => format!("{direction} · {device}"),
                (Some(direction), None) => direction.to_string(),
                (None, Some(device)) => device.to_string(),
                _ => container.to_string(),
            };
            let points = item
                .get("values")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|point| {
                    let pair = point.as_array()?;
                    let timestamp = pair.first()?.as_f64()? as i64;
                    let value = pair.get(1)?.as_str()?.parse::<f64>().ok()?;
                    value
                        .is_finite()
                        .then_some(PodMetricPoint { timestamp, value })
                })
                .collect::<Vec<_>>();
            (!points.is_empty()).then_some(PodMetricSeries {
                id: format!("{container}-{index}"),
                label,
                unit: unit.to_string(),
                points,
            })
        })
        .collect()
}

fn metric_queries(namespace: &str, pod: &str) -> [(&'static str, String, &'static str); 4] {
    let selector = format!(
        "namespace=\"{}\",pod=\"{}\"",
        namespace.replace('"', "\\\""),
        pod.replace('"', "\\\"")
    );
    [
        ("cpu", format!("sum by (container) (rate(container_cpu_usage_seconds_total{{{selector},container!=\"\",image!=\"\"}}[5m]))"), "cores"),
        ("memory", format!("sum by (container) (container_memory_working_set_bytes{{{selector},container!=\"\",image!=\"\"}})"), "bytes"),
        ("network", format!("sum by (direction) (label_replace(rate(container_network_receive_bytes_total{{{selector}}}[5m]), \"direction\", \"Receive\", \"pod\", \".*\") or label_replace(rate(container_network_transmit_bytes_total{{{selector}}}[5m]), \"direction\", \"Transmit\", \"pod\", \".*\"))"), "bytes/s"),
        ("filesystem", format!("sum by (container, device) (container_fs_usage_bytes{{{selector},container!=\"\"}})"), "bytes"),
    ]
}

fn escape_regex(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'.' | b'+' | b'*' | b'?' | b'(' | b')' | b'[' | b']' | b'{' | b'}' | b'|' | b'^'
            | b'$' | b'\\' => {
                result.push('\\');
                result.push(byte as char);
            }
            _ => result.push(byte as char),
        }
    }
    result
}

/// node_exporter series carry an `instance` label (usually `<ip>:9100`) rather
/// than the node name, so the node name must be resolved to instance matchers
/// before any metric query can be filtered. Resolution walks several sources
/// because node_exporter's `nodename` is the kernel hostname and kube-state-
/// metrics moved the node IP across metric versions.
async fn node_instance_selector(
    client: &Client,
    service: &PrometheusService,
    node: &str,
) -> Result<Option<String>, String> {
    let escaped = node.replace('"', "\\\"");
    let now = chrono::Utc::now().timestamp();
    // Prefer node_exporter's own `nodename` label, which usually equals the
    // Kubernetes node name and pins down its instance directly.
    let uname = prometheus_query_range(
        client,
        service,
        &format!("node_uname_info{{nodename=\"{escaped}\"}}"),
        now,
        now,
        1,
    )
    .await?;
    let mut matchers = instance_matchers(&uname);
    // kube-state-metrics v2+ exposes the node's addresses on a separate metric.
    if matchers.is_empty() {
        let addresses = prometheus_query_range(
            client,
            service,
            &format!("kube_node_status_address{{node=\"{escaped}\",type=\"InternalIP\"}}"),
            now,
            now,
            1,
        )
        .await?;
        matchers = address_matchers(&addresses);
    }
    // Older kube-state-metrics carried the internal IP on kube_node_info itself.
    if matchers.is_empty() {
        let info = prometheus_query_range(
            client,
            service,
            &format!("kube_node_info{{node=\"{escaped}\"}}"),
            now,
            now,
            1,
        )
        .await?;
        matchers = address_matchers(&info);
    }
    // Last resort: node-exporter instances usually start with the node name,
    // e.g. `minikube:9100` or `<node>.<domain>:9100`.
    if matchers.is_empty() {
        return Ok(Some(format!("{}[:.]", escape_regex(node))));
    }
    Ok(Some(matchers.join("|")))
}

fn instance_matchers(value: &Value) -> Vec<String> {
    value
        .pointer("/data/result")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.get("metric")
                .and_then(|metric| metric.get("instance"))
                .and_then(Value::as_str)
                .map(escape_regex)
                .filter(|matcher| !matcher.is_empty())
        })
        .collect()
}

fn address_matchers(value: &Value) -> Vec<String> {
    value
        .pointer("/data/result")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let metric = item.get("metric")?;
            let address = metric
                .get("internal_ip")
                .or_else(|| metric.get("address"))
                .and_then(Value::as_str)
                .filter(|address| !address.is_empty())?;
            Some(format!("{}:.*", escape_regex(address)))
        })
        .collect()
}

fn node_metric_queries(instance_matchers: &str) -> [(&'static str, String, &'static str); 4] {
    let selector = format!("instance=~\"{}\"", instance_matchers.replace('"', "\\\""));
    let virtual_devices = "device!~\"lo|veth.*|docker.*|cbr.*|flannel.*|cali.*|tunl.*|weave.*\"";
    [
        ("cpu", format!("label_replace(sum by (instance) (rate(node_cpu_seconds_total{{{selector},mode!=\"idle\"}}[5m])), \"container\", \"Node\", \"instance\", \".*\")"), "cores"),
        ("memory", format!("label_replace(node_memory_MemTotal_bytes{{{selector}}} - node_memory_MemAvailable_bytes{{{selector}}}, \"container\", \"Node\", \"instance\", \".*\")"), "bytes"),
        ("network", format!("sum by (direction) (label_replace(rate(node_network_receive_bytes_total{{{selector},{virtual_devices}}}[5m]), \"direction\", \"Receive\", \"instance\", \".*\") or label_replace(rate(node_network_transmit_bytes_total{{{selector},{virtual_devices}}}[5m]), \"direction\", \"Transmit\", \"instance\", \".*\"))"), "bytes/s"),
        ("filesystem", format!("sum by (device) (node_filesystem_size_bytes{{{selector},fstype!~\"tmpfs|overlay|squashfs|ramfs|iso9660\"}} - node_filesystem_avail_bytes{{{selector},fstype!~\"tmpfs|overlay|squashfs|ramfs|iso9660\"}})"), "bytes"),
    ]
}

/// Runs a set of PromQL queries against the cluster's Prometheus and shapes the
/// matrix results into the response the sheet charts render.
async fn run_prometheus_queries(
    client: &Client,
    service: &PrometheusService,
    range_hours: u8,
    queries: &[(&str, String, &str)],
) -> Result<Option<PodMetricsResponse>, String> {
    if ![1, 2, 4, 8, 24].contains(&range_hours) {
        return Err("Metric range must be one of 1, 2, 4, 8, or 24 hours".into());
    }
    let end = chrono::Utc::now().timestamp();
    let start = end - i64::from(range_hours) * 3600;
    let step = match range_hours {
        1 => 30,
        2 => 60,
        4 => 120,
        8 => 240,
        _ => 600,
    };
    let mut series = HashMap::new();
    let mut query_succeeded = false;
    for (key, query, unit) in queries {
        match prometheus_query_range(client, service, query, start, end, step).await {
            Ok(value) if value.get("status").and_then(Value::as_str) == Some("success") => {
                query_succeeded = true;
                series.insert(key.to_string(), parse_series(&value, unit));
            }
            Ok(_) => {
                series.insert(key.to_string(), Vec::new());
            }
            Err(_) => {
                series.insert(key.to_string(), Vec::new());
            }
        }
    }
    if !query_succeeded {
        return Ok(None);
    }
    Ok(Some(PodMetricsResponse {
        provider: format!("Service/{}/{}", service.namespace, service.name),
        range_hours,
        step_seconds: step,
        series,
    }))
}

pub async fn pod_metrics(
    registry: &ClusterRegistry,
    request: PodMetricsRequest,
) -> Result<Option<PodMetricsResponse>, String> {
    let client = registry.client(&request.cluster_id).await?;
    let Some(service) = cached_prometheus(client.clone(), &request.cluster_id).await? else {
        return Ok(None);
    };
    let queries = metric_queries(&request.namespace, &request.pod);
    run_prometheus_queries(&client, &service, request.range_hours, &queries).await
}

/// Parses a Kubernetes CPU quantity ("100m", "1", "0.5", "67131864n") into
/// millicores. Metrics-server reports CPU in millicores ("12m") by default but
/// some versions return integer nanocores ("12345678n"), so the "n" (nano) and
/// "u" (micro) suffixes are handled too.
fn parse_quantity_millicores(value: &str) -> Option<u64> {
    let value = value.trim();
    let millicores = if let Some(milli) = value.strip_suffix('m') {
        milli.parse::<f64>().ok()?
    } else if let Some(nano) = value.strip_suffix('n') {
        nano.parse::<f64>().ok()? / 1_000_000.0
    } else if let Some(micro) = value.strip_suffix('u') {
        micro.parse::<f64>().ok()? / 1_000.0
    } else {
        value.parse::<f64>().ok()? * 1000.0
    };
    Some(millicores.round().max(0.0) as u64)
}

/// Parses a Kubernetes memory quantity ("128Mi", "1Gi", "512M", "4096") into
/// bytes. Binary suffixes (Ki/Mi/…) scale by powers of 1024, decimal ones by
/// powers of 1000, matching the quantity grammar.
fn parse_quantity_bytes(value: &str) -> Option<u64> {
    let value = value.trim();
    const SUFFIXES: [(&str, f64); 12] = [
        ("Ei", 1_152_921_504_606_846_976.0),
        ("Pi", 1_125_899_906_842_624.0),
        ("Ti", 1_099_511_627_776.0),
        ("Gi", 1_073_741_824.0),
        ("Mi", 1_048_576.0),
        ("Ki", 1024.0),
        ("E", 1_000_000_000_000_000_000.0),
        ("P", 1_000_000_000_000_000.0),
        ("T", 1_000_000_000_000.0),
        ("G", 1_000_000_000.0),
        ("M", 1_000_000.0),
        ("K", 1000.0),
    ];
    for (suffix, multiplier) in SUFFIXES {
        if let Some(number) = value.strip_suffix(suffix) {
            return Some((number.parse::<f64>().ok()? * multiplier).round().max(0.0) as u64);
        }
    }
    Some(value.parse::<f64>().ok()?.round().max(0.0) as u64)
}

/// Lists pod usage from the aggregated metrics API (`metrics.k8s.io`, served by
/// metrics-server). Returns `None` when the cluster does not serve that API so
/// the caller can fall back to the pod spec's requests/limits.
pub async fn list_pod_metrics(
    registry: &ClusterRegistry,
    request: PodMetricsListRequest,
) -> Result<Option<PodMetricsListResponse>, String> {
    let client = registry.client(&request.cluster_id).await?;
    let gvk = GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "PodMetrics");
    let resource = ApiResource::from_gvk_with_plural(&gvk, "pods");
    let api: Api<DynamicObject> = match request.namespace.as_deref().filter(|value| !value.is_empty()) {
        Some(namespace) => Api::namespaced_with(client, namespace, &resource),
        None => Api::all_with(client, &resource),
    };
    let list = match api.list(&ListParams::default()).await {
        Ok(list) => list,
        Err(kube::Error::Api(response)) if response.code == 404 || response.code == 403 => {
            return Ok(None);
        }
        Err(error) => return Err(error.to_string()),
    };
    let items: Vec<PodUsageEntry> = list
        .items
        .into_iter()
        .filter_map(|item| {
            let name = item.name_any();
            let namespace = item.namespace().unwrap_or_default();
            let mut cpu_millicores = 0u64;
            let mut memory_bytes = 0u64;
            let mut found = false;
            for container in item
                .data
                .pointer("/containers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let usage = container.pointer("/usage");
                if let Some(cpu) = usage
                    .and_then(|usage| usage.get("cpu"))
                    .and_then(Value::as_str)
                    .and_then(parse_quantity_millicores)
                {
                    cpu_millicores += cpu;
                    found = true;
                }
                if let Some(memory) = usage
                    .and_then(|usage| usage.get("memory"))
                    .and_then(Value::as_str)
                    .and_then(parse_quantity_bytes)
                {
                    memory_bytes += memory;
                    found = true;
                }
            }
            found.then_some(PodUsageEntry {
                namespace,
                name,
                cpu_millicores,
                memory_bytes,
            })
        })
        .collect();
    Ok(Some(PodMetricsListResponse { items }))
}

pub async fn node_metrics(
    registry: &ClusterRegistry,
    request: NodeMetricsRequest,
) -> Result<Option<NodeMetricsResponse>, String> {
    let client = registry.client(&request.cluster_id).await?;
    let Some(service) = cached_prometheus(client.clone(), &request.cluster_id).await? else {
        return Ok(None);
    };
    let Some(selector) = node_instance_selector(&client, &service, &request.node).await? else {
        return Err(format!(
            "Could not resolve node \"{}\" to a Prometheus instance",
            request.node
        ));
    };
    let queries = node_metric_queries(&selector);
    run_prometheus_queries(&client, &service, request.range_hours, &queries).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_prometheus_queries() {
        assert_eq!(query_escape("a{b=\"c d\"}"), "a%7Bb%3D%22c%20d%22%7D");
    }

    #[test]
    fn builds_all_metric_queries() {
        let queries = metric_queries("commerce", "checkout-api-abc");
        assert_eq!(
            queries.each_ref().map(|(key, _, _)| *key),
            ["cpu", "memory", "network", "filesystem"]
        );
        assert!(queries
            .iter()
            .all(|(_, query, _)| query.contains("namespace=\"commerce\"")
                && query.contains("pod=\"checkout-api-abc\"")));
    }

    #[test]
    fn builds_node_metric_queries() {
        let queries = node_metric_queries("10\\.0\\.0\\.5:.*|node-a");
        assert_eq!(
            queries.each_ref().map(|(key, _, _)| *key),
            ["cpu", "memory", "network", "filesystem"]
        );
        assert!(queries
            .iter()
            .all(|(_, query, _)| query.contains("instance=~\"10\\.0\\.0\\.5:.*|node-a\"")));
        assert!(queries
            .iter()
            .filter(|(key, _, _)| *key != "memory" && *key != "filesystem")
            .all(|(_, query, _)| query.contains("5m")));
        assert!(queries
            .iter()
            .filter(|(key, _, _)| *key != "filesystem")
            .all(|(_, query, _)| query.contains("label_replace(")));
    }

    #[test]
    fn escapes_regex_metacharacters() {
        assert_eq!(escape_regex("10.0.0.5"), "10\\.0\\.0\\.5");
        assert_eq!(escape_regex("node-a"), "node-a");
        assert_eq!(escape_regex("a.b|c"), "a\\.b\\|c");
    }

    #[test]
    fn collects_instance_and_address_matchers() {
        let uname = serde_json::json!({"data":{"result":[{"metric":{"instance":"10.0.0.5:9100","nodename":"node-a"}}]}});
        assert_eq!(instance_matchers(&uname), ["10\\.0\\.0\\.5:9100"]);
        // kube_node_status_address (kube-state-metrics v2+)
        let status = serde_json::json!({"data":{"result":[{"metric":{"node":"node-a","type":"InternalIP","address":"10.0.0.5"}}]}});
        assert_eq!(address_matchers(&status), ["10\\.0\\.0\\.5:.*"]);
        // kube_node_info (older kube-state-metrics)
        let info = serde_json::json!({"data":{"result":[{"metric":{"node":"node-a","internal_ip":"10.0.0.5"}}]}});
        assert_eq!(address_matchers(&info), ["10\\.0\\.0\\.5:.*"]);
    }

    #[test]
    fn parses_matrix_series() {
        let response = serde_json::json!({"data":{"result":[{"metric":{"container":"api"},"values":[[1,"2.5"],[2,"3"]]}]}});
        let series = parse_series(&response, "cores");
        assert_eq!(series[0].label, "api");
        assert_eq!(series[0].points.len(), 2);
    }

    #[test]
    fn parses_cpu_quantities_to_millicores() {
        assert_eq!(parse_quantity_millicores("100m"), Some(100));
        assert_eq!(parse_quantity_millicores("1"), Some(1000));
        assert_eq!(parse_quantity_millicores("0.5"), Some(500));
        assert_eq!(parse_quantity_millicores("1.25"), Some(1250));
        assert_eq!(parse_quantity_millicores("250m"), Some(250));
        // metrics-server can report integer nanocores on some versions.
        assert_eq!(parse_quantity_millicores("67131864n"), Some(67));
        assert_eq!(parse_quantity_millicores("123456u"), Some(123));
        assert_eq!(parse_quantity_millicores("100n"), Some(0));
        assert_eq!(parse_quantity_millicores("garbage"), None);
    }

    #[test]
    fn parses_memory_quantities_to_bytes() {
        assert_eq!(parse_quantity_bytes("128Mi"), Some(128 * 1024 * 1024));
        assert_eq!(parse_quantity_bytes("1Gi"), Some(1024 * 1024 * 1024));
        assert_eq!(parse_quantity_bytes("512Ki"), Some(512 * 1024));
        assert_eq!(parse_quantity_bytes("1.5Gi"), Some(3 * 1024 * 1024 * 1024 / 2));
        assert_eq!(parse_quantity_bytes("100M"), Some(100_000_000));
        assert_eq!(parse_quantity_bytes("4096"), Some(4096));
        assert_eq!(parse_quantity_bytes("bogus"), None);
    }
}
