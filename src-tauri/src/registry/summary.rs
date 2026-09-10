use super::*;

struct SummaryStats {
    version: String,
    nodes: usize,
    ready_nodes: usize,
}

impl ClusterRegistry {
    pub(super) async fn summary(&self, entry: ClusterEntry) -> ClusterSummary {
        if self.disconnected.read().await.contains(&entry.id) {
            return self.format_summary(&entry, None, None).await;
        }

        match tokio::time::timeout(Duration::from_secs(8), self.collect_stats(&entry)).await {
            Ok(Ok(stats)) => {
                let summary = self.format_summary(&entry, Some(&stats), None).await;
                self.record_state(&entry.id, &stats.version).await;
                summary
            }
            Ok(Err(error)) => self.format_summary(&entry, None, Some(error)).await,
            Err(_) => {
                self.format_summary(&entry, None, Some("Connection timed out".into()))
                    .await
            }
        }
    }

    async fn collect_stats(&self, entry: &ClusterEntry) -> Result<SummaryStats, String> {
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
        Ok(SummaryStats {
            version: format!("v{}", version.git_version.trim_start_matches('v')),
            nodes: list.items.len(),
            ready_nodes: list.items.iter().filter(|node| node_ready(node)).count(),
        })
    }

    async fn format_summary(
        &self,
        entry: &ClusterEntry,
        stats: Option<&SummaryStats>,
        error: Option<String>,
    ) -> ClusterSummary {
        let mut summary = ClusterSummary {
            id: entry.id.clone(),
            name: entry.display_name.clone(),
            provider: infer_provider(&entry.server).to_string(),
            region: server_region(&entry.server),
            version: "unknown".into(),
            status: "offline".into(),
            nodes: 0,
            cpu: 0,
            memory: 0,
            context: entry.context.clone(),
            server: entry.server.clone(),
            default_namespace: entry.default_namespace.clone(),
            imported: entry.imported,
            source_path: entry
                .source_path
                .as_ref()
                .map(|path| display_home_path(path)),
            disconnected: false,
            error,
        };

        if let Some(stats) = stats {
            summary.version = stats.version.clone();
            summary.nodes = stats.nodes as u32;
            summary.status = if stats.nodes == 0 || stats.ready_nodes == stats.nodes {
                "healthy"
            } else {
                "warning"
            }
            .into();
        } else if self.disconnected.read().await.contains(&entry.id) {
            summary.disconnected = true;
            summary.error = None;
        } else {
            self.apply_stored_state(&entry.id, &mut summary).await;
        }

        if summary.disconnected {
            self.apply_stored_state(&entry.id, &mut summary).await;
        }
        summary
    }

    /// Persist the last-known version after a successful live probe. Writes the
    /// state file only when the value actually changed.
    pub(super) async fn record_state(&self, id: &str, version: &str) {
        let mut states = self.states.write().await;
        if states.get(id).and_then(|state| state.version.as_deref()) == Some(version) {
            return;
        }
        states.insert(
            id.to_string(),
            ClusterState {
                version: Some(version.to_string()),
            },
        );
        if let Err(error) = persist_states(&self.state_path, &states) {
            eprintln!("Unable to persist cluster state for {id}: {error}");
        }
    }

    /// Fill a summary with the last-known version when the live probe did not
    /// succeed, so disconnected or unreachable clusters keep their version.
    pub(super) async fn apply_stored_state(&self, id: &str, summary: &mut ClusterSummary) {
        if let Some(version) = self
            .states
            .read()
            .await
            .get(id)
            .and_then(|state| state.version.clone())
        {
            summary.version = version;
        }
    }
}
