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
 *   - `currentFile` — the open document: path, doc text, dirty flag.
 *   - `recents`     — the bounded ring used by the quick switcher.
 *   - `quickSwitcherOpen` — overlay flag.
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

export interface MarkdownState {
  vaults: string[];
  files: Record<string, MarkdownVaultDto>;
  expanded: Set<string>;
  currentFile: OpenFileState | null;
  recents: string[];
  quickSwitcherOpen: boolean;
  bootstrapping: boolean;
  editing: EditingState | null;
}

const initialState: MarkdownState = {
  vaults: [],
  files: {},
  expanded: new Set<string>(),
  currentFile: null,
  recents: [],
  quickSwitcherOpen: false,
  bootstrapping: true,
  editing: null,
};

export type MarkdownAction =
  | { type: "setVaults"; vaults: string[] }
  | { type: "setFiles"; vaults: MarkdownVaultDto[] }
  | { type: "toggleExpand"; nodeId: string }
  | { type: "setExpanded"; nodeId: string; open: boolean }
  | { type: "openFile"; path: string; doc: string }
  | { type: "closeFile" }
  | { type: "editDoc"; doc: string }
  | { type: "markSaved" }
  | { type: "setRecents"; recents: string[] }
  | { type: "setQuickSwitcher"; open: boolean }
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

    case "openFile":
      return {
        ...state,
        currentFile: { path: action.path, doc: action.doc, dirty: false },
        quickSwitcherOpen: false,
      };

    case "closeFile":
      return { ...state, currentFile: null };

    case "editDoc":
      if (!state.currentFile) return state;
      // Skip a re-render when the doc didn't actually change (CodeMirror
      // dispatches transactions for selection changes too).
      if (state.currentFile.doc === action.doc) return state;
      return {
        ...state,
        currentFile: {
          ...state.currentFile,
          doc: action.doc,
          dirty: true,
        },
      };

    case "markSaved":
      if (!state.currentFile) return state;
      return {
        ...state,
        currentFile: { ...state.currentFile, dirty: false },
      };

    case "setRecents":
      return { ...state, recents: action.recents };

    case "setQuickSwitcher":
      return { ...state, quickSwitcherOpen: action.open };

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
      // If the user renamed the currently-open file, swap its path.
      // The doc itself is unchanged.
      if (
        state.currentFile &&
        state.currentFile.path === action.oldPath
      ) {
        return {
          ...state,
          currentFile: { ...state.currentFile, path: action.newPath },
        };
      }
      return state;
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
