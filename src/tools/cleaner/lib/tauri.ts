/**
 * Typed wrappers around the `cleaner_*` Tauri commands plus the live
 * scan / size-update event streams.
 *
 * The DTO shapes mirror `crates/zen-cleaner/src/dto.rs`. Field names use
 * camelCase because the Rust layer applies `#[serde(rename_all = "camelCase")]`.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ────────────────────────────────────────────────────────────────────────
// Domain types — keep in sync with `crates/zen-cleaner/src/dto.rs`.
// ────────────────────────────────────────────────────────────────────────

/** What kind of node a row in the tree represents. */
export type CleanerNodeKind = "section" | "repo" | "globalPath";

/** User-marked action. `none` means "skip when running". */
export type CleanerNodeAction = "none" | "clean" | "delete";

/** A single tree row as returned from the backend. */
export interface CleanerTreeNode {
  /** Stable id ("repos/<abs-path>" or "globals/<abs-path>"). */
  id: string;
  /** Display label. Repos use the basename; globals use a friendly name. */
  label: string;
  /** Discriminator (matches the Rust `kind` string). */
  kind: CleanerNodeKind;
  /** `true` for directories. */
  isDir: boolean;
  /** Indentation depth (0 = section, 1 = leaf). */
  depth: number;
  /** Absolute path on disk (empty for sections). */
  path: string;
  /** Children in display order. Leaves are empty. */
  children: CleanerTreeNode[];
  /** Repo only: bytes a `git clean -fxd` would reclaim. */
  cleanSize: number | null;
  /** Repo only: total repo size on disk. */
  deleteSize: number | null;
  /** Global only: total path size on disk. */
  size: number | null;
  /** True once the size estimator has settled (sizes may still be null). */
  sizeDone: boolean;
}

/** Result returned by `cleaner_scan_folder`'s `cleaner:scan-complete` event. */
export interface CleanerScanResult {
  folder: string;
  repoCount: number;
  roots: CleanerTreeNode[];
}

/** Streamed by `cleaner:size-update` events. */
export interface CleanerSizeUpdate {
  scanId: string;
  nodeId: string;
  cleanSize: number | null;
  deleteSize: number | null;
  size: number | null;
  done: boolean;
}

/**
 * Streamed by `cleaner:size-progress` events. Lets the UI render an
 * `estimating X/Y` counter while individual size-update events fill in
 * the per-row numbers.
 */
export interface CleanerSizeProgress {
  scanId: string;
  completed: number;
  total: number;
  done: boolean;
}

/** Wrapped envelope of the `cleaner:scan-complete` event. */
export interface CleanerScanCompleteEvent {
  scanId: string;
  folder: string;
  result: CleanerScanResult;
}

/** Fired once at the start of a scan, before any repos are discovered. */
export interface CleanerScanStartedEvent {
  scanId: string;
  folder: string;
}

/**
 * Fired periodically while `find_git_repos` is in flight. The `roots`
 * payload is a *complete* sorted snapshot of everything found so far —
 * the frontend can simply replace the tree on each emission rather
 * than tracking deltas.
 */
export interface CleanerScanProgressEvent {
  scanId: string;
  folder: string;
  repoCount: number;
  roots: CleanerTreeNode[];
}

/** Action sent up by the run-confirm dialog. */
export interface CleanerRunActionItem {
  /** "repo" or "globalPath" — matches `CleanerTreeNode.kind`. */
  kind: "repo" | "globalPath";
  /** Display label for messaging. */
  label: string;
  /** Absolute path to act on. */
  path: string;
  /** "clean" or "delete" — globals only support "delete". */
  action: "clean" | "delete";
}

/** Single failure entry. */
export interface CleanerRunFailure {
  /** Display label of the command (e.g. `[clean] /a/b`). */
  item: string;
  /** Human-readable error from `git`/`rm`. */
  error: string;
}

/** Aggregate result of a bulk run. */
export interface CleanerRunResult {
  successes: string[];
  failures: CleanerRunFailure[];
}

// ────────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────────

export const cleanerTauri = {
  /** Read the persisted scan-folder list. */
  listScanFolders: () => invoke<string[]>("cleaner_list_scan_folders"),

  /** Push a folder onto the scan list. Returns the updated list. */
  addScanFolder: (path: string) =>
    invoke<string[]>("cleaner_add_scan_folder", { path }),

  /** Remove a folder by exact path match. Returns the updated list. */
  removeScanFolder: (path: string) =>
    invoke<string[]>("cleaner_remove_scan_folder", { path }),

  /**
   * Kick off an asynchronous scan. Returns immediately; subscribe to
   * `cleaner:scan-complete` (one event) and `cleaner:size-update`
   * (one per repo) to receive results.
   */
  scanFolder: (folder: string, scanId: string) =>
    invoke<void>("cleaner_scan_folder", { folder, scanId }),

  /**
   * Build the global cache section synchronously (cheap), then stream
   * sizes via `cleaner:size-update` with `scan_id == "globals"`.
   */
  discoverGlobals: () => invoke<CleanerTreeNode>("cleaner_discover_globals"),

  /** Run all marked actions in parallel. Returns aggregate results. */
  runActions: (items: CleanerRunActionItem[]) =>
    invoke<CleanerRunResult>("cleaner_run_actions", { items }),

  /**
   * Re-emit the cached tree for a given folder (or `"globals"` for the
   * global section). Used to re-hydrate after a remount without a fresh
   * filesystem walk.
   */
  getCachedTree: (folder: string) =>
    invoke<CleanerTreeNode[] | null>("cleaner_get_cached_tree", { folder }),

  /** Native folder picker (re-uses the http-runner backend command). */
  pickDirectory: () => invoke<string | null>("pick_directory"),
};

// ────────────────────────────────────────────────────────────────────────
// Events
// ────────────────────────────────────────────────────────────────────────

/** Subscribe to `cleaner:scan-started` (one fire per scan, at start). */
export function listenScanStarted(
  cb: (event: CleanerScanStartedEvent) => void,
): Promise<UnlistenFn> {
  return listen<CleanerScanStartedEvent>("cleaner:scan-started", (e) =>
    cb(e.payload),
  );
}

/**
 * Subscribe to `cleaner:scan-progress` — fires every ~150ms while a
 * scan is in flight, with a sorted snapshot of repos found so far.
 */
export function listenScanProgress(
  cb: (event: CleanerScanProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<CleanerScanProgressEvent>("cleaner:scan-progress", (e) =>
    cb(e.payload),
  );
}

/** Subscribe to `cleaner:scan-complete` (one fire per scan). */
export function listenScanComplete(
  cb: (event: CleanerScanCompleteEvent) => void,
): Promise<UnlistenFn> {
  return listen<CleanerScanCompleteEvent>("cleaner:scan-complete", (e) =>
    cb(e.payload),
  );
}

/** Subscribe to `cleaner:size-update` (one per repo / global path). */
export function listenSizeUpdate(
  cb: (update: CleanerSizeUpdate) => void,
): Promise<UnlistenFn> {
  return listen<CleanerSizeUpdate>("cleaner:size-update", (e) =>
    cb(e.payload),
  );
}

/**
 * Subscribe to `cleaner:size-progress`. Fires once at start (with
 * `completed: 0`), once per completed estimate, and once at the end
 * with `done: true`.
 */
export function listenSizeProgress(
  cb: (update: CleanerSizeProgress) => void,
): Promise<UnlistenFn> {
  return listen<CleanerSizeProgress>("cleaner:size-progress", (e) =>
    cb(e.payload),
  );
}

// ────────────────────────────────────────────────────────────────────────
// Display helpers
// ────────────────────────────────────────────────────────────────────────

/** `1.4 GB`-style human size. Returns `—` when `bytes` is null/undefined. */
export function fmtSize(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  const TB = GB * 1024;
  if (bytes >= TB) return `${(bytes / TB).toFixed(2)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(0)} KB`;
  return `${bytes} B`;
}
