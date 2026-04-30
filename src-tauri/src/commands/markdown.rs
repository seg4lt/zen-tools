//! Tauri command surface for the Markdown editor tool.
//!
//! Lifecycle:
//! 1. `markdown_list_vaults` returns the persisted vault folders.
//! 2. `markdown_add_vault` / `markdown_remove_vault` mutate that list
//!    and persist atomically through the existing prefs pipeline.
//! 3. `markdown_discover_files` walks every vault and returns one
//!    `MarkdownVaultDto` per root, each carrying a pre-order DFS list
//!    of `.md` / `.markdown` entries (directories included so the tree
//!    can render section headers).
//! 4. `markdown_save_pasted_image` writes a clipboard image's bytes
//!    next to the open document and returns the relative path the
//!    editor should insert as `![…](…)`.  This is the headline feature
//!    that makes "paste an image" feel right.
//! 5. `markdown_recent_files` / `markdown_push_recent` keep a bounded
//!    ring of recently-opened files for the quick switcher.

use crate::commands::preferences::{load_preferences, write_preferences};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tracing::warn;

/// Maximum number of entries kept in the recent-files ring.  Anything
/// older than this gets dropped on the next push.
const RECENT_FILES_CAP: usize = 30;

/// One file/dir entry in a vault's pre-order DFS list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownFileItem {
    /// Display name (basename — `notes.md`, `Daily Notes`, …).
    pub name: String,
    /// Absolute filesystem path.
    pub path: String,
    /// `true` for directories.
    pub is_dir: bool,
    /// Indent depth — `0` is a top-level child of the vault root.
    pub depth: usize,
    /// Coarse type — drives the icon and click behaviour in the UI.
    /// `"markdown"` rows open in the editor; `"image"` rows are
    /// visual-only.
    pub kind: String,
}

/// One vault's slice of the discovered tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownVaultDto {
    /// Absolute path of the vault root.
    pub root: String,
    /// Basename of the root, used as the section header.
    pub name: String,
    /// Pre-order DFS list of files + directories under this root.
    pub items: Vec<MarkdownFileItem>,
}

// ────────────────────────────────────────────────────────────────────────
// Vault list (persisted)
// ────────────────────────────────────────────────────────────────────────

/// Return the persisted vault list.
#[tauri::command]
pub async fn markdown_list_vaults(app: AppHandle) -> AppResult<Vec<String>> {
    let prefs = load_preferences(&app).unwrap_or_default();
    Ok(prefs.markdown_vault_dirs)
}

/// Add a vault folder.  Validates the path, dedupes, and persists.
/// Returns the canonical list after the update.
#[tauri::command]
pub async fn markdown_add_vault(
    path: String,
    app: AppHandle,
) -> AppResult<Vec<String>> {
    let pb = PathBuf::from(&path);
    if !pb.exists() {
        return Err(AppError::BadRequest(format!(
            "directory does not exist: {}",
            pb.display()
        )));
    }
    if !pb.is_dir() {
        return Err(AppError::BadRequest(format!(
            "not a directory: {}",
            pb.display()
        )));
    }

    let mut prefs = load_preferences(&app).unwrap_or_default();
    if !prefs.markdown_vault_dirs.iter().any(|p| p == &path) {
        prefs.markdown_vault_dirs.push(path);
    }
    let out = prefs.markdown_vault_dirs.clone();
    if let Err(e) = write_preferences(&app, &prefs) {
        warn!(?e, "failed to persist markdown vault list");
    }
    Ok(out)
}

/// Remove a vault folder by exact path.
#[tauri::command]
pub async fn markdown_remove_vault(
    path: String,
    app: AppHandle,
) -> AppResult<Vec<String>> {
    let mut prefs = load_preferences(&app).unwrap_or_default();
    prefs.markdown_vault_dirs.retain(|p| p != &path);
    let out = prefs.markdown_vault_dirs.clone();
    if let Err(e) = write_preferences(&app, &prefs) {
        warn!(?e, "failed to persist markdown vault list");
    }
    Ok(out)
}

// ────────────────────────────────────────────────────────────────────────
// File discovery
// ────────────────────────────────────────────────────────────────────────

/// Walk every vault and return its `.md` / `.markdown` tree.  Empty
/// vaults still come back with `items: []`.
#[tauri::command]
pub async fn markdown_discover_files(
    vaults: Vec<String>,
) -> AppResult<Vec<MarkdownVaultDto>> {
    let mut out = Vec::with_capacity(vaults.len());
    for v in vaults {
        let pb = PathBuf::from(&v);
        let name = pb
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| v.clone());
        let mut items = Vec::new();
        collect_markdown(&pb, &mut items, 0);
        out.push(MarkdownVaultDto {
            root: v,
            name,
            items,
        });
    }
    Ok(out)
}

fn collect_markdown(dir: &Path, items: &mut Vec<MarkdownFileItem>, depth: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
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

        // Skip dotfiles and well-known noise.  Users routinely keep
        // node-modules / .git directories inside their vaults; walking
        // them is both slow and useless.
        if name.starts_with('.')
            || name == "node_modules"
            || name == "target"
            || name == "dist"
            || name == "build"
        {
            continue;
        }

        if path.is_dir() {
            // Only emit directories that hold at least one markdown
            // or image descendant — keeps the tree quiet for unrelated
            // folders, but still surfaces `pasted/` and any siblings
            // that exist purely for attachments.
            if has_included_descendant(&path) {
                items.push(MarkdownFileItem {
                    name: name.clone(),
                    path: path.to_string_lossy().to_string(),
                    is_dir: true,
                    depth,
                    kind: "directory".to_string(),
                });
                collect_markdown(&path, items, depth + 1);
            }
        } else if is_markdown(&name) {
            items.push(MarkdownFileItem {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                depth,
                kind: "markdown".to_string(),
            });
        } else if is_image(&name) {
            items.push(MarkdownFileItem {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                depth,
                kind: "image".to_string(),
            });
        }
    }
}

fn is_markdown(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".mdown")
        || lower.ends_with(".mkd")
}

fn is_image(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp")
        || lower.ends_with(".svg")
        || lower.ends_with(".avif")
}

fn has_included_descendant(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            if let Some(name) = path.file_name() {
                let n = name.to_string_lossy();
                if is_markdown(&n) || is_image(&n) {
                    return true;
                }
            }
        } else if path.is_dir() {
            if let Some(n) = path.file_name() {
                let n = n.to_string_lossy();
                if n.starts_with('.')
                    || n == "node_modules"
                    || n == "target"
                    || n == "dist"
                    || n == "build"
                {
                    continue;
                }
            }
            if has_included_descendant(&path) {
                return true;
            }
        }
    }
    false
}

// ────────────────────────────────────────────────────────────────────────
// Recent files (bounded ring, persisted)
// ────────────────────────────────────────────────────────────────────────

/// Read the persisted recent-files ring (most-recent first).
#[tauri::command]
pub async fn markdown_recent_files(app: AppHandle) -> AppResult<Vec<String>> {
    let prefs = load_preferences(&app).unwrap_or_default();
    Ok(prefs.markdown_recent_files)
}

/// Push `path` to the front of the ring; dedupe, then truncate to the
/// cap.  Returns the updated ring so callers can update local state
/// without an extra round-trip.
#[tauri::command]
pub async fn markdown_push_recent(
    path: String,
    app: AppHandle,
) -> AppResult<Vec<String>> {
    let mut prefs = load_preferences(&app).unwrap_or_default();
    prefs.markdown_recent_files.retain(|p| p != &path);
    prefs.markdown_recent_files.insert(0, path);
    if prefs.markdown_recent_files.len() > RECENT_FILES_CAP {
        prefs.markdown_recent_files.truncate(RECENT_FILES_CAP);
    }
    let out = prefs.markdown_recent_files.clone();
    if let Err(e) = write_preferences(&app, &prefs) {
        warn!(?e, "failed to persist markdown recent files");
    }
    Ok(out)
}

// ────────────────────────────────────────────────────────────────────────
// Image paste — the headline feature
// ────────────────────────────────────────────────────────────────────────

/// Subfolder name (relative to the markdown file's directory) where
/// pasted images land.  Keeps the doc directory tidy — without this
/// every screenshot would clutter the same folder as the notes.
pub const PASTED_SUBDIR: &str = "pasted";

/// Save a clipboard-pasted image into a `pasted/` subfolder of the
/// document the user is editing.  Creates the subfolder if missing.
///
/// Returns the **path the editor should embed in `![…](…)`** — that's
/// always relative to `target_dir`, e.g. `pasted/foo-123.png`.
///
/// Args:
///   - `target_dir`: absolute directory of the open `.md` (caller does
///     `dirname()` on the file path).
///   - `file_name`: the desired file name including extension.  The
///     extension drives no behaviour here — the caller decides which
///     `.png` / `.jpg` / `.webp` to use based on the clipboard MIME.
///   - `bytes`: raw image bytes.
#[tauri::command]
pub async fn markdown_save_pasted_image(
    target_dir: String,
    file_name: String,
    bytes: Vec<u8>,
) -> AppResult<String> {
    let dir = PathBuf::from(&target_dir);
    if !dir.is_dir() {
        return Err(AppError::BadRequest(format!(
            "target directory does not exist: {}",
            dir.display()
        )));
    }
    // Ensure the `pasted/` subfolder exists.  `create_dir_all` is a
    // no-op when the directory is already there.
    let pasted_dir = dir.join(PASTED_SUBDIR);
    tokio::fs::create_dir_all(&pasted_dir)
        .await
        .map_err(|e| AppError::Other(format!("create pasted/ subdir: {e}")))?;

    let stem = Path::new(&file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image")
        .to_string();
    let ext = Path::new(&file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("png")
        .to_string();

    // Dedupe by appending `-1`, `-2`, … until we land on a fresh name.
    // This handles the "paste two screenshots in the same millisecond"
    // edge case without overwriting prior pastes.
    let mut candidate = file_name.clone();
    let mut counter = 1u32;
    loop {
        let path = pasted_dir.join(&candidate);
        if !path.exists() {
            tokio::fs::write(&path, &bytes).await.map_err(|e| {
                AppError::Other(format!("write pasted image: {e}"))
            })?;
            // Return the path relative to `target_dir` (i.e. relative
            // to the markdown file) so the editor can embed it directly.
            return Ok(format!("{PASTED_SUBDIR}/{candidate}"));
        }
        candidate = format!("{stem}-{counter}.{ext}");
        counter += 1;
        if counter > 9999 {
            return Err(AppError::Other(
                "could not find a unique filename after 9999 attempts".into(),
            ));
        }
    }
}
