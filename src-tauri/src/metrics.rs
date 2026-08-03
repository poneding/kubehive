use crate::{
    models::{PodMetricPoint, PodMetricSeries, PodMetricsRequest, PodMetricsResponse},
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

pub async fn pod_metrics(
    registry: &ClusterRegistry,
    request: PodMetricsRequest,
) -> Result<Option<PodMetricsResponse>, String> {
    if ![1, 2, 4, 8, 24].contains(&request.range_hours) {
        return Err("Pod metric range must be one of 1, 2, 4, 8, or 24 hours".into());
    }
    let client = registry.client(&request.cluster_id).await?;
    let Some(service) = cached_prometheus(client.clone(), &request.cluster_id).await? else {
        return Ok(None);
    };
    let end = chrono::Utc::now().timestamp();
    let start = end - i64::from(request.range_hours) * 3600;
    let step = match request.range_hours {
        1 => 30,
        2 => 60,
        4 => 120,
        8 => 240,
        _ => 600,
    };
    let queries = metric_queries(&request.namespace, &request.pod);
    let mut series = HashMap::new();
    let mut query_succeeded = false;
    for (key, query, unit) in queries {
        match prometheus_query_range(&client, &service, &query, start, end, step).await {
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
        range_hours: request.range_hours,
        step_seconds: step,
        series,
    }))
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
    fn parses_matrix_series() {
        let response = serde_json::json!({"data":{"result":[{"metric":{"container":"api"},"values":[[1,"2.5"],[2,"3"]]}]}});
        let series = parse_series(&response, "cores");
        assert_eq!(series[0].label, "api");
        assert_eq!(series[0].points.len(), 2);
    }
}
