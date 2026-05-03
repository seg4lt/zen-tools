//! File-discovery and working-directory commands.

use crate::commands::preferences::{load_preferences, write_preferences};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;
use tracing::{debug, warn};
use zen_parser::{find_env_file, parse_env_file, pick_default_env};
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
    app_handle: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<String>> {
    let path = PathBuf::from(&path);
    if !path.exists() {
        return Err(AppError::BadRequest(format!(
            "directory does not exist: {}",
            path.display()
        )));
    }

    let working_dirs: Vec<PathBuf> = {
        let mut s = state.lock().await;
        let already = s.working_dirs.iter().any(|p| p == &path);
        if !already {
            let was_empty = s.working_dirs.is_empty();
            s.working_dirs.push(path.clone());

            // First project added → match the old single-dir behaviour
            // and auto-load whatever env file lives at the root,
            // picking a sensible default name. Later additions don't
            // touch env state.
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
        s.working_dirs.clone()
    };

    persist_project_list(&app_handle, &working_dirs);
    Ok(working_dirs.iter().map(|p| p.display().to_string()).collect())
}

/// Remove a project root by exact path match. Does **not** clear env
/// state, cookies, or extracted vars — those are env-keyed, not
/// project-keyed, and survive project removal.
#[tauri::command]
pub async fn remove_working_dir(
    path: String,
    app_handle: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<String>> {
    let target = PathBuf::from(&path);
    let working_dirs: Vec<PathBuf> = {
        let mut s = state.lock().await;
        s.working_dirs.retain(|p| p != &target);
        s.working_dirs.clone()
    };

    persist_project_list(&app_handle, &working_dirs);
    Ok(working_dirs.iter().map(|p| p.display().to_string()).collect())
}

/// Read the on-disk preferences, mutate `working_dirs`, and write back
/// atomically. The frontend used to do this — but a frontend crash
/// between `add_working_dir` and the disk write would lose the
/// project. Owning persistence on the backend collapses both calls
/// into a single command, so the user can never see "I added a
/// project but it's gone after restart".
fn persist_project_list(app: &AppHandle, working_dirs: &[PathBuf]) {
    let mut prefs = load_preferences(app).unwrap_or_default();
    prefs.working_dirs = working_dirs
        .iter()
        .map(|p| p.display().to_string())
        .collect();
    if let Err(e) = write_preferences(app, &prefs) {
        warn!(?e, "failed to persist project list");
    }
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

/// Returns the [`FileType`] for a relevant http-runner file given its
/// lowercased basename, or `None` if the file is not interesting.
///
/// Order matters: `perf.variable.yaml` is checked **before** the generic
/// `perf.yaml` pattern so it gets the dedicated [`FileType::PerfVariableFile`]
/// tag.
fn classify_http_file(name: &str) -> Option<FileType> {
    if name.ends_with(".http") || name.ends_with(".rest") {
        Some(FileType::HttpFile)
    } else if name.ends_with(".env.json") {
        Some(FileType::EnvFile)
    } else if name == "perf.variable.yaml" || name == "perf.variable.yml" {
        Some(FileType::PerfVariableFile)
    } else if name == "perf.yaml"
        || name == "perf.yml"
        || name.ends_with(".perf.yaml")
        || name.ends_with(".perf.yml")
    {
        Some(FileType::PerfFile)
    } else {
        None
    }
}

/// Recursively collect HTTP, env, and perf files from `dir`.
/// Empty directories (no relevant descendant) are pruned.
fn collect_http_files(dir: &Path) -> Vec<FileTreeItem> {
    let cfg = zen_fs::WalkConfig {
        include_file: &|name| classify_http_file(name).is_some(),
        include_dir: &|p| zen_fs::dir_contains(p, |n| classify_http_file(n).is_some()),
        ..Default::default()
    };
    zen_fs::walk_tree(dir, &cfg)
        .into_iter()
        .map(|e| {
            let file_type = if e.is_dir {
                FileType::Directory
            } else {
                // Re-classify on the lowercased basename. Falls back to
                // `HttpFile` defensively, though `include_file` already
                // ensures classification will succeed.
                classify_http_file(&e.name.to_ascii_lowercase()).unwrap_or(FileType::HttpFile)
            };
            FileTreeItem {
                name: e.name,
                path: e.path.to_string_lossy().to_string(),
                is_dir: e.is_dir,
                depth: e.depth,
                expanded: e.is_dir,
                file_type,
            }
        })
        .collect()
}
