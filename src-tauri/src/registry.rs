use crate::models::{
    ClusterSummary, ImportClusterRequest, ProxySettings, RenameClusterRequest, RenameClusterResult,
};
use k8s_openapi::api::core::v1::Node;
use kube::{
    api::{Api, ListParams},
    config::{KubeConfigOptions, Kubeconfig, NamedExtension},
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
    pub source_path: Option<PathBuf>,
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
        let context_sources = default_context_sources();
        if let Ok(kubeconfig) = Kubeconfig::read() {
            Self::append_entries(
                &mut entries,
                kubeconfig,
                false,
                None,
                None,
                Some(&context_sources),
            );
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
                            None,
                        ) {
                            entries.insert(entry.id.clone(), entry);
                        }
                    }
                }
            }
        }
        let disconnected = entries.keys().cloned().collect();
        Self {
            entries: RwLock::new(entries),
            clients: RwLock::new(HashMap::new()),
            proxy: RwLock::new(RuntimeProxy::default()),
            disconnected: RwLock::new(disconnected),
            imports_path,
        }
    }

    fn append_entries(
        target: &mut HashMap<String, ClusterEntry>,
        kubeconfig: Kubeconfig,
        imported: bool,
        display_name: Option<String>,
        id_prefix: Option<String>,
        context_sources: Option<&HashMap<String, PathBuf>>,
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
            let source_path = context_sources.and_then(|sources| sources.get(&context).cloned());
            if let Some(entry) = Self::entry_for_context(
                kubeconfig.clone(),
                imported,
                context,
                display_name.clone(),
                id,
                source_path,
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
        source_path: Option<PathBuf>,
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
                .or_else(|| display_name_from_context(context_data))
                .unwrap_or_else(|| context_name.clone()),
            context: context_name,
            server,
            default_namespace: context_data
                .namespace
                .clone()
                .unwrap_or_else(|| "default".into()),
            imported,
            source_path,
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

    pub async fn terminal_kubeconfig(&self, id: &str) -> Result<String, String> {
        if self.disconnected.read().await.contains(id) {
            return Err(
                "Cluster is disconnected. Reconnect it before opening a local terminal.".into(),
            );
        }
        terminal_kubeconfig_for_entry(&self.entry(id).await?)
    }

    async fn client_config(
        &self,
        id: &str,
        read_timeout: Option<Duration>,
    ) -> Result<Config, String> {
        if self.disconnected.read().await.contains(id) {
            return Err(
                "Cluster is disconnected. Reconnect it from the cluster rail to continue.".into(),
            );
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
        config.read_timeout = read_timeout;
        Ok(config)
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
        let config = self
            .client_config(id, Some(Duration::from_secs(45)))
            .await?;
        let client = Client::try_from(config)
            .map_err(|error| format!("Unable to create Kubernetes client: {error}"))?;
        self.clients
            .write()
            .await
            .insert(id.to_string(), client.clone());
        Ok(client)
    }

    pub async fn streaming_client(&self, id: &str) -> Result<Client, String> {
        let config = self.client_config(id, None).await?;
        Client::try_from(config)
            .map_err(|error| format!("Unable to create streaming Kubernetes client: {error}"))
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

    pub async fn reconnect_and_summary(&self, id: &str) -> Result<ClusterSummary, String> {
        self.reconnect(id).await?;
        let summary = self.summary(self.entry(id).await?).await;
        if let Some(error) = summary.error.clone() {
            self.disconnect(id).await?;
            return Err(error);
        }
        Ok(summary)
    }

    pub async fn probe(&self, id: &str) -> Result<ClusterSummary, String> {
        Ok(self.summary(self.entry(id).await?).await)
    }

    pub async fn rename(
        &self,
        request: RenameClusterRequest,
    ) -> Result<RenameClusterResult, String> {
        let display_name = validate_display_name(&request.display_name)?;
        let entry = self.entry(&request.cluster_id).await?;

        if entry.imported {
            let mut records = self.persisted_imports().await;
            let record = records
                .iter_mut()
                .find(|record| record.id == request.cluster_id)
                .ok_or_else(|| "Imported cluster record not found".to_string())?;
            let mut kubeconfig = Kubeconfig::from_yaml(&record.kubeconfig_yaml)
                .map_err(|error| format!("Unable to read imported kubeconfig: {error}"))?;
            set_context_display_name(&mut kubeconfig, &record.context, &display_name)?;
            record.display_name = display_name.clone();
            record.kubeconfig_yaml =
                serde_yaml::to_string(&kubeconfig).map_err(|error| error.to_string())?;
            self.write_imports(&records)?;

            if let Some(current) = self.entries.write().await.get_mut(&request.cluster_id) {
                current.display_name = display_name.clone();
                current.kubeconfig = kubeconfig;
            }
        } else {
            let path = entry.source_path.clone().ok_or_else(|| {
                format!(
                    "Unable to determine the kubeconfig file that defines context {}",
                    entry.context
                )
            })?;
            let text = fs::read_to_string(&path).map_err(|error| {
                format!("Unable to read kubeconfig {}: {error}", path.display())
            })?;
            let mut source = Kubeconfig::from_yaml(&text).map_err(|error| {
                format!("Unable to parse kubeconfig {}: {error}", path.display())
            })?;
            set_context_display_name(&mut source, &entry.context, &display_name)?;
            let yaml = serde_yaml::to_string(&source).map_err(|error| error.to_string())?;
            fs::write(&path, yaml).map_err(|error| {
                format!("Unable to save kubeconfig {}: {error}", path.display())
            })?;

            if let Some(current) = self.entries.write().await.get_mut(&request.cluster_id) {
                current.display_name = display_name.clone();
                let _ = set_context_display_name(
                    &mut current.kubeconfig,
                    &entry.context,
                    &display_name,
                );
            }
        }

        Ok(RenameClusterResult {
            id: request.cluster_id,
            name: display_name,
        })
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
            source_path: entry.source_path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            disconnected: false,
            error: None,
        };
        if self.disconnected.read().await.contains(&entry.id) {
            summary.disconnected = true;
            summary.error = None;
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
                None,
            )
            .ok_or_else(|| format!("Context {context} references a missing cluster"))?;
            records.push(PersistedImport {
                id: id.clone(),
                display_name: entry.display_name.clone(),
                context,
                kubeconfig_yaml: yaml.clone(),
            });
            self.entries.write().await.insert(id.clone(), entry.clone());
            let mut summary = self.summary(entry).await;
            self.disconnect(&id).await?;
            summary.disconnected = true;
            summary.status = "offline".into();
            added.push(summary);
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
        self.disconnected.write().await.remove(id);
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

fn terminal_kubeconfig_for_entry(entry: &ClusterEntry) -> Result<String, String> {
    let context = entry
        .kubeconfig
        .contexts
        .iter()
        .find(|context| context.name == entry.context)
        .cloned()
        .ok_or_else(|| format!("Kubeconfig context {} was not found", entry.context))?;
    let context_data = context
        .context
        .as_ref()
        .ok_or_else(|| format!("Kubeconfig context {} is incomplete", entry.context))?;
    let mut cluster = entry
        .kubeconfig
        .clusters
        .iter()
        .find(|cluster| cluster.name == context_data.cluster)
        .cloned()
        .ok_or_else(|| {
            format!(
                "Kubeconfig context {} references a missing cluster",
                entry.context
            )
        })?;
    let mut auth_info = match context_data.user.as_deref() {
        Some(user) => Some(
            entry
                .kubeconfig
                .auth_infos
                .iter()
                .find(|auth_info| auth_info.name == user)
                .cloned()
                .ok_or_else(|| {
                    format!(
                        "Kubeconfig context {} references a missing user",
                        entry.context
                    )
                })?,
        ),
        None => None,
    };
    let source_dir = entry.source_path.as_deref().and_then(Path::parent);
    if let Some(cluster_data) = cluster.cluster.as_mut() {
        normalize_terminal_path(
            &mut cluster_data.certificate_authority,
            source_dir,
            "certificate-authority",
        )?;
    }
    if let Some(auth_data) = auth_info
        .as_mut()
        .and_then(|auth_info| auth_info.auth_info.as_mut())
    {
        normalize_terminal_path(
            &mut auth_data.client_certificate,
            source_dir,
            "client-certificate",
        )?;
        normalize_terminal_path(&mut auth_data.client_key, source_dir, "client-key")?;
        normalize_terminal_path(&mut auth_data.token_file, source_dir, "tokenFile")?;
    }
    let kubeconfig = Kubeconfig {
        preferences: None,
        clusters: vec![cluster],
        auth_infos: auth_info.into_iter().collect(),
        contexts: vec![context],
        current_context: Some(entry.context.clone()),
        extensions: None,
        kind: Some("Config".into()),
        api_version: Some("v1".into()),
    };
    serde_yaml::to_string(&kubeconfig)
        .map_err(|error| format!("Unable to serialize terminal kubeconfig: {error}"))
}

fn normalize_terminal_path(
    value: &mut Option<String>,
    source_dir: Option<&Path>,
    field: &str,
) -> Result<(), String> {
    let Some(path) = value.as_deref() else {
        return Ok(());
    };
    let path = PathBuf::from(path);
    if path.is_absolute() {
        return Ok(());
    }
    let source_dir = source_dir.ok_or_else(|| {
        format!(
            "The active kubeconfig uses a relative {field} path. Import it from a file or use absolute credential paths before opening a local terminal."
        )
    })?;
    *value = Some(source_dir.join(path).to_string_lossy().into_owned());
    Ok(())
}

const KUBEHIVE_CONTEXT_EXTENSION: &str = "dev.kubehive.desktop";

fn kubeconfig_paths() -> Vec<PathBuf> {
    if let Some(value) = std::env::var_os("KUBECONFIG") {
        let paths = std::env::split_paths(&value)
            .filter(|path| !path.as_os_str().is_empty())
            .collect::<Vec<_>>();
        if !paths.is_empty() {
            return paths;
        }
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(".kube").join("config"))
        .into_iter()
        .collect()
}

fn default_context_sources() -> HashMap<String, PathBuf> {
    context_sources_from_paths(kubeconfig_paths())
}

fn context_sources_from_paths(
    paths: impl IntoIterator<Item = PathBuf>,
) -> HashMap<String, PathBuf> {
    let mut sources = HashMap::new();
    for path in paths {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(kubeconfig) = Kubeconfig::from_yaml(&text) else {
            continue;
        };
        for context in kubeconfig.contexts {
            sources.entry(context.name).or_insert_with(|| path.clone());
        }
    }
    sources
}

fn display_name_from_context(context: &kube::config::Context) -> Option<String> {
    context.extensions.as_ref()?.iter().find_map(|extension| {
        if extension.name != KUBEHIVE_CONTEXT_EXTENSION {
            return None;
        }
        extension
            .extension
            .get("displayName")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn set_context_display_name(
    kubeconfig: &mut Kubeconfig,
    context_name: &str,
    display_name: &str,
) -> Result<(), String> {
    let context = kubeconfig
        .contexts
        .iter_mut()
        .find(|context| context.name == context_name)
        .and_then(|context| context.context.as_mut())
        .ok_or_else(|| format!("Context {context_name} was not found in its kubeconfig file"))?;
    let extensions = context.extensions.get_or_insert_with(Vec::new);
    if let Some(extension) = extensions
        .iter_mut()
        .find(|extension| extension.name == KUBEHIVE_CONTEXT_EXTENSION)
    {
        let object = extension
            .extension
            .as_object_mut()
            .ok_or_else(|| "The KubeHive context extension is not an object".to_string())?;
        object.insert(
            "displayName".into(),
            serde_json::Value::String(display_name.into()),
        );
    } else {
        extensions.push(NamedExtension {
            name: KUBEHIVE_CONTEXT_EXTENSION.into(),
            extension: serde_json::json!({ "displayName": display_name }),
        });
    }
    Ok(())
}

fn validate_display_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Cluster name is required".into());
    }
    if value.chars().count() > 128 {
        return Err("Cluster name must be 128 characters or fewer".into());
    }
    if value.chars().any(char::is_control) {
        return Err("Cluster name cannot contain control characters".into());
    }
    Ok(value.to_string())
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
    fn terminal_kubeconfig_contains_only_the_active_context() {
        let kubeconfig = Kubeconfig::from_yaml(
            r#"
apiVersion: v1
kind: Config
clusters:
  - name: active-cluster
    cluster:
      server: https://active.example.test
  - name: other-cluster
    cluster:
      server: https://other.example.test
users:
  - name: active-user
    user:
      token: active-token
  - name: other-user
    user:
      token: other-token
contexts:
  - name: active
    context:
      cluster: active-cluster
      user: active-user
  - name: other
    context:
      cluster: other-cluster
      user: other-user
current-context: other
"#,
        )
        .unwrap();
        let entry = ClusterRegistry::entry_for_context(
            kubeconfig,
            false,
            "active".into(),
            None,
            Some("active".into()),
            None,
        )
        .unwrap();

        let yaml = terminal_kubeconfig_for_entry(&entry).unwrap();
        let isolated = Kubeconfig::from_yaml(&yaml).unwrap();
        assert_eq!(isolated.current_context.as_deref(), Some("active"));
        assert_eq!(isolated.contexts.len(), 1);
        assert_eq!(isolated.clusters.len(), 1);
        assert_eq!(isolated.auth_infos.len(), 1);
        assert_eq!(isolated.clusters[0].name, "active-cluster");
        assert_eq!(isolated.auth_infos[0].name, "active-user");
        assert!(!yaml.contains("other-token"));
    }

    #[tokio::test]
    async fn disconnected_clusters_are_listed_without_creating_clients() {
        let yaml = manual_kubeconfig_yaml(&ImportClusterRequest {
            display_name: Some("offline-dev".into()),
            kubeconfig_yaml: None,
            server: Some("https://127.0.0.1:9".into()),
            token: Some("secret-token".into()),
            insecure_skip_tls_verify: true,
        })
        .unwrap();
        let kubeconfig = Kubeconfig::from_yaml(&yaml).unwrap();
        let entry = ClusterRegistry::entry_for_context(
            kubeconfig,
            false,
            "offline-dev".into(),
            None,
            Some("offline-dev".into()),
            None,
        )
        .unwrap();
        let id = entry.id.clone();
        let registry = ClusterRegistry {
            entries: RwLock::new(std::collections::HashMap::from([(id.clone(), entry)])),
            clients: RwLock::new(std::collections::HashMap::new()),
            proxy: RwLock::new(RuntimeProxy::default()),
            disconnected: RwLock::new(std::collections::HashSet::from([id.clone()])),
            imports_path: std::env::temp_dir().join("kubehive-registry-test.json"),
        };

        let summaries = registry.list_clusters().await;
        assert_eq!(summaries.len(), 1);
        assert!(summaries[0].disconnected);
        assert_eq!(summaries[0].status, "offline");
        assert!(summaries[0].error.is_none());
        assert!(registry.clients.read().await.is_empty());
        assert!(registry.client(&id).await.is_err());
        assert!(registry.clients.read().await.is_empty());
    }

    #[tokio::test]
    async fn streaming_clients_do_not_expire_idle_reads() {
        let yaml = manual_kubeconfig_yaml(&ImportClusterRequest {
            display_name: Some("streaming-dev".into()),
            kubeconfig_yaml: None,
            server: Some("https://127.0.0.1:6443".into()),
            token: Some("secret-token".into()),
            insecure_skip_tls_verify: true,
        })
        .unwrap();
        let kubeconfig = Kubeconfig::from_yaml(&yaml).unwrap();
        let entry = ClusterRegistry::entry_for_context(
            kubeconfig,
            false,
            "streaming-dev".into(),
            None,
            Some("streaming-dev".into()),
            None,
        )
        .unwrap();
        let id = entry.id.clone();
        let registry = ClusterRegistry {
            entries: RwLock::new(std::collections::HashMap::from([(id.clone(), entry)])),
            clients: RwLock::new(std::collections::HashMap::new()),
            proxy: RwLock::new(RuntimeProxy::default()),
            disconnected: RwLock::new(std::collections::HashSet::new()),
            imports_path: std::env::temp_dir().join("kubehive-streaming-client-test.json"),
        };

        let request_config = registry
            .client_config(&id, Some(Duration::from_secs(45)))
            .await
            .unwrap();
        let streaming_config = registry.client_config(&id, None).await.unwrap();
        assert_eq!(request_config.read_timeout, Some(Duration::from_secs(45)));
        assert_eq!(streaming_config.read_timeout, None);
    }

    #[test]
    fn maps_duplicate_contexts_to_the_first_kubeconfig_file() {
        let dir = std::env::temp_dir().join(format!("kubehive-context-source-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let first = dir.join("first.yaml");
        let second = dir.join("second.yaml");
        for (path, server) in [
            (&first, "https://first.example.com"),
            (&second, "https://second.example.com"),
        ] {
            let yaml = manual_kubeconfig_yaml(&ImportClusterRequest {
                display_name: Some("shared".into()),
                kubeconfig_yaml: None,
                server: Some(server.into()),
                token: Some("secret-token".into()),
                insecure_skip_tls_verify: true,
            })
            .unwrap();
            fs::write(path, yaml).unwrap();
        }
        let sources = context_sources_from_paths(vec![first.clone(), second]);
        assert_eq!(sources.get("shared"), Some(&first));
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn renames_default_cluster_in_its_kubeconfig_extension() {
        let dir = std::env::temp_dir().join(format!("kubehive-rename-default-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let source_path = dir.join("config");
        let yaml = manual_kubeconfig_yaml(&ImportClusterRequest {
            display_name: Some("dev".into()),
            kubeconfig_yaml: None,
            server: Some("https://127.0.0.1:6443".into()),
            token: Some("secret-token".into()),
            insecure_skip_tls_verify: true,
        })
        .unwrap();
        fs::write(&source_path, &yaml).unwrap();
        let kubeconfig = Kubeconfig::from_yaml(&yaml).unwrap();
        let entry = ClusterRegistry::entry_for_context(
            kubeconfig,
            false,
            "dev".into(),
            None,
            Some("default:dev".into()),
            Some(source_path.clone()),
        )
        .unwrap();
        let registry = ClusterRegistry {
            entries: RwLock::new(std::collections::HashMap::from([(entry.id.clone(), entry)])),
            clients: RwLock::new(std::collections::HashMap::new()),
            proxy: RwLock::new(RuntimeProxy::default()),
            disconnected: RwLock::new(std::collections::HashSet::from(["default:dev".into()])),
            imports_path: dir.join("clusters.json"),
        };

        let result = registry
            .rename(RenameClusterRequest {
                cluster_id: "default:dev".into(),
                display_name: "  development  ".into(),
            })
            .await
            .unwrap();
        assert_eq!(result.id, "default:dev");
        assert_eq!(result.name, "development");
        assert_eq!(
            registry.entry("default:dev").await.unwrap().display_name,
            "development"
        );

        let saved = Kubeconfig::from_yaml(&fs::read_to_string(&source_path).unwrap()).unwrap();
        let context = saved.contexts[0].context.as_ref().unwrap();
        assert_eq!(
            display_name_from_context(context).as_deref(),
            Some("development")
        );
        assert_eq!(saved.contexts[0].name, "dev");
        assert_eq!(saved.current_context.as_deref(), Some("dev"));
        let restarted = ClusterRegistry::entry_for_context(
            saved,
            false,
            "dev".into(),
            None,
            Some("default:dev".into()),
            Some(source_path),
        )
        .unwrap();
        assert_eq!(restarted.display_name, "development");
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn renames_imported_cluster_in_persisted_kubeconfig_record() {
        let dir = std::env::temp_dir().join(format!("kubehive-rename-import-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let imports_path = dir.join("clusters.json");
        let yaml = manual_kubeconfig_yaml(&ImportClusterRequest {
            display_name: Some("imported-dev".into()),
            kubeconfig_yaml: None,
            server: Some("https://127.0.0.1:6443".into()),
            token: Some("secret-token".into()),
            insecure_skip_tls_verify: true,
        })
        .unwrap();
        let kubeconfig = Kubeconfig::from_yaml(&yaml).unwrap();
        let id = "import:test".to_string();
        let entry = ClusterRegistry::entry_for_context(
            kubeconfig,
            true,
            "imported-dev".into(),
            Some("imported-dev".into()),
            Some(id.clone()),
            None,
        )
        .unwrap();
        let registry = ClusterRegistry {
            entries: RwLock::new(std::collections::HashMap::from([(id.clone(), entry)])),
            clients: RwLock::new(std::collections::HashMap::new()),
            proxy: RwLock::new(RuntimeProxy::default()),
            disconnected: RwLock::new(std::collections::HashSet::from([id.clone()])),
            imports_path: imports_path.clone(),
        };
        registry
            .write_imports(&[PersistedImport {
                id: id.clone(),
                display_name: "imported-dev".into(),
                context: "imported-dev".into(),
                kubeconfig_yaml: yaml,
            }])
            .unwrap();

        registry
            .rename(RenameClusterRequest {
                cluster_id: id.clone(),
                display_name: "renamed import".into(),
            })
            .await
            .unwrap();
        let records: Vec<PersistedImport> =
            serde_json::from_str(&fs::read_to_string(imports_path).unwrap()).unwrap();
        assert_eq!(records[0].display_name, "renamed import");
        let saved = Kubeconfig::from_yaml(&records[0].kubeconfig_yaml).unwrap();
        assert_eq!(
            display_name_from_context(saved.contexts[0].context.as_ref().unwrap()).as_deref(),
            Some("renamed import")
        );
        assert_eq!(
            registry.entry(&id).await.unwrap().display_name,
            "renamed import"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn infers_common_clouds() {
        assert_eq!(infer_provider("https://x.eks.amazonaws.com"), "AWS");
        assert_eq!(infer_provider("https://x.azmk8s.io"), "Azure");
        assert_eq!(infer_provider("https://localhost:6443"), "Local");
    }
}
