/**
 * Distraction-free mode for the terminal.
 *
 * When enabled (toggled via `cmd+opt+f` while on `/terminal`), the
 * app's `<TitleBar>` is hidden so the terminal NSView fills the whole
 * window. The toggle is intercepted on the native side by
 * `tauri-plugin-ghostty`'s NSEvent monitor (so it works even though
 * the GhosttyHostView has focus, not the WKWebView) and surfaced to
 * React via the `terminal:host-key-hook:cmd-opt-f` Tauri event — see
 * the trampoline in `crates/tauri-plugin-ghostty/src/commands.rs`.
 *
 * The state is intentionally tiny (one boolean) and lives in its own
 * context rather than the main `terminal-store` because it's
 * read by the app shell (TitleBar) too — keeping it separate avoids
 * `<AppProviders>` having to take a dependency on the terminal
 * pane store.
 *
 * Provider is hoisted into `App.tsx` (above the router) so both
 * `TitleBar` (in the root route's component) and `TerminalView`
 * (inside `<Outlet>`) can read/write the same state.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface DistractionFreeContextValue {
  /** True while the host TitleBar should be hidden. */
  enabled: boolean;
  /** Toggle the flag. Used by the cmd+opt+f Tauri event listener. */
  toggle: () => void;
  /** Explicit setter, used by the floating Exit button. */
  setEnabled: (value: boolean) => void;
}

const DistractionFreeContext = createContext<DistractionFreeContextValue | null>(
  null,
);

export function DistractionFreeProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const toggle = useCallback(() => setEnabled((v) => !v), []);
  const value = useMemo<DistractionFreeContextValue>(
    () => ({ enabled, toggle, setEnabled }),
    [enabled, toggle],
  );
  return (
    <DistractionFreeContext.Provider value={value}>
      {children}
    </DistractionFreeContext.Provider>
  );
}

export function useDistractionFree(): DistractionFreeContextValue {
  const ctx = useContext(DistractionFreeContext);
  if (!ctx) {
    throw new Error(
      "useDistractionFree must be used inside <DistractionFreeProvider>",
    );
  }
  return ctx;
}
