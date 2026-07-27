use serde::Serialize;
#[cfg(not(target_os = "macos"))]
use tauri::Manager;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendInfo {
    name: &'static str,
    runtime: &'static str,
    kubernetes_client: &'static str,
}

/// Thin Tauri boundary. Cluster sessions and kube watch streams stay in Rust;
/// the webview receives normalized snapshots and incremental events.
#[tauri::command]
fn backend_info() -> BackendInfo {
    BackendInfo {
        name: "KubeHive",
        runtime: "Tokio",
        kubernetes_client: "kube-rs",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            #[cfg(not(target_os = "macos"))]
            if let Some(window) = _app.get_webview_window("main") {
                window.set_decorations(false)?;
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![backend_info])
        .run(tauri::generate_context!())
        .expect("failed to run KubeHive");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_data_plane() {
        let info = backend_info();
        assert_eq!(info.kubernetes_client, "kube-rs");
        assert_eq!(info.runtime, "Tokio");
    }
}
