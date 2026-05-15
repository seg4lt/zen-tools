/**
 * Keyboard bindings for the markdown tool.
 *
 * Bound through the shared `useShortcut` registry — single window
 * keydown listener, auto-skipped while focus is inside an `<input>`
 * or the CodeMirror `.cm-content` surface (so vim keystrokes pass
 * through cleanly).
 *
 * Shortcuts mirror Flowstate's fff:
 *   - `Cmd+P`        → search palette in **Files** mode
 *   - `Cmd+Shift+F`  → search palette in **Content** mode
 *   - `Cmd+Shift+O`  → open vault folder picker (legacy carry-over)
 *
 * Re-pressing the same shortcut while the palette is already open
 * swaps mode without closing — same affordance Flowstate gives.
 */

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useShortcut } from "@zen-tools/keyboard/registry";
import { terminalCloseTab } from "@/tools/terminal/lib/tauri";
import { useMarkdownStore } from "../store/markdown-store";
import { useOpenTerminalTab } from "./use-open-terminal-tab";
import { useVaults } from "./use-vaults";

export function useMarkdownKeyboardNav() {
  const { state, dispatch } = useMarkdownStore();
  const { addVault } = useVaults();
  const { openTerminalTab } = useOpenTerminalTab();

  // Cmd+P → Files mode.  When already open in any mode, re-pressing
  // closes (so Cmd+P is a true toggle); when open *and* in Content
  // mode it just swaps modes instead of closing.
  //
  // `fireInInputs: true` so the shortcut works while the cursor is
  // parked inside the CodeMirror editor — matches Flowstate's
  // "always-fire" behaviour for the picker openers.
  useShortcut(
    "mod+p",
    (e) => {
      e.preventDefault();
      if (!state.searchOpen) {
        dispatch({ type: "setSearchPalette", open: true, mode: "files" });
      } else if (state.searchMode === "files") {
        dispatch({ type: "setSearchPalette", open: false });
      } else {
        dispatch({ type: "setSearchMode", mode: "files" });
      }
    },
    true,
    { fireInInputs: true },
  );

  // Cmd+Shift+F → Content mode.  Same toggle/swap logic.
  useShortcut(
    "mod+shift+f",
    (e) => {
      e.preventDefault();
      if (!state.searchOpen) {
        dispatch({ type: "setSearchPalette", open: true, mode: "content" });
      } else if (state.searchMode === "content") {
        dispatch({ type: "setSearchPalette", open: false });
      } else {
        dispatch({ type: "setSearchMode", mode: "content" });
      }
    },
    true,
    { fireInInputs: true },
  );

  // Legacy: Cmd+Shift+O still opens the native folder picker for
  // adding a vault.  Also fire in editor — adding a vault from inside
  // a doc is reasonable.
  useShortcut(
    "mod+t",
    (e) => {
      e.preventDefault();
      void openTerminalTab();
    },
    true,
    { fireInInputs: true },
  );

  useShortcut(
    "mod+shift+o",
    () => {
      void addVault();
    },
    !state.searchOpen,
    { fireInInputs: true },
  );

  // Cmd+W closes the active tab when one is open.  Bound here so the
  // editor's vim mode doesn't swallow the keystroke.
  // NOTE: on macOS AppKit intercepts Cmd+W before WKWebView does, so this
  // `useShortcut` binding may not fire.  The `app:close-requested` Tauri
  // listener below is the primary macOS path.
  useShortcut(
    "mod+w",
    (e) => {
      e.preventDefault();
      const active = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (
        active?.kind === "terminal" &&
        active.terminal?.paneId != null
      ) {
        void terminalCloseTab(active.terminal.paneId).catch((err) =>
          console.error("[markdown] close terminal tab failed", err),
        );
      } else if (state.activeTabId) {
        dispatch({ type: "closeTab", id: state.activeTabId });
      }
    },
    true,
    { fireInInputs: true },
  );

  // Primary Cmd+W handler for macOS.  AppKit intercepts Cmd+W before
  // WKWebView so `useShortcut("mod+w")` never fires; instead the Rust
  // `CloseRequested` handler emits `app:close-requested` and defers the
  // decision to us.
  //
  // * Active tab → close it; window stays visible.
  // * No tabs → fall through to `app_hide_main_window` so Cmd+W still
  //   hides the app as expected.
  //
  // `activeTabId` is captured in a ref so the listener can close the
  // *current* active tab even if the state changed since the effect ran.
  const activeTabIdRef = useRef(state.activeTabId);
  const tabsRef = useRef(state.tabs);
  const dispatchRef = useRef(dispatch);
  useEffect(() => {
    activeTabIdRef.current = state.activeTabId;
    tabsRef.current = state.tabs;
    dispatchRef.current = dispatch;
  });

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      unlisten = await listen<null>("app:close-requested", () => {
        const active = tabsRef.current.find((tab) => tab.id === activeTabIdRef.current);
        if (
          active?.kind === "terminal" &&
          active.terminal?.paneId != null
        ) {
          void terminalCloseTab(active.terminal.paneId).catch((err) =>
            console.error("[markdown] close terminal tab failed", err),
          );
        } else if (activeTabIdRef.current) {
          dispatchRef.current({ type: "closeTab", id: activeTabIdRef.current });
        } else {
          void invoke("app_hide_main_window");
        }
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  // Cmd+Opt+T → "close all other tabs", keeping just the active one.
  // Mirrors browsers / VS Code's "Close Others" command.
  useShortcut(
    "mod+alt+t",
    (e) => {
      e.preventDefault();
      const activeId = state.activeTabId;
      const terminalTabsToClose = state.tabs.filter(
        (tab) =>
          tab.id !== activeId &&
          tab.kind === "terminal" &&
          tab.terminal?.paneId != null,
      );
      for (const tab of terminalTabsToClose) {
        void terminalCloseTab(tab.terminal!.paneId!).catch((err) =>
          console.error("[markdown] close other terminal tab failed", err),
        );
      }
      dispatch({ type: "closeOtherTabs" });
    },
    true,
    { fireInInputs: true },
  );

  // Cmd+1..9 → switch to the Nth tab.  Cmd+9 jumps to the *last*
  // tab (browser convention).
  for (let i = 1; i <= 9; i++) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useShortcut(
      `mod+${i}`,
      (e) => {
        e.preventDefault();
        if (state.tabs.length === 0) return;
        const target =
          i === 9 ? state.tabs[state.tabs.length - 1] : state.tabs[i - 1];
        if (target) {
          dispatch({ type: "selectTab", id: target.id });
        }
      },
      true,
      { fireInInputs: true },
    );
  }

  // Cmd+Alt+] / [ → cycle tabs.  We use Alt because Cmd+] / Cmd+[
  // are already taken by macOS browser conventions and by the OS for
  // window management in some setups.
  useShortcut(
    "mod+alt+]",
    (e) => {
      e.preventDefault();
      const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      if (idx === -1 || state.tabs.length < 2) return;
      const next = state.tabs[(idx + 1) % state.tabs.length];
      dispatch({ type: "selectTab", id: next.id });
    },
    true,
    { fireInInputs: true },
  );
  useShortcut(
    "mod+alt+[",
    (e) => {
      e.preventDefault();
      const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      if (idx === -1 || state.tabs.length < 2) return;
      const prev =
        state.tabs[(idx - 1 + state.tabs.length) % state.tabs.length];
      dispatch({ type: "selectTab", id: prev.id });
    },
    true,
    { fireInInputs: true },
  );
}
