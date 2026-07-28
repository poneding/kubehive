use crate::models::{ClusterSummary, ImportClusterRequest, ProxySettings};
use k8s_openapi::api::core::v1::Node;
use kube::{
    api::{Api, ListParams},
    config::{KubeConfigOptions, Kubeconfig},
    Client, Config,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::RwLock;
use uuid::Uuid;

#[derive(Clone)]
pub struct ClusterEntry {
    pub id: String,
    pub display_name: String,
    pub context: String,
    pub server: String,
    pub default_namespace: String,
    pub imported: bool,
    pub kubeconfig: Kubeconfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedImport {
    id: String,
    display_name: String,
    context: String,
    kubeconfig_yaml: String,
}

#[derive(Debug, Clone, Default)]
struct RuntimeProxy {
    enabled: bool,
    url: Option<String>,
}

pub struct ClusterRegistry {
    entries: RwLock<HashMap<String, ClusterEntry>>,
    clients: RwLock<HashMap<String, Client>>,
    proxy: RwLock<RuntimeProxy>,
    disconnected: RwLock<HashSet<String>>,
    imports_path: PathBuf,
}

impl ClusterRegistry {
    pub fn new(config_dir: PathBuf) -> Self {
        // rustls cannot choose automatically when transitive dependencies enable multiple providers.
        // Install ring explicitly before kube creates its first HTTPS client.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let imports_path = config_dir.join("clusters.json");
        let mut entries = HashMap::new();
        if let Ok(kubeconfig) = Kubeconfig::read() {
            Self::append_entries(&mut entries, kubeconfig, false, None, None);
        }
        if let Ok(text) = fs::read_to_string(&imports_path) {
            if let Ok(records) = serde_json::from_str::<Vec<PersistedImport>>(&text) {
                for record in records {
                    if let Ok(kubeconfig) = Kubeconfig::from_yaml(&record.kubeconfig_yaml) {
                        if let Some(entry) = Self::entry_for_context(
                            kubeconfig,
                            true,
                            record.context,
                            Some(record.display_name),
                            Some(record.id),
                        ) {
                            entries.insert(entry.id.clone(), entry);
                        }
                    }
                }
            }
        }
        Self {
            entries: RwLock::new(entries),
            clients: RwLock::new(HashMap::new()),
            proxy: RwLock::new(RuntimeProxy::default()),
            disconnected: RwLock::new(HashSet::new()),
            imports_path,
        }
    }

    fn append_entries(
        target: &mut HashMap<String, ClusterEntry>,
        kubeconfig: Kubeconfig,
        imported: bool,
        display_name: Option<String>,
        id_prefix: Option<String>,
    ) {
        let contexts = kubeconfig
            .contexts
            .iter()
            .map(|item| item.name.clone())
            .collect::<Vec<_>>();
        for context in contexts {
            let id = id_prefix
                .as_ref()
                .map(|prefix| format!("{prefix}:{context}"));
            if let Some(entry) = Self::entry_for_context(
                kubeconfig.clone(),
                imported,
                context,
                display_name.clone(),
                id,
            ) {
                target.insert(entry.id.clone(), entry);
            }
        }
    }

    fn entry_for_context(
        kubeconfig: Kubeconfig,
        imported: bool,
        context_name: String,
        display_name: Option<String>,
        id: Option<String>,
    ) -> Option<ClusterEntry> {
        let context = kubeconfig
            .contexts
            .iter()
            .find(|item| item.name == context_name)?;
        let context_data = context.context.as_ref()?;
        let named_cluster = kubeconfig
            .clusters
            .iter()
            .find(|item| item.name == context_data.cluster)?;
        let server = named_cluster
            .cluster
            .as_ref()?
            .server
            .clone()
            .unwrap_or_default();
        let entry_id = id.unwrap_or_else(|| format!("default:{context_name}"));
        Some(ClusterEntry {
            id: entry_id,
            display_name: display_name
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| context_name.clone()),
            context: context_name,
            server,
            default_namespace: context_data
                .namespace
                .clone()
                .unwrap_or_else(|| "default".into()),
            imported,
            kubeconfig,
        })
    }

    pub async fn entry(&self, id: &str) -> Result<ClusterEntry, String> {
        self.entries
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Unknown cluster: {id}"))
    }

    pub async fn client(&self, id: &str) -> Result<Client, String> {
        if self.disconnected.read().await.contains(id) {
            return Err(
                "Cluster is disconnected. Reconnect it from the cluster rail to continue.".into(),
            );
        }
        if let Some(client) = self.clients.read().await.get(id).cloned() {
            return Ok(client);
        }
        let entry = self.entry(id).await?;
        let options = KubeConfigOptions {
            context: Some(entry.context.clone()),
            ..Default::default()
        };
        let mut config = Config::from_custom_kubeconfig(entry.kubeconfig.clone(), &options)
            .await
            .map_err(|error| {
                format!(
                    "Unable to load kubeconfig context {}: {error}",
                    entry.context
                )
            })?;
        let proxy = self.proxy.read().await.clone();
        if proxy.enabled {
            if let Some(url) = proxy.url {
                config.proxy_url = Some(
                    url.parse()
                        .map_err(|error| format!("Invalid proxy URL: {error}"))?,
                );
            }
        }
        config.connect_timeout = Some(Duration::from_secs(8));
        config.read_timeout = Some(Duration::from_secs(45));
        let client = Client::try_from(config)
            .map_err(|error| format!("Unable to create Kubernetes client: {error}"))?;
        self.clients
            .write()
            .await
            .insert(id.to_string(), client.clone());
        Ok(client)
    }

    pub async fn disconnect(&self, id: &str) -> Result<(), String> {
        self.entry(id).await?;
        self.disconnected.write().await.insert(id.to_string());
        self.invalidate(Some(id)).await;
        Ok(())
    }

    pub async fn reconnect(&self, id: &str) -> Result<(), String> {
        self.entry(id).await?;
        self.disconnected.write().await.remove(id);
        self.invalidate(Some(id)).await;
        Ok(())
    }

    pub async fn invalidate(&self, id: Option<&str>) {
        let mut clients = self.clients.write().await;
        if let Some(id) = id {
            clients.remove(id);
        } else {
            clients.clear();
        }
    }

    pub async fn set_proxy(&self, settings: ProxySettings) -> Result<(), String> {
        if settings.enabled {
            let url = settings
                .url
                .as_deref()
                .ok_or_else(|| "A proxy URL is required".to_string())?;
            let _: http::Uri = url
                .parse()
                .map_err(|error| format!("Invalid proxy URL: {error}"))?;
        }
        *self.proxy.write().await = RuntimeProxy {
            enabled: settings.enabled,
            url: settings.url,
        };
        self.invalidate(None).await;
        Ok(())
    }

    pub async fn list_clusters(&self) -> Vec<ClusterSummary> {
        let mut entries = self
            .entries
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| left.display_name.cmp(&right.display_name));
        let futures = entries.into_iter().map(|entry| self.summary(entry));
        futures::future::join_all(futures).await
    }

    async fn summary(&self, entry: ClusterEntry) -> ClusterSummary {
        let provider = infer_provider(&entry.server).to_string();
        let region = server_region(&entry.server);
        let mut summary = ClusterSummary {
            id: entry.id.clone(),
            name: entry.display_name.clone(),
            provider,
            region,
            version: "unknown".into(),
            status: "offline".into(),
            nodes: 0,
            cpu: 0,
            memory: 0,
            context: entry.context.clone(),
            server: entry.server.clone(),
            default_namespace: entry.default_namespace.clone(),
            imported: entry.imported,
            error: None,
        };
        if self.disconnected.read().await.contains(&entry.id) {
            summary.error = Some("Disconnected by user".into());
            return summary;
        }
        let probe = async {
            let client = self.client(&entry.id).await?;
            let version = client
                .apiserver_version()
                .await
                .map_err(|error| error.to_string())?;
            let nodes: Api<Node> = Api::all(client);
            let list = nodes
                .list(&ListParams::default())
                .await
                .map_err(|error| error.to_string())?;
            let ready = list.items.iter().filter(|node| node_ready(node)).count();
            Ok::<_, String>((
                format!("v{}", version.git_version.trim_start_matches('v')),
                list.items.len(),
                ready,
            ))
        };
        match tokio::time::timeout(Duration::from_secs(8), probe).await {
            Ok(Ok((version, nodes, ready))) => {
                summary.version = version;
                summary.nodes = nodes as u32;
                summary.status = if nodes == 0 || ready == nodes {
                    "healthy"
                } else {
                    "warning"
                }
                .into();
            }
            Ok(Err(error)) => summary.error = Some(error),
            Err(_) => summary.error = Some("Connection timed out".into()),
        }
        summary
    }

    pub async fn import(
        &self,
        request: ImportClusterRequest,
    ) -> Result<Vec<ClusterSummary>, String> {
        let yaml = if let Some(yaml) = request
            .kubeconfig_yaml
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            yaml.clone()
        } else {
            manual_kubeconfig_yaml(&request)?
        };
        let kubeconfig =
            Kubeconfig::from_yaml(&yaml).map_err(|error| format!("Invalid kubeconfig: {error}"))?;
        if kubeconfig.contexts.is_empty() {
            return Err("The kubeconfig does not contain any contexts".into());
        }
        let display_name = request
            .display_name
            .clone()
            .filter(|value| !value.trim().is_empty());
        let mut added = Vec::new();
        let mut records = self.persisted_imports().await;
        for context in kubeconfig
            .contexts
            .iter()
            .map(|item| item.name.clone())
            .collect::<Vec<_>>()
        {
            let id = format!("import:{}", Uuid::new_v4());
            let entry = Self::entry_for_context(
                kubeconfig.clone(),
                true,
                context.clone(),
                display_name.clone(),
                Some(id.clone()),
            )
            .ok_or_else(|| format!("Context {context} references a missing cluster"))?;
            records.push(PersistedImport {
                id: id.clone(),
                display_name: entry.display_name.clone(),
                context,
                kubeconfig_yaml: yaml.clone(),
            });
            self.entries.write().await.insert(id.clone(), entry.clone());
            added.push(self.summary(entry).await);
        }
        self.write_imports(&records)?;
        Ok(added)
    }

    pub async fn remove(&self, id: &str) -> Result<(), String> {
        let entry = self.entry(id).await?;
        if !entry.imported {
            return Err("Default kubeconfig contexts cannot be deleted; remove them from kubeconfig instead".into());
        }
        self.entries.write().await.remove(id);
        self.invalidate(Some(id)).await;
        let records = self
            .persisted_imports()
            .await
            .into_iter()
            .filter(|record| record.id != id)
            .collect::<Vec<_>>();
        self.write_imports(&records)
    }

    async fn persisted_imports(&self) -> Vec<PersistedImport> {
        fs::read_to_string(&self.imports_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn write_imports(&self, records: &[PersistedImport]) -> Result<(), String> {
        if let Some(parent) = self.imports_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Unable to create app config directory: {error}"))?;
        }
        let text = serde_json::to_string_pretty(records).map_err(|error| error.to_string())?;
        fs::write(&self.imports_path, text)
            .map_err(|error| format!("Unable to save imported clusters: {error}"))?;
        set_private_permissions(&self.imports_path)?;
        Ok(())
    }
}

fn manual_kubeconfig_yaml(request: &ImportClusterRequest) -> Result<String, String> {
    let server = request
        .server
        .as_deref()
        .filter(|value| value.starts_with("https://") || value.starts_with("http://"))
        .ok_or_else(|| "A valid Kubernetes API server URL is required".to_string())?;
    let token = request
        .token
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "A bearer token is required for a manual connection".to_string())?;
    let name = request
        .display_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("manual-cluster");
    let value = serde_json::json!({
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": [{"name": name, "cluster": {"server": server, "insecure-skip-tls-verify": request.insecure_skip_tls_verify}}],
        "users": [{"name": name, "user": {"token": token}}],
        "contexts": [{"name": name, "context": {"cluster": name, "user": name}}],
        "current-context": name,
    });
    serde_yaml::to_string(&value).map_err(|error| error.to_string())
}

fn infer_provider(server: &str) -> &'static str {
    let lower = server.to_ascii_lowercase();
    if lower.contains("eks.amazonaws.com") {
        "AWS"
    } else if lower.contains("gke") || lower.contains("googleapis.com") {
        "GCP"
    } else if lower.contains("azmk8s.io") {
        "Azure"
    } else {
        "Local"
    }
}

fn server_region(server: &str) -> String {
    server
        .split("//")
        .nth(1)
        .unwrap_or(server)
        .split('/')
        .next()
        .unwrap_or("kubeconfig")
        .split(':')
        .next()
        .unwrap_or("kubeconfig")
        .to_string()
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

#[cfg(unix)]
fn set_private_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Unable to protect imported kubeconfig: {error}"))
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_manual_config_without_shell_commands() {
        let yaml = manual_kubeconfig_yaml(&ImportClusterRequest {
            display_name: Some("dev".into()),
            kubeconfig_yaml: None,
            server: Some("https://127.0.0.1:6443".into()),
            token: Some("secret-token".into()),
            insecure_skip_tls_verify: true,
        })
        .unwrap();
        let parsed = Kubeconfig::from_yaml(&yaml).unwrap();
        assert_eq!(parsed.contexts[0].name, "dev");
        assert!(yaml.contains("secret-token"));
    }

    #[test]
    fn infers_common_clouds() {
        assert_eq!(infer_provider("https://x.eks.amazonaws.com"), "AWS");
        assert_eq!(infer_provider("https://x.azmk8s.io"), "Azure");
        assert_eq!(infer_provider("https://localhost:6443"), "Local");
    }
}
