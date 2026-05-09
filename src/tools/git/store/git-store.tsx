/**
 * Git tool state — Context + reducer.
 *
 * Holds:
 *   - `repos`           — full registry from the backend.
 *   - `activeRepoPath`  — absolute path of the active repo (mirrored
 *                         into `localStorage` so the choice survives
 *                         reloads).
 *   - `mergeState`      — last-fetched in-progress op snapshot, used
 *                         by the Merge tab badge.
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

import { gitTauri, type MergeState, type RepoEntry } from "../lib/tauri";

const ACTIVE_KEY = "git.activeRepo";

export interface GitStoreState {
  repos: RepoEntry[];
  activeRepoPath: string | null;
  mergeState: MergeState | null;
  reposLoaded: boolean;
}

type Action =
  | { type: "set-repos"; repos: RepoEntry[] }
  | { type: "set-active"; path: string | null }
  | { type: "set-merge-state"; state: MergeState | null }
  | { type: "remove-repo"; path: string };

function reducer(state: GitStoreState, action: Action): GitStoreState {
  switch (action.type) {
    case "set-repos": {
      // If activeRepo was removed (or never set), pick the first.
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
      // localStorage may be unavailable (private browsing etc.).
    }
  }, [state.activeRepoPath]);

  // Hydrate the repo list once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const repos = await gitTauri.listRepos();
        if (!cancelled) dispatch({ type: "set-repos", repos });
      } catch (e) {
        // Surface to console; the sidebar shows a blank list which is
        // the correct UX for "no repos registered yet".
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
