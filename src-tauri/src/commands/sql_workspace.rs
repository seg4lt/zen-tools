//! Database Explorer SQL-file workspace commands.
//!
//! Mirrors the http-runner project pattern (`commands::files`) but
//! stores its own list of project roots so the two tools don't share a
//! folder list. SQL workspace roots are persisted as
//! `Preferences.sql_workspace_dirs`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;
use tokio::sync::Mutex;
use tracing::warn;
use zen_types::prelude::*;

use crate::commands::preferences::{load_preferences, write_preferences};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// One project's slice of the discovered tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSqlProject {
    /// Absolute path of the project root.
    pub root: String,
    /// Basename of the root, used as the section header.
    pub name: String,
    /// Pre-order DFS list of `.sql` files + intermediate directories.
    pub items: Vec<FileTreeItem>,
}

/// List currently-open SQL workspace roots.
#[tauri::command]
pub async fn sql_workspace_list(
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<String>> {
    Ok(state
        .lock()
        .await
        .sql_workspace_dirs
        .iter()
        .map(|p| p.display().to_string())
        .collect())
}

/// Add a SQL project root. Validates the path, dedupes, and persists.
/// Returns the canonical list after the update.
#[tauri::command]
pub async fn sql_workspace_add(
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

    let dirs: Vec<PathBuf> = {
        let mut s = state.lock().await;
        if !s.sql_workspace_dirs.iter().any(|p| p == &path) {
            s.sql_workspace_dirs.push(path.clone());
        }
        s.sql_workspace_dirs.clone()
    };

    persist(&app_handle, &dirs);
    Ok(dirs.iter().map(|p| p.display().to_string()).collect())
}

/// Remove a SQL project root by exact path match.
#[tauri::command]
pub async fn sql_workspace_remove(
    path: String,
    app_handle: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<String>> {
    let target = PathBuf::from(&path);
    let dirs: Vec<PathBuf> = {
        let mut s = state.lock().await;
        s.sql_workspace_dirs.retain(|p| p != &target);
        s.sql_workspace_dirs.clone()
    };

    persist(&app_handle, &dirs);
    Ok(dirs.iter().map(|p| p.display().to_string()).collect())
}

/// Walk every open SQL project root and return its discovered file
/// tree. Hidden folders (`.git`, `.idea`, etc.), `target`, and
/// `node_modules` are skipped, mirroring the http-runner pattern.
#[tauri::command]
pub async fn sql_workspace_discover(
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<DiscoveredSqlProject>> {
    let dirs = state.lock().await.sql_workspace_dirs.clone();
    let mut projects = Vec::with_capacity(dirs.len());
    for dir in dirs {
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| dir.display().to_string());
        projects.push(DiscoveredSqlProject {
            root: dir.display().to_string(),
            name,
            items: collect(&dir),
        });
    }
    Ok(projects)
}

fn persist(app: &AppHandle, dirs: &[PathBuf]) {
    let mut prefs = load_preferences(app).unwrap_or_default();
    prefs.sql_workspace_dirs = dirs.iter().map(|p| p.display().to_string()).collect();
    if let Err(e) = write_preferences(app, &prefs) {
        warn!(?e, "failed to persist sql workspace dirs");
    }
}

fn collect(dir: &Path) -> Vec<FileTreeItem> {
    let mut items = Vec::new();
    walk(dir, &mut items, 0);
    items
}

fn walk(dir: &Path, items: &mut Vec<FileTreeItem>, depth: usize) {
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
            if has_sql(&path) {
                items.push(FileTreeItem {
                    name: name.clone(),
                    path: path.to_string_lossy().to_string(),
                    is_dir: true,
                    depth,
                    expanded: true,
                    file_type: FileType::Directory,
                });
                walk(&path, items, depth + 1);
            }
        } else if name.ends_with(".sql") {
            items.push(FileTreeItem {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                depth,
                expanded: false,
                file_type: FileType::SqlFile,
            });
        }
    }
}

fn has_sql(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            if let Some(name) = path.file_name() {
                if name.to_string_lossy().ends_with(".sql") {
                    return true;
                }
            }
        } else if path.is_dir()
            && !path
                .file_name()
                .map(|n| n.to_string_lossy().starts_with('.'))
                .unwrap_or(true)
            && has_sql(&path)
        {
            return true;
        }
    }
    false
}

// ── Filesystem mutations (used by the right-click context menu) ─────────

/// Create an empty `.sql` file inside `parent_dir`. If `name` has no
/// extension, `.sql` is appended; an existing extension (e.g. `.psql`)
/// is kept verbatim. Sibling-name collisions are resolved by appending
/// ` 2`, ` 3`, … to the stem.
#[tauri::command]
pub async fn sql_workspace_create_file(
    parent_dir: String,
    name: String,
) -> AppResult<String> {
    let parent = PathBuf::from(&parent_dir);
    if !parent.is_dir() {
        return Err(AppError::BadRequest(format!(
            "parent is not a directory: {}",
            parent.display()
        )));
    }
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("name cannot be empty".into()));
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(AppError::BadRequest(
            "name must not contain path separators".into(),
        ));
    }
    let with_ext = if Path::new(trimmed).extension().is_none() {
        format!("{trimmed}.sql")
    } else {
        trimmed.to_string()
    };
    let resolved = unique_sibling(&parent, &with_ext);
    tokio::fs::write(&resolved, b"")
        .await
        .map_err(|e| AppError::Other(format!("create sql file: {e}")))?;
    Ok(resolved.to_string_lossy().to_string())
}

/// Create a directory inside `parent_dir`. Same dedup rules as
/// [`sql_workspace_create_file`].
#[tauri::command]
pub async fn sql_workspace_create_dir(
    parent_dir: String,
    name: String,
) -> AppResult<String> {
    let parent = PathBuf::from(&parent_dir);
    if !parent.is_dir() {
        return Err(AppError::BadRequest(format!(
            "parent is not a directory: {}",
            parent.display()
        )));
    }
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("name cannot be empty".into()));
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(AppError::BadRequest(
            "name must not contain path separators".into(),
        ));
    }
    let resolved = unique_sibling(&parent, trimmed);
    tokio::fs::create_dir(&resolved)
        .await
        .map_err(|e| AppError::Other(format!("create directory: {e}")))?;
    Ok(resolved.to_string_lossy().to_string())
}

/// Rename a file or directory in place. `new_name` is the **basename
/// only**. Files keep their original extension when the user doesn't
/// supply one (so `foo.sql` → `bar` becomes `bar.sql`).
#[tauri::command]
pub async fn sql_workspace_rename(
    old_path: String,
    new_name: String,
) -> AppResult<String> {
    let old = PathBuf::from(&old_path);
    if !old.exists() {
        return Err(AppError::BadRequest(format!(
            "path does not exist: {}",
            old.display()
        )));
    }
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("name cannot be empty".into()));
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(AppError::BadRequest(
            "name must not contain path separators".into(),
        ));
    }
    let parent = old
        .parent()
        .ok_or_else(|| AppError::Other("path has no parent".into()))?
        .to_path_buf();

    let final_name = if old.is_file() {
        let has_ext = Path::new(trimmed).extension().is_some();
        if has_ext {
            trimmed.to_string()
        } else {
            match old.extension().and_then(|e| e.to_str()) {
                Some(ext) => format!("{trimmed}.{ext}"),
                None => trimmed.to_string(),
            }
        }
    } else {
        trimmed.to_string()
    };

    let new_path = parent.join(&final_name);
    if new_path == old {
        return Ok(old.to_string_lossy().to_string());
    }
    if new_path.exists() {
        return Err(AppError::BadRequest(format!(
            "a sibling named `{}` already exists",
            final_name
        )));
    }
    tokio::fs::rename(&old, &new_path)
        .await
        .map_err(|e| AppError::Other(format!("rename: {e}")))?;
    Ok(new_path.to_string_lossy().to_string())
}

/// Move a file or directory to the OS trash. Uses the `trash` crate so
/// a misclick is recoverable (same semantics as Finder's "Move to
/// Trash").
#[tauri::command]
pub async fn sql_workspace_delete_to_trash(path: String) -> AppResult<()> {
    let pb = PathBuf::from(&path);
    if !pb.exists() {
        return Err(AppError::BadRequest(format!(
            "path does not exist: {}",
            pb.display()
        )));
    }
    tokio::task::spawn_blocking(move || trash::delete(&pb))
        .await
        .map_err(|e| AppError::Other(format!("join trash worker: {e}")))?
        .map_err(|e| AppError::Other(format!("move to trash: {e}")))?;
    Ok(())
}

/// Find a sibling name that doesn't yet exist by appending ` 2`, ` 3`,
/// … to the file stem. Mirrors the helper used by the markdown tool.
fn unique_sibling(parent: &Path, name: &str) -> PathBuf {
    let candidate = parent.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled")
        .to_string();
    let ext = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{s}"))
        .unwrap_or_default();
    for n in 2..=9999 {
        let c = parent.join(format!("{stem} {n}{ext}"));
        if !c.exists() {
            return c;
        }
    }
    parent.join(format!(
        "{stem}-{}{ext}",
        chrono::Utc::now().timestamp_millis()
    ))
}
