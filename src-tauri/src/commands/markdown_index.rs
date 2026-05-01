//! Per-vault `fff-search` `FilePicker` registry + the two query
//! surfaces (file fuzzy-search and content grep) the markdown editor
//! needs.  Modelled on flowstate's `file_index.rs` — same lazy
//! `get_or_init` pattern, same `(?i)` / `to_lowercase()+smart_case`
//! query mapping, same `notify`-driven incremental updates with an
//! explicit `reindex(path)` escape hatch.
//!
//! ## Why per-vault
//!
//! A user can have multiple vaults open at once and they're typically
//! unrelated trees — sharing one index would surface another vault's
//! files as matches in this vault's search palette.  We canonicalise
//! the vault root (via `dunce`, which keeps paths in non-extended
//! form so the picker's notify-watcher can `strip_prefix` cleanly on
//! Windows) and key the registry off the canonical path; symlink
//! variants of the same vault collapse to one entry.
//!
//! ## What lives here vs. what stays in `markdown.rs`
//!
//! The Tauri command thunks in `markdown.rs` stay thin — they just
//! parse args, register the cancel flag, and call into
//! [`search_file_contents`] / [`search_files`] below.  All
//! fff-search-specific code (picker construction, `GrepSearchOptions`
//! defaults, query plan, result mapping) is in this module so the
//! command layer doesn't grow a dependency on the SDK's types.

use std::collections::HashMap as StdHashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

// fff-search re-exports everything off the crate root via `pub use
// {file_picker,grep,types,shared,fff_query_parser,…}::*` — no need to
// reach into submodules.
use fff_search::{
    grep_search, ContentCacheBudget, FFFMode, FilePicker, FilePickerOptions,
    FuzzySearchOptions, GrepConfig, GrepMode, GrepSearchOptions, PaginationArgs,
    QueryParser, SharedFrecency, SharedPicker,
};

use crate::error::{AppError, AppResult};

// ────────────────────────────────────────────────────────────────────────
// Tunables
// ────────────────────────────────────────────────────────────────────────

/// Cap on file-search results we send to the frontend.  Matches
/// `PICKER_RESULT_LIMIT` in `src/tools/markdown/lib/file-rank.ts`.
const FILE_SEARCH_PAGE_LIMIT: usize = 200;

/// How long content search blocks waiting for the bg scan to land
/// enough files to be useful before giving up and grepping whatever
/// is already indexed.  Matches flowstate's 15 s.  Cold-open on a
/// fresh vault is the only real exposure — warm hits return
/// instantly.
const SEARCH_WAIT_MS: u64 = 15_000;

/// fff-search's defaults silently drop matches on big files / dense
/// hits.  These widened caps mirror the values flowstate landed on
/// after their post-mortem (`fff-search` dep comment in
/// `src-tauri/Cargo.toml` of flowstate).
const CONTENT_SEARCH_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MATCHES_PER_FILE: usize = 2_000;
const CONTENT_SEARCH_MAX_TOTAL_LINES: usize = 20_000;
/// Hard ceiling on a single grep call — 30 s is plenty for any
/// realistic vault and short enough that a runaway regex doesn't
/// hang the picker forever.
const SEARCH_TIME_BUDGET_MS: u64 = 30_000;
/// Lines of context emitted on either side of every match line.
const CONTENT_SEARCH_CONTEXT_LINES: usize = 3;

// ────────────────────────────────────────────────────────────────────────
// Handle + registry
// ────────────────────────────────────────────────────────────────────────

/// Live `FilePicker` for one vault root, plus the shared state it
/// needs.  Frecency persistence is intentionally **not** initialised:
/// flowstate's experience is that the LMDB store isn't worth its
/// complexity for this workload, and we re-rank on the frontend
/// anyway via `file-rank.ts`.
pub struct FilePickerHandle {
    /// Live `fff-search` picker.  Read-locked on every search call.
    pub picker: SharedPicker,
    /// Held only so the bg scanner has something to ref-count.
    #[allow(dead_code)]
    pub frecency: SharedFrecency,
    /// Cloned out of the picker so we can poll scan state without
    /// taking the picker's `RwLock` on every render.
    pub scan_signal: Arc<AtomicBool>,
    /// Canonicalised root (matches the registry key).
    pub root: PathBuf,
}

impl FilePickerHandle {
    /// Best-effort wait until the initial scan settles.  Returns
    /// `false` on timeout — caller decides whether to query the
    /// partially-filled index anyway.
    fn wait_for_scan(&self, timeout_ms: u64) -> bool {
        let start = std::time::Instant::now();
        while self.scan_signal.load(Ordering::Acquire) {
            if start.elapsed() >= Duration::from_millis(timeout_ms) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        true
    }
}

/// Per-vault cached `FilePicker`s.  Keyed by **canonicalised** vault
/// path so symlinks of the same root collapse but distinct vaults
/// stay distinct.
#[derive(Default)]
pub struct MarkdownIndexRegistry {
    inner: RwLock<StdHashMap<PathBuf, Arc<FilePickerHandle>>>,
}

impl MarkdownIndexRegistry {
    /// Return an existing handle or build one.  Building kicks off
    /// fff-search's background scanner immediately; the call returns
    /// while the scanner is still walking.  Use
    /// [`FilePickerHandle::wait_for_scan`] before querying if you
    /// need a hot index, or query immediately and let the result set
    /// fill in over polling reads.
    pub fn get_or_init(&self, vault: &Path) -> AppResult<Arc<FilePickerHandle>> {
        let canon = dunce::canonicalize(vault).map_err(|e| {
            AppError::Other(format!("canonicalize vault {}: {e}", vault.display()))
        })?;

        // Fast path: handle already exists.
        if let Ok(guard) = self.inner.read() {
            if let Some(h) = guard.get(&canon) {
                return Ok(Arc::clone(h));
            }
        }

        // Slow path: take the write lock and double-check (another
        // thread may have raced past `read()` and inserted).
        let mut guard = self
            .inner
            .write()
            .map_err(|e| AppError::Other(format!("registry write: {e}")))?;
        if let Some(h) = guard.get(&canon) {
            return Ok(Arc::clone(h));
        }

        let picker = SharedPicker::default();
        let frecency = SharedFrecency::default();
        let base_path = canon
            .to_str()
            .ok_or_else(|| AppError::Other(format!("non-UTF8 vault path: {}", canon.display())))?
            .to_string();
        let opts = FilePickerOptions {
            base_path,
            warmup_mmap_cache: false,
            // `Ai` mode keeps `get_files()` returning the full set
            // regardless of fff's internal scoring threshold; we
            // re-rank ourselves.  Switch only if a future fff mode
            // pre-filters the file set.
            mode: FFFMode::Ai,
            cache_budget: None,
            watch: true,
        };
        FilePicker::new_with_shared_state(picker.clone(), frecency.clone(), opts)
            .map_err(|e| AppError::Other(format!("FilePicker init for {}: {e}", canon.display())))?;

        // Pull the scan signal so callers can poll without locking
        // the picker's RwLock.  fff exposes it as a public field on
        // `FilePicker` (`is_scanning: Arc<AtomicBool>`).
        let scan_signal = picker
            .read()
            .map_err(|e| AppError::Other(format!("picker read: {e}")))?
            .as_ref()
            .map(|p| p.is_scanning.clone())
            .ok_or_else(|| AppError::Other("picker uninitialised".into()))?;

        let handle = Arc::new(FilePickerHandle {
            picker,
            frecency,
            scan_signal,
            root: canon.clone(),
        });
        guard.insert(canon, Arc::clone(&handle));
        Ok(handle)
    }

    /// Drop the cached picker for `vault`.  Used by
    /// `markdown_remove_vault` to release the bg watcher when the
    /// user removes a vault from the sidebar.  Silently no-ops when
    /// the vault isn't in the registry.
    pub fn drop_vault(&self, vault: &Path) {
        let Ok(canon) = dunce::canonicalize(vault) else {
            return;
        };
        if let Ok(mut guard) = self.inner.write() {
            guard.remove(&canon);
        }
    }
}

// ────────────────────────────────────────────────────────────────────────
// File-search impl
// ────────────────────────────────────────────────────────────────────────

/// Run a file fuzzy-search across the supplied vaults.  Empty query
/// → return the union of every vault's file list (frontend ranks).
pub fn search_files(
    registry: &MarkdownIndexRegistry,
    vaults: &[String],
    query: &str,
    current_file: Option<&str>,
) -> AppResult<Vec<String>> {
    let trimmed = query.trim();
    let mut out: Vec<(i32, String)> = Vec::new();

    for vault in vaults {
        let handle = match registry.get_or_init(Path::new(vault)) {
            Ok(h) => h,
            Err(e) => {
                tracing::warn!("[markdown] picker init failed for {vault}: {e}");
                continue;
            }
        };
        // Brief settle window for cold opens — keeps an empty
        // result on the very first query when the user hasn't
        // sat on the editor long enough for the bg scan to finish.
        let _ = handle.wait_for_scan(2_000);

        let guard = handle
            .picker
            .read()
            .map_err(|e| AppError::Other(format!("picker read: {e}")))?;
        let Some(picker) = guard.as_ref() else {
            continue;
        };
        let files = picker.get_files();

        if trimmed.is_empty() {
            // Empty query: hand back every indexed path; frontend
            // does the empty-state ordering (recents first).
            for f in files {
                if f.is_deleted {
                    continue;
                }
                out.push((0, f.path.to_string_lossy().to_string()));
            }
            continue;
        }

        let parser = QueryParser::new(GrepConfig);
        let parsed = parser.parse(trimmed);
        let opts = FuzzySearchOptions {
            max_threads: 0, // 0 = use rayon's default
            current_file,
            project_path: Some(handle.root.as_path()),
            combo_boost_score_multiplier: 1,
            min_combo_count: 0,
            pagination: PaginationArgs {
                offset: 0,
                limit: FILE_SEARCH_PAGE_LIMIT,
            },
        };
        let result = FilePicker::fuzzy_search(files, &parsed, None, opts);
        for (item, score) in result.items.into_iter().zip(result.scores.into_iter()) {
            out.push((score.total, item.path.to_string_lossy().to_string()));
        }
    }

    // Stable-sort by score desc, then dedupe by path (a file in two
    // overlapping vaults should appear once, with its best score).
    out.sort_by(|a, b| b.0.cmp(&a.0));
    let mut seen = std::collections::HashSet::new();
    let mut deduped = Vec::with_capacity(out.len().min(FILE_SEARCH_PAGE_LIMIT));
    for (_, path) in out {
        if deduped.len() >= FILE_SEARCH_PAGE_LIMIT {
            break;
        }
        if seen.insert(path.clone()) {
            deduped.push(path);
        }
    }
    Ok(deduped)
}

// ────────────────────────────────────────────────────────────────────────
// Content-search impl
// ────────────────────────────────────────────────────────────────────────

/// What kind of grep to run.  Maps directly onto fff-search's
/// `GrepMode` after we apply the same case-handling that flowstate
/// does (lowercase + `smart_case` for plain insensitive; `(?i)`
/// prefix for regex insensitive).
struct QueryPlan {
    mode: GrepMode,
    query: String,
    smart_case: bool,
}

fn build_query_plan(
    use_regex: bool,
    use_fuzzy: bool,
    case_sensitive: bool,
    raw_query: &str,
) -> QueryPlan {
    if use_fuzzy {
        return QueryPlan {
            mode: GrepMode::Fuzzy,
            query: raw_query.to_string(),
            smart_case: false,
        };
    }
    match (use_regex, case_sensitive) {
        (true, true) => QueryPlan {
            mode: GrepMode::Regex,
            query: raw_query.to_string(),
            smart_case: false,
        },
        (true, false) => QueryPlan {
            mode: GrepMode::Regex,
            // Inline `(?i)` rather than a separate flag — fff-search
            // honours regex-syntax flags on the parsed query.
            query: format!("(?i){raw_query}"),
            smart_case: false,
        },
        (false, true) => QueryPlan {
            mode: GrepMode::PlainText,
            query: raw_query.to_string(),
            smart_case: false,
        },
        (false, false) => QueryPlan {
            mode: GrepMode::PlainText,
            // Lowercase + smart_case: matches `Foo` against either
            // `foo` or `Foo`, but `FOO` only matches `FOO`.
            query: raw_query.to_lowercase(),
            smart_case: true,
        },
    }
}

/// One contiguous run of matching + context lines inside a file.
/// Mirrors flowstate's `ContentBlock` byte-for-byte so the frontend
/// can render the same shape.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentBlock {
    /// Absolute filesystem path of the matched file.
    pub path: String,
    /// 1-based line number of the first line in `lines` (i.e. the
    /// start of the block's before-context window).
    pub start_line: u64,
    /// Match + context lines, in document order.
    pub lines: Vec<BlockLine>,
}

/// One row inside a [`ContentBlock`].
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockLine {
    /// 1-based line number of this row.
    pub line: u64,
    /// Possibly-truncated line text (CR/LF stripped, capped at
    /// [`MAX_LINE_CHARS`] characters with a trailing ellipsis).
    pub text: String,
    /// `true` when this line itself contains a match; `false` when
    /// it's surrounding context.
    pub is_match: bool,
}

/// Truncate displayed lines to keep payloads bounded.
const MAX_LINE_CHARS: usize = 240;

fn truncate_line(s: &str) -> String {
    let mut out: String = s.chars().take(MAX_LINE_CHARS).collect();
    if s.chars().count() > MAX_LINE_CHARS {
        out.push('…');
    }
    out
}

/// Run a content search against a single vault's index.  The Tauri
/// command in `markdown.rs` calls this once per vault and concats
/// the results.  Cancellation is cooperative: the worker checks
/// `is_cancelled` between files / matches.
pub fn search_file_contents(
    registry: &MarkdownIndexRegistry,
    vault: &str,
    query: &str,
    use_regex: bool,
    use_fuzzy: bool,
    case_sensitive: bool,
    is_cancelled: Option<&AtomicBool>,
) -> AppResult<Vec<ContentBlock>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let handle = registry.get_or_init(Path::new(vault))?;
    // Block until the bg scan settles (or 15s, whichever first).
    // Without this a fresh vault returns zero matches on the user's
    // first content search, since `get_files()` is empty.
    let _ = handle.wait_for_scan(SEARCH_WAIT_MS);

    let plan = build_query_plan(use_regex, use_fuzzy, case_sensitive, trimmed);
    let parser = QueryParser::new(GrepConfig);
    let parsed = parser.parse(&plan.query);

    let opts = GrepSearchOptions {
        max_file_size: CONTENT_SEARCH_MAX_FILE_BYTES,
        max_matches_per_file: MAX_MATCHES_PER_FILE,
        smart_case: plan.smart_case,
        file_offset: 0,
        page_limit: CONTENT_SEARCH_MAX_TOTAL_LINES,
        mode: plan.mode,
        time_budget_ms: SEARCH_TIME_BUDGET_MS,
        before_context: CONTENT_SEARCH_CONTEXT_LINES,
        after_context: CONTENT_SEARCH_CONTEXT_LINES,
        classify_definitions: false,
    };

    let guard = handle
        .picker
        .read()
        .map_err(|e| AppError::Other(format!("picker read: {e}")))?;
    let Some(picker) = guard.as_ref() else {
        return Ok(Vec::new());
    };
    let files = picker.get_files();
    let budget = ContentCacheBudget::new_for_repo(files.len());
    let result = grep_search(
        files,
        &parsed,
        &opts,
        &budget,
        None, // BigramFilter — not used; bg index would speed up cold queries but adds memory
        None, // BigramOverlay — same rationale
        is_cancelled,
    );

    // fff returns one `GrepMatch` per match line plus its context;
    // we re-shape into our `ContentBlock` (one block per match line
    // for now).  This intentionally doesn't merge nearby matches
    // into a single block — the frontend renders matches as a flat
    // list and merging would shuffle line numbers around in a way
    // the current UI doesn't expect.  Future improvement: bucket
    // matches whose `line_number` ranges overlap by ≤ 2*context.
    let mut blocks = Vec::with_capacity(result.matches.len());
    for m in &result.matches {
        let path = result
            .files
            .get(m.file_index)
            .map(|f| f.path.to_string_lossy().to_string())
            .unwrap_or_default();
        if path.is_empty() {
            continue;
        }

        // Build the lines slice: before-context, match, after-context.
        let mut lines: Vec<BlockLine> = Vec::with_capacity(
            m.context_before.len() + 1 + m.context_after.len(),
        );
        let context_before_start = m
            .line_number
            .saturating_sub(m.context_before.len() as u64);
        for (i, ctx) in m.context_before.iter().enumerate() {
            lines.push(BlockLine {
                line: context_before_start + i as u64,
                text: truncate_line(ctx),
                is_match: false,
            });
        }
        lines.push(BlockLine {
            line: m.line_number,
            text: truncate_line(&m.line_content),
            is_match: true,
        });
        for (i, ctx) in m.context_after.iter().enumerate() {
            lines.push(BlockLine {
                line: m.line_number + 1 + i as u64,
                text: truncate_line(ctx),
                is_match: false,
            });
        }
        blocks.push(ContentBlock {
            path,
            start_line: context_before_start.max(1),
            lines,
        });
    }
    Ok(blocks)
}
