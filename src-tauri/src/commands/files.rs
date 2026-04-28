//! File-discovery and working-directory commands.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;
use tracing::debug;
use zen_parser::{find_env_file, parse_env_file, PerfConfig};
use zen_types::prelude::*;

/// Recursively discover `.http` / `.rest` / `.env.json` / `perf.yaml` files
/// under the working directory, sorted directory-first. Returns an empty
/// list when no working directory is selected.
#[tauri::command]
pub async fn discover_http_files(
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<FileTreeItem>> {
    let Some(working_dir) = state.lock().await.working_dir.clone() else {
        return Ok(Vec::new());
    };
    Ok(collect_http_files(&working_dir))
}

/// Recursively discover perf YAML files under the working directory.
#[tauri::command]
pub async fn discover_perf_files(
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<FileTreeItem>> {
    let Some(working_dir) = state.lock().await.working_dir.clone() else {
        return Ok(Vec::new());
    };
    Ok(PerfConfig::discover_perf_file_tree(&working_dir))
}

/// Walk upward from `directory` to find an env file (returns absolute path).
#[tauri::command]
pub async fn find_env_file_command(directory: String) -> AppResult<Option<String>> {
    Ok(find_env_file(Path::new(&directory)).map(|p| p.display().to_string()))
}

/// Set a new working directory, clearing every cached state piece.
/// Auto-loads `http-client.env.json` if found and pre-selects a sensible
/// default environment (`development` → `dev` → first alphabetical).
#[tauri::command]
pub async fn set_working_dir(
    path: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Option<String>> {
    let path = PathBuf::from(&path);
    if !path.exists() {
        return Err(AppError::BadRequest(format!(
            "directory does not exist: {}",
            path.display()
        )));
    }

    let mut s = state.lock().await;
    s.working_dir = Some(path.clone());
    s.file_registry.clear();
    s.global_env_file = None;
    s.local_env_file = None;
    s.selected_env = None;
    s.extracted_vars.clear();
    s.cookies.clear();
    s.last_results.clear();

    if let Some(env_path) = find_env_file(&path) {
        match std::fs::read_to_string(&env_path) {
            Ok(content) => match parse_env_file(env_path.clone(), &content) {
                Ok(env) => s.global_env_file = Some(env),
                Err(e) => debug!(?e, "failed to parse global env file"),
            },
            Err(e) => debug!(?e, "failed to read global env file"),
        }
    }

    // Auto-select a default env so `{{host}}` etc. resolve right away.
    let chosen = s.global_env_file.as_ref().and_then(pick_default_env);
    if let Some(name) = chosen.clone() {
        s.selected_env = Some(EnvName::new(name));
    }

    Ok(chosen)
}

/// Choose a sensible default environment from the loaded env file.
/// Preference order: `development` → `dev` → first alphabetical name.
fn pick_default_env(env: &EnvironmentFile) -> Option<String> {
    let names = env.env_names();
    if names.iter().any(|n| n == "development") {
        return Some("development".to_string());
    }
    if names.iter().any(|n| n == "dev") {
        return Some("dev".to_string());
    }
    names.into_iter().next()
}

/// Read the current working directory, or `None` if none is set.
#[tauri::command]
pub async fn get_working_dir(
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Option<String>> {
    Ok(state
        .lock()
        .await
        .working_dir
        .as_ref()
        .map(|p| p.display().to_string()))
}

/// Show a native directory picker. Returns the selected path or `None` if
/// the user cancelled.
#[tauri::command]
pub async fn pick_directory(app_handle: AppHandle) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app_handle.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });

    match rx.await {
        Ok(Some(folder)) => Ok(Some(folder.to_string())),
        Ok(None) => Ok(None),
        Err(_) => Ok(None),
    }
}

/// Recursively collect HTTP, env, and perf files from `dir`.
fn collect_http_files(dir: &Path) -> Vec<FileTreeItem> {
    let mut items = Vec::new();
    collect_recursive(dir, &mut items, 0);
    items
}

fn collect_recursive(dir: &Path, items: &mut Vec<FileTreeItem>, depth: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    entries.sort_by(|a, b| {
        let a_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let b_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.file_name().cmp(&b.file_name()),
        }
    });

    for entry in entries {
        let path = entry.path();
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        if name.starts_with('.') || name == "target" || name == "node_modules" {
            continue;
        }

        if path.is_dir() {
            if has_relevant_files(&path) {
                items.push(FileTreeItem {
                    name: name.clone(),
                    path: path.to_string_lossy().to_string(),
                    is_dir: true,
                    depth,
                    expanded: true,
                    file_type: FileType::Directory,
                });
                collect_recursive(&path, items, depth + 1);
            }
        } else if name.ends_with(".http") || name.ends_with(".rest") {
            items.push(FileTreeItem {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                depth,
                expanded: false,
                file_type: FileType::HttpFile,
            });
        } else if name.ends_with(".env.json") {
            items.push(FileTreeItem {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                depth,
                expanded: false,
                file_type: FileType::EnvFile,
            });
        } else if name == "perf.yaml" || name == "perf.yml" || name.ends_with(".perf.yaml") {
            items.push(FileTreeItem {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                depth,
                expanded: false,
                file_type: FileType::PerfFile,
            });
        }
    }
}

fn has_relevant_files(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            if let Some(name) = path.file_name() {
                let name = name.to_string_lossy();
                if name.ends_with(".http")
                    || name.ends_with(".rest")
                    || name.ends_with(".env.json")
                    || name == "perf.yaml"
                    || name == "perf.yml"
                    || name.ends_with(".perf.yaml")
                {
                    return true;
                }
            }
        } else if path.is_dir()
            && !path
                .file_name()
                .map(|n| n.to_string_lossy().starts_with('.'))
                .unwrap_or(true)
            && has_relevant_files(&path)
        {
            return true;
        }
    }
    false
}
