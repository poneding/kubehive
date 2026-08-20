use crate::{
    models::{HelmChartSummary, HelmReleaseRequest, HelmReleaseValues},
    registry::ClusterRegistry,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use flate2::read::GzDecoder;
use futures::future::join_all;
use k8s_openapi::api::core::v1::Secret;
use kube::Api;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    io::Read,
    time::{Duration, Instant},
};
use tokio::sync::RwLock;

const DEFAULT_REPOSITORIES: [(&str, &str); 4] = [
    (
        "ingress-nginx",
        "https://kubernetes.github.io/ingress-nginx/index.yaml",
    ),
    ("jetstack", "https://charts.jetstack.io/index.yaml"),
    (
        "prometheus-community",
        "https://prometheus-community.github.io/helm-charts/index.yaml",
    ),
    ("argo", "https://argoproj.github.io/argo-helm/index.yaml"),
];

#[derive(Debug, Deserialize)]
struct RepositoryIndex {
    #[serde(default)]
    entries: HashMap<String, Vec<ChartVersion>>,
}

#[derive(Debug, Deserialize)]
struct ChartVersion {
    version: String,
    #[serde(rename = "appVersion", default)]
    app_version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    deprecated: bool,
}

pub struct HelmCatalog {
    cache: RwLock<Option<(Instant, Vec<HelmChartSummary>)>>,
    client: RwLock<reqwest::Client>,
}

impl Default for HelmCatalog {
    fn default() -> Self {
        Self {
            cache: RwLock::new(None),
            client: RwLock::new(build_client(None).expect("build Helm repository client")),
        }
    }
}

impl HelmCatalog {
    pub async fn set_proxy(&self, enabled: bool, url: Option<&str>) -> Result<(), String> {
        let proxy = if enabled {
            Some(url.ok_or_else(|| "A proxy URL is required".to_string())?)
        } else {
            None
        };
        *self.client.write().await = build_client(proxy)?;
        *self.cache.write().await = None;
        Ok(())
    }

    pub async fn list(&self, refresh: bool) -> Result<Vec<HelmChartSummary>, String> {
        if !refresh {
            if let Some((updated, charts)) = self.cache.read().await.as_ref() {
                if updated.elapsed() < Duration::from_secs(15 * 60) {
                    return Ok(charts.clone());
                }
            }
        }
        let requests = DEFAULT_REPOSITORIES
            .into_iter()
            .map(|(name, url)| self.fetch(name, url));
        let results = join_all(requests).await;
        let mut charts = Vec::new();
        let mut errors = Vec::new();
        for result in results {
            match result {
                Ok(mut repository_charts) => charts.append(&mut repository_charts),
                Err(error) => errors.push(error),
            }
        }
        if charts.is_empty() {
            return Err(format!(
                "Unable to load Helm repositories: {}",
                errors.join("; ")
            ));
        }
        charts.sort_by(|left, right| {
            left.name
                .cmp(&right.name)
                .then(left.repository.cmp(&right.repository))
        });
        *self.cache.write().await = Some((Instant::now(), charts.clone()));
        Ok(charts)
    }

    async fn fetch(&self, repository: &str, url: &str) -> Result<Vec<HelmChartSummary>, String> {
        let client = self.client.read().await.clone();
        let response = client
            .get(url)
            .send()
            .await
            .map_err(|error| format!("{repository}: {error}"))?
            .error_for_status()
            .map_err(|error| format!("{repository}: {error}"))?;
        let text = response
            .text()
            .await
            .map_err(|error| format!("{repository}: {error}"))?;
        let index: RepositoryIndex = serde_yaml::from_str(&text)
            .map_err(|error| format!("{repository}: invalid index: {error}"))?;
        Ok(index
            .entries
            .into_iter()
            .filter_map(|(name, versions)| {
                let latest = versions.into_iter().find(|version| !version.deprecated)?;
                Some(HelmChartSummary {
                    name,
                    repository: repository.into(),
                    version: latest.version,
                    app_version: latest.app_version,
                    description: latest.description,
                })
            })
            .collect())
    }
}

/// Reads the values recorded in one Helm release revision.
///
/// Helm's Secret storage driver keeps the whole release object in the
/// `release` key as `base64(gzip(json))`; the Kubernetes client already
/// undoes the API-level base64, so one more decode plus an inflate returns
/// the release JSON that `helm get values` reads.
pub async fn release_values(
    registry: &ClusterRegistry,
    request: HelmReleaseRequest,
) -> Result<HelmReleaseValues, String> {
    let client = registry.client(&request.cluster_id).await?;
    let api: Api<Secret> = Api::namespaced(client, &request.namespace);
    let secret = api.get(&request.secret_name).await.map_err(|error| {
        format!(
            "Unable to read Helm release {}: {error}",
            request.secret_name
        )
    })?;
    let payload = secret
        .data
        .as_ref()
        .and_then(|data| data.get("release"))
        .ok_or_else(|| {
            format!(
                "Secret {} does not carry a Helm release payload",
                request.secret_name
            )
        })?;
    Ok(summarize(decode_release(&payload.0)?, &request))
}

fn decode_release(payload: &[u8]) -> Result<Value, String> {
    let encoded = std::str::from_utf8(payload)
        .map_err(|_| "The Helm release payload is not valid UTF-8".to_string())?;
    let decoded = BASE64
        .decode(encoded.trim())
        .map_err(|error| format!("Unable to decode the Helm release payload: {error}"))?;
    // Helm gzips releases since 3.0; the magic bytes keep the rare
    // uncompressed payload readable too.
    let json = if decoded.starts_with(&[0x1f, 0x8b]) {
        let mut buffer = Vec::new();
        GzDecoder::new(decoded.as_slice())
            .read_to_end(&mut buffer)
            .map_err(|error| format!("Unable to decompress the Helm release payload: {error}"))?;
        buffer
    } else {
        decoded
    };
    serde_json::from_slice(&json)
        .map_err(|error| format!("Unable to parse the Helm release payload: {error}"))
}

fn summarize(release: Value, request: &HelmReleaseRequest) -> HelmReleaseValues {
    let defaults = release
        .pointer("/chart/values")
        .cloned()
        .unwrap_or(Value::Null);
    let supplied = release.get("config").cloned().unwrap_or(Value::Null);
    let computed = coalesce(&defaults, &supplied);
    let chart_name = text(release.pointer("/chart/metadata/name"));
    let chart_version = text(release.pointer("/chart/metadata/version"));
    HelmReleaseValues {
        name: text(release.get("name")),
        namespace: {
            let namespace = text(release.get("namespace"));
            if namespace.is_empty() {
                request.namespace.clone()
            } else {
                namespace
            }
        },
        revision: release
            .get("version")
            .and_then(Value::as_u64)
            .unwrap_or_default() as u32,
        status: text(release.pointer("/info/status")),
        chart: match (chart_name.is_empty(), chart_version.is_empty()) {
            (true, _) => String::new(),
            (false, true) => chart_name,
            (false, false) => format!("{chart_name}-{chart_version}"),
        },
        app_version: text(release.pointer("/chart/metadata/appVersion")),
        supplied_values: to_yaml(&supplied),
        supplied_value_count: top_level_keys(&supplied),
        default_values: to_yaml(&defaults),
        default_value_count: top_level_keys(&defaults),
        computed_values: to_yaml(&computed),
        computed_value_count: top_level_keys(&computed),
    }
}

/// Merges supplied values over chart defaults the way Helm coalesces them:
/// maps merge key by key, every other value replaces the default outright,
/// and an explicit null drops the default.
fn coalesce(defaults: &Value, supplied: &Value) -> Value {
    match (defaults, supplied) {
        (Value::Object(base), Value::Object(overrides)) => {
            let mut merged = base.clone();
            for (key, value) in overrides {
                if value.is_null() {
                    merged.remove(key);
                    continue;
                }
                match merged.get(key) {
                    Some(existing) if existing.is_object() && value.is_object() => {
                        let nested = coalesce(existing, value);
                        merged.insert(key.clone(), nested);
                    }
                    _ => {
                        merged.insert(key.clone(), value.clone());
                    }
                }
            }
            Value::Object(merged)
        }
        (base, Value::Null) => base.clone(),
        (_, overrides) => overrides.clone(),
    }
}

fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Empty documents render as an empty state in the sheet, not as `{}`.
fn to_yaml(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Object(map) if map.is_empty() => String::new(),
        other => serde_yaml::to_string(other).unwrap_or_default(),
    }
}

fn top_level_keys(value: &Value) -> u32 {
    value.as_object().map(|map| map.len() as u32).unwrap_or(0)
}

fn build_client(proxy: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("KubeHive/0.1");
    if let Some(url) = proxy {
        builder = builder.proxy(
            reqwest::Proxy::all(url).map_err(|error| format!("Invalid proxy URL: {error}"))?,
        );
    }
    builder
        .build()
        .map_err(|error| format!("Unable to build Helm repository client: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    #[tokio::test]
    async fn live_helm_catalog_when_requested() {
        if std::env::var("KUBEHIVE_LIVE_TEST").as_deref() != Ok("1") {
            return;
        }
        let charts = HelmCatalog::default()
            .list(true)
            .await
            .expect("load official Helm indexes");
        assert!(charts.iter().any(|chart| chart.name == "ingress-nginx"));
        assert!(charts
            .iter()
            .any(|chart| chart.name == "kube-prometheus-stack"));
    }

    #[test]
    fn parses_repository_index_and_skips_deprecated_latest() {
        let index: RepositoryIndex = serde_yaml::from_str(
            r#"
entries:
  app:
    - version: 2.0.0
      appVersion: v2
      deprecated: true
    - version: 1.9.0
      appVersion: v1.9
      description: Stable chart
"#,
        )
        .unwrap();
        let versions = index.entries.get("app").unwrap();
        let latest = versions.iter().find(|version| !version.deprecated).unwrap();
        assert_eq!(latest.version, "1.9.0");
        assert_eq!(latest.app_version, "v1.9");
    }

    fn release_payload(release: &Value) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(&serde_json::to_vec(release).unwrap())
            .unwrap();
        BASE64.encode(encoder.finish().unwrap()).into_bytes()
    }

    fn sample_release() -> Value {
        serde_json::json!({
            "name": "checkout",
            "namespace": "shop",
            "version": 3,
            "info": { "status": "deployed" },
            "chart": {
                "metadata": { "name": "checkout", "version": "1.4.0", "appVersion": "2.1.0" },
                "values": {
                    "replicaCount": 1,
                    "image": { "repository": "checkout", "tag": "2.1.0", "pullPolicy": "IfNotPresent" },
                    "ingress": { "enabled": false },
                },
            },
            "config": {
                "replicaCount": 4,
                "image": { "tag": "2.2.0" },
                "ingress": null,
            },
        })
    }

    #[test]
    fn decodes_gzipped_release_payloads() {
        let release = decode_release(&release_payload(&sample_release())).unwrap();
        assert_eq!(release.pointer("/info/status").unwrap(), "deployed");
    }

    #[test]
    fn decodes_uncompressed_release_payloads() {
        let json = serde_json::to_vec(&sample_release()).unwrap();
        let release = decode_release(BASE64.encode(json).as_bytes()).unwrap();
        assert_eq!(release.get("name").unwrap(), "checkout");
    }

    #[test]
    fn summarizes_supplied_default_and_computed_values() {
        let request = HelmReleaseRequest {
            cluster_id: "test".into(),
            namespace: "shop".into(),
            secret_name: "sh.helm.release.v1.checkout.v3".into(),
        };
        let values = summarize(sample_release(), &request);
        assert_eq!(values.name, "checkout");
        assert_eq!(values.revision, 3);
        assert_eq!(values.status, "deployed");
        assert_eq!(values.chart, "checkout-1.4.0");
        assert_eq!(values.app_version, "2.1.0");
        assert_eq!(values.supplied_value_count, 3);
        assert_eq!(values.default_value_count, 3);
        // `ingress: null` drops the chart default, so only two keys remain.
        assert_eq!(values.computed_value_count, 2);
        assert!(values.computed_values.contains("replicaCount: 4"));
        assert!(values.computed_values.contains("tag: 2.2.0"));
        // Unset sibling keys survive the merge of a nested map.
        assert!(values.computed_values.contains("pullPolicy: IfNotPresent"));
        assert!(!values.computed_values.contains("ingress"));
    }

    #[test]
    fn empty_value_documents_stay_empty() {
        let request = HelmReleaseRequest {
            cluster_id: "test".into(),
            namespace: "shop".into(),
            secret_name: "sh.helm.release.v1.plain.v1".into(),
        };
        let values = summarize(
            serde_json::json!({ "name": "plain", "config": {}, "chart": { "values": {} } }),
            &request,
        );
        assert_eq!(values.supplied_values, "");
        assert_eq!(values.default_values, "");
        assert_eq!(values.computed_values, "");
        assert_eq!(values.namespace, "shop");
    }
}
