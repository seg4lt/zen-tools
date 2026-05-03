/**
 * Process Monitor reducer + Context.
 *
 * Mirrors the original Leptos signals (`targets`, `active_target`, `poll_ms`,
 * `history`, `view`) in a single React reducer. The store is created per-tool
 * so navigating away and back doesn't leak listeners — the bootstrap effect
 * unsubscribes on unmount.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import {
  listenSamples,
  listenTargetsCleared,
  pmTauri,
  type Sample,
} from "../lib/tauri";

export type PmView = "picker" | "dashboard" | "settings";

const HISTORY_LEN = 240;

export interface PmState {
  view: PmView;
  /** Selected root PIDs, in pick order. */
  targets: number[];
  /** Currently-displayed root tab. `null` until the first sample lands. */
  activeTarget: number | null;
  /** Poll interval in ms. Default 1 s. */
  pollMs: number;
  /** Capped at HISTORY_LEN samples. */
  history: Sample[];
  /** True until the bootstrap fetch resolves. */
  bootstrapping: boolean;
}

const initialState: PmState = {
  view: "picker",
  targets: [],
  activeTarget: null,
  pollMs: 1000,
  history: [],
  bootstrapping: true,
};

export type PmAction =
  | { type: "view"; view: PmView }
  | { type: "setTargets"; pids: number[] }
  | { type: "removeTarget"; pid: number }
  | { type: "clearTargets" }
  | { type: "setActive"; pid: number | null }
  | { type: "setPollMs"; ms: number }
  | { type: "sample"; sample: Sample }
  | { type: "bootstrapped"; pollMs: number; targets: number[]; history: Sample[] };

function reducer(state: PmState, action: PmAction): PmState {
  switch (action.type) {
    case "view":
      return { ...state, view: action.view };

    case "setTargets": {
      // After any target change, drop history so sparklines start fresh
      // (matches the Leptos source's `reset_deltas` behaviour).
      const next = action.pids;
      const stillValid =
        state.activeTarget != null && next.includes(state.activeTarget);
      return {
        ...state,
        targets: next,
        activeTarget: stillValid ? state.activeTarget : (next[0] ?? null),
        history: [],
        view: next.length > 0 ? "dashboard" : "picker",
      };
    }

    case "removeTarget": {
      const next = state.targets.filter((p) => p !== action.pid);
      const stillValid =
        state.activeTarget != null && next.includes(state.activeTarget);
      return {
        ...state,
        targets: next,
        activeTarget: stillValid ? state.activeTarget : (next[0] ?? null),
        history: [],
        view: next.length > 0 ? "dashboard" : "picker",
      };
    }

    case "clearTargets":
      return {
        ...state,
        targets: [],
        activeTarget: null,
        history: [],
        view: "picker",
      };

    case "setActive":
      return { ...state, activeTarget: action.pid };

    case "setPollMs":
      return { ...state, pollMs: action.ms };

    case "sample": {
      // Drop samples that arrive before bootstrap completes; otherwise the
      // first frame can render with no `activeTarget` set.
      if (state.targets.length === 0) return state;
      const next = state.history.slice(-(HISTORY_LEN - 1));
      next.push(action.sample);
      // First sample after a target change picks the first root as active.
      const active =
        state.activeTarget ?? state.targets[0] ?? null;
      return { ...state, history: next, activeTarget: active };
    }

    case "bootstrapped": {
      const active = action.targets[0] ?? null;
      return {
        ...state,
        bootstrapping: false,
        pollMs: action.pollMs,
        targets: action.targets,
        history: action.history.slice(-HISTORY_LEN),
        activeTarget: active,
        view: action.targets.length > 0 ? "dashboard" : "picker",
      };
    }
  }
}

const StoreCtx = createContext<{
  state: PmState;
  dispatch: Dispatch<PmAction>;
} | null>(null);

export function ProcessMonitorStoreProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);

  // Bootstrap from the backend + subscribe to the live sample stream.
  // Both side-effects are guarded by an `alive` flag so a quick mount/
  // unmount cycle doesn't dispatch into a stale reducer.
  useEffect(() => {
    let alive = true;
    let unlistenSamples: (() => void) | null = null;
    let unlistenCleared: (() => void) | null = null;

    (async () => {
      try {
        const [cfg, hist] = await Promise.all([
          pmTauri.getConfig(),
          pmTauri.getHistory(),
        ]);
        if (!alive) return;
        dispatch({
          type: "bootstrapped",
          pollMs: cfg.poll_ms,
          targets: cfg.target_pids,
          history: hist,
        });
      } catch (err) {
        // Non-fatal: leave the store in its initial state. The picker
        // will still load via `pmTauri.listProcesses` when shown.
        console.warn("[process-monitor] bootstrap failed", err);
        if (alive) {
          dispatch({
            type: "bootstrapped",
            pollMs: 1000,
            targets: [],
            history: [],
          });
        }
      }

      unlistenSamples = await listenSamples((s) => {
        if (!alive) return;
        dispatch({ type: "sample", sample: s });
      });
      unlistenCleared = await listenTargetsCleared(() => {
        if (!alive) return;
        dispatch({ type: "clearTargets" });
      });
    })();

    return () => {
      alive = false;
      unlistenSamples?.();
      unlistenCleared?.();
    };
  }, []);

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useProcessMonitorStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) {
    throw new Error(
      "useProcessMonitorStore must be used inside <ProcessMonitorStoreProvider>",
    );
  }
  return ctx;
}

/**
 * Action helpers that combine an IPC call with the matching dispatch.
 * Components should reach for these instead of calling `pmTauri.*`
 * directly — keeps the IPC boundary inside the store and stops leaf
 * components from drifting on success / failure handling.
 *
 * Today this is a single `stopMonitoring` callback (the only place
 * the Shell needed a one-shot IPC + dispatch); add more here as more
 * IPC-touching buttons land in views.
 */
export function usePmActions(): {
  /** Stop monitoring every PID — backend tray clears as a side effect. */
  stopMonitoring: () => Promise<void>;
} {
  const { dispatch } = useProcessMonitorStore();
  const stopMonitoring = useCallback(async () => {
    try {
      await pmTauri.clearTargets();
      dispatch({ type: "clearTargets" });
    } catch (err) {
      // Non-fatal: surface to console; the dashboard will simply keep
      // its existing target list until the user retries.
      console.error("[process-monitor] clearTargets failed", err);
    }
  }, [dispatch]);
  return { stopMonitoring };
}
