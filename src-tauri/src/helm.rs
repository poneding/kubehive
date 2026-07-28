use crate::models::HelmChartSummary;
use futures::future::join_all;
use serde::Deserialize;
use std::{
    collections::HashMap,
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
}
