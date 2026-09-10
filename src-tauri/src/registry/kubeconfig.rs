use super::*;

pub(crate) fn terminal_kubeconfig_for_entry(entry: &ClusterEntry) -> Result<String, String> {
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

pub(super) fn kubeconfig_paths() -> Vec<PathBuf> {
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

pub(super) fn default_context_sources() -> HashMap<String, PathBuf> {
    context_sources_from_paths(kubeconfig_paths())
}

pub(super) fn context_sources_from_paths(
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

pub(super) fn display_name_from_context(context: &kube::config::Context) -> Option<String> {
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

pub(super) fn set_context_display_name(
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

pub(super) fn validate_display_name(value: &str) -> Result<String, String> {
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

pub(super) fn manual_kubeconfig_yaml(request: &ImportClusterRequest) -> Result<String, String> {
    let server = request
        .server
        .as_deref()
        .and_then(|value| {
            let uri = value.parse::<http::Uri>().ok()?;
            (uri.scheme_str()
                .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https"))
                && uri.authority().is_some())
            .then_some(value)
        })
        .ok_or_else(|| "A valid HTTPS Kubernetes API server URL is required".to_string())?;
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
