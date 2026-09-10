use super::*;

impl ClusterRegistry {
    /// Imports contexts from a kubeconfig (or a manual server/token), persists private copies,
    /// and returns offline summaries. Imported records are written before the in-memory entries become usable.
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
        let source_path = managed_kubeconfigs_dir_from_imports_path(&self.imports_path)
            .join(format!("{}.yaml", Uuid::new_v4()));
        write_private_kubeconfig(&source_path, &yaml)?;
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
                Some(source_path.clone()),
            )
            .ok_or_else(|| format!("Context {context} references a missing cluster"))?;
            records.push(PersistedImport {
                id: id.clone(),
                display_name: entry.display_name.clone(),
                context,
                kubeconfig_yaml: yaml.clone(),
                source_path: Some(source_path.clone()),
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

    /// Removes an imported cluster and its private kubeconfig.
    /// Default kubeconfig contexts are rejected: they must be removed from the kubeconfig itself.
    pub async fn remove(&self, id: &str) -> Result<(), String> {
        let entry = self.entry(id).await?;
        if !entry.imported {
            return Err("Default kubeconfig contexts cannot be deleted; remove them from kubeconfig instead".into());
        }
        self.entries.write().await.remove(id);
        self.disconnected.write().await.remove(id);
        if self.states.write().await.remove(id).is_some() {
            let states = self.states.read().await.clone();
            persist_states(&self.state_path, &states)?;
        }
        self.invalidate(Some(id)).await;
        let records = self.persisted_imports().await;
        let removed_source_path = records
            .iter()
            .find(|record| record.id == id)
            .and_then(|record| record.source_path.clone());
        let retained = records
            .into_iter()
            .filter(|record| record.id != id)
            .collect::<Vec<_>>();
        self.write_imports(&retained)?;
        if let Some(path) = removed_source_path.filter(|path| {
            !retained
                .iter()
                .any(|record| record.source_path.as_ref() == Some(path))
        }) {
            if let Err(error) = fs::remove_file(&path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!(
                        "Unable to remove imported kubeconfig {}: {error}",
                        path.display()
                    ));
                }
            }
        }
        Ok(())
    }

    pub(super) async fn persisted_imports(&self) -> Vec<PersistedImport> {
        fs::read_to_string(&self.imports_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub(super) fn write_imports(&self, records: &[PersistedImport]) -> Result<(), String> {
        write_persisted_imports(&self.imports_path, records)
    }
}

pub(super) fn managed_kubeconfigs_dir(config_dir: &Path) -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| config_dir.to_path_buf())
        .join(".kubehive")
        .join("clusters")
}

pub(super) fn managed_kubeconfigs_dir_from_imports_path(imports_path: &Path) -> PathBuf {
    managed_kubeconfigs_dir(imports_path.parent().unwrap_or_else(|| Path::new(".")))
}

pub(super) fn managed_kubeconfig_path(directory: &Path, id: &str) -> PathBuf {
    let filename = id
        .strip_prefix("import:")
        .filter(|value| Uuid::parse_str(value).is_ok())
        .unwrap_or("");
    let filename = if filename.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        filename.to_string()
    };
    directory.join(format!("{filename}.yaml"))
}

pub(super) fn materialize_imported_kubeconfigs(
    records: &mut [PersistedImport],
    directory: &Path,
) -> bool {
    let mut changed = false;
    for record in records {
        match record.source_path.clone() {
            Some(path) if path.is_file() => {}
            Some(path) => {
                if let Err(error) = write_private_kubeconfig(&path, &record.kubeconfig_yaml) {
                    eprintln!(
                        "Unable to restore imported kubeconfig {} during startup: {error}",
                        path.display()
                    );
                }
            }
            None => {
                let path = managed_kubeconfig_path(directory, &record.id);
                if let Err(error) = write_private_kubeconfig(&path, &record.kubeconfig_yaml) {
                    eprintln!(
                        "Unable to materialize imported kubeconfig {} during startup: {error}",
                        path.display()
                    );
                } else {
                    record.source_path = Some(path);
                    changed = true;
                }
            }
        }
    }
    changed
}

pub(super) fn write_private_kubeconfig(path: &Path, yaml: &str) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| {
        format!(
            "Imported kubeconfig path {} has no parent directory",
            path.display()
        )
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create imported kubeconfig directory: {error}"))?;
    set_private_directory_permissions(parent)?;
    fs::write(path, yaml).map_err(|error| {
        format!(
            "Unable to save imported kubeconfig {}: {error}",
            path.display()
        )
    })?;
    set_private_permissions(path)
}

pub(super) fn write_persisted_imports(
    imports_path: &Path,
    records: &[PersistedImport],
) -> Result<(), String> {
    if let Some(parent) = imports_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create app config directory: {error}"))?;
    }
    let text = serde_json::to_string_pretty(records).map_err(|error| error.to_string())?;
    fs::write(imports_path, text)
        .map_err(|error| format!("Unable to save imported clusters: {error}"))?;
    set_private_permissions(imports_path)
}

pub(super) fn persist_states(
    state_path: &Path,
    states: &HashMap<String, ClusterState>,
) -> Result<(), String> {
    if let Some(parent) = state_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create app config directory: {error}"))?;
    }
    let text = serde_json::to_string_pretty(states).map_err(|error| error.to_string())?;
    fs::write(state_path, text)
        .map_err(|error| format!("Unable to save cluster state: {error}"))?;
    set_private_permissions(state_path)
}
