/**
 * PRMaster reducer + Context.
 *
 * Mirrors the Swift `PRListViewModel` singleton: holds the four PR lists,
 * the selected detail row, the current user's login, and any in-flight
 * load / error state. Bootstraps on mount by fetching `prmaster_whoami`
 * (to seed the badge / "you" markers) and the first Mine + To-Review
 * lists. Each tab can re-fetch on demand.
 *
 * Subsequent phases plug refresh-event listeners (`prmaster:refreshed`,
 * `prmaster:notification`, `prmaster:badge-changed`) into the same
 * reducer so the UI stays in sync with backend polling.
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
  listenRefresh,
  prmasterTauri,
  type ConversationGroup,
  type EnrichedPullRequest,
  type RefreshSnapshot,
} from "../lib/tauri";

export interface PrMasterState {
  /** Login of the current user (`null` until whoami resolves). */
  currentUser: string | null;
  /** Open PRs the user authored (with detail enrichment). */
  mine: EnrichedPullRequest[];
  /** Open PRs requesting the user as a reviewer (enriched). */
  toReview: EnrichedPullRequest[];
  /** Open PRs the user has reviewed (enriched). */
  reviewed: EnrichedPullRequest[];
  /** Conversation groups (unresolved review threads + @mentions). */
  conversations: ConversationGroup[];
  /** Last-load status per tab. */
  loading: { mine: boolean; toReview: boolean; reviewed: boolean; conversations: boolean };
  /** Most recent error per tab (cleared on next successful load). */
  errors: {
    mine: string | null;
    toReview: string | null;
    reviewed: string | null;
    conversations: string | null;
  };
  /** Currently-selected PR id (`"{owner}/{repo}#{n}"`) for the inline detail panel. */
  selectedPrId: string | null;
  /** True until the initial bootstrap fetch finishes. */
  bootstrapping: boolean;
}

const initialState: PrMasterState = {
  currentUser: null,
  mine: [],
  toReview: [],
  reviewed: [],
  conversations: [],
  loading: { mine: false, toReview: false, reviewed: false, conversations: false },
  errors: { mine: null, toReview: null, reviewed: null, conversations: null },
  selectedPrId: null,
  bootstrapping: true,
};

type Tab = "mine" | "toReview" | "reviewed" | "conversations";

export type PrMasterAction =
  | { type: "bootstrapped"; user: string | null }
  | { type: "loadStart"; tab: Tab }
  | { type: "loadMineDone"; data: EnrichedPullRequest[] }
  | { type: "loadToReviewDone"; data: EnrichedPullRequest[] }
  | { type: "loadReviewedDone"; data: EnrichedPullRequest[] }
  | { type: "loadConversationsDone"; data: ConversationGroup[] }
  | { type: "applyRefresh"; snapshot: RefreshSnapshot }
  | { type: "loadFail"; tab: Tab; message: string }
  | { type: "select"; id: string | null }
  | { type: "patchMine"; id: string; patch: Partial<EnrichedPullRequest> };

function reducer(state: PrMasterState, action: PrMasterAction): PrMasterState {
  switch (action.type) {
    case "bootstrapped":
      return { ...state, currentUser: action.user, bootstrapping: false };

    case "loadStart":
      return {
        ...state,
        loading: { ...state.loading, [action.tab]: true },
        errors: { ...state.errors, [action.tab]: null },
      };

    case "loadMineDone":
      return {
        ...state,
        mine: action.data,
        loading: { ...state.loading, mine: false },
      };

    case "loadToReviewDone":
      return {
        ...state,
        toReview: action.data,
        loading: { ...state.loading, toReview: false },
      };

    case "loadReviewedDone":
      return {
        ...state,
        reviewed: action.data,
        loading: { ...state.loading, reviewed: false },
      };

    case "loadConversationsDone":
      return {
        ...state,
        conversations: action.data,
        loading: { ...state.loading, conversations: false },
      };

    case "applyRefresh":
      // The backend's broadcast bridge fires `prmaster:refreshed` after
      // every poll (foreground and background). We trust it as the source
      // of truth for all three buckets.
      return {
        ...state,
        currentUser: action.snapshot.current_user ?? state.currentUser,
        toReview: action.snapshot.to_review,
        reviewed: action.snapshot.reviewed,
        mine: action.snapshot.mine,
        loading: {
          ...state.loading,
          mine: false,
          toReview: false,
          reviewed: false,
        },
        errors: { ...state.errors, mine: null, toReview: null, reviewed: null },
      };

    case "loadFail":
      return {
        ...state,
        loading: { ...state.loading, [action.tab]: false },
        errors: { ...state.errors, [action.tab]: action.message },
      };

    case "select":
      return { ...state, selectedPrId: action.id };

    case "patchMine":
      return {
        ...state,
        mine: state.mine.map((row) =>
          enrichedId(row) === action.id ? { ...row, ...action.patch } : row,
        ),
      };
  }
}

export function enrichedId(row: EnrichedPullRequest): string {
  return `${row.pr.repository.nameWithOwner}#${row.pr.number}`;
}

const StoreCtx = createContext<{
  state: PrMasterState;
  dispatch: Dispatch<PrMasterAction>;
} | null>(null);

export function PrMasterStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);

  // Bootstrap: resolve the current user. Failures are non-fatal — the UI
  // still works for users without `gh` configured; Settings surfaces the
  // problem.
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const user = await prmasterTauri.whoami();
        if (alive) dispatch({ type: "bootstrapped", user });
      } catch (err) {
        console.warn("[prmaster] whoami failed (gh not authed?):", err);
        if (alive) dispatch({ type: "bootstrapped", user: null });
      }
      unlisten = await listenRefresh((snapshot) => {
        if (!alive) return;
        dispatch({ type: "applyRefresh", snapshot });
      });
    })();
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function usePrMasterStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) {
    throw new Error("usePrMasterStore must be used inside <PrMasterStoreProvider>");
  }
  return ctx;
}

// ────────────────────────────────────────────────────────────────────────
// Action helpers — kept here so components don't reimplement the same
// dispatch + invoke pairing.
// ────────────────────────────────────────────────────────────────────────

export async function loadMine(dispatch: Dispatch<PrMasterAction>) {
  dispatch({ type: "loadStart", tab: "mine" });
  try {
    const data = await prmasterTauri.getMine();
    dispatch({ type: "loadMineDone", data });
  } catch (err) {
    dispatch({
      type: "loadFail",
      tab: "mine",
      message: errorMessage(err),
    });
  }
}

export async function loadToReview(dispatch: Dispatch<PrMasterAction>) {
  dispatch({ type: "loadStart", tab: "toReview" });
  try {
    const data = await prmasterTauri.getToReview();
    dispatch({ type: "loadToReviewDone", data });
  } catch (err) {
    dispatch({
      type: "loadFail",
      tab: "toReview",
      message: errorMessage(err),
    });
  }
}

export async function loadReviewed(dispatch: Dispatch<PrMasterAction>) {
  dispatch({ type: "loadStart", tab: "reviewed" });
  try {
    const data = await prmasterTauri.getReviewed();
    dispatch({ type: "loadReviewedDone", data });
  } catch (err) {
    dispatch({
      type: "loadFail",
      tab: "reviewed",
      message: errorMessage(err),
    });
  }
}

export async function loadConversations(dispatch: Dispatch<PrMasterAction>) {
  dispatch({ type: "loadStart", tab: "conversations" });
  try {
    const data = await prmasterTauri.getConversations();
    dispatch({ type: "loadConversationsDone", data });
  } catch (err) {
    dispatch({
      type: "loadFail",
      tab: "conversations",
      message: errorMessage(err),
    });
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
