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
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::image::Image as TauriImage;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::sync::Mutex;
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
    registry: tauri::State<'_, Arc<crate::commands::markdown_index::MarkdownIndexRegistry>>,
) -> AppResult<Vec<String>> {
    let mut prefs = load_preferences(&app).unwrap_or_default();
    prefs.markdown_vault_dirs.retain(|p| p != &path);
    let out = prefs.markdown_vault_dirs.clone();
    if let Err(e) = write_preferences(&app, &prefs) {
        warn!(?e, "failed to persist markdown vault list");
    }
    // Release the fff-search picker for this vault — its bg watcher
    // is no longer useful.  Silently no-ops when the user removes a
    // vault they never searched.
    registry.drop_vault(Path::new(&path));
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
        out.push(MarkdownVaultDto {
            root: v,
            name,
            items: collect_markdown(&pb),
        });
    }
    Ok(out)
}

/// Classify a markdown-vault file basename (lowercased) into the kind
/// string the frontend expects.  Anything we don't recognise as a
/// markdown / drawing / image still gets a slot — `"file"` — so the
/// sidebar can show it and the normal text editor can open it.  The
/// vault is just a folder; users keep `.txt` notes, `.json` config,
/// shell scripts, and so on alongside their markdown, and hiding those
/// behind an extension allowlist makes the tree feel broken.
///
/// Order matters: excalidraw drawings end in `.svg` / `.png`, so they
/// must be checked **before** the generic image classifier.
fn classify_markdown_file(name: &str) -> &'static str {
    if is_markdown(name) {
        "markdown"
    } else if is_excalidraw(name) {
        "excalidraw"
    } else if is_image(name) {
        "image"
    } else {
        "file"
    }
}

fn collect_markdown(dir: &Path) -> Vec<MarkdownFileItem> {
    let cfg = zen_fs::WalkConfig {
        // No extension filter — show every file the walker yields.
        // `walk_inner` still skips dotfiles + `DEFAULT_PRUNED_DIRS`
        // (`.git`, `node_modules`, …) so the tree doesn't fill up
        // with build junk, but anything the user actually put in
        // their vault is now visible.  Non-markdown files come back
        // with `kind: "file"` and open in the regular CodeMirror
        // editor like everything else.
        include_file: &|_name| true,
        // Emit every (non-hidden, non-pruned) directory regardless of
        // whether its subtree contains a recognised file. The
        // previous "subtree must contain a matching file" gate hid
        // freshly-created empty folders from the sidebar, which was
        // confusing — the user just made the folder, but it
        // disappeared until they dropped a `.md` in it.
        include_dir: &|_p| true,
        ..Default::default()
    };
    zen_fs::walk_tree(dir, &cfg)
        .into_iter()
        .map(|e| MarkdownFileItem {
            name: e.name.clone(),
            path: e.path.to_string_lossy().to_string(),
            is_dir: e.is_dir,
            depth: e.depth,
            kind: if e.is_dir {
                "directory".to_string()
            } else {
                classify_markdown_file(&e.name.to_ascii_lowercase()).to_string()
            },
        })
        .collect()
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

/// Excalidraw drawings.  Two on-disk formats — both carry an
/// embedded scene we can re-open in the drawing pane:
///   - `*.excalidraw.svg`: scene embedded in a `<metadata>` block.
///     Saved + read as text.
///   - `*.excalidraw.png`: scene embedded in a `tEXt` PNG chunk.
///     Saved + read as binary (Excalidraw's `loadFromBlob` accepts
///     both formats).
/// Plain `.svg` / `.png` files stay as `image` kind.
fn is_excalidraw(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".excalidraw.svg") || lower.ends_with(".excalidraw.png")
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

// ────────────────────────────────────────────────────────────────────────
// File-tree mutations: create / rename / delete-to-trash
// ────────────────────────────────────────────────────────────────────────

/// Create an empty markdown file inside `parent_dir`.  Adds a `.md`
/// extension if `name` doesn't already end in one.  Dedupes by
/// appending ` 2`, ` 3`, … to the stem when a sibling already owns
/// the chosen name.  Returns the resolved absolute path.
#[tauri::command]
pub async fn markdown_create_file(
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
    // Preserve any extension the user typed verbatim (so
    // `Foo.excalidraw.svg`, `notes.txt`, etc. stay as-is).  Only when
    // the user supplies a bare name with NO extension at all do we
    // append `.md` — that's the common-case "New file → Untitled"
    // shortcut.  `Path::new(...).extension()` is `None` for `"Foo"`
    // but `Some("svg")` for `"Foo.excalidraw.svg"`, which is exactly
    // the partition we want.
    let with_ext = if Path::new(trimmed).extension().is_none() {
        format!("{trimmed}.md")
    } else {
        trimmed.to_string()
    };
    let resolved = zen_fs::unique_sibling(&parent, &with_ext);
    tokio::fs::write(&resolved, b"")
        .await
        .map_err(|e| AppError::Other(format!("create markdown file: {e}")))?;
    Ok(resolved.to_string_lossy().to_string())
}

/// Create an empty directory inside `parent_dir`.  Same name-dedup
/// rules as `markdown_create_file`.  Returns the absolute path.
#[tauri::command]
pub async fn markdown_create_dir(
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
    let resolved = zen_fs::unique_sibling(&parent, trimmed);
    tokio::fs::create_dir(&resolved)
        .await
        .map_err(|e| AppError::Other(format!("create directory: {e}")))?;
    Ok(resolved.to_string_lossy().to_string())
}

/// Rename a file or directory in place.  `new_name` is the **basename
/// only** — callers pass `Untitled.md` or `Daily Notes`, not a full
/// path.  Files keep their original extension when one isn't supplied
/// (so renaming `foo.md` → `bar` produces `bar.md`).
#[tauri::command]
pub async fn markdown_rename(
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

    // Files: preserve extension if the user didn't supply one.
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
        // No-op rename — return the same path so callers don't have to
        // special-case it.
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

/// Move a file or directory into a different parent directory, keeping
/// its existing basename.  Used by drag-and-drop in the file tree.
///
/// Validates:
///   - `source` exists.
///   - `target_dir` exists and is a directory.
///   - The destination doesn't already exist (no silent overwrite).
///   - `target_dir` is not `source` itself, nor any descendant of it
///     (would corrupt the tree by trying to move a folder into its
///     own subtree).
#[tauri::command]
pub async fn markdown_move(
    source: String,
    target_dir: String,
) -> AppResult<String> {
    let src = PathBuf::from(&source);
    let dst_parent = PathBuf::from(&target_dir);

    if !src.exists() {
        return Err(AppError::BadRequest(format!(
            "source does not exist: {}",
            src.display()
        )));
    }
    if !dst_parent.exists() || !dst_parent.is_dir() {
        return Err(AppError::BadRequest(format!(
            "target directory is not a directory: {}",
            dst_parent.display()
        )));
    }

    // Canonicalize so we can compare paths without false-negatives from
    // trailing slashes, `./` segments, or symlink differences.  The
    // self-and-descendant check below relies on this.
    let src_canon = src
        .canonicalize()
        .map_err(|e| AppError::Other(format!("canonicalize source: {e}")))?;
    let dst_canon = dst_parent
        .canonicalize()
        .map_err(|e| AppError::Other(format!("canonicalize target: {e}")))?;

    if dst_canon == src_canon {
        return Err(AppError::BadRequest(
            "cannot move a folder into itself".into(),
        ));
    }
    if dst_canon.starts_with(&src_canon) {
        return Err(AppError::BadRequest(
            "cannot move a folder into one of its own descendants".into(),
        ));
    }

    let name = src
        .file_name()
        .ok_or_else(|| AppError::Other("source has no basename".into()))?
        .to_owned();
    let new_path = dst_parent.join(&name);

    // Same-parent check is a no-op move — return the existing path so
    // the caller doesn't have to special-case it.
    if let Some(parent) = src.parent() {
        let parent_canon = parent
            .canonicalize()
            .map_err(|e| AppError::Other(format!("canonicalize parent: {e}")))?;
        if parent_canon == dst_canon {
            return Ok(src.to_string_lossy().to_string());
        }
    }

    if new_path.exists() {
        return Err(AppError::BadRequest(format!(
            "`{}` already exists in the destination",
            name.to_string_lossy()
        )));
    }

    tokio::fs::rename(&src, &new_path)
        .await
        .map_err(|e| AppError::Other(format!("move: {e}")))?;
    Ok(new_path.to_string_lossy().to_string())
}

/// Move a file or directory to the OS trash.  Uses the `trash` crate
/// rather than `fs::remove_*` so the user can recover from a misclick
/// — the same semantics as Finder's "Move to Trash".
#[tauri::command]
pub async fn markdown_delete_to_trash(path: String) -> AppResult<()> {
    let pb = PathBuf::from(&path);
    if !pb.exists() {
        return Err(AppError::BadRequest(format!(
            "path does not exist: {}",
            pb.display()
        )));
    }
    // `trash::delete` is synchronous; spawn-blocking keeps the runtime
    // responsive on big directories.
    tokio::task::spawn_blocking(move || trash::delete(&pb))
        .await
        .map_err(|e| AppError::Other(format!("join trash worker: {e}")))?
        .map_err(|e| AppError::Other(format!("move to trash: {e}")))?;
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────
// Content search (mirrors flowstate's fff `search_file_contents`)
// ────────────────────────────────────────────────────────────────────────

/// User-facing knobs for [`markdown_search_contents`].  Field names
/// match the camelCase the frontend sends.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchOptions {
    /// Treat the query as a regex (vs. a literal substring).
    pub use_regex: bool,
    /// Case-sensitive matching (literal or regex).  Forced off in
    /// fuzzy mode.
    pub case_sensitive: bool,
    /// Fuzzy mode — split the query on whitespace; a line matches
    /// when *every* word appears anywhere in it (case-insensitive).
    /// Cheaper and more forgiving than full Smith-Waterman, while
    /// still much friendlier than literal substring for unordered
    /// keywords.  Disables `useRegex` and `caseSensitive`.
    #[serde(default)]
    pub use_fuzzy: bool,
    /// Glob patterns to *include* (matches any → keep).  Empty = all.
    pub includes: Vec<String>,
    /// Glob patterns to *exclude* (matches any → skip).
    pub excludes: Vec<String>,
}

// `ContentBlock` and `BlockLine` are now defined in `markdown_index`
// — re-export under the same name so existing call sites and the
// IPC contract stay unchanged.
pub use crate::commands::markdown_index::{BlockLine, ContentBlock};

/// Streaming-style content search across every `.md` / `.markdown`
/// file under the supplied vault roots, backed by `fff-search`.  See
/// the comment on `markdown_index::search_file_contents` for the
/// per-vault `FilePicker` lifecycle.
///
/// Cancellation: callers mint a monotonic `token` and pass it in.
/// Concurrent invocations register their own [`AtomicBool`] flag in
/// `AppState::markdown_search_tokens`; calling
/// [`markdown_stop_content_search`] flips that flag, which fff-search
/// checks cooperatively at every per-file boundary.
#[tauri::command]
pub async fn markdown_search_contents(
    vaults: Vec<String>,
    query: String,
    options: ContentSearchOptions,
    token: u64,
    state: tauri::State<'_, Mutex<AppState>>,
    registry: tauri::State<'_, Arc<crate::commands::markdown_index::MarkdownIndexRegistry>>,
) -> AppResult<Vec<ContentBlock>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    // Register the cancel flag *before* doing any work so a
    // `markdown_stop_content_search(token)` racing the start of this
    // call still cancels it.
    let cancel: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    let cancel_arc = {
        let s = state.lock().await;
        s.markdown_search_tokens.lock().insert(token, cancel.clone());
        s.markdown_search_tokens.clone()
    };

    let registry_arc: Arc<crate::commands::markdown_index::MarkdownIndexRegistry> =
        Arc::clone(&*registry);
    let opts = options.clone();
    let q = trimmed.to_string();
    let cancel_for_worker = Arc::clone(&cancel);

    // Hop off the runtime — fff-search's grep is CPU/IO bound.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut blocks = Vec::new();
        for vault in &vaults {
            if cancel_for_worker.load(Ordering::Relaxed) {
                break;
            }
            match crate::commands::markdown_index::search_file_contents(
                &registry_arc,
                vault,
                &q,
                opts.use_regex,
                opts.use_fuzzy,
                opts.case_sensitive,
                Some(cancel_for_worker.as_ref()),
            ) {
                Ok(per_vault) => blocks.extend(per_vault),
                Err(e) => tracing::warn!("[markdown] grep on {vault}: {e}"),
            }
        }
        blocks
    })
    .await
    .map_err(|e| AppError::Other(format!("join content-search worker: {e}")))?;

    cancel_arc.lock().remove(&token);
    Ok(result)
}

/// Mark the in-flight content search identified by `token` as
/// cancelled.  No-op when the token is unknown — typical when the
/// frontend re-fires the command after the previous run already
/// returned naturally.
#[tauri::command]
pub async fn markdown_stop_content_search(
    token: u64,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    let s = state.lock().await;
    if let Some(flag) = s.markdown_search_tokens.lock().remove(&token) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// File fuzzy search across every supplied vault, backed by
/// `fff-search`'s `FilePicker::fuzzy_search`.  Returns up to ~200
/// ranked **absolute paths**.  Empty query → every indexed path
/// across the union of vaults (frontend orders them by recents).
#[tauri::command]
pub async fn markdown_search_files(
    vaults: Vec<String>,
    query: String,
    current_file: Option<String>,
    registry: tauri::State<'_, Arc<crate::commands::markdown_index::MarkdownIndexRegistry>>,
) -> AppResult<Vec<String>> {
    let registry_arc: Arc<crate::commands::markdown_index::MarkdownIndexRegistry> =
        Arc::clone(&*registry);
    let q = query.clone();
    let cf = current_file.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::commands::markdown_index::search_files(
            &registry_arc,
            &vaults,
            &q,
            cf.as_deref(),
        )
    })
    .await
    .map_err(|e| AppError::Other(format!("join file-search worker: {e}")))?
}

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

// ────────────────────────────────────────────────────────────────────────
// Mermaid: copy diagram as PNG
// ────────────────────────────────────────────────────────────────────────
//
// We can't rasterise on the JS side: WKWebView taints any canvas an SVG
// `<img>` is drawn into, so `getImageData` / `toBlob` both throw a
// `SecurityError` even for self-contained mermaid SVGs.  Instead we
// ship the SVG XML over to Rust, render it with `resvg` + `tiny-skia`
// to RGBA pixels, and push those straight into the OS clipboard via
// the plugin we already have wired up.
//
// The frontend computes the source size from the SVG's viewBox and
// passes a `scale` factor (typically 2) so the result is hi-DPI.

/// Generic binary write — used by the Excalidraw editor's PNG save
/// path (the `.svg` case still goes through `write_file_content`'s
/// string write).  Distinct command rather than reusing
/// `markdown_save_pasted_image` because pasted images are *new*
/// files placed under a `pasted/` subdir, whereas this overwrites
/// an existing absolute path the editor already owns.
#[tauri::command]
pub async fn markdown_write_bytes(
    path: String,
    bytes: Vec<u8>,
) -> AppResult<()> {
    let pb = PathBuf::from(&path);
    let parent = pb
        .parent()
        .ok_or_else(|| AppError::Other(format!("path has no parent: {path}")))?;
    if !parent.is_dir() {
        return Err(AppError::BadRequest(format!(
            "parent is not a directory: {}",
            parent.display()
        )));
    }
    tokio::fs::write(&pb, &bytes)
        .await
        .map_err(|e| AppError::Other(format!("write {path}: {e}")))?;
    Ok(())
}

/// Rasterise `svg` to RGBA at `scale`× and put the resulting bitmap on
/// the OS clipboard.  Errors are surfaced as plain strings so the
/// frontend can display them in a failure flash.
#[tauri::command]
pub async fn markdown_copy_svg_as_png(
    app: AppHandle,
    svg: String,
    scale: f32,
) -> Result<(), String> {
    // Heavy CPU work — hop off the async runtime so we don't block
    // other Tauri commands from making progress while resvg works.
    let rgba_image = tokio::task::spawn_blocking(move || rasterise_svg(&svg, scale))
        .await
        .map_err(|e| format!("rasterise task panicked: {e}"))??;

    let image = TauriImage::new(&rgba_image.rgba, rgba_image.width, rgba_image.height);
    app.clipboard()
        .write_image(&image)
        .map_err(|e| format!("clipboard write_image: {e}"))?;
    Ok(())
}

struct RgbaImage {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
}

fn rasterise_svg(svg: &str, scale: f32) -> Result<RgbaImage, String> {
    // Use the default usvg options + the system font database so any
    // text in the diagram renders with whatever fonts mermaid asked
    // for.  `text` + `system-fonts` features on resvg pull this in.
    let mut opts = resvg::usvg::Options::default();
    let mut fontdb = resvg::usvg::fontdb::Database::new();
    fontdb.load_system_fonts();
    opts.fontdb = std::sync::Arc::new(fontdb);

    let tree = resvg::usvg::Tree::from_str(svg, &opts)
        .map_err(|e| format!("parse svg: {e}"))?;

    let size = tree.size();
    let scale = scale.max(0.1);
    let width = ((size.width() as f32) * scale).ceil().max(1.0) as u32;
    let height = ((size.height() as f32) * scale).ceil().max(1.0) as u32;

    let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| format!("tiny_skia pixmap {width}x{height} alloc failed"))?;
    // Fill white so the diagram survives a paste into apps that
    // composite against a dark background (Slack, Linear, …).
    pixmap.fill(resvg::tiny_skia::Color::WHITE);

    let transform = resvg::tiny_skia::Transform::from_scale(scale, scale);
    resvg::render(&tree, transform, &mut pixmap.as_mut());

    Ok(RgbaImage {
        rgba: pixmap.take(),
        width,
        height,
    })
}
