/**
 * Terminal pane store.
 *
 * The actual NSView + PTY state lives in the plugin's Rust
 * `PluginState` (process-singleton), so this React store is purely
 * informational — it mirrors the plugin's tab list so the inner
 * pane-tab strip can render without round-tripping `terminal_list_tabs`
 * on every paint.
 *
 * Hoisted into `<AppProviders>` so navigating away from `/terminal`
 * doesn't drop the pane list. The four tab-lifecycle event listeners
 * are wired up here once at app start (gated on macOS) and stay
 * subscribed for the lifetime of the window.
 *
 * Bootstrap of the *first* pane (the one-time `terminal_new` call) is
 * deliberately deferred to `TerminalView`'s mount effect — we don't
 * want to spawn a shell for a tool the user might never visit. Once
 * spawned, the pane survives navigation indefinitely.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import {
  onTabClosed,
  onTabCreated,
  onTabFocused,
  onTabTitleChanged,
  terminalListTabs,
  terminalNew,
  terminalSetCloseWindowOnLastTab,
  type PaneInfo,
} from "../lib/tauri";

interface State {
  panes: PaneInfo[];
  activeId: number | null;
  /** True once `terminal_new` (the one-time bootstrap) has succeeded. */
  bootstrapped: boolean;
}

type Action =
  | { type: "set_panes"; panes: PaneInfo[]; activeId: number | null }
  | { type: "add_pane"; pane: PaneInfo }
  | { type: "remove_pane"; id: number }
  | { type: "set_active"; id: number }
  | { type: "set_title"; id: number; title: string }
  | { type: "mark_bootstrapped" };

const initial: State = { panes: [], activeId: null, bootstrapped: false };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "set_panes":
      return { ...state, panes: action.panes, activeId: action.activeId };
    case "add_pane": {
      // Idempotent — the plugin emits `tab:created` AND `terminal_new`
      // returns the new tab id; either path lands here.
      if (state.panes.some((p) => p.id === action.pane.id)) return state;
      return { ...state, panes: [...state.panes, action.pane] };
    }
    case "remove_pane": {
      const panes = state.panes.filter((p) => p.id !== action.id);
      const activeId =
        state.activeId === action.id
          ? (panes[panes.length - 1]?.id ?? null)
          : state.activeId;
      return { ...state, panes, activeId };
    }
    case "set_active":
      return {
        ...state,
        activeId: action.id,
        panes: state.panes.map((p) => ({ ...p, active: p.id === action.id })),
      };
    case "set_title":
      return {
        ...state,
        panes: state.panes.map((p) =>
          p.id === action.id ? { ...p, title: action.title } : p,
        ),
      };
    case "mark_bootstrapped":
      return { ...state, bootstrapped: true };
  }
}

interface ContextValue extends State {
  /**
   * Idempotent one-time bootstrap: disables the close-window-on-last-tab
   * behaviour, then spawns the first pane if none exist. Safe to call
   * from every `TerminalView` mount — only the first call does work.
   */
  ensureBootstrapped: () => Promise<void>;
}

const TerminalStoreContext = createContext<ContextValue | null>(null);

export function TerminalStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  // Lock so concurrent `ensureBootstrapped` callers (e.g. the Provider
  // mounting + the View mounting on the same tick) don't race.
  const bootstrapPromise = useRef<Promise<void> | null>(null);

  // ── Subscribe to lifecycle events once at provider mount ──────────
  // The plugin emits these via `app.emit(...)` from the C-side
  // trampoline (`tab_event_trampoline`), which is itself called from
  // ObjC on the main thread.
  useEffect(() => {
    let unlisteners: Array<() => void> = [];
    let cancelled = false;
    void (async () => {
      const subs = await Promise.all([
        onTabCreated((p) => {
          dispatch({
            type: "add_pane",
            pane: { id: p.id, title: p.title ?? "", active: false },
          });
        }),
        onTabFocused((p) => dispatch({ type: "set_active", id: p.id })),
        onTabClosed((p) => dispatch({ type: "remove_pane", id: p.id })),
        onTabTitleChanged((p) =>
          dispatch({ type: "set_title", id: p.id, title: p.title ?? "" }),
        ),
      ]);
      if (cancelled) {
        for (const u of subs) u();
      } else {
        unlisteners = subs;
      }
    })();
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, []);

  const ensureBootstrapped = useCallback(async () => {
    if (state.bootstrapped) return;
    if (bootstrapPromise.current) return bootstrapPromise.current;

    bootstrapPromise.current = (async () => {
      // Guard the host window — without this the plugin closes the
      // entire zen-tools window when the user closes the last pane.
      try {
        await terminalSetCloseWindowOnLastTab(false);
      } catch (err) {
        console.error("[terminal] set_close_window_on_last_tab failed:", err);
      }

      // Adopt any pre-existing panes (e.g. after a Vite HMR refresh
      // — the Tauri process outlives webview reloads).
      let existing: PaneInfo[] = [];
      try {
        existing = await terminalListTabs();
      } catch (err) {
        console.error("[terminal] terminal_list_tabs failed:", err);
      }
      if (existing.length > 0) {
        dispatch({
          type: "set_panes",
          panes: existing,
          activeId: existing.find((t) => t.active)?.id ?? null,
        });
        dispatch({ type: "mark_bootstrapped" });
        return;
      }

      // No existing panes — spawn the first.
      try {
        const result = await terminalNew({});
        dispatch({
          type: "add_pane",
          pane: { id: result.tab_id, title: "", active: true },
        });
        dispatch({ type: "set_active", id: result.tab_id });
      } catch (err) {
        console.error("[terminal] terminal_new failed:", err);
      } finally {
        dispatch({ type: "mark_bootstrapped" });
      }
    })();

    return bootstrapPromise.current;
  }, [state.bootstrapped]);

  const value = useMemo<ContextValue>(
    () => ({ ...state, ensureBootstrapped }),
    [state, ensureBootstrapped],
  );

  return (
    <TerminalStoreContext.Provider value={value}>
      {children}
    </TerminalStoreContext.Provider>
  );
}

export function useTerminalStore(): ContextValue {
  const ctx = useContext(TerminalStoreContext);
  if (!ctx) {
    throw new Error(
      "useTerminalStore must be used inside <TerminalStoreProvider>",
    );
  }
  return ctx;
}
