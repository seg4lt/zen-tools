//! File-discovery and working-directory commands.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;
use tracing::debug;
use zen_parser::{find_env_file, parse_env_file};
use zen_types::prelude::*;

/// One project's slice of the discovered tree. The frontend renders one
/// such block per open project root.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredProject {
    /// Absolute path of the project root.
    pub root: String,
    /// Basename of the root, used as the section header.
    pub name: String,
    /// Pre-order DFS list of files + directories under this root.
    pub items: Vec<FileTreeItem>,
}

/// Recursively discover `.http` / `.rest` / `.env.json` / perf YAML files
/// under every open project root. Returns one `DiscoveredProject` per
/// root; the result is empty when no projects have been added.
#[tauri::command]
pub async fn discover_http_files(
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<DiscoveredProject>> {
    let dirs = state.lock().await.working_dirs.clone();
    let mut projects = Vec::with_capacity(dirs.len());
    for dir in dirs {
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| dir.display().to_string());
        projects.push(DiscoveredProject {
            root: dir.display().to_string(),
            name,
            items: collect_http_files(&dir),
        });
    }
    Ok(projects)
}

/// Walk upward from `directory` to find an env file (returns absolute path).
#[tauri::command]
pub async fn find_env_file_command(directory: String) -> AppResult<Option<String>> {
    Ok(find_env_file(Path::new(&directory)).map(|p| p.display().to_string()))
}

/// Add a project root. Validates the path, dedupes, and (when this is
/// the **first** project) auto-loads `http-client.env.json` and picks a
/// sensible default environment so `{{host}}` resolves immediately for
/// the common single-project case.
///
/// Returns the canonical list of open projects after the update.
#[tauri::command]
pub async fn add_working_dir(
    path: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<String>> {
    let path = PathBuf::from(&path);
    if !path.exists() {
        return Err(AppError::BadRequest(format!(
            "directory does not exist: {}",
            path.display()
        )));
    }

    let mut s = state.lock().await;
    let already = s.working_dirs.iter().any(|p| p == &path);
    if !already {
        let was_empty = s.working_dirs.is_empty();
        s.working_dirs.push(path.clone());

        // First project added → match the old single-dir behaviour and
        // auto-load whatever env file lives at the root, picking a
        // sensible default name. Later additions don't touch env state.
        if was_empty {
            if let Some(env_path) = find_env_file(&path) {
                match std::fs::read_to_string(&env_path) {
                    Ok(content) => match parse_env_file(env_path.clone(), &content) {
                        Ok(env) => s.global_env_file = Some(env),
                        Err(e) => debug!(?e, "failed to parse global env file"),
                    },
                    Err(e) => debug!(?e, "failed to read global env file"),
                }
            }
            if s.selected_env.is_none() {
                if let Some(name) = s.global_env_file.as_ref().and_then(pick_default_env) {
                    s.selected_env = Some(EnvName::new(name));
                }
            }
        }
    }
    Ok(s.working_dirs.iter().map(|p| p.display().to_string()).collect())
}

/// Remove a project root by exact path match. Does **not** clear env
/// state, cookies, or extracted vars — those are env-keyed, not
/// project-keyed, and survive project removal.
#[tauri::command]
pub async fn remove_working_dir(
    path: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<String>> {
    let target = PathBuf::from(&path);
    let mut s = state.lock().await;
    s.working_dirs.retain(|p| p != &target);
    Ok(s.working_dirs.iter().map(|p| p.display().to_string()).collect())
}

/// List currently-open project roots.
#[tauri::command]
pub async fn list_working_dirs(
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<String>> {
    Ok(state
        .lock()
        .await
        .working_dirs
        .iter()
        .map(|p| p.display().to_string())
        .collect())
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
        } else if name == "perf.variable.yaml" || name == "perf.variable.yml" {
            // Perf variable files are matched *before* the generic perf
            // pattern so they get tagged with their own file type.
            items.push(FileTreeItem {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                depth,
                expanded: false,
                file_type: FileType::PerfVariableFile,
            });
        } else if name == "perf.yaml"
            || name == "perf.yml"
            || name.ends_with(".perf.yaml")
            || name.ends_with(".perf.yml")
        {
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
                    || name.ends_with(".perf.yml")
                    || name == "perf.variable.yaml"
                    || name == "perf.variable.yml"
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
