//! Startup window appearance.
//!
//! The webview paints only after the page and its CSS arrive, so until then
//! the native window shows whatever background the window layer provides.
//! KubeHive's default (white) background flashed on every launch for users
//! whose configured theme is dark. The frontend persists the configured
//! application theme here (`appearance.json` in the app config directory)
//! whenever it changes, and the window is painted with the matching color
//! during `setup`, before the webview content can render.

use serde::Deserialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, WebviewWindow};

/// Dark app-shell base color (`#0c0e12`, src/index.css `.app-shell`).
const DARK_BACKGROUND: tauri::window::Color = tauri::window::Color(12, 14, 18, 255);
/// Light app-shell base color (`#f3f5f7`, src/index.css `.theme-light .app-shell`).
const LIGHT_BACKGROUND: tauri::window::Color = tauri::window::Color(243, 245, 247, 255);

#[derive(Debug, Deserialize)]
struct SavedTheme {
    theme: Option<String>,
}

fn appearance_file(config_dir: &Path) -> PathBuf {
    config_dir.join("appearance.json")
}

/// Persists the configured application theme so the next launch can paint the
/// native window background before the webview loads. The theme string is one
/// of `"system" | "light" | "dark"`; `"system"` is resolved against the OS
/// theme at startup so OS changes between sessions keep working.
#[tauri::command]
pub fn set_app_theme(app: AppHandle, theme: String) -> Result<(), String> {
    if !matches!(theme.as_str(), "system" | "light" | "dark") {
        return Err(format!("unknown theme: {theme}"));
    }
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let path = appearance_file(&config_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, format!("{{\"theme\":\"{theme}\"}}")).map_err(|error| error.to_string())
}

/// Background color for the main window on this launch. Missing or corrupt
/// saved state (and the `"system"` preference) resolve against the OS theme.
pub fn window_background(app: &AppHandle, window: &WebviewWindow) -> tauri::window::Color {
    let saved = app
        .path()
        .app_config_dir()
        .ok()
        .map(|config_dir| appearance_file(&config_dir))
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str::<SavedTheme>(&json).ok())
        .and_then(|state| state.theme);
    match saved.as_deref() {
        Some("light") => LIGHT_BACKGROUND,
        Some("dark") => DARK_BACKGROUND,
        // Default and "system": follow the operating system theme.
        _ => match window.theme() {
            Ok(tauri::Theme::Light) => LIGHT_BACKGROUND,
            _ => DARK_BACKGROUND,
        },
    }
}
