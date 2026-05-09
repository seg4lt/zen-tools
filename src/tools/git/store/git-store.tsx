/**
 * Git tool state — Context + reducer.
 *
 * Holds:
 *   - `repos`              — full registry from the backend.
 *   - `activeRepoPath`     — absolute path of the active repo (mirrored
 *                            into `localStorage` so the choice survives
 *                            reloads).
 *   - `mergeState`         — last-fetched in-progress op snapshot, used
 *                            by the Merge tab badge and the merge
 *                            header.
 *   - `conflicts`          — conflicting paths from `git ls-files
 *                            --unmerged`. Lives here (not in MergePane)
 *                            because the activity-bar side panel
 *                            renders the file tree from the same data
 *                            that the merge editor consumes.
 *   - `activeConflictPath` — which conflict the editor is showing.
 *   - `resolvedPaths`      — paths the user has marked resolved this
 *                            session. Cleared on continue/abort.
 *
 * The reducer never reaches into Tauri itself — every async call
 * happens in the components and dispatches the result back.
 */

import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";

import {
  gitTauri,
  type ConflictFile,
  type FileChange,
  type MergeState,
  type RepoEntry,
} from "../lib/tauri";

const ACTIVE_KEY = "git.activeRepo";

export interface GitStoreState {
  repos: RepoEntry[];
  activeRepoPath: string | null;
  mergeState: MergeState | null;
  reposLoaded: boolean;
  conflicts: ConflictFile[];
  activeConflictPath: string | null;
  resolvedPaths: ReadonlySet<string>;
  /** Primary commit on the Log tab — the most-recently-clicked sha,
   *  always also a member of `logSelectedShas`. The detail pane uses
   *  this to show single-commit metadata when the selection is a
   *  single row. */
  logSelectedSha: string | null;
  /** Full multi-selection. When `size === 1`, behaviour is identical
   *  to the old single-select mode. When `size > 1`, the detail pane
   *  switches into "range" mode and shows the combined diff between
   *  the oldest selected commit's parent and the newest selected
   *  commit. */
  logSelectedShas: ReadonlySet<string>;
  /** Files touched by the selected commit (or the union of files in
   *  range mode). Mirrored here so the side-panel "Files" mode can
   *  render the same tree the detail pane is showing the diff for. */
  logFiles: FileChange[];
  /** Which file inside `logFiles` the user has open in the diff view. */
  logActiveFilePath: string | null;
}

type Action =
  | { type: "set-repos"; repos: RepoEntry[] }
  | { type: "set-active"; path: string | null }
  | { type: "set-merge-state"; state: MergeState | null }
  | { type: "remove-repo"; path: string }
  | { type: "set-conflicts"; conflicts: ConflictFile[] }
  | { type: "set-active-conflict"; path: string | null }
  | { type: "mark-conflict-resolved"; path: string }
  | { type: "clear-resolved" }
  | { type: "set-log-selected-sha"; sha: string | null }
  | { type: "toggle-log-selected-sha"; sha: string }
  | { type: "set-log-selected-range"; shas: ReadonlySet<string>; primary: string }
  | { type: "set-log-files"; sha: string | null; files: FileChange[] }
  | { type: "set-log-active-file"; path: string | null };

function reducer(state: GitStoreState, action: Action): GitStoreState {
  switch (action.type) {
    case "set-repos": {
      const stillActive = action.repos.find(
        (r) => r.path === state.activeRepoPath,
      );
      const next: GitStoreState = {
        ...state,
        repos: action.repos,
        reposLoaded: true,
      };
      if (!stillActive) {
        next.activeRepoPath = action.repos[0]?.path ?? null;
      }
      return next;
    }
    case "set-active":
      return { ...state, activeRepoPath: action.path };
    case "set-merge-state":
      return { ...state, mergeState: action.state };
    case "remove-repo": {
      const repos = state.repos.filter((r) => r.path !== action.path);
      const activeRepoPath =
        state.activeRepoPath === action.path
          ? repos[0]?.path ?? null
          : state.activeRepoPath;
      return { ...state, repos, activeRepoPath };
    }
    case "set-conflicts": {
      // If the previously-active conflict is still in the list, keep
      // it. Otherwise default to the first one (or null when empty).
      const stillThere =
        state.activeConflictPath != null &&
        action.conflicts.some((c) => c.path === state.activeConflictPath);
      return {
        ...state,
        conflicts: action.conflicts,
        activeConflictPath: stillThere
          ? state.activeConflictPath
          : action.conflicts[0]?.path ?? null,
      };
    }
    case "set-active-conflict":
      return { ...state, activeConflictPath: action.path };
    case "mark-conflict-resolved": {
      const next = new Set(state.resolvedPaths);
      next.add(action.path);
      return { ...state, resolvedPaths: next };
    }
    case "clear-resolved":
      return { ...state, resolvedPaths: new Set() };
    case "set-log-selected-sha":
      // Plain (non-modifier) click: collapse multi-selection down to
      // just this sha (or clear when null).
      return {
        ...state,
        logSelectedSha: action.sha,
        logSelectedShas:
          action.sha == null ? new Set() : new Set([action.sha]),
      };
    case "toggle-log-selected-sha": {
      // Cmd/Ctrl-click: flip membership. The clicked sha always
      // becomes the primary on add; on remove, primary falls back to
      // any remaining sha (deterministic by iteration order).
      const next = new Set(state.logSelectedShas);
      if (next.has(action.sha)) {
        next.delete(action.sha);
        const primary =
          state.logSelectedSha === action.sha
            ? next.values().next().value ?? null
            : state.logSelectedSha;
        return {
          ...state,
          logSelectedShas: next,
          logSelectedSha: primary ?? null,
        };
      }
      next.add(action.sha);
      return {
        ...state,
        logSelectedShas: next,
        logSelectedSha: action.sha,
      };
    }
    case "set-log-selected-range":
      // Shift-click: replace the set with a contiguous slice already
      // computed by the caller. The caller is responsible for
      // including both anchor and target.
      return {
        ...state,
        logSelectedShas: action.shas,
        logSelectedSha: action.primary,
      };
    case "set-log-files": {
      // Drop the active-file pointer if it isn't part of the new
      // file list — otherwise the diff pane would keep showing
      // whatever file we *had* selected from the previous commit.
      //
      // CRITICAL: do NOT touch `logSelectedSha` here. The selection
      // is owned by the click handler in CommitLogPane; this reducer
      // is purely about syncing the file list. In range mode the
      // detail pane dispatches `set-log-files` with `sha: null`, and
      // clobbering the primary selection here used to wipe out the
      // multi-select highlight (and break the next interaction).
      const stillThere =
        state.logActiveFilePath != null &&
        action.files.some((f) => f.path === state.logActiveFilePath);
      return {
        ...state,
        logFiles: action.files,
        logActiveFilePath: stillThere
          ? state.logActiveFilePath
          : action.files[0]?.path ?? null,
      };
    }
    case "set-log-active-file":
      return { ...state, logActiveFilePath: action.path };
    default:
      return state;
  }
}

interface ContextShape {
  state: GitStoreState;
  dispatch: Dispatch<Action>;
}

const GitStoreContext = createContext<ContextShape | null>(null);

function readPersistedActive(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function GitStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    repos: [],
    activeRepoPath: readPersistedActive(),
    mergeState: null,
    reposLoaded: false,
    conflicts: [],
    activeConflictPath: null,
    resolvedPaths: new Set<string>(),
    logSelectedSha: null,
    logSelectedShas: new Set<string>(),
    logFiles: [],
    logActiveFilePath: null,
  }));

  // Persist active repo to localStorage (cheap, runs only on change).
  useEffect(() => {
    try {
      if (state.activeRepoPath) {
        window.localStorage.setItem(ACTIVE_KEY, state.activeRepoPath);
      } else {
        window.localStorage.removeItem(ACTIVE_KEY);
      }
    } catch {
      /* localStorage may be unavailable */
    }
  }, [state.activeRepoPath]);

  // When the active repo changes, throw away conflict + log state —
  // the next tab visit will refetch for the new repo.
  useEffect(() => {
    dispatch({ type: "set-conflicts", conflicts: [] });
    dispatch({ type: "clear-resolved" });
    dispatch({ type: "set-merge-state", state: null });
    dispatch({ type: "set-log-files", sha: null, files: [] });
  }, [state.activeRepoPath]);

  // Hydrate the repo list once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const repos = await gitTauri.listRepos();
        if (!cancelled) dispatch({ type: "set-repos", repos });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("git: failed to load repos", e);
        if (!cancelled) dispatch({ type: "set-repos", repos: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <GitStoreContext.Provider value={{ state, dispatch }}>
      {children}
    </GitStoreContext.Provider>
  );
}

/** Read-only access to the store — throws if used outside the provider. */
export function useGitStore(): ContextShape {
  const ctx = useContext(GitStoreContext);
  if (!ctx) {
    throw new Error("useGitStore must be used inside <GitStoreProvider>");
  }
  return ctx;
}
