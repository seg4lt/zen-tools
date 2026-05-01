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
use globset::{Glob, GlobSet, GlobSetBuilder};
use rayon::prelude::*;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
        } else if is_excalidraw(&name) {
            // Must come BEFORE `is_image` — excalidraw drawings end in
            // `.svg` and would otherwise get the generic image kind,
            // making them unclickable in the sidebar.
            items.push(MarkdownFileItem {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                depth,
                kind: "excalidraw".to_string(),
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

/// Excalidraw drawings.  We only treat the *double-extension* form as
/// editable drawings — a plain `.svg` is just an image, but anything
/// suffixed `.excalidraw.svg` carries an embedded scene we know how to
/// open in the drawing pane.
fn is_excalidraw(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".excalidraw.svg")
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
                if is_markdown(&n) || is_excalidraw(&n) || is_image(&n) {
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
    let resolved = unique_sibling(&parent, &with_ext);
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
    let resolved = unique_sibling(&parent, trimmed);
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

/// One contiguous run of matching + context lines inside a file.
/// Mirrors flowstate's `ContentBlock` byte-for-byte so the frontend
/// can render the same shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentBlock {
    /// Absolute filesystem path of the matched file.
    pub path: String,
    /// 1-based line number of the first line in `lines`.
    pub start_line: usize,
    /// Match + context lines, in document order.
    pub lines: Vec<BlockLine>,
}

/// One row inside a [`ContentBlock`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockLine {
    /// 1-based line number.
    pub line: usize,
    /// Trimmed line text (CR/LF stripped, capped at 240 chars).
    pub text: String,
    /// `true` when this line itself contains a match; `false` when
    /// it's surrounding context.
    pub is_match: bool,
}

/// Maximum file size we'll read for content search.  Bigger files are
/// almost always binary or generated and slow to scan.
const MAX_CONTENT_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Truncate displayed lines to keep payloads bounded.
const MAX_LINE_CHARS: usize = 240;
/// Lines of context before/after each match to include in a block.
/// Three lines gives the user enough surrounding text to read a hit
/// in place without dragging across half the document — and the
/// `2 * CONTEXT_LINES` greedy-extend threshold (`file_blocks_from`)
/// merges nearby matches into one block, so dense regions don't
/// produce a wall of repeated context.
const CONTEXT_LINES: usize = 3;
/// Cap on total matches returned per call to keep IPC payload sane.
const MAX_BLOCKS: usize = 500;

/// Streaming-style content search across every `.md` / `.markdown`
/// file under the supplied vault roots.  Returns one [`ContentBlock`]
/// per contiguous run of matches in a single file.
///
/// Cancellation: callers mint a monotonic `token` and pass it in.
/// Concurrent invocations register their own [`AtomicBool`] flag in
/// `AppState::markdown_search_tokens`; calling
/// [`markdown_stop_content_search`] flips that flag, which is checked
/// at every per-file boundary so the worker drops out fast.
#[tauri::command]
pub async fn markdown_search_contents(
    vaults: Vec<String>,
    query: String,
    options: ContentSearchOptions,
    token: u64,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<ContentBlock>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    // Build the matcher up-front so each per-file iteration just
    // consults a `Regex`/literal pattern with no extra setup.
    let matcher = build_matcher(trimmed, &options)?;
    let include_set = build_globset(&options.includes)?;
    let exclude_set = build_globset(&options.excludes)?;

    // Register a fresh cancellation flag against the user's token.
    let cancel: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    let cancel_arc = {
        let s = state.lock().await;
        s.markdown_search_tokens.lock().insert(token, cancel.clone());
        s.markdown_search_tokens.clone()
    };

    // Hop the actual filesystem walk + regex pass off to a blocking
    // pool so the runtime stays responsive on big vaults.
    let vaults_clone = vaults.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        search_contents_blocking(
            &vaults_clone,
            matcher,
            include_set.as_ref(),
            exclude_set.as_ref(),
            cancel.as_ref(),
        )
    })
    .await
    .map_err(|e| AppError::Other(format!("join content-search worker: {e}")))?;

    // Always tear down the cancel slot, even on success — bad hygiene
    // otherwise; the map would grow unbounded across sessions.
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

/// Pattern matcher — literal substring (with or without case folding),
/// compiled regex, or all-words fuzzy.  Wrapped so the per-line inner
/// loop only has to call `is_match` against pre-cased line slices.
enum Matcher {
    /// Case-sensitive literal: match against the raw line.
    LiteralCase(String),
    /// Case-insensitive literal: match against a pre-lowercased line.
    LiteralLower(String),
    /// Compiled regex (case-insensitivity baked into the regex itself).
    Regex(Regex),
    /// All-words fuzzy match against a pre-lowercased line.  Lines
    /// match when *every* word appears anywhere; word order is free.
    FuzzyAllWords(Vec<String>),
}

impl Matcher {
    /// True when the matcher needs the lowercased copy of each line —
    /// callers cache that copy once per line to avoid re-allocating.
    fn needs_lower(&self) -> bool {
        matches!(
            self,
            Matcher::LiteralLower(_) | Matcher::FuzzyAllWords(_),
        )
    }

    fn is_match(&self, line: &str, line_lower: &str) -> bool {
        match self {
            Matcher::LiteralCase(needle) => line.contains(needle.as_str()),
            Matcher::LiteralLower(needle) => line_lower.contains(needle.as_str()),
            Matcher::Regex(re) => re.is_match(line),
            Matcher::FuzzyAllWords(words) => {
                words.iter().all(|w| line_lower.contains(w.as_str()))
            }
        }
    }
}

fn build_matcher(query: &str, options: &ContentSearchOptions) -> AppResult<Matcher> {
    // Fuzzy wins over the other modes — same precedence as the UI's
    // "fuzzy ⇒ regex+case toggles disabled" affordance.
    if options.use_fuzzy {
        let words: Vec<String> = query
            .split_whitespace()
            .map(|w| w.to_ascii_lowercase())
            .filter(|w| !w.is_empty())
            .collect();
        if words.is_empty() {
            // Nothing to match — fall through to a guaranteed-empty
            // literal so we don't spin through every file for nothing.
            return Ok(Matcher::LiteralCase("\0__never__\0".to_string()));
        }
        return Ok(Matcher::FuzzyAllWords(words));
    }
    if options.use_regex {
        let re = RegexBuilder::new(query)
            .case_insensitive(!options.case_sensitive)
            .build()
            .map_err(|e| AppError::BadRequest(format!("invalid regex: {e}")))?;
        return Ok(Matcher::Regex(re));
    }
    if options.case_sensitive {
        Ok(Matcher::LiteralCase(query.to_string()))
    } else {
        Ok(Matcher::LiteralLower(query.to_ascii_lowercase()))
    }
}

fn build_globset(patterns: &[String]) -> AppResult<Option<GlobSet>> {
    let live: Vec<&String> = patterns.iter().filter(|p| !p.trim().is_empty()).collect();
    if live.is_empty() {
        return Ok(None);
    }
    let mut builder = GlobSetBuilder::new();
    for pat in live {
        builder.add(
            Glob::new(pat).map_err(|e| AppError::BadRequest(format!("bad glob `{pat}`: {e}")))?,
        );
    }
    Ok(Some(builder.build().map_err(|e| {
        AppError::Other(format!("compile glob set: {e}"))
    })?))
}

/// Two-phase search:
///   1. Walk every vault sequentially to collect the set of candidate
///      `.md` files (cheap — `fs::read_dir` is fast).  Glob filters
///      are applied here so the parallel pass doesn't waste work.
///   2. Process the candidates in parallel via rayon, reading +
///      scanning each file independently.  An [`AtomicUsize`] tracks
///      the running match-count so threads can short-circuit once the
///      `MAX_BLOCKS` cap is reached.
fn search_contents_blocking(
    vaults: &[String],
    matcher: Matcher,
    include: Option<&GlobSet>,
    exclude: Option<&GlobSet>,
    cancel: &AtomicBool,
) -> Vec<ContentBlock> {
    // Phase 1 — gather candidate files.
    let mut candidates: Vec<PathBuf> = Vec::new();
    'outer: for vault in vaults {
        let root = PathBuf::from(vault);
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            if cancel.load(Ordering::Relaxed) {
                break 'outer;
            }
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path.file_name().map(|s| s.to_string_lossy().to_string());
                if let Some(n) = name.as_deref() {
                    if n.starts_with('.')
                        || n == "node_modules"
                        || n == "target"
                        || n == "dist"
                        || n == "build"
                    {
                        continue;
                    }
                }
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let Some(name_str) = name.as_deref() else {
                    continue;
                };
                if !is_markdown(name_str) {
                    continue;
                }
                let rel = path
                    .strip_prefix(&root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();
                if let Some(set) = include {
                    if !set.is_match(&rel) {
                        continue;
                    }
                }
                if let Some(set) = exclude {
                    if set.is_match(&rel) {
                        continue;
                    }
                }
                candidates.push(path);
            }
        }
    }
    if cancel.load(Ordering::Relaxed) {
        return Vec::new();
    }

    // Phase 2 — parallel search.  `block_count` lets each worker
    // bail as soon as the global cap is reached without coordinating
    // through a Mutex on the result vec.
    let block_count = AtomicUsize::new(0);
    let needs_lower = matcher.needs_lower();
    let mut blocks: Vec<ContentBlock> = candidates
        .par_iter()
        .filter_map(|path| {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            if block_count.load(Ordering::Relaxed) >= MAX_BLOCKS {
                return None;
            }
            let meta = fs::metadata(path).ok()?;
            if meta.len() > MAX_CONTENT_FILE_BYTES {
                return None;
            }
            let contents = fs::read_to_string(path).ok()?;
            let file_blocks = file_blocks_from(path, &contents, &matcher, needs_lower);
            if file_blocks.is_empty() {
                return None;
            }
            block_count.fetch_add(file_blocks.len(), Ordering::Relaxed);
            Some(file_blocks)
        })
        .flatten()
        .collect();

    // Sort for stable output regardless of rayon's scheduling order.
    blocks.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then_with(|| a.start_line.cmp(&b.start_line))
    });
    if blocks.len() > MAX_BLOCKS {
        blocks.truncate(MAX_BLOCKS);
    }
    blocks
}

/// Truncate `s` to at most `max_chars` Unicode scalar values, appending
/// an ellipsis when anything was dropped.  Byte-safe — never panics on
/// multi-byte characters.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    let mut iter = s.chars();
    let mut out: String = iter.by_ref().take(max_chars).collect();
    if iter.next().is_some() {
        out.push('…');
    }
    out
}

/// Walk `contents` once per file, emitting one [`ContentBlock`] per
/// run of consecutive match lines (with [`CONTEXT_LINES`] of context
/// stitched in).
///
/// `needs_lower` lets us skip a per-line `to_ascii_lowercase` allocation
/// for case-sensitive literal + regex modes — just match against an
/// empty string when it's unused.
fn file_blocks_from(
    path: &Path,
    contents: &str,
    matcher: &Matcher,
    needs_lower: bool,
) -> Vec<ContentBlock> {
    let lines: Vec<&str> = contents.lines().collect();
    if lines.is_empty() {
        return Vec::new();
    }
    let match_flags: Vec<bool> = if needs_lower {
        lines
            .iter()
            .map(|l| matcher.is_match(l, &l.to_ascii_lowercase()))
            .collect()
    } else {
        lines.iter().map(|l| matcher.is_match(l, "")).collect()
    };
    let mut out: Vec<ContentBlock> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        if !match_flags[i] {
            i += 1;
            continue;
        }
        // Found a match; greedy-extend through any tightly-grouped
        // matches (within 2*CONTEXT_LINES of the previous match).
        let block_start = i.saturating_sub(CONTEXT_LINES);
        let mut last_match = i;
        let mut j = i + 1;
        while j < lines.len() {
            if match_flags[j] {
                last_match = j;
                j += 1;
            } else if j - last_match <= CONTEXT_LINES * 2 {
                j += 1;
            } else {
                break;
            }
        }
        let block_end = (last_match + CONTEXT_LINES).min(lines.len() - 1);
        let mut block_lines = Vec::with_capacity(block_end - block_start + 1);
        for k in block_start..=block_end {
            let raw = lines[k];
            // `String::truncate` works on byte indices, so naïvely
            // truncating at `MAX_LINE_CHARS` panics when the boundary
            // falls mid-UTF-8-codepoint (emoji, accents, CJK …).  Cap
            // by *character* count instead.
            let text = truncate_chars(raw, MAX_LINE_CHARS);
            block_lines.push(BlockLine {
                line: k + 1,
                text,
                is_match: match_flags[k],
            });
        }
        out.push(ContentBlock {
            path: path.to_string_lossy().to_string(),
            start_line: block_start + 1,
            lines: block_lines,
        });
        i = block_end + 1;
    }
    out
}

/// Find a sibling name that doesn't yet exist.  Returns the resolved
/// path.  Strategy: try `name`, then `stem 2.ext`, `stem 3.ext`, …
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
    // Astronomically unlikely fallback; better than panicking.
    parent.join(format!("{stem}-{}{ext}", chrono::Utc::now().timestamp_millis()))
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
