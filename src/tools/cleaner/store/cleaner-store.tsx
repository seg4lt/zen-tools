/**
 * Cleaner reducer + Context.
 *
 * The store holds:
 *   - `folders`           — persisted scan-folder list (mirror of backend).
 *   - `trees`             — `folderKey → root[]` for the freshly-built tree
 *                           per folder, plus `"globals"` for the global section.
 *   - `scanStatus`        — per-folder lifecycle.
 *   - `actions`           — node id → marked action.
 *   - `expanded`          — node ids that are expanded (default-expanded
 *                           when absent; explicit collapses use a `-:` prefix).
 *   - `cursor`            — node id under the keyboard cursor.
 *   - `flat`              — derived flattened visible-row id list, used for
 *                           j/k cursor movement (recomputed on every state
 *                           change touching trees / expanded / actions).
 *   - `runState` / `results` — confirmation + bulk-run plumbing.
 *   - `paletteOpen` / `helpOpen` — UI overlay flags.
 *
 * The reducer never reaches into Tauri directly — every async command is
 * dispatched from a hook (`use-cleaner-scans`) that then writes the
 * outcome back into the store.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import {
  cleanerTauri,
  listenScanComplete,
  listenScanProgress,
  listenScanStarted,
  listenSizeProgress,
  listenSizeUpdate,
  type CleanerNodeAction,
  type CleanerRunResult,
  type CleanerTreeNode,
} from "../lib/tauri";

/** Constant key the global cache section lives under in `trees`. */
export const GLOBALS_KEY = "globals";

/**
 * Virtual id of the merged `Repositories` section.  Repos discovered
 * across every scan-folder are aggregated under this single header
 * (so the user never sees `REPOSITORIES` rendered twice when more than
 * one folder is being scanned).
 */
export const REPOS_SECTION_ID = "repos:all";

export type ScanStatus = "idle" | "scanning" | "ready" | "error";

export type RunState = "idle" | "confirming" | "running" | "done";

/** How leaves under each section are ordered. */
export type SortMode = "alpha" | "clean" | "delete";

/**
 * Per-folder size estimation progress. `completed === total && total > 0`
 * means the scan is done (the UI hides the indicator); a missing entry
 * means estimation hasn't started for that key.
 */
export interface SizeProgress {
  completed: number;
  total: number;
}

export interface CleanerState {
  /** Persisted folder list, in user-defined order. */
  folders: string[];
  /** Folder path or `GLOBALS_KEY` → its tree root list. */
  trees: Record<string, CleanerTreeNode[]>;
  /** Lifecycle per folder/globals key. */
  scanStatus: Record<string, ScanStatus>;
  /** Most recent error per folder (used in the sidebar tooltip). */
  scanError: Record<string, string | undefined>;
  /** Live `estimating X/Y` counter per folder/globals key. */
  sizeProgress: Record<string, SizeProgress>;
  /** Marked action per node id. */
  actions: Record<string, CleanerNodeAction>;
  /**
   * Expansion overrides. A bare id means "expanded"; `-:` prefix means
   * "explicitly collapsed". Nodes not in the set fall back to default-
   * expanded.
   */
  expanded: Set<string>;
  /** Currently-focused row id (matches a `flat` entry). */
  cursor: string | null;
  /** Flattened, visible row order. Recomputed from `trees + expanded`. */
  flat: string[];
  /**
   * Derived top-level roots used for rendering: a single virtual
   * `Repositories` section that aggregates repos from every scan-folder
   * (in [`sort`] order), followed by the `Globals` section.  Recomputed
   * any time `folders`, `trees`, or `sort` change.
   */
  aggregatedRoots: CleanerTreeNode[];
  /** Active sort mode for repo / global leaves. */
  sort: SortMode;
  /** Run lifecycle. */
  runState: RunState;
  /** Result of the most recent run (lives until the user dismisses). */
  results: CleanerRunResult | null;
  /** Bulk-action command palette open? */
  paletteOpen: boolean;
  /** Keybinding help overlay open? */
  helpOpen: boolean;
}

const initialState: CleanerState = {
  folders: [],
  trees: {},
  scanStatus: {},
  scanError: {},
  sizeProgress: {},
  actions: {},
  expanded: new Set<string>(),
  cursor: null,
  flat: [],
  aggregatedRoots: [],
  sort: "alpha",
  runState: "idle",
  results: null,
  paletteOpen: false,
  helpOpen: false,
};

export type CleanerAction =
  | { type: "setFolders"; folders: string[] }
  | { type: "setScanStatus"; key: string; status: ScanStatus; error?: string }
  | {
      type: "setSizeProgress";
      key: string;
      completed: number;
      total: number;
      done: boolean;
    }
  | { type: "setTree"; key: string; roots: CleanerTreeNode[] }
  | { type: "removeTree"; key: string }
  | {
      type: "updateNodeSize";
      nodeId: string;
      cleanSize: number | null;
      deleteSize: number | null;
      size: number | null;
    }
  | { type: "toggleExpand"; nodeId: string }
  | { type: "setExpanded"; nodeId: string; open: boolean }
  | { type: "setAction"; nodeId: string; action: CleanerNodeAction }
  | { type: "cycleAction"; nodeId: string }
  | {
      type: "bulkMark";
      kind: "repo" | "globalPath" | "all";
      action: CleanerNodeAction;
    }
  | { type: "clearMarks" }
  | { type: "setCursor"; nodeId: string | null }
  | { type: "moveCursor"; delta: number }
  | { type: "cursorTop" }
  | { type: "cursorBottom" }
  | { type: "openConfirm" }
  | { type: "cancelConfirm" }
  | { type: "startRun" }
  | { type: "finishRun"; results: CleanerRunResult }
  | { type: "dismissResults" }
  | { type: "setPalette"; open: boolean }
  | { type: "setHelp"; open: boolean }
  | { type: "setSort"; sort: SortMode };

// ────────────────────────────────────────────────────────────────────────
// Tree helpers (pure)
// ────────────────────────────────────────────────────────────────────────

/**
 * Walk a forest and apply `mut` to every node. Returns a NEW forest if
 * any node was rewritten, otherwise `null` so callers can short-circuit.
 *
 * Path-based recursion keeps the immutable update cheap — only the
 * spine from each rewritten node up to its tree root is reallocated.
 */
function mapForest(
  roots: CleanerTreeNode[],
  mut: (node: CleanerTreeNode) => CleanerTreeNode | null,
): CleanerTreeNode[] | null {
  let changed = false;
  const next = roots.map((root) => {
    const out = mapNode(root, mut);
    if (out !== root) changed = true;
    return out;
  });
  return changed ? next : null;
}

function mapNode(
  node: CleanerTreeNode,
  mut: (node: CleanerTreeNode) => CleanerTreeNode | null,
): CleanerTreeNode {
  // 1. Recurse first (deepest mutation wins for the same id).
  let nextChildren: CleanerTreeNode[] | null = null;
  if (node.children.length > 0) {
    let childrenChanged = false;
    const updated = node.children.map((c) => {
      const out = mapNode(c, mut);
      if (out !== c) childrenChanged = true;
      return out;
    });
    if (childrenChanged) nextChildren = updated;
  }

  // 2. Apply the mutator at this node.
  const mutated = mut(node);

  if (!mutated && !nextChildren) return node;
  const base = mutated ?? node;
  return nextChildren ? { ...base, children: nextChildren } : base;
}

/** Default-expanded helper. Mirrors `useExpanded` in HttpFileTree. */
function isExpanded(expanded: Set<string>, id: string): boolean {
  if (expanded.has(id)) return true;
  return !expanded.has(`-:${id}`);
}

/** Re-flatten the aggregated forest under the current expansion state. */
function rebuildFlat(
  aggregatedRoots: CleanerTreeNode[],
  expanded: Set<string>,
): string[] {
  const out: string[] = [];
  for (const root of aggregatedRoots) walkVisible(root, expanded, out);
  return out;
}

/**
 * Sort comparator helper — returns the size in bytes that sort mode
 * cares about for a given leaf.  Globals don't have a separate "clean"
 * size, so they always sort to 0 in `clean` mode (effectively meaning
 * "globals stay below repos when sorting by clean reclaim").
 */
function sizeFor(node: CleanerTreeNode, mode: SortMode): number {
  if (mode === "alpha") return 0;
  if (node.kind === "repo") {
    return mode === "clean"
      ? (node.cleanSize ?? 0)
      : (node.deleteSize ?? 0);
  }
  if (node.kind === "globalPath") {
    return mode === "delete" ? (node.size ?? 0) : 0;
  }
  return 0;
}

function sortLeaves(leaves: CleanerTreeNode[], sort: SortMode): void {
  if (sort === "alpha") {
    leaves.sort((a, b) => a.label.localeCompare(b.label));
    return;
  }
  // Descending: biggest culprits first.
  leaves.sort((a, b) => sizeFor(b, sort) - sizeFor(a, sort));
}

/**
 * Build the rendered top-level forest:
 *
 *   [virtual `Repositories` section, …all-repos…]
 *   [`Globals` section, …globals…]
 *
 * Repos are extracted from every per-folder tree so the user sees one
 * merged list (instead of `Repositories` repeating once per scan-folder).
 * Both sections respect the current sort order.
 */
function rebuildAggregated(
  folders: string[],
  trees: Record<string, CleanerTreeNode[]>,
  sort: SortMode,
): CleanerTreeNode[] {
  const allRepos: CleanerTreeNode[] = [];
  for (const folder of folders) {
    const roots = trees[folder];
    if (!roots) continue;
    for (const root of roots) {
      if (root.kind !== "section") continue;
      for (const child of root.children) {
        if (child.kind === "repo") allRepos.push(child);
      }
    }
  }
  sortLeaves(allRepos, sort);

  const globalsRoots = trees[GLOBALS_KEY] ?? [];
  const sortedGlobals = globalsRoots.map((root) => {
    if (root.kind !== "section") return root;
    const children = [...root.children];
    sortLeaves(children, sort);
    return { ...root, children };
  });

  const out: CleanerTreeNode[] = [];
  // Show the Repositories header any time the user has at least one
  // folder configured — even before a scan completes — so it's
  // immediately obvious that work is in progress.
  if (folders.length > 0) {
    out.push({
      id: REPOS_SECTION_ID,
      label: "Repositories",
      kind: "section",
      isDir: true,
      depth: 0,
      path: "",
      children: allRepos,
      cleanSize: null,
      deleteSize: null,
      size: null,
      sizeDone: true,
    });
  }
  out.push(...sortedGlobals);
  return out;
}

/**
 * Recompute `aggregatedRoots`, `flat`, and clamp `cursor` to the new
 * flat list.  Called from every reducer case that touches the inputs
 * those derived fields depend on.
 */
function withAggregated(state: CleanerState): CleanerState {
  const aggregatedRoots = rebuildAggregated(
    state.folders,
    state.trees,
    state.sort,
  );
  const flat = rebuildFlat(aggregatedRoots, state.expanded);
  const cursor =
    state.cursor && flat.includes(state.cursor)
      ? state.cursor
      : (flat[0] ?? null);
  return { ...state, aggregatedRoots, flat, cursor };
}

function walkVisible(
  node: CleanerTreeNode,
  expanded: Set<string>,
  out: string[],
): void {
  out.push(node.id);
  if (node.isDir && isExpanded(expanded, node.id)) {
    for (const child of node.children) walkVisible(child, expanded, out);
  }
}

/** Find a node by id across every tree. Linear scan — trees are tiny. */
export function findNode(
  trees: Record<string, CleanerTreeNode[]>,
  id: string,
): CleanerTreeNode | null {
  for (const roots of Object.values(trees)) {
    for (const root of roots) {
      const hit = findInNode(root, id);
      if (hit) return hit;
    }
  }
  return null;
}

function findInNode(
  node: CleanerTreeNode,
  id: string,
): CleanerTreeNode | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = findInNode(child, id);
    if (hit) return hit;
  }
  return null;
}

/** Iterate every leaf node of every tree. */
function* iterLeaves(
  trees: Record<string, CleanerTreeNode[]>,
): Generator<CleanerTreeNode> {
  for (const roots of Object.values(trees)) {
    for (const root of roots) yield* leavesOf(root);
  }
}

function* leavesOf(node: CleanerTreeNode): Generator<CleanerTreeNode> {
  if (node.kind === "section") {
    for (const child of node.children) yield* leavesOf(child);
    return;
  }
  yield node;
}

// ────────────────────────────────────────────────────────────────────────
// Reducer
// ────────────────────────────────────────────────────────────────────────

function reducer(state: CleanerState, action: CleanerAction): CleanerState {
  switch (action.type) {
    case "setFolders": {
      // Drop any cached state belonging to folders that are no longer
      // in the list (the user removed them).  Never drops the globals.
      const keep = new Set([...action.folders, GLOBALS_KEY]);
      const trees: Record<string, CleanerTreeNode[]> = {};
      const scanStatus: Record<string, ScanStatus> = {};
      const scanError: Record<string, string | undefined> = {};
      const sizeProgress: Record<string, SizeProgress> = {};
      for (const k of Object.keys(state.trees)) {
        if (keep.has(k)) trees[k] = state.trees[k];
      }
      for (const k of Object.keys(state.scanStatus)) {
        if (keep.has(k)) scanStatus[k] = state.scanStatus[k];
      }
      for (const k of Object.keys(state.scanError)) {
        if (keep.has(k)) scanError[k] = state.scanError[k];
      }
      for (const k of Object.keys(state.sizeProgress)) {
        if (keep.has(k)) sizeProgress[k] = state.sizeProgress[k];
      }
      return withAggregated({
        ...state,
        folders: action.folders,
        trees,
        scanStatus,
        scanError,
        sizeProgress,
      });
    }

    case "setScanStatus":
      return {
        ...state,
        scanStatus: { ...state.scanStatus, [action.key]: action.status },
        scanError: { ...state.scanError, [action.key]: action.error },
      };

    case "setSizeProgress": {
      const sizeProgress = { ...state.sizeProgress };
      if (action.done) {
        // Drop the entry so the UI can stop showing the counter.
        delete sizeProgress[action.key];
      } else {
        sizeProgress[action.key] = {
          completed: action.completed,
          total: action.total,
        };
      }
      return { ...state, sizeProgress };
    }

    case "setTree": {
      const trees = { ...state.trees, [action.key]: action.roots };
      return withAggregated({ ...state, trees });
    }

    case "removeTree": {
      if (!(action.key in state.trees)) return state;
      const trees = { ...state.trees };
      delete trees[action.key];
      return withAggregated({ ...state, trees });
    }

    case "updateNodeSize": {
      // Walk every tree looking for `nodeId` — only one is ever in
      // any tree, but the lookup is cheap.
      let didChange = false;
      const trees: Record<string, CleanerTreeNode[]> = {};
      for (const [key, roots] of Object.entries(state.trees)) {
        const next = mapForest(roots, (n) => {
          if (n.id !== action.nodeId) return null;
          didChange = true;
          return {
            ...n,
            cleanSize:
              action.cleanSize !== null ? action.cleanSize : n.cleanSize,
            deleteSize:
              action.deleteSize !== null ? action.deleteSize : n.deleteSize,
            size: action.size !== null ? action.size : n.size,
            sizeDone: true,
          };
        });
        trees[key] = next ?? roots;
      }
      if (!didChange) return state;
      // Aggregated roots reference the per-folder repo nodes — we have
      // to rebuild so the new size flows through and (when sorting by
      // size) the row reorders.
      return withAggregated({ ...state, trees });
    }

    case "toggleExpand": {
      const expanded = new Set(state.expanded);
      const open = isExpanded(expanded, action.nodeId);
      expanded.delete(action.nodeId);
      expanded.delete(`-:${action.nodeId}`);
      if (open) expanded.add(`-:${action.nodeId}`);
      else expanded.add(action.nodeId);
      return withAggregated({ ...state, expanded });
    }

    case "setExpanded": {
      const expanded = new Set(state.expanded);
      expanded.delete(action.nodeId);
      expanded.delete(`-:${action.nodeId}`);
      if (action.open) expanded.add(action.nodeId);
      else expanded.add(`-:${action.nodeId}`);
      return withAggregated({ ...state, expanded });
    }

    case "setSort":
      return withAggregated({ ...state, sort: action.sort });

    case "setAction": {
      const node = findNode(state.trees, action.nodeId);
      if (!node || node.kind === "section") return state;
      // Globals can't be marked Clean — silently coerce.
      const safe =
        node.kind === "globalPath" && action.action === "clean"
          ? "delete"
          : action.action;
      const next = { ...state.actions };
      if (safe === "none") delete next[action.nodeId];
      else next[action.nodeId] = safe;
      return { ...state, actions: next };
    }

    case "cycleAction": {
      const node = findNode(state.trees, action.nodeId);
      if (!node || node.kind === "section") return state;
      const cur = state.actions[action.nodeId] ?? "none";
      let nextAction: CleanerNodeAction;
      if (node.kind === "repo") {
        nextAction =
          cur === "none" ? "clean" : cur === "clean" ? "delete" : "none";
      } else {
        nextAction = cur === "delete" ? "none" : "delete";
      }
      const next = { ...state.actions };
      if (nextAction === "none") delete next[action.nodeId];
      else next[action.nodeId] = nextAction;
      return { ...state, actions: next };
    }

    case "bulkMark": {
      const next: Record<string, CleanerNodeAction> = { ...state.actions };
      for (const leaf of iterLeaves(state.trees)) {
        if (action.kind !== "all" && leaf.kind !== action.kind) continue;
        // Skip illegal globals×clean combo.
        if (leaf.kind === "globalPath" && action.action === "clean") continue;
        if (action.action === "none") delete next[leaf.id];
        else next[leaf.id] = action.action;
      }
      return { ...state, actions: next };
    }

    case "clearMarks":
      return { ...state, actions: {} };

    case "setCursor":
      return { ...state, cursor: action.nodeId };

    case "moveCursor": {
      if (state.flat.length === 0) return state;
      const idx = state.cursor ? state.flat.indexOf(state.cursor) : -1;
      const base = idx < 0 ? 0 : idx;
      const next = Math.max(
        0,
        Math.min(state.flat.length - 1, base + action.delta),
      );
      return { ...state, cursor: state.flat[next] };
    }

    case "cursorTop":
      return { ...state, cursor: state.flat[0] ?? null };

    case "cursorBottom":
      return {
        ...state,
        cursor: state.flat[state.flat.length - 1] ?? null,
      };

    case "openConfirm":
      return Object.keys(state.actions).length > 0
        ? { ...state, runState: "confirming" }
        : state;

    case "cancelConfirm":
      return state.runState === "confirming"
        ? { ...state, runState: "idle" }
        : state;

    case "startRun":
      return { ...state, runState: "running" };

    case "finishRun":
      return {
        ...state,
        runState: "done",
        results: action.results,
        // Successful actions imply the underlying data is gone — clear
        // the marks so the user doesn't accidentally re-run them.
        actions: {},
      };

    case "dismissResults":
      return { ...state, runState: "idle", results: null };

    case "setPalette":
      return { ...state, paletteOpen: action.open };

    case "setHelp":
      return { ...state, helpOpen: action.open };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Context plumbing
// ────────────────────────────────────────────────────────────────────────

const StoreCtx = createContext<{
  state: CleanerState;
  dispatch: Dispatch<CleanerAction>;
} | null>(null);

export function CleanerStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);

  // Bootstrap lives at the provider level — runs exactly once per
  // provider mount.  Previously this effect lived inside `useCleanerScans`,
  // but that hook is invoked from six components and each instance ran
  // its own bootstrap; one of the late-arriving `setFolders([])`
  // dispatches could land *after* the user's own `addFolder` dispatch
  // and clobber it, hiding the just-added folder until the next add.
  useEffect(() => {
    let alive = true;
    let unlistenStarted: (() => void) | null = null;
    let unlistenProgress: (() => void) | null = null;
    let unlistenComplete: (() => void) | null = null;
    let unlistenSize: (() => void) | null = null;
    let unlistenSizeProgress: (() => void) | null = null;

    (async () => {
      // Subscribe to every Tauri event *before* kicking the initial
      // fetch, so the first `cleaner:scan-complete` from a
      // hydration-triggered scan can't slip through unobserved.
      unlistenStarted = await listenScanStarted((ev) => {
        if (!alive) return;
        dispatch({
          type: "setScanStatus",
          key: ev.folder,
          status: "scanning",
        });
      });
      unlistenProgress = await listenScanProgress((ev) => {
        if (!alive) return;
        dispatch({ type: "setTree", key: ev.folder, roots: ev.roots });
      });
      unlistenComplete = await listenScanComplete((ev) => {
        if (!alive) return;
        dispatch({
          type: "setTree",
          key: ev.folder,
          roots: ev.result.roots,
        });
        dispatch({
          type: "setScanStatus",
          key: ev.folder,
          status: "ready",
        });
      });
      unlistenSize = await listenSizeUpdate((u) => {
        if (!alive) return;
        dispatch({
          type: "updateNodeSize",
          nodeId: u.nodeId,
          cleanSize: u.cleanSize,
          deleteSize: u.deleteSize,
          size: u.size,
        });
      });
      unlistenSizeProgress = await listenSizeProgress((p) => {
        if (!alive) return;
        dispatch({
          type: "setSizeProgress",
          key: p.scanId,
          completed: p.completed,
          total: p.total,
          done: p.done,
        });
      });

      try {
        const folders = await cleanerTauri.listScanFolders();
        if (!alive) return;
        dispatch({ type: "setFolders", folders });

        // Hydrate trees from the backend's persisted cache first
        // (instant), and only kick a fresh scan when there's nothing to
        // show yet.  Tab switching paints last-known data immediately.
        const targets = [...folders, GLOBALS_KEY];
        for (const key of targets) {
          let cached: CleanerTreeNode[] | null = null;
          try {
            cached = await cleanerTauri.getCachedTree(key);
          } catch (err) {
            console.warn("[cleaner] cache hydration failed", key, err);
          }
          if (!alive) return;

          if (cached && cached.length > 0) {
            dispatch({ type: "setTree", key, roots: cached });
            dispatch({ type: "setScanStatus", key, status: "ready" });
            continue;
          }

          // No cache — run a fresh scan/discover.
          dispatch({ type: "setScanStatus", key, status: "scanning" });
          if (key === GLOBALS_KEY) {
            try {
              const section = await cleanerTauri.discoverGlobals();
              if (!alive) return;
              dispatch({ type: "setTree", key, roots: [section] });
              dispatch({ type: "setScanStatus", key, status: "ready" });
            } catch (err) {
              if (!alive) return;
              dispatch({
                type: "setScanStatus",
                key,
                status: "error",
                error: String(
                  (err as { message?: string })?.message ?? err,
                ),
              });
            }
          } else {
            try {
              await cleanerTauri.scanFolder(key, key);
              // The actual `setTree` arrives via the scan-complete
              // event we already subscribed to above.
            } catch (err) {
              if (!alive) return;
              dispatch({
                type: "setScanStatus",
                key,
                status: "error",
                error: String(
                  (err as { message?: string })?.message ?? err,
                ),
              });
            }
          }
        }
      } catch (err) {
        console.error("[cleaner] bootstrap failed", err);
      }
    })();

    return () => {
      alive = false;
      unlistenStarted?.();
      unlistenProgress?.();
      unlistenComplete?.();
      unlistenSize?.();
      unlistenSizeProgress?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useCleanerStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) {
    throw new Error(
      "useCleanerStore must be used inside <CleanerStoreProvider>",
    );
  }
  return ctx;
}

// ────────────────────────────────────────────────────────────────────────
// Selectors (memo helpers)
// ────────────────────────────────────────────────────────────────────────

/**
 * Total reclaimable size for currently-marked items.
 *
 * Repos with `clean` use `cleanSize`; repos with `delete` use `deleteSize`;
 * globals use `size`. Missing sizes count as 0 — it's an estimate.
 */
export function totalReclaimable(state: CleanerState): number {
  let total = 0;
  for (const [id, action] of Object.entries(state.actions)) {
    const node = findNode(state.trees, id);
    if (!node) continue;
    if (node.kind === "repo") {
      const v = action === "clean" ? node.cleanSize : node.deleteSize;
      if (v != null) total += v;
    } else if (node.kind === "globalPath") {
      if (node.size != null) total += node.size;
    }
  }
  return total;
}

/** Counts of marked actions per kind, used by the action bar + palette. */
export function markCounts(state: CleanerState): {
  clean: number;
  delete: number;
  total: number;
} {
  let clean = 0;
  let del = 0;
  for (const action of Object.values(state.actions)) {
    if (action === "clean") clean += 1;
    else if (action === "delete") del += 1;
  }
  return { clean, delete: del, total: clean + del };
}
