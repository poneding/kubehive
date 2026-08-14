//! System font enumeration.
//!
//! The font pickers in Settings show the faces that are actually installed on
//! the current operating system instead of a hard-coded list, and each entry
//! carries a monospace flag so the monospace picker can surface mono faces
//! first.

use std::collections::BTreeMap;

use serde::Serialize;

/// A single installed font family.
#[derive(Debug, Clone, Serialize)]
pub struct SystemFontFamily {
    /// Family name exactly as the OS reports it; safe to use in a CSS font stack.
    pub name: String,
    /// Whether at least one face of this family is monospaced.
    pub monospace: bool,
}

/// Lists every font family installed on the host, deduplicated and sorted.
///
/// Runs on a blocking thread because enumeration scans font directories; the
/// webview receives a plain JSON array of `SystemFontFamily` objects.
#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<SystemFontFamily>, String> {
    let families = tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut families: BTreeMap<String, bool> = BTreeMap::new();
        for face in db.faces() {
            for (name, _language) in &face.families {
                families
                    .entry(name.clone())
                    .and_modify(|monospace| *monospace = *monospace || face.monospaced)
                    .or_insert(face.monospaced);
            }
        }
        families
            .into_iter()
            .map(|(name, monospace)| SystemFontFamily { name, monospace })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|error| format!("font enumeration failed: {error}"))?;
    Ok(families)
}
