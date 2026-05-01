/**
 * Markdown editor reducer + Context.
 *
 * State holds:
 *   - `vaults`      — persisted vault folder list (mirror of backend).
 *   - `files`       — `vaultRoot → MarkdownVaultDto` from
 *                     `markdown_discover_files`.
 *   - `expanded`    — node ids that the user has explicitly toggled
 *                     (default-expanded otherwise; explicit collapses
 *                     are tagged with a `-:` prefix).
 *   - `tabs` / `activeTabId` — the open documents, in tab-strip
 *     order; the active tab is derived through `activeTab(state)`.
 *   - `recents`     — the bounded ring used by the quick switcher.
 *   - `searchOpen` / `searchMode` — drives the unified Cmd+P /
 *     Cmd+Shift+F search palette (file vs content modes).
 *   - `bootstrapping` — `true` until the first discovery completes.
 *
 * Bootstrap (vault list fetch + discover + recent files) lives **inside
 * the provider's `useEffect`**, *not* in a per-component hook, so it
 * runs exactly once per mount.  This avoids the "stale dispatch
 * clobbers user mutation" race we hit in the cleaner tool when the
 * same hook was instantiated from multiple components.
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
import { markdownTauri, type MarkdownVaultDto } from "../lib/tauri";

export interface OpenFileState {
  path: string;
  doc: string;
  dirty: boolean;
}

/** What sort of editor a tab needs.  Drives both the icon in the
 *  tab strip and the component the view layer mounts in the body. */
export type TabKind = "markdown" | "excalidraw";

/** One entry in the tab strip — own copy of the doc + dirty flag so
 *  the user can switch away mid-edit and come back to their changes. */
export interface TabState {
  /** Stable per-session tab id (used by tab-strip click + close).
   *  We don't reuse `path` because the user might rename a file (path
   *  changes) and we want the tab to keep its identity. */
  id: string;
  path: string;
  /** For markdown tabs: the file's text contents.  For excalidraw
   *  tabs: always `""` — the drawing is megabytes of SVG that we
   *  refuse to thread through the reducer; the editor reads it
   *  straight from disk on mount and serialises a fresh SVG only at
   *  save time.  `dirty` is still flipped via a sentinel `editDoc`. */
  doc: string;
  dirty: boolean;
  /** Markdown by default; `"excalidraw"` for `*.excalidraw.svg`
   *  tabs.  Set once at `openFile` time — the path doesn't change
   *  the tab kind even if the file is later renamed. */
  kind: TabKind;
}

/**
 * Drives the inline editing UI in the sidebar.
 *
 *  - `kind: "rename"` swaps a tree row's label with an `<input>`
 *    pre-filled with `seed`.  Path identifies which row.
 *  - `kind: "create"` inserts an empty placeholder row inside
 *    `parentDir` at the requested kind ("file" or "folder") with a
 *    focused input.  Used by "New file" / "New folder" menu items.
 */
export type EditingState =
  | { kind: "rename"; path: string; seed: string }
  | { kind: "create"; parentDir: string; childKind: "file" | "folder" };

/** Which kind of search the unified palette is showing. */
export type SearchMode = "files" | "content";

export interface MarkdownState {
  vaults: string[];
  files: Record<string, MarkdownVaultDto>;
  expanded: Set<string>;
  /** Open tabs, in user-visible order. */
  tabs: TabState[];
  /** Id of the active tab (or `null` when no tab is open). */
  activeTabId: string | null;
  recents: string[];
  /** Whether the search palette overlay is open. */
  searchOpen: boolean;
  /** Which mode the palette is currently in. */
  searchMode: SearchMode;
  bootstrapping: boolean;
  editing: EditingState | null;
  /**
   * One-shot scroll target.  When set, the next render of
   * `MarkdownView` calls `editor.scrollToLine()` and dispatches
   * `clearGotoLine`.  Used so the search palette can take the user
   * to the exact match line after opening a file.
   */
  pendingGotoLine: number | null;
}

const initialState: MarkdownState = {
  vaults: [],
  files: {},
  expanded: new Set<string>(),
  tabs: [],
  activeTabId: null,
  recents: [],
  searchOpen: false,
  searchMode: "files",
  bootstrapping: true,
  editing: null,
  pendingGotoLine: null,
};

/** Selector — the currently active tab, or `null`. */
export function activeTab(state: MarkdownState): TabState | null {
  if (!state.activeTabId) return null;
  return state.tabs.find((t) => t.id === state.activeTabId) ?? null;
}

/** Backwards-compatible accessor for callers that just want the
 *  active doc + path + dirty triple.  Lets us roll out tabs without
 *  rewriting every consumer at once. */
export function currentFile(state: MarkdownState): OpenFileState | null {
  const tab = activeTab(state);
  if (!tab) return null;
  return { path: tab.path, doc: tab.doc, dirty: tab.dirty };
}

let tabIdCounter = 0;
function nextTabId(): string {
  tabIdCounter += 1;
  return `tab-${Date.now()}-${tabIdCounter}`;
}

export type MarkdownAction =
  | { type: "setVaults"; vaults: string[] }
  | { type: "setFiles"; vaults: MarkdownVaultDto[] }
  | { type: "toggleExpand"; nodeId: string }
  | { type: "setExpanded"; nodeId: string; open: boolean }
  | {
      type: "openFile";
      path: string;
      doc: string;
      gotoLine?: number;
      /** Defaults to `"markdown"`; pass `"excalidraw"` for drawings. */
      kind?: TabKind;
    }
  | { type: "closeFile" }
  | { type: "selectTab"; id: string; gotoLine?: number }
  | { type: "closeTab"; id: string }
  | { type: "closeOtherTabs" }
  | { type: "setGotoLine"; line: number }
  | { type: "clearGotoLine" }
  | { type: "revealPath"; path: string }
  | { type: "editDoc"; doc: string }
  /**
   * Clear the dirty flag. With no `path` it clears the active tab
   * (back-compat with the old binary action). With `path` it clears
   * that specific tab — used by autosave, where a write may complete
   * after the user has switched tabs and we mustn't clobber the new
   * tab's state.
   */
  | { type: "markSaved"; path?: string }
  | { type: "setRecents"; recents: string[] }
  | { type: "setSearchPalette"; open: boolean; mode?: SearchMode }
  | { type: "setSearchMode"; mode: SearchMode }
  | { type: "bootstrapped" }
  | { type: "startRename"; path: string; seed: string }
  | { type: "startCreate"; parentDir: string; childKind: "file" | "folder" }
  | { type: "cancelEditing" }
  | { type: "renamedFile"; oldPath: string; newPath: string };

function reducer(state: MarkdownState, action: MarkdownAction): MarkdownState {
  switch (action.type) {
    case "setVaults": {
      // Drop file entries belonging to vaults that disappeared.
      const keep = new Set(action.vaults);
      const files: Record<string, MarkdownVaultDto> = {};
      for (const k of Object.keys(state.files)) {
        if (keep.has(k)) files[k] = state.files[k];
      }
      return { ...state, vaults: action.vaults, files };
    }

    case "setFiles": {
      // The backend always returns one entry per requested vault, so we
      // mirror them as-is into the keyed map.
      const files: Record<string, MarkdownVaultDto> = {};
      for (const v of action.vaults) {
        files[v.root] = v;
      }
      return { ...state, files };
    }

    case "toggleExpand": {
      // Default-collapsed semantics: a node is open iff its id is in
      // the set.  Toggle = add or remove.
      const expanded = new Set(state.expanded);
      if (expanded.has(action.nodeId)) expanded.delete(action.nodeId);
      else expanded.add(action.nodeId);
      return { ...state, expanded };
    }

    case "setExpanded": {
      const expanded = new Set(state.expanded);
      if (action.open) expanded.add(action.nodeId);
      else expanded.delete(action.nodeId);
      return { ...state, expanded };
    }

    case "openFile": {
      // If a tab for this path already exists, just switch to it
      // (carrying over any dirty edits the user already made).
      const gotoLine = action.gotoLine ?? null;
      const existing = state.tabs.find((t) => t.path === action.path);
      if (existing) {
        return {
          ...state,
          activeTabId: existing.id,
          searchOpen: false,
          pendingGotoLine: gotoLine,
        };
      }
      const id = nextTabId();
      const newTab: TabState = {
        id,
        path: action.path,
        doc: action.doc,
        dirty: false,
        kind: action.kind ?? "markdown",
      };
      return {
        ...state,
        tabs: [...state.tabs, newTab],
        activeTabId: id,
        searchOpen: false,
        pendingGotoLine: gotoLine,
      };
    }

    case "selectTab": {
      if (!state.tabs.some((t) => t.id === action.id)) return state;
      return {
        ...state,
        activeTabId: action.id,
        pendingGotoLine: action.gotoLine ?? null,
      };
    }

    case "setGotoLine":
      return { ...state, pendingGotoLine: action.line };

    case "clearGotoLine":
      return state.pendingGotoLine == null
        ? state
        : { ...state, pendingGotoLine: null };

    case "revealPath": {
      // Mark every ancestor of `path` as expanded so the file is
      // visible in the sidebar tree.  Vault roots use the `vault:`
      // prefix in the expanded set — see `VaultBlock` in the
      // sidebar — so we expand both the matching vault and every
      // parent directory between the vault and the file.
      const next = new Set(state.expanded);
      let changed = false;
      for (const vault of state.vaults) {
        if (action.path === vault) continue;
        const prefix = vault.endsWith("/") ? vault : `${vault}/`;
        if (!action.path.startsWith(prefix)) continue;
        // Expand the vault block itself.
        const vaultKey = `vault:${vault}`;
        if (!next.has(vaultKey)) {
          next.add(vaultKey);
          changed = true;
        }
        // Expand every intermediate directory.  We walk the relative
        // path segment-by-segment, building the absolute prefix the
        // tree uses as its expansion key.
        const rel = action.path.slice(prefix.length);
        const parts = rel.split("/");
        let cursor = vault;
        // Skip the last segment — it's the file itself.
        for (let i = 0; i < parts.length - 1; i++) {
          cursor = `${cursor}/${parts[i]}`;
          if (!next.has(cursor)) {
            next.add(cursor);
            changed = true;
          }
        }
        break;
      }
      return changed ? { ...state, expanded: next } : state;
    }

    case "closeTab": {
      const idx = state.tabs.findIndex((t) => t.id === action.id);
      if (idx === -1) return state;
      const tabs = state.tabs.slice(0, idx).concat(state.tabs.slice(idx + 1));
      // Pick a sensible new active tab: the neighbour to the right
      // (matches VS Code), or the previous one when we just closed
      // the last entry.
      let activeTabId: string | null = state.activeTabId;
      if (state.activeTabId === action.id) {
        const fallback = tabs[idx] ?? tabs[idx - 1] ?? null;
        activeTabId = fallback ? fallback.id : null;
      }
      return { ...state, tabs, activeTabId };
    }

    case "closeOtherTabs": {
      // Keep only the active tab.  No-op when there are 0 or 1 tabs.
      const id = state.activeTabId;
      if (!id) return state;
      const active = state.tabs.find((t) => t.id === id);
      if (!active || state.tabs.length <= 1) return state;
      return { ...state, tabs: [active], activeTabId: id };
    }

    case "closeFile":
      // Legacy alias — close the active tab.
      if (!state.activeTabId) return state;
      return reducer(state, { type: "closeTab", id: state.activeTabId });

    case "editDoc": {
      const id = state.activeTabId;
      if (!id) return state;
      let changed = false;
      const tabs = state.tabs.map((t) => {
        if (t.id !== id) return t;
        if (t.doc === action.doc) return t;
        changed = true;
        return { ...t, doc: action.doc, dirty: true };
      });
      if (!changed) return state;
      return { ...state, tabs };
    }

    case "markSaved": {
      // Path-targeted variant — used by the autosave hook so a write
      // that completes after the user switched tabs clears the right
      // tab. Falls back to the active tab for back-compat callers.
      if (action.path) {
        const target = action.path;
        const tabs = state.tabs.map((t) =>
          t.path === target ? { ...t, dirty: false } : t,
        );
        return { ...state, tabs };
      }
      const id = state.activeTabId;
      if (!id) return state;
      const tabs = state.tabs.map((t) =>
        t.id === id ? { ...t, dirty: false } : t,
      );
      return { ...state, tabs };
    }

    case "setRecents":
      return { ...state, recents: action.recents };

    case "setSearchPalette":
      return {
        ...state,
        searchOpen: action.open,
        searchMode: action.mode ?? state.searchMode,
      };

    case "setSearchMode":
      return { ...state, searchMode: action.mode };

    case "bootstrapped":
      return { ...state, bootstrapping: false };

    case "startRename":
      return {
        ...state,
        editing: { kind: "rename", path: action.path, seed: action.seed },
      };

    case "startCreate":
      return {
        ...state,
        editing: {
          kind: "create",
          parentDir: action.parentDir,
          childKind: action.childKind,
        },
        // Auto-expand the parent so the placeholder row is visible.
        expanded: new Set(state.expanded).add(action.parentDir),
      };

    case "cancelEditing":
      return { ...state, editing: null };

    case "renamedFile": {
      // Re-target every open tab whose path matches `oldPath` (the
      // file itself) or whose path lives under `oldPath/` (the user
      // renamed an ancestor directory).  Doc + dirty flag carry over.
      let changed = false;
      const tabs = state.tabs.map((t) => {
        if (t.path === action.oldPath) {
          changed = true;
          return { ...t, path: action.newPath };
        }
        const prefix = `${action.oldPath}/`;
        if (t.path.startsWith(prefix)) {
          changed = true;
          return {
            ...t,
            path: `${action.newPath}/${t.path.slice(prefix.length)}`,
          };
        }
        return t;
      });
      if (!changed) return state;
      return { ...state, tabs };
    }
  }
}

const StoreCtx = createContext<{
  state: MarkdownState;
  dispatch: Dispatch<MarkdownAction>;
} | null>(null);

export function MarkdownStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);

  // Single bootstrap effect.  Lives at the provider level so it runs
  // exactly once per provider mount, regardless of how many components
  // call `useMarkdownStore`.  See the cleaner's bootstrap-race fix in
  // the plan file for why this matters.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [vaults, recents] = await Promise.all([
          markdownTauri.listVaults(),
          markdownTauri.recentFiles(),
        ]);
        if (!alive) return;
        dispatch({ type: "setVaults", vaults });
        dispatch({ type: "setRecents", recents });

        if (vaults.length > 0) {
          const files = await markdownTauri.discoverFiles(vaults);
          if (!alive) return;
          dispatch({ type: "setFiles", vaults: files });
        }
      } catch (err) {
        console.error("[markdown] bootstrap failed", err);
      } finally {
        if (alive) dispatch({ type: "bootstrapped" });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useMarkdownStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) {
    throw new Error(
      "useMarkdownStore must be used inside <MarkdownStoreProvider>",
    );
  }
  return ctx;
}

/**
 * Default-collapsed expansion check.  A node is open iff the user
 * has explicitly toggled it open — a fresh vault starts fully
 * collapsed so the sidebar isn't a wall of files.
 */
export function isExpanded(expanded: Set<string>, id: string): boolean {
  return expanded.has(id);
}
