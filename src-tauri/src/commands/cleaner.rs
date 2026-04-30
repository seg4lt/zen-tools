//! Tauri command surface for the Cleaner tool.
//!
//! Lifecycle:
//! 1. UI calls `cleaner_list_scan_folders` on mount.
//! 2. UI may call `cleaner_add_scan_folder` / `cleaner_remove_scan_folder` —
//!    these persist atomically through the existing preferences pipeline.
//! 3. UI calls `cleaner_scan_folder { folder, scan_id }`. The command
//!    spawns a worker thread that:
//!      a. runs `find_git_repos`,
//!      b. builds a `Tree` and stores it under the folder key,
//!      c. emits a single `cleaner:scan-complete` event with the full
//!         `ScanResultDto`,
//!      d. spawns a per-repo size-estimation pool and emits one
//!         `cleaner:size-update` per repo as it finishes.
//! 4. UI calls `cleaner_discover_globals` once at startup; same shape
//!    as the per-folder scan but for the global cache section.
//! 5. UI calls `cleaner_run_actions` with the marked items; this runs
//!    rayon-parallel and returns `RunResultDto` once everything finishes.

use crate::commands::preferences::{
    load_preferences, write_preferences, CleanerScanCacheEntry,
};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, CleanerState};
use parking_lot::Mutex as PlMutex;
use rayon::prelude::*;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tracing::{info, warn};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};
use zen_cleaner::{
    discover_global_cleanup_targets, estimate_path_size, estimate_repo_savings,
    find_git_repos_streaming, run_repo_commands, GlobalTreeEntry, NodeKind, RepoCommand,
    RepoCommandKind, RunActionItem, RunActionKind, RunFailureDto, RunResultDto, ScanResultDto,
    SizeProgressDto, SizeUpdateDto, Tree, TreeNode, TreeNodeDto,
};

/// Throttle between successive `cleaner:scan-progress` emissions.  Small
/// enough that the UI feels live, large enough that we don't flood the
/// IPC channel for huge folders (Mac home dirs with hundreds of repos).
const SCAN_PROGRESS_THROTTLE: Duration = Duration::from_millis(150);

/// Key the globals tree is stored under in `CleanerState::trees`.
///
/// Mirrors the `scan_id` the frontend uses for the global section so a
/// single per-key API works for both per-folder and global sections.
pub const GLOBALS_KEY: &str = "globals";

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/// Clone the cleaner-state `Arc` out from under the outer Tokio mutex.
/// Holding the tokio lock for the briefest possible window keeps the
/// async runtime responsive even while a long scan is in flight.
async fn clone_cleaner_arc(state: &Mutex<AppState>) -> Arc<PlMutex<CleanerState>> {
    state.lock().await.cleaner.clone()
}

// ────────────────────────────────────────────────────────────────────────
// Folder list (persisted)
// ────────────────────────────────────────────────────────────────────────

/// Read the persisted scan-folder list. Reflects whatever is in
/// `preferences.json::cleaner_scan_folders`.
///
/// On the *first* call after app start the in-memory cache is empty,
/// so we also hydrate it from `cleaner_scan_cache` in prefs — meaning
/// the very next `cleaner_get_cached_tree` call returns the previous
/// session's tree instantly while a fresh scan runs in the background.
#[tauri::command]
pub async fn cleaner_list_scan_folders(
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<String>> {
    let prefs = load_preferences(&app).unwrap_or_default();
    let arc = clone_cleaner_arc(&state).await;
    {
        let mut c = arc.lock();
        c.folders = prefs.cleaner_scan_folders.clone();
    }
    // Hydrate trees + globals only when the cache is empty — repeated
    // calls (e.g. after add/remove) shouldn't clobber freshly-scanned data.
    let needs_hydrate = {
        let c = arc.lock();
        c.trees.is_empty() && c.globals.is_none()
    };
    if needs_hydrate {
        hydrate_cache_from_disk(&app, &arc);
    }
    Ok(prefs.cleaner_scan_folders)
}

/// Add a folder to the scan list. Validates the path exists, dedupes,
/// and persists atomically. Returns the updated list.
#[tauri::command]
pub async fn cleaner_add_scan_folder(
    path: String,
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
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

    let folders = {
        let arc = clone_cleaner_arc(&state).await;
        let mut c = arc.lock();
        if !c.folders.iter().any(|f| f == &path) {
            c.folders.push(path.clone());
        }
        c.folders.clone()
    };

    persist_folder_list(&app, &folders);
    Ok(folders)
}

/// Remove a folder from the scan list. Drops any cached tree for it.
#[tauri::command]
pub async fn cleaner_remove_scan_folder(
    path: String,
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<String>> {
    let folders = {
        let arc = clone_cleaner_arc(&state).await;
        let mut c = arc.lock();
        c.folders.retain(|f| f != &path);
        c.trees.remove(&path);
        c.folders.clone()
    };

    persist_folder_list(&app, &folders);
    Ok(folders)
}

fn persist_folder_list(app: &AppHandle, folders: &[String]) {
    let mut prefs = load_preferences(app).unwrap_or_default();
    prefs.cleaner_scan_folders = folders.to_vec();
    // Drop cache entries for folders that no longer exist.
    let keep: ahash::HashSet<String> = folders.iter().cloned().chain([GLOBALS_KEY.to_string()]).collect();
    prefs.cleaner_scan_cache.retain(|c| keep.contains(&c.key));
    if let Err(e) = write_preferences(app, &prefs) {
        warn!(?e, "failed to persist cleaner scan folders");
    }
}

/// Persist the freshly built tree (or globals section) for `key` so it
/// survives an app restart.  Best-effort: failures are logged and
/// swallowed — losing the cache only means the next launch does a fresh
/// scan, which is recoverable.
fn persist_tree(app: &AppHandle, key: &str, roots: &[TreeNodeDto]) {
    let tree_json = match serde_json::to_string(roots) {
        Ok(s) => s,
        Err(e) => {
            warn!(?e, key, "failed to serialise cleaner tree");
            return;
        }
    };
    let mut prefs = load_preferences(app).unwrap_or_default();
    prefs.cleaner_scan_cache.retain(|c| c.key != key);
    prefs.cleaner_scan_cache.push(CleanerScanCacheEntry {
        key: key.to_string(),
        tree_json,
    });
    if let Err(e) = write_preferences(app, &prefs) {
        warn!(?e, key, "failed to persist cleaner scan cache");
    }
}

/// Read every persisted tree blob out of `prefs.cleaner_scan_cache`
/// and mirror it into the in-memory cache.  Called once during the
/// frontend's bootstrap (`cleaner_list_scan_folders`).
fn hydrate_cache_from_disk(app: &AppHandle, cleaner: &PlMutex<CleanerState>) {
    let prefs = match load_preferences(app) {
        Ok(p) => p,
        Err(_) => return,
    };
    let mut c = cleaner.lock();
    for entry in &prefs.cleaner_scan_cache {
        let roots: Vec<TreeNodeDto> = match serde_json::from_str(&entry.tree_json) {
            Ok(v) => v,
            Err(e) => {
                warn!(?e, key = %entry.key, "skipping malformed cleaner cache entry");
                continue;
            }
        };
        // Round-trip the DTOs into a Tree so size updates and lookups
        // continue to mutate a single source of truth. Anything missing
        // from the JSON (sizes, etc.) will just be re-derived by the
        // next scan/size-estimation pass.
        let tree = tree_from_dto_roots(&roots);
        if entry.key == GLOBALS_KEY {
            c.globals = Some(tree);
        } else {
            c.trees.insert(entry.key.clone(), tree);
        }
    }
}

/// Copy repo size estimates from a previous tree's roots into a freshly
/// built tree.  Used so refreshes don't flash skeleton placeholders for
/// repos whose path is unchanged from the previous scan.
fn preserve_repo_sizes(new_tree: &mut Tree, old_roots: &[TreeNode]) {
    for old_root in old_roots {
        for old_child in &old_root.children {
            if old_child.kind != NodeKind::Repo {
                continue;
            }
            if let Some(node) = new_tree.get_repo_node_mut_by_path(&old_child.path) {
                node.clean_size = old_child.clean_size;
                node.delete_size = old_child.delete_size;
                node.repo_estimate_status = old_child.repo_estimate_status;
            }
        }
    }
}

/// Best-effort reconstruction of a [`Tree`] from serialised DTOs.
///
/// We rebuild via the canonical [`Tree::build`] helpers so the in-memory
/// shape exactly matches what a fresh scan would produce.  Any sizes
/// from the JSON are layered back in afterwards.
fn tree_from_dto_roots(roots: &[TreeNodeDto]) -> Tree {
    use std::path::PathBuf;
    use zen_cleaner::GlobalTreeEntry;

    let mut repo_paths: Vec<PathBuf> = Vec::new();
    let mut global_entries: Vec<GlobalTreeEntry> = Vec::new();
    for root in roots {
        if root.kind != "section" {
            continue;
        }
        for child in &root.children {
            match child.kind.as_str() {
                "repo" => repo_paths.push(PathBuf::from(&child.path)),
                "globalPath" => global_entries.push(GlobalTreeEntry {
                    label: child.label.clone(),
                    path: PathBuf::from(&child.path),
                    is_dir: child.is_dir,
                    size: child.size,
                }),
                _ => {}
            }
        }
    }
    let mut tree = Tree::build(repo_paths, global_entries);

    // Layer back the cached repo size estimates.
    for root in roots {
        for child in &root.children {
            if child.kind == "repo" {
                if let Some(node) = tree.get_repo_node_mut_by_path(&PathBuf::from(&child.path)) {
                    node.clean_size = child.clean_size;
                    node.delete_size = child.delete_size;
                    if child.size_done {
                        node.repo_estimate_status =
                            Some(zen_cleaner::RepoEstimateStatus { clean_done: true, delete_done: true });
                    }
                }
            } else if child.kind == "globalPath" {
                if let Some(node) = tree.get_global_node_mut_by_path(&PathBuf::from(&child.path)) {
                    node.size = child.size;
                    node.size_done = child.size_done;
                }
            }
        }
    }
    tree
}

// ────────────────────────────────────────────────────────────────────────
// Scanning
// ────────────────────────────────────────────────────────────────────────

/// Kick off a folder scan. Returns immediately — the actual repo
/// discovery + size estimation happens on a worker thread, with progress
/// streamed over Tauri events:
///
/// - `cleaner:scan-complete` — `ScanCompleteEvent`, fired once.
/// - `cleaner:size-update`   — `SizeUpdateDto`, fired per repo (and per
///                             global when the globals scan is run).
#[tauri::command]
pub async fn cleaner_scan_folder(
    folder: String,
    scan_id: String,
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    let pb = PathBuf::from(&folder);
    if !pb.is_dir() {
        return Err(AppError::BadRequest(format!(
            "not a directory: {}",
            pb.display()
        )));
    }

    let cleaner = clone_cleaner_arc(&state).await;
    let app_handle = app.clone();
    let folder_for_worker = folder.clone();

    std::thread::Builder::new()
        .name(format!("cleaner-scan:{}", scan_id))
        .spawn(move || {
            run_scan_worker(app_handle, cleaner, folder_for_worker, scan_id, pb);
        })
        .map_err(|e| AppError::Other(format!("spawn cleaner-scan thread: {e}")))?;

    Ok(())
}

fn run_scan_worker(
    app: AppHandle,
    cleaner: Arc<PlMutex<CleanerState>>,
    folder: String,
    scan_id: String,
    root: PathBuf,
) {
    info!(?folder, ?scan_id, "cleaner: scan start");

    // 0. Snapshot the *previous* tree (if any) so we can preserve its
    //    repo size estimates when rebuilding.  Without this, a refresh
    //    would briefly replace real sizes with skeletons until the size
    //    worker finished re-estimating.  We do *not* clear the in-memory
    //    cache: callers (notably `cleaner_get_cached_tree`) keep seeing
    //    the previous data while the walk is in flight.
    let old_roots: Vec<TreeNode> = cleaner
        .lock()
        .trees
        .get(&folder)
        .map(|t| t.roots.clone())
        .unwrap_or_default();
    let _ = app.emit(
        "cleaner:scan-started",
        ScanStartedEvent {
            scan_id: scan_id.clone(),
            folder: folder.clone(),
        },
    );

    // 1. Discover repos *progressively*.  We accumulate into a shared
    //    Vec and re-emit a sorted snapshot at most once every
    //    `SCAN_PROGRESS_THROTTLE`.  This is what makes the UI feel
    //    instant on a CLI-sized folder: the first few repos surface
    //    within ~150ms instead of "after the whole walk completes".
    let repos = StdMutex::new(Vec::<PathBuf>::new());
    let last_emit = StdMutex::new(Instant::now() - SCAN_PROGRESS_THROTTLE);
    let app_clone = app.clone();
    let folder_clone = folder.clone();
    let scan_id_clone = scan_id.clone();
    let old_roots_clone = old_roots.clone();

    find_git_repos_streaming(&root, |path| {
        let path_buf = path.to_path_buf();
        let snapshot: Option<Vec<PathBuf>> = {
            let mut guard = repos.lock().unwrap();
            guard.push(path_buf);
            // Throttle progress emissions.  Take a snapshot under the
            // same lock so two threads can't both pass the gate.
            let mut last = last_emit.lock().unwrap();
            if last.elapsed() >= SCAN_PROGRESS_THROTTLE {
                *last = Instant::now();
                let mut sorted = guard.clone();
                drop(last);
                drop(guard);
                sorted.sort();
                Some(sorted)
            } else {
                None
            }
        };

        if let Some(sorted) = snapshot {
            let mut progress_tree = Tree::build(sorted.clone(), Vec::new());
            preserve_repo_sizes(&mut progress_tree, &old_roots_clone);
            let roots: Vec<TreeNodeDto> =
                progress_tree.roots.iter().map(TreeNodeDto::from).collect();
            let _ = app_clone.emit(
                "cleaner:scan-progress",
                ScanProgressEvent {
                    scan_id: scan_id_clone.clone(),
                    folder: folder_clone.clone(),
                    repo_count: sorted.len(),
                    roots,
                },
            );
        }
    });

    // 2. Final sort + tree build, preserving previous size estimates so
    //    the UI doesn't flash skeletons on a refresh.
    let mut repos = repos.into_inner().unwrap();
    repos.sort();
    let repo_count = repos.len();
    let mut tree = Tree::build(repos.clone(), Vec::new());
    preserve_repo_sizes(&mut tree, &old_roots);
    let roots: Vec<TreeNodeDto> = tree.roots.iter().map(TreeNodeDto::from).collect();
    cleaner.lock().trees.insert(folder.clone(), tree);

    // 3. Authoritative scan-complete with the final sorted tree.
    let _ = app.emit(
        "cleaner:scan-complete",
        ScanCompleteEvent {
            scan_id: scan_id.clone(),
            folder: folder.clone(),
            result: ScanResultDto {
                folder: folder.clone(),
                repo_count,
                roots,
            },
        },
    );

    // 4. Run repo size estimation in parallel; emit one update per repo
    //    plus a running `cleaner:size-progress` counter so the UI can
    //    render an `estimating X/Y` indicator like the reference TUI.
    let total = repos.len();
    if total > 0 {
        let _ = app.emit(
            "cleaner:size-progress",
            SizeProgressDto {
                scan_id: scan_id.clone(),
                completed: 0,
                total,
                done: false,
            },
        );
    }
    let completed = AtomicUsize::new(0);
    repos.par_iter().for_each(|repo_path| {
        let estimate = estimate_repo_savings(repo_path);
        let id = format!("repos/{}", repo_path.to_string_lossy());

        // Mutate the cached tree so future updates reuse the resolved size.
        if let Some(tree) = cleaner.lock().trees.get_mut(&folder) {
            tree.update_repo_estimate(repo_path, estimate.clean_size, estimate.delete_size);
        }

        let _ = app.emit(
            "cleaner:size-update",
            SizeUpdateDto {
                scan_id: scan_id.clone(),
                node_id: id,
                clean_size: estimate.clean_size,
                delete_size: estimate.delete_size,
                size: None,
                done: true,
            },
        );

        let done_n = completed.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = app.emit(
            "cleaner:size-progress",
            SizeProgressDto {
                scan_id: scan_id.clone(),
                completed: done_n,
                total,
                done: done_n == total,
            },
        );
    });

    // 5. Persist the now-fully-sized tree so the next app launch can
    //    render it instantly.  Uses the in-memory cache (which has the
    //    sizes layered in) rather than the original DTO list.
    let final_roots: Vec<TreeNodeDto> = {
        let c = cleaner.lock();
        c.trees
            .get(&folder)
            .map(|t| t.roots.iter().map(TreeNodeDto::from).collect())
            .unwrap_or_default()
    };
    persist_tree(&app, &folder, &final_roots);

    info!(?folder, ?scan_id, repo_count, "cleaner: scan done");
}

/// Discover global dev-tool caches and stream their sizes.
///
/// Synchronous up to the section build (cheap), then spawns a worker that
/// emits one `cleaner:size-update` per cache as its size resolves.  The
/// `scan_id` for global updates is the constant [`GLOBALS_KEY`].
#[tauri::command]
pub async fn cleaner_discover_globals(
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<TreeNodeDto> {
    let targets = discover_global_cleanup_targets();
    let entries: Vec<GlobalTreeEntry> = targets
        .iter()
        .map(|t| GlobalTreeEntry {
            label: t.label.clone(),
            path: t.path.clone(),
            is_dir: t.is_dir,
            size: t.size,
        })
        .collect();

    let tree = Tree::build(Vec::new(), entries);
    let section = tree
        .roots
        .first()
        .map(TreeNodeDto::from)
        .ok_or_else(|| AppError::Other("no global section built".into()))?;

    let cleaner = clone_cleaner_arc(&state).await;
    cleaner.lock().globals = Some(tree);

    let app_for_worker = app.clone();
    let target_paths: Vec<PathBuf> = targets.iter().map(|t| t.path.clone()).collect();
    let cleaner_worker = cleaner.clone();
    std::thread::Builder::new()
        .name("cleaner-globals-sizes".into())
        .spawn(move || {
            let total = target_paths.len();
            if total > 0 {
                let _ = app_for_worker.emit(
                    "cleaner:size-progress",
                    SizeProgressDto {
                        scan_id: GLOBALS_KEY.to_string(),
                        completed: 0,
                        total,
                        done: false,
                    },
                );
            }
            let completed = AtomicUsize::new(0);
            target_paths.par_iter().for_each(|path| {
                let size = estimate_path_size(path);
                let id = format!("globals/{}", path.to_string_lossy());

                if let Some(tree) = cleaner_worker.lock().globals.as_mut() {
                    tree.update_global_size(path, size);
                }

                let _ = app_for_worker.emit(
                    "cleaner:size-update",
                    SizeUpdateDto {
                        scan_id: GLOBALS_KEY.to_string(),
                        node_id: id,
                        clean_size: None,
                        delete_size: None,
                        size,
                        done: true,
                    },
                );

                let done_n = completed.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = app_for_worker.emit(
                    "cleaner:size-progress",
                    SizeProgressDto {
                        scan_id: GLOBALS_KEY.to_string(),
                        completed: done_n,
                        total,
                        done: done_n == total,
                    },
                );
            });

            // Persist the (now-sized) globals section so the next launch
            // can render it instantly.
            let roots: Vec<TreeNodeDto> = {
                let c = cleaner_worker.lock();
                c.globals
                    .as_ref()
                    .map(|t| t.roots.iter().map(TreeNodeDto::from).collect())
                    .unwrap_or_default()
            };
            persist_tree(&app_for_worker, GLOBALS_KEY, &roots);
        })
        .map_err(|e| AppError::Other(format!("spawn cleaner-globals thread: {e}")))?;

    Ok(section)
}

// ────────────────────────────────────────────────────────────────────────
// Run
// ────────────────────────────────────────────────────────────────────────

/// Execute the marked actions in parallel and return aggregate results.
#[tauri::command]
pub async fn cleaner_run_actions(items: Vec<RunActionItem>) -> AppResult<RunResultDto> {
    let mut commands: Vec<RepoCommand> = Vec::with_capacity(items.len());
    for item in &items {
        let path = PathBuf::from(&item.path);
        let action = item.action.as_node_action();
        let cmd = match item.kind.as_str() {
            "repo" => RepoCommand::Repo {
                repo_path: path,
                kind: match action {
                    zen_cleaner::NodeAction::Clean => RepoCommandKind::Clean,
                    zen_cleaner::NodeAction::Delete => RepoCommandKind::Delete,
                    zen_cleaner::NodeAction::None => continue,
                },
            },
            "globalPath" => {
                if matches!(item.action, RunActionKind::Clean) {
                    return Err(AppError::BadRequest(format!(
                        "global path cannot be 'clean': {}",
                        item.label
                    )));
                }
                RepoCommand::GlobalDelete {
                    label: item.label.clone(),
                    path,
                }
            }
            other => {
                return Err(AppError::BadRequest(format!(
                    "unknown run-action kind: {other}"
                )))
            }
        };
        commands.push(cmd);
    }

    // run_repo_commands itself parallelises via rayon. Wrap it in
    // spawn_blocking so the Tokio runtime stays responsive (the bulk
    // delete can take seconds for big caches).
    let result = tauri::async_runtime::spawn_blocking(move || run_repo_commands(commands))
        .await
        .map_err(|e| AppError::Other(format!("join run-actions worker: {e}")))?;

    let (successes, failures) = result;
    Ok(RunResultDto {
        successes,
        failures: failures
            .into_iter()
            .map(|(item, error)| RunFailureDto { item, error })
            .collect(),
    })
}

/// Re-emit the cached scan tree for `folder` (or the cached globals
/// section when `folder == "globals"`). Lets the frontend re-hydrate
/// after a remount without re-scanning the whole filesystem.
#[tauri::command]
pub async fn cleaner_get_cached_tree(
    folder: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Option<Vec<TreeNodeDto>>> {
    let cleaner = clone_cleaner_arc(&state).await;
    let c = cleaner.lock();
    let tree = if folder == GLOBALS_KEY {
        c.globals.as_ref()
    } else {
        c.trees.get(&folder)
    };
    Ok(tree.map(|t| t.roots.iter().map(TreeNodeDto::from).collect()))
}

// ────────────────────────────────────────────────────────────────────────
// Event payloads
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanStartedEvent {
    scan_id: String,
    folder: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgressEvent {
    scan_id: String,
    folder: String,
    repo_count: usize,
    roots: Vec<TreeNodeDto>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanCompleteEvent {
    scan_id: String,
    folder: String,
    result: ScanResultDto,
}
