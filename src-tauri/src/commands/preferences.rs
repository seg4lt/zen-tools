//! Persisted UI preferences — stored as JSON inside the OS-specific app
//! data directory (resolved by Tauri):
//!
//! | OS      | Path (typical)                                                  |
//! |---------|-----------------------------------------------------------------|
//! | macOS   | `~/Library/Application Support/com.zen.tools/preferences.json`  |
//! | Linux   | `~/.local/share/com.zen.tools/preferences.json`                 |
//! | Windows | `%APPDATA%\com.zen.tools\preferences.json`                      |
//!
//! Only includes user-facing UI state (open project list, expanded
//! folders). Anything sensitive or per-environment lives elsewhere.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Persisted UI state. New optional fields can be added without
/// breaking older preferences files thanks to `#[serde(default)]`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    /// Open project roots, in user-defined order.
    #[serde(default)]
    pub working_dirs: Vec<String>,
    /// Folders the user has explicitly toggled. The string is the
    /// absolute path; if it's prefixed with `-:` the folder was
    /// explicitly *collapsed* (versus the default-expanded behaviour).
    #[serde(default)]
    pub expanded_paths: Vec<String>,
}

/// Resolve the preferences file path. Creates the parent directory if
/// it doesn't exist yet.
fn preferences_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("resolve app_data_dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("preferences.json"))
}

/// Read the preferences JSON. Returns defaults when the file is
/// missing — the very first launch must not fail.
#[tauri::command]
pub async fn get_preferences(app: AppHandle) -> AppResult<Preferences> {
    let path = preferences_path(&app)?;
    if !path.exists() {
        return Ok(Preferences::default());
    }
    let content = std::fs::read_to_string(&path)?;
    // Be lenient: if the file got corrupted, log it but keep working
    // by returning defaults instead of crashing the app.
    match serde_json::from_str::<Preferences>(&content) {
        Ok(prefs) => Ok(prefs),
        Err(e) => {
            tracing::warn!(?e, path = %path.display(), "preferences parse failed; using defaults");
            Ok(Preferences::default())
        }
    }
}

/// Persist the preferences JSON atomically. Writes to a sibling
/// `.tmp` file then renames into place so a crash mid-write can't
/// leave a half-written file.
#[tauri::command]
pub async fn save_preferences(prefs: Preferences, app: AppHandle) -> AppResult<()> {
    let path = preferences_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&prefs)?;
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}
