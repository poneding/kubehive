mod helm;
mod models;
mod overview;
mod port_forward;
mod registry;
mod resources;
mod terminal;

use chrono::Utc;
use helm::HelmCatalog;
use models::*;
use port_forward::PortForwardRegistry;
use registry::ClusterRegistry;
use resources::WatchRegistry;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{
    ipc::Channel, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow, Window,
    WindowEvent,
};
use terminal::TerminalRegistry;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
struct SavedWindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
struct SavedWindowStates {
    windows: HashMap<String, SavedWindowState>,
}

struct WindowStateStore {
    path: PathBuf,
    states: Mutex<SavedWindowStates>,
}

impl WindowStateStore {
    fn load(path: PathBuf) -> Self {
        let states = fs::read_to_string(&path)
            .ok()
            .and_then(|contents| serde_json::from_str(&contents).ok())
            .unwrap_or_default();
        Self {
            path,
            states: Mutex::new(states),
        }
    }

    fn restore(&self, window: &WebviewWindow) -> tauri::Result<()> {
        let state = self
            .states
            .lock()
            .ok()
            .and_then(|states| states.windows.get(window.label()).cloned());
        let Some(state) = state.filter(|state| state.width > 0 && state.height > 0) else {
            return Ok(());
        };
        window.set_size(PhysicalSize::new(state.width, state.height))?;
        window.set_position(PhysicalPosition::new(state.x, state.y))?;
        if state.maximized {
            window.maximize()?;
        }
        Ok(())
    }

    fn capture_bounds(&self, window: &Window) {
        if window.is_maximized().unwrap_or(false) {
            return;
        }
        self.record_bounds(window);
    }

    fn record_bounds(&self, window: &Window) {
        let (Ok(size), Ok(position)) = (window.outer_size(), window.outer_position()) else {
            return;
        };
        if size.width == 0 || size.height == 0 {
            return;
        }
        if let Ok(mut states) = self.states.lock() {
            states.windows.insert(
                window.label().to_string(),
                SavedWindowState {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                    maximized: false,
                },
            );
        }
    }

    fn save(&self, window: &Window) {
        let maximized = window.is_maximized().unwrap_or(false);
        let needs_bounds = self
            .states
            .lock()
            .ok()
            .map(|states| match states.windows.get(window.label()) {
                Some(state) => state.width == 0 || state.height == 0,
                None => true,
            })
            .unwrap_or(false);
        if maximized && needs_bounds {
            self.record_bounds(window);
        } else if !maximized {
            self.capture_bounds(window);
        }
        if let Ok(mut states) = self.states.lock() {
            let state = states
                .windows
                .entry(window.label().to_string())
                .or_insert_with(|| SavedWindowState {
                    maximized,
                    ..Default::default()
                });
            state.maximized = maximized;
        }
        self.persist();
    }

    fn persist(&self) {
        let Ok(states) = self.states.lock() else {
            return;
        };
        let Ok(contents) = serde_json::to_string_pretty(&*states) else {
            return;
        };
        let Some(parent) = self.path.parent() else {
            return;
        };
        if fs::create_dir_all(parent).is_ok() {
            let _ = fs::write(&self.path, contents);
        }
    }
}

#[tauri::command]
fn backend_info() -> BackendInfo {
    BackendInfo {
        name: "KubeHive",
        runtime: "Tokio",
        kubernetes_client: "kube-rs",
        mode: "native",
    }
}

#[tauri::command]
async fn list_clusters(
    registry: State<'_, Arc<ClusterRegistry>>,
) -> Result<Vec<ClusterSummary>, String> {
    Ok(registry.list_clusters().await)
}

#[tauri::command]
async fn import_clusters(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ImportClusterRequest,
) -> Result<Vec<ClusterSummary>, String> {
    registry.import(request).await
}

#[tauri::command]
async fn remove_cluster(
    registry: State<'_, Arc<ClusterRegistry>>,
    cluster_id: String,
) -> Result<(), String> {
    registry.remove(&cluster_id).await
}

#[tauri::command]
async fn disconnect_cluster(
    registry: State<'_, Arc<ClusterRegistry>>,
    cluster_id: String,
) -> Result<(), String> {
    registry.disconnect(&cluster_id).await
}

#[tauri::command]
async fn reconnect_cluster(
    registry: State<'_, Arc<ClusterRegistry>>,
    cluster_id: String,
) -> Result<ClusterSummary, String> {
    registry.reconnect_and_summary(&cluster_id).await
}

#[tauri::command]
async fn probe_cluster(
    registry: State<'_, Arc<ClusterRegistry>>,
    cluster_id: String,
) -> Result<ClusterSummary, String> {
    registry.probe(&cluster_id).await
}

#[tauri::command]
async fn rename_cluster(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: RenameClusterRequest,
) -> Result<RenameClusterResult, String> {
    registry.rename(request).await
}

#[tauri::command]
async fn set_network_proxy(
    registry: State<'_, Arc<ClusterRegistry>>,
    catalog: State<'_, Arc<HelmCatalog>>,
    settings: ProxySettings,
) -> Result<(), String> {
    catalog
        .set_proxy(settings.enabled, settings.url.as_deref())
        .await?;
    registry.set_proxy(settings).await
}

#[tauri::command]
async fn discover_resources(
    registry: State<'_, Arc<ClusterRegistry>>,
    cluster_id: String,
) -> Result<Vec<ApiResourceDescriptor>, String> {
    resources::discover_resources(&registry, &cluster_id).await
}

#[tauri::command]
async fn list_resources(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ResourceListRequest,
) -> Result<ResourceListResponse, String> {
    resources::list_resources(&registry, request).await
}

#[tauri::command]
async fn get_resource(
    registry: State<'_, Arc<ClusterRegistry>>,
    target: ResourceTarget,
) -> Result<ResourceDetail, String> {
    resources::get_resource(&registry, target).await
}

#[tauri::command]
async fn apply_manifest(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ApplyManifestRequest,
) -> Result<ResourceDetail, String> {
    resources::apply_manifest(&registry, request).await
}

#[tauri::command]
async fn delete_resource(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: DeleteResourceRequest,
) -> Result<(), String> {
    resources::delete_resource(&registry, request).await
}

#[tauri::command]
async fn delete_resources(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: BulkDeleteResourcesRequest,
) -> Result<BulkActionResult, String> {
    resources::delete_resources(&registry, request).await
}

#[tauri::command]
async fn evict_pod(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: EvictPodRequest,
) -> Result<(), String> {
    resources::evict_pod(&registry, request).await
}

#[tauri::command]
async fn evict_pods(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: BulkEvictPodsRequest,
) -> Result<BulkActionResult, String> {
    resources::evict_pods(&registry, request).await
}

#[tauri::command]
async fn scale_resource(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ScaleResourceRequest,
) -> Result<ResourceDetail, String> {
    resources::scale_resource(&registry, request).await
}

#[tauri::command]
async fn restart_resource(
    registry: State<'_, Arc<ClusterRegistry>>,
    target: ResourceTarget,
) -> Result<ResourceDetail, String> {
    resources::restart_resource(&registry, target).await
}

#[tauri::command]
async fn pod_logs(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: PodLogsRequest,
) -> Result<String, String> {
    resources::pod_logs(&registry, request).await
}

#[tauri::command]
async fn download_logs(
    app: tauri::AppHandle,
    request: DownloadLogsRequest,
) -> Result<String, String> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| format!("Unable to locate the Downloads directory: {error}"))?;
    tokio::fs::create_dir_all(&downloads)
        .await
        .map_err(|error| format!("Unable to create the Downloads directory: {error}"))?;
    let pod = safe_file_component(&request.pod);
    let container = request
        .container
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(safe_file_component);
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S");
    let filename = match container {
        Some(container) => format!("{pod}-{container}-{timestamp}.log"),
        None => format!("{pod}-{timestamp}.log"),
    };
    let path = downloads.join(filename);
    tokio::fs::write(&path, request.content.as_bytes())
        .await
        .map_err(|error| format!("Unable to write the log file: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn safe_file_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let sanitized = sanitized.trim_matches(['-', '.']);
    if sanitized.is_empty() {
        "pod".to_string()
    } else {
        sanitized.chars().take(100).collect()
    }
}

#[tauri::command]
async fn exec_pod(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ExecPodRequest,
) -> Result<ExecResult, String> {
    resources::exec_pod(&registry, request).await
}

#[tauri::command]
async fn start_terminal(
    registry: State<'_, Arc<ClusterRegistry>>,
    terminals: State<'_, Arc<TerminalRegistry>>,
    request: StartTerminalRequest,
    on_event: Channel<TerminalEvent>,
) -> Result<String, String> {
    terminals
        .inner()
        .clone()
        .start(registry.inner().clone(), request, on_event)
        .await
}

#[tauri::command]
async fn write_terminal(
    terminals: State<'_, Arc<TerminalRegistry>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    terminals.write(&session_id, data).await
}

#[tauri::command]
async fn resize_terminal(
    terminals: State<'_, Arc<TerminalRegistry>>,
    session_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    terminals.resize(&session_id, columns, rows).await
}

#[tauri::command]
async fn stop_terminal(
    terminals: State<'_, Arc<TerminalRegistry>>,
    session_id: String,
) -> Result<bool, String> {
    Ok(terminals.stop(&session_id).await)
}

#[tauri::command]
async fn list_helm_charts(
    catalog: State<'_, Arc<HelmCatalog>>,
    refresh: Option<bool>,
) -> Result<Vec<HelmChartSummary>, String> {
    catalog.list(refresh.unwrap_or(false)).await
}

#[tauri::command]
async fn cluster_overview(
    registry: State<'_, Arc<ClusterRegistry>>,
    cluster_id: String,
) -> Result<ClusterOverview, String> {
    overview::cluster_overview(&registry, &cluster_id).await
}

#[tauri::command]
async fn start_resource_watch(
    registry: State<'_, Arc<ClusterRegistry>>,
    watches: State<'_, Arc<WatchRegistry>>,
    request: ResourceListRequest,
    on_event: Channel<ResourceWatchMessage>,
) -> Result<String, String> {
    resources::start_watch(
        registry.inner().clone(),
        watches.inner().clone(),
        request,
        on_event,
    )
    .await
}

#[tauri::command]
async fn stop_resource_watch(
    watches: State<'_, Arc<WatchRegistry>>,
    subscription_id: String,
) -> Result<bool, String> {
    Ok(watches.stop(&subscription_id).await)
}

#[tauri::command]
async fn list_port_forwards(
    forwards: State<'_, Arc<PortForwardRegistry>>,
    cluster_id: Option<String>,
) -> Result<Vec<PortForwardSession>, String> {
    Ok(forwards.list(cluster_id.as_deref()).await)
}

#[tauri::command]
async fn start_port_forward(
    registry: State<'_, Arc<ClusterRegistry>>,
    forwards: State<'_, Arc<PortForwardRegistry>>,
    request: StartPortForwardRequest,
) -> Result<PortForwardSession, String> {
    forwards
        .inner()
        .clone()
        .start(registry.inner().clone(), request)
        .await
}

#[tauri::command]
async fn stop_port_forward(
    forwards: State<'_, Arc<PortForwardRegistry>>,
    session_id: String,
) -> Result<bool, String> {
    Ok(forwards.stop(&session_id).await)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(not(target_os = "macos"))]
            if let Some(window) = app.get_webview_window("main") {
                window.set_decorations(false)?;
            }
            let config_dir = app.path().app_config_dir()?;
            let window_states =
                Arc::new(WindowStateStore::load(config_dir.join("window-state.json")));
            if let Some(window) = app.get_webview_window("main") {
                window_states.restore(&window)?;
            }
            app.manage(window_states);
            app.manage(Arc::new(ClusterRegistry::new(config_dir)));
            app.manage(Arc::new(WatchRegistry::default()));
            app.manage(Arc::new(TerminalRegistry::default()));
            app.manage(Arc::new(HelmCatalog::default()));
            app.manage(Arc::new(PortForwardRegistry::default()));
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            let window_states = window.app_handle().state::<Arc<WindowStateStore>>();
            match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    window_states.capture_bounds(window)
                }
                WindowEvent::CloseRequested { .. } => window_states.save(window),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            backend_info,
            list_clusters,
            import_clusters,
            remove_cluster,
            disconnect_cluster,
            reconnect_cluster,
            probe_cluster,
            rename_cluster,
            set_network_proxy,
            discover_resources,
            list_resources,
            get_resource,
            apply_manifest,
            delete_resource,
            delete_resources,
            evict_pod,
            evict_pods,
            scale_resource,
            restart_resource,
            pod_logs,
            download_logs,
            exec_pod,
            start_terminal,
            write_terminal,
            resize_terminal,
            stop_terminal,
            list_helm_charts,
            cluster_overview,
            start_resource_watch,
            stop_resource_watch,
            list_port_forwards,
            start_port_forward,
            stop_port_forward,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run KubeHive");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_real_data_plane() {
        let info = backend_info();
        assert_eq!(info.kubernetes_client, "kube-rs");
        assert_eq!(info.runtime, "Tokio");
        assert_eq!(info.mode, "native");
    }

    #[test]
    fn sanitizes_log_download_filename_components() {
        assert_eq!(safe_file_component("payments/api"), "payments-api");
        assert_eq!(safe_file_component("../"), "pod");
        assert_eq!(safe_file_component("worker_1.2"), "worker_1.2");
    }

    #[test]
    fn persists_saved_window_bounds() {
        let path = std::env::temp_dir().join(format!(
            "kubehive-window-state-{}.json",
            uuid::Uuid::new_v4()
        ));
        let store = WindowStateStore::load(path.clone());
        store.states.lock().unwrap().windows.insert(
            "main".to_string(),
            SavedWindowState {
                x: -120,
                y: 84,
                width: 1280,
                height: 820,
                maximized: true,
            },
        );
        store.persist();

        let reloaded = WindowStateStore::load(path.clone());
        let saved = reloaded
            .states
            .lock()
            .unwrap()
            .windows
            .get("main")
            .cloned()
            .unwrap();
        assert_eq!(
            (saved.x, saved.y, saved.width, saved.height, saved.maximized),
            (-120, 84, 1280, 820, true)
        );
        let _ = fs::remove_file(path);
    }
}
