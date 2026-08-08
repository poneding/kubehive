mod container_files;
mod helm;
mod metrics;
mod models;
mod node_files;
mod nodes;
mod overview;
mod port_forward;
mod registry;
mod remote_command;
mod resources;
mod terminal;

use chrono::Utc;
use helm::HelmCatalog;
use models::*;
use node_files::NodeFileSessionRegistry;
use port_forward::PortForwardRegistry;
use registry::ClusterRegistry;
use resources::WatchRegistry;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::{
    image::Image,
    ipc::Channel,
    menu::MenuBuilder,
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, State, WebviewWindow, Window,
    WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use terminal::{ContainerTerminalRegistry, TerminalRegistry};
use tokio::sync::RwLock as AsyncRwLock;
use tokio_util::sync::CancellationToken;

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
    states: Arc<Mutex<SavedWindowStates>>,
    persist_request: mpsc::Sender<()>,
}

/// How long the debounced disk write waits for geometry events to settle.
const WINDOW_STATE_PERSIST_DEBOUNCE: Duration = Duration::from_millis(200);

/// Geometry accessors shared by `Window` (used by window events) and
/// `WebviewWindow` (used by the exit handler), so the state store can accept
/// either handle.
trait WindowGeometry {
    fn label(&self) -> &str;
    fn is_maximized(&self) -> tauri::Result<bool>;
    fn outer_size(&self) -> tauri::Result<PhysicalSize<u32>>;
    fn outer_position(&self) -> tauri::Result<PhysicalPosition<i32>>;
}

impl WindowGeometry for Window {
    fn label(&self) -> &str {
        Window::label(self)
    }
    fn is_maximized(&self) -> tauri::Result<bool> {
        Window::is_maximized(self)
    }
    fn outer_size(&self) -> tauri::Result<PhysicalSize<u32>> {
        Window::outer_size(self)
    }
    fn outer_position(&self) -> tauri::Result<PhysicalPosition<i32>> {
        Window::outer_position(self)
    }
}

impl WindowGeometry for WebviewWindow {
    fn label(&self) -> &str {
        WebviewWindow::label(self)
    }
    fn is_maximized(&self) -> tauri::Result<bool> {
        WebviewWindow::is_maximized(self)
    }
    fn outer_size(&self) -> tauri::Result<PhysicalSize<u32>> {
        WebviewWindow::outer_size(self)
    }
    fn outer_position(&self) -> tauri::Result<PhysicalPosition<i32>> {
        WebviewWindow::outer_position(self)
    }
}

#[derive(Default)]
struct ClusterConnectionRegistry {
    operations: AsyncRwLock<HashMap<String, CancellationToken>>,
}

impl ClusterConnectionRegistry {
    async fn begin(&self, operation_id: String) -> CancellationToken {
        let token = CancellationToken::new();
        if let Some(previous) = self
            .operations
            .write()
            .await
            .insert(operation_id, token.clone())
        {
            previous.cancel();
        }
        token
    }

    async fn finish(&self, operation_id: &str) {
        self.operations.write().await.remove(operation_id);
    }

    async fn cancel(&self, operation_id: &str) -> bool {
        let token = self.operations.read().await.get(operation_id).cloned();
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }
}

impl WindowStateStore {
    fn load(path: PathBuf) -> Self {
        let states = Arc::new(Mutex::new(
            fs::read_to_string(&path)
                .ok()
                .and_then(|contents| serde_json::from_str(&contents).ok())
                .unwrap_or_default(),
        ));
        let (persist_request, requests) = mpsc::channel();
        let worker_path = path.clone();
        let worker_states = states.clone();
        // Debounced disk writes: geometry events arrive continuously while
        // the window is dragged or resized, so write once they settle instead
        // of on every event. This keeps the latest state on disk no matter
        // how the app quits — macOS Cmd+Q destroys windows before any exit
        // event fires, so the exit handler alone cannot cover it.
        std::thread::spawn(move || {
            while requests.recv().is_ok() {
                loop {
                    while requests.try_recv().is_ok() {}
                    std::thread::sleep(WINDOW_STATE_PERSIST_DEBOUNCE);
                    if requests.try_recv().is_err() {
                        break;
                    }
                }
                persist_to(&worker_path, &worker_states);
            }
        });
        Self {
            path,
            states,
            persist_request,
        }
    }

    fn request_persist(&self) {
        let _ = self.persist_request.send(());
    }

    fn set_maximized(&self, window: &impl WindowGeometry, maximized: bool) {
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
        let size = PhysicalSize::new(state.width, state.height);
        window.set_size(size)?;
        let saved = PhysicalPosition::new(state.x, state.y);
        let position = self.visible_position(window, saved, size);
        window.set_position(position)?;
        if state.maximized {
            window.maximize()?;
        }
        Ok(())
    }

    /// Pick a restore position that keeps the window reachable: the saved one
    /// when it still intersects a connected monitor, otherwise the saved size
    /// centered on the primary monitor (an unplugged external display must not
    /// strand the window off-screen).
    fn visible_position(
        &self,
        window: &WebviewWindow,
        saved: PhysicalPosition<i32>,
        size: PhysicalSize<u32>,
    ) -> PhysicalPosition<i32> {
        let Ok(monitors) = window.available_monitors() else {
            return saved;
        };
        let Ok(primary) = window.primary_monitor() else {
            return saved;
        };
        let monitors = monitors
            .iter()
            .map(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                (position.x, position.y, size.width, size.height)
            })
            .collect::<Vec<_>>();
        let Some(primary) = primary else {
            return saved;
        };
        let primary_position = primary.position();
        let primary_size = primary.size();
        restore_position(
            saved,
            size,
            &monitors,
            (
                primary_position.x,
                primary_position.y,
                primary_size.width,
                primary_size.height,
            ),
        )
    }

    fn capture_bounds(&self, window: &impl WindowGeometry) {
        if window.is_maximized().unwrap_or(false) {
            return;
        }
        self.record_bounds(window);
    }

    fn record_bounds(&self, window: &impl WindowGeometry) {
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

    fn save(&self, window: &impl WindowGeometry) {
        let maximized = window.is_maximized().unwrap_or(false);
        // Never record maximized geometry as the restore bounds — that would
        // leave the window full-screen-sized after unmaximizing. Keep the
        // last non-maximized bounds (or none, falling back to the config
        // defaults on restore) and only remember the maximized flag.
        if !maximized {
            self.capture_bounds(window);
        }
        self.set_maximized(window, maximized);
        self.persist();
    }

    fn persist(&self) {
        persist_to(&self.path, &self.states);
    }
}

fn persist_to(path: &Path, states: &Mutex<SavedWindowStates>) {
    let Ok(states) = states.lock() else {
        return;
    };
    let Ok(contents) = serde_json::to_string_pretty(&*states) else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_ok() {
        let _ = fs::write(path, contents);
    }
}

/// Two axis-aligned monitor/window rectangles overlap when neither is fully
/// to the left, above, right, or below the other.
fn rects_intersect(a: (i32, i32, u32, u32), b: (i32, i32, u32, u32)) -> bool {
    let aw = a.2 as i32;
    let ah = a.3 as i32;
    let bw = b.2 as i32;
    let bh = b.3 as i32;
    a.0 < b.0 + bw && a.0 + aw > b.0 && a.1 < b.1 + bh && a.1 + ah > b.1
}

/// Restore position for a saved window: the saved position when it still
/// intersects a connected monitor, otherwise the saved size centered on the
/// primary monitor so an unplugged external display never strands the window
/// off-screen. Windows larger than the primary monitor sit flush against its
/// top-left corner instead of going negative.
fn restore_position(
    saved: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    monitors: &[(i32, i32, u32, u32)],
    primary: (i32, i32, u32, u32),
) -> PhysicalPosition<i32> {
    let window = (saved.x, saved.y, size.width, size.height);
    if monitors
        .iter()
        .any(|monitor| rects_intersect(window, *monitor))
    {
        return saved;
    }
    let (x, y, width, height) = primary;
    PhysicalPosition::new(
        x + (width.saturating_sub(size.width) / 2) as i32,
        y + (height.saturating_sub(size.height) / 2) as i32,
    )
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

/// Applies a whole-window UI zoom factor (Cmd/Ctrl +/-/0). Session-only and
/// never persisted: every launch starts back at the 1.0 default.
#[tauri::command]
fn set_window_zoom(window: WebviewWindow, factor: f64) -> Result<(), String> {
    if !factor.is_finite() || factor <= 0.0 {
        return Err("zoom factor must be a positive number".into());
    }
    window
        .set_zoom(factor)
        .map_err(|error| format!("failed to set window zoom: {error}"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectedKubeconfig {
    file_name: String,
    contents: String,
}

fn kubeconfig_directory(home_directory: PathBuf) -> PathBuf {
    home_directory.join(".kube")
}

#[tauri::command]
async fn select_kubeconfig_file(
    app: tauri::AppHandle,
) -> Result<Option<SelectedKubeconfig>, String> {
    let kubeconfig_directory = app
        .path()
        .home_dir()
        .map(kubeconfig_directory)
        .map_err(|error| format!("Unable to locate the home directory: {error}"))?;
    let app_handle = app.clone();

    tokio::task::spawn_blocking(move || {
        let selected = app_handle
            .dialog()
            .file()
            .set_title("Select kubeconfig file")
            .set_directory(kubeconfig_directory)
            .add_filter("Kubeconfig", &["yaml", "yml", "config"])
            .blocking_pick_file();
        let Some(path) = selected else {
            return Ok(None);
        };
        let path = path
            .into_path()
            .map_err(|error| format!("Unable to read the selected file path: {error}"))?;
        let contents = fs::read_to_string(&path)
            .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());

        Ok(Some(SelectedKubeconfig {
            file_name,
            contents,
        }))
    })
    .await
    .map_err(|error| format!("Unable to open the kubeconfig file chooser: {error}"))?
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
    forwards: State<'_, Arc<PortForwardRegistry>>,
    terminals: State<'_, Arc<TerminalRegistry>>,
    container_terminals: State<'_, Arc<ContainerTerminalRegistry>>,
    node_files: State<'_, Arc<NodeFileSessionRegistry>>,
    cluster_id: String,
) -> Result<(), String> {
    terminals.stop_cluster(&cluster_id);
    container_terminals.stop_cluster(&cluster_id).await;
    node_files.stop_cluster(registry.inner(), &cluster_id).await;
    registry.remove(&cluster_id).await?;
    forwards.remove_cluster(&cluster_id).await
}

#[tauri::command]
async fn disconnect_cluster(
    registry: State<'_, Arc<ClusterRegistry>>,
    forwards: State<'_, Arc<PortForwardRegistry>>,
    terminals: State<'_, Arc<TerminalRegistry>>,
    container_terminals: State<'_, Arc<ContainerTerminalRegistry>>,
    node_files: State<'_, Arc<NodeFileSessionRegistry>>,
    cluster_id: String,
) -> Result<(), String> {
    terminals.stop_cluster(&cluster_id);
    container_terminals.stop_cluster(&cluster_id).await;
    node_files.stop_cluster(registry.inner(), &cluster_id).await;
    forwards.suspend_cluster(&cluster_id).await;
    registry.disconnect(&cluster_id).await
}

#[tauri::command]
async fn reconnect_cluster(
    registry: State<'_, Arc<ClusterRegistry>>,
    connections: State<'_, Arc<ClusterConnectionRegistry>>,
    forwards: State<'_, Arc<PortForwardRegistry>>,
    cluster_id: String,
    operation_id: String,
) -> Result<ClusterSummary, String> {
    let cancellation = connections.begin(operation_id.clone()).await;
    let connection_result = tokio::select! {
        result = registry.reconnect_and_summary(&cluster_id) => result,
        _ = cancellation.cancelled() => {
            let _ = registry.disconnect(&cluster_id).await;
            Err("Cluster connection cancelled".into())
        }
    };
    let summary = match connection_result {
        Ok(summary) => summary,
        Err(error) => {
            connections.finish(&operation_id).await;
            return Err(error);
        }
    };
    if cancellation.is_cancelled() {
        let _ = registry.disconnect(&cluster_id).await;
        connections.finish(&operation_id).await;
        return Err("Cluster connection cancelled".into());
    }

    let forward_registry = forwards.inner().clone();
    let cluster_registry = registry.inner().clone();
    let resume_forwards = forward_registry.resume_cluster(cluster_registry, &cluster_id);
    tokio::pin!(resume_forwards);
    let result = tokio::select! {
        _ = &mut resume_forwards => Ok(summary),
        _ = cancellation.cancelled() => {
            let _ = registry.disconnect(&cluster_id).await;
            Err("Cluster connection cancelled".into())
        }
    };
    connections.finish(&operation_id).await;
    result
}

#[tauri::command]
async fn cancel_cluster_connection(
    connections: State<'_, Arc<ClusterConnectionRegistry>>,
    operation_id: String,
) -> Result<bool, String> {
    Ok(connections.cancel(&operation_id).await)
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
async fn pod_metrics(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: PodMetricsRequest,
) -> Result<Option<PodMetricsResponse>, String> {
    metrics::pod_metrics(&registry, request).await
}

#[tauri::command]
async fn node_metrics(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: NodeMetricsRequest,
) -> Result<Option<NodeMetricsResponse>, String> {
    metrics::node_metrics(&registry, request).await
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
async fn container_file_context(
    registry: State<'_, Arc<ClusterRegistry>>,
    target: ContainerFileTarget,
) -> Result<ContainerDirectoryContext, String> {
    container_files::directory_context(&registry, target).await
}

#[tauri::command]
async fn list_container_files(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ContainerPathRequest,
) -> Result<Vec<ContainerFileEntry>, String> {
    container_files::list(&registry, request).await
}

#[tauri::command]
async fn read_container_text_file(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ContainerPathRequest,
) -> Result<ContainerTextFile, String> {
    container_files::read_text(&registry, request).await
}

#[tauri::command]
async fn write_container_text_file(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ContainerWriteTextRequest,
) -> Result<(), String> {
    container_files::write_text(&registry, request).await
}

#[tauri::command]
async fn upload_container_file(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ContainerUploadRequest,
) -> Result<(), String> {
    container_files::upload(&registry, request).await
}

#[tauri::command]
async fn create_container_directory(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ContainerPathRequest,
) -> Result<(), String> {
    container_files::create_directory(&registry, request).await
}

#[tauri::command]
async fn create_container_file(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ContainerPathRequest,
) -> Result<(), String> {
    container_files::create_file(&registry, request).await
}

#[tauri::command]
async fn rename_container_path(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ContainerRenameRequest,
) -> Result<(), String> {
    container_files::rename(&registry, request).await
}

#[tauri::command]
async fn move_container_path(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ContainerTransferRequest,
) -> Result<(), String> {
    container_files::move_path(&registry, request).await
}

#[tauri::command]
async fn copy_container_path(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ContainerTransferRequest,
) -> Result<(), String> {
    container_files::copy_path(&registry, request).await
}

#[tauri::command]
async fn delete_container_path(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ContainerPathRequest,
) -> Result<(), String> {
    container_files::delete_path(&registry, request).await
}

#[tauri::command]
async fn delete_container_paths(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ContainerBatchPathRequest,
) -> Result<(), String> {
    container_files::delete_paths(&registry, request).await
}

#[tauri::command]
async fn download_container_path(
    app: tauri::AppHandle,
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ContainerDownloadRequest,
) -> Result<String, String> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| format!("Unable to locate the Downloads directory: {error}"))?;
    container_files::download(&registry, &downloads, request).await
}

#[tauri::command]
async fn download_container_paths(
    app: tauri::AppHandle,
    registry: State<'_, Arc<ClusterRegistry>>,
    request: ContainerBatchDownloadRequest,
) -> Result<String, String> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| format!("Unable to locate the Downloads directory: {error}"))?;
    container_files::download_batch(&registry, &downloads, request).await
}

#[tauri::command]
async fn start_node_file_session(
    registry: State<'_, Arc<ClusterRegistry>>,
    node_files: State<'_, Arc<NodeFileSessionRegistry>>,
    target: NodeFileTarget,
) -> Result<ContainerFileTarget, String> {
    node_files
        .start(registry.inner(), &target.cluster_id, &target.node)
        .await
}

#[tauri::command]
async fn stop_node_file_session(
    registry: State<'_, Arc<ClusterRegistry>>,
    node_files: State<'_, Arc<NodeFileSessionRegistry>>,
    target: NodeFileTarget,
) -> Result<(), String> {
    node_files
        .stop(registry.inner(), &target.cluster_id, &target.node)
        .await;
    Ok(())
}

#[tauri::command]
async fn set_node_unschedulable(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: SetNodeUnschedulableRequest,
) -> Result<(), String> {
    nodes::set_node_unschedulable(
        &registry,
        &request.cluster_id,
        &request.node,
        request.unschedulable,
    )
    .await
}

#[tauri::command]
async fn drain_node(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: DrainNodeRequest,
) -> Result<DrainNodeResult, String> {
    nodes::drain_node(&registry, request).await
}

#[tauri::command]
async fn list_node_taints(
    registry: State<'_, Arc<ClusterRegistry>>,
    target: NodeFileTarget,
) -> Result<Vec<NodeTaintInfo>, String> {
    nodes::list_node_taints(&registry, &target.cluster_id, &target.node).await
}

#[tauri::command]
async fn add_node_taint(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: AddNodeTaintRequest,
) -> Result<Vec<NodeTaintInfo>, String> {
    nodes::add_node_taint(&registry, request).await
}

#[tauri::command]
async fn remove_node_taint(
    registry: State<'_, Arc<ClusterRegistry>>,
    request: RemoveNodeTaintRequest,
) -> Result<Vec<NodeTaintInfo>, String> {
    nodes::remove_node_taint(&registry, request).await
}

#[tauri::command]
async fn start_terminal(
    registry: State<'_, Arc<ClusterRegistry>>,
    terminals: State<'_, Arc<ContainerTerminalRegistry>>,
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
async fn start_local_terminal(
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
    container_terminals: State<'_, Arc<ContainerTerminalRegistry>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    if terminals.write(&session_id, data.clone()).await.is_ok() {
        return Ok(());
    }
    container_terminals.write(&session_id, data).await
}

#[tauri::command]
async fn resize_terminal(
    terminals: State<'_, Arc<TerminalRegistry>>,
    container_terminals: State<'_, Arc<ContainerTerminalRegistry>>,
    session_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    if terminals.resize(&session_id, columns, rows).await.is_ok() {
        return Ok(());
    }
    container_terminals.resize(&session_id, columns, rows).await
}

#[tauri::command]
async fn stop_terminal(
    terminals: State<'_, Arc<TerminalRegistry>>,
    container_terminals: State<'_, Arc<ContainerTerminalRegistry>>,
    session_id: String,
) -> Result<bool, String> {
    if terminals.stop(&session_id).await {
        return Ok(true);
    }
    Ok(container_terminals.stop(&session_id).await)
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
async fn pause_port_forward(
    forwards: State<'_, Arc<PortForwardRegistry>>,
    session_id: String,
) -> Result<PortForwardSession, String> {
    forwards.pause(&session_id).await
}

#[tauri::command]
async fn resume_port_forward(
    registry: State<'_, Arc<ClusterRegistry>>,
    forwards: State<'_, Arc<PortForwardRegistry>>,
    session_id: String,
) -> Result<PortForwardSession, String> {
    forwards
        .inner()
        .clone()
        .resume(registry.inner().clone(), &session_id)
        .await
}

#[tauri::command]
async fn stop_port_forward(
    forwards: State<'_, Arc<PortForwardRegistry>>,
    session_id: String,
) -> Result<bool, String> {
    forwards.stop(&session_id).await
}

fn show_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn emit_tray_action(app: &tauri::AppHandle, action: &str) {
    show_main_window(app);
    let _ = app.emit("kubehive://tray-action", action);
}

fn exit_from_tray(app: &tauri::AppHandle) {
    app.state::<Arc<TerminalRegistry>>().shutdown();
    app.exit(0);
}

/// Dedicated monochrome tray marks (not the padded Dock app icon). macOS uses a
/// black template so the menu bar can invert with the system appearance; Windows
/// and Linux use a light glyph that stays readable on dark notification areas.
fn tray_icon_image() -> tauri::Result<Image<'static>> {
    #[cfg(target_os = "macos")]
    {
        Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Image::from_bytes(include_bytes!("../icons/tray-icon-light.png"))
    }
}

fn create_tray_icon(app: &tauri::App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("tray.open", "Open KubeHive")
        .text("tray.settings", "Settings")
        .text("tray.check-updates", "Check for Updates")
        .text("tray.about", "About KubeHive")
        .separator()
        .text("tray.quit", "Quit KubeHive")
        .build()?;
    let icon = tray_icon_image().or_else(|_| {
        app.default_window_icon()
            .cloned()
            .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))
    })?;
    let mut builder = TrayIconBuilder::with_id("kubehive-tray")
        .icon(icon)
        .tooltip("KubeHive")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray.open" => show_main_window(app),
            "tray.settings" => emit_tray_action(app, "settings"),
            "tray.check-updates" => emit_tray_action(app, "check-updates"),
            "tray.about" => emit_tray_action(app, "about"),
            "tray.quit" => exit_from_tray(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    // macOS menu bar expects a template image so the system can recolor it.
    #[cfg(target_os = "macos")]
    {
        builder = builder.icon_as_template(true);
    }
    builder.build(app)?;
    Ok(())
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
            app.manage(Arc::new(ClusterRegistry::new(config_dir.clone())));
            app.manage(Arc::new(ClusterConnectionRegistry::default()));
            app.manage(Arc::new(WatchRegistry::default()));
            app.manage(Arc::new(TerminalRegistry::default()));
            app.manage(Arc::new(ContainerTerminalRegistry::default()));
            app.manage(Arc::new(NodeFileSessionRegistry::default()));
            app.manage(Arc::new(HelmCatalog::default()));
            app.manage(Arc::new(PortForwardRegistry::new(config_dir)));
            create_tray_icon(app)?;
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|window, event| {
            let window_states = window.app_handle().state::<Arc<WindowStateStore>>();
            match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    window_states.capture_bounds(window);
                    // Maximized state has no dedicated event in Tauri v2
                    // (macOS zoom fires only geometry events), so read the
                    // flag from the geometry change itself.
                    window_states.set_maximized(window, window.is_maximized().unwrap_or(false));
                    window_states.request_persist();
                }
                WindowEvent::CloseRequested { api, .. } => {
                    window_states.save(window);
                    api.prevent_close();
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            backend_info,
            set_window_zoom,
            select_kubeconfig_file,
            list_clusters,
            import_clusters,
            remove_cluster,
            disconnect_cluster,
            reconnect_cluster,
            cancel_cluster_connection,
            probe_cluster,
            rename_cluster,
            set_network_proxy,
            discover_resources,
            list_resources,
            get_resource,
            pod_metrics,
            node_metrics,
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
            container_file_context,
            list_container_files,
            read_container_text_file,
            write_container_text_file,
            upload_container_file,
            create_container_directory,
            create_container_file,
            rename_container_path,
            move_container_path,
            copy_container_path,
            delete_container_path,
            delete_container_paths,
            download_container_path,
            download_container_paths,
            start_node_file_session,
            stop_node_file_session,
            set_node_unschedulable,
            drain_node,
            list_node_taints,
            add_node_taint,
            remove_node_taint,
            start_terminal,
            start_local_terminal,
            write_terminal,
            resize_terminal,
            stop_terminal,
            list_helm_charts,
            cluster_overview,
            start_resource_watch,
            stop_resource_watch,
            list_port_forwards,
            start_port_forward,
            pause_port_forward,
            resume_port_forward,
            stop_port_forward,
        ])
        .build(tauri::generate_context!())
        .expect("failed to run KubeHive")
        .run(|app, event| {
            // Windows are still alive at ExitRequested, so persist the last
            // window state on every quit path: tray Quit (app.exit), macOS
            // Cmd+Q, and OS shutdown. CloseRequested already saved, but
            // quitting without closing the window would otherwise restore a
            // stale copy from disk.
            if matches!(event, RunEvent::ExitRequested { .. }) {
                if let Some(window) = app.get_webview_window("main") {
                    app.state::<Arc<WindowStateStore>>().save(&window);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancels_active_cluster_connection_operations() {
        let registry = ClusterConnectionRegistry::default();
        let token = registry.begin("connect-1".into()).await;
        assert!(!token.is_cancelled());
        assert!(registry.cancel("connect-1").await);
        assert!(token.is_cancelled());
        registry.finish("connect-1").await;
        assert!(!registry.cancel("connect-1").await);
    }

    #[test]
    fn reports_real_data_plane() {
        let info = backend_info();
        assert_eq!(info.kubernetes_client, "kube-rs");
        assert_eq!(info.runtime, "Tokio");
        assert_eq!(info.mode, "native");
    }

    #[test]
    fn starts_kubeconfig_picker_in_user_kube_directory() {
        assert_eq!(
            kubeconfig_directory(PathBuf::from("/home/kubehive")),
            PathBuf::from("/home/kubehive/.kube")
        );
    }

    #[test]
    fn sanitizes_log_download_filename_components() {
        assert_eq!(safe_file_component("payments/api"), "payments-api");
        assert_eq!(safe_file_component("../"), "pod");
        assert_eq!(safe_file_component("worker_1.2"), "worker_1.2");
    }

    #[test]
    fn keeps_saved_position_when_it_still_intersects_a_monitor() {
        let position = restore_position(
            PhysicalPosition::new(-120, 84),
            PhysicalSize::new(1280, 820),
            &[(0, 0, 1920, 1080)],
            (0, 0, 1920, 1080),
        );
        assert_eq!((position.x, position.y), (-120, 84));
    }

    #[test]
    fn centers_window_on_primary_monitor_when_saved_position_is_off_screen() {
        let position = restore_position(
            PhysicalPosition::new(4000, 4000),
            PhysicalSize::new(1280, 820),
            &[(0, 0, 1920, 1080)],
            (0, 0, 1920, 1080),
        );
        assert_eq!((position.x, position.y), (320, 130));
    }

    #[test]
    fn flushes_oversized_window_to_primary_monitor_corner() {
        let position = restore_position(
            PhysicalPosition::new(4000, 4000),
            PhysicalSize::new(2560, 1440),
            &[(0, 0, 1920, 1080)],
            (0, 0, 1920, 1080),
        );
        assert_eq!((position.x, position.y), (0, 0));
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
