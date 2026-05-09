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
}

type Action =
  | { type: "set-repos"; repos: RepoEntry[] }
  | { type: "set-active"; path: string | null }
  | { type: "set-merge-state"; state: MergeState | null }
  | { type: "remove-repo"; path: string }
  | { type: "set-conflicts"; conflicts: ConflictFile[] }
  | { type: "set-active-conflict"; path: string | null }
  | { type: "mark-conflict-resolved"; path: string }
  | { type: "clear-resolved" };

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

  // When the active repo changes, throw away conflict state — the
  // next merge tab visit will refetch for the new repo.
  useEffect(() => {
    dispatch({ type: "set-conflicts", conflicts: [] });
    dispatch({ type: "clear-resolved" });
    dispatch({ type: "set-merge-state", state: null });
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
