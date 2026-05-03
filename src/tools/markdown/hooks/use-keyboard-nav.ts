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

import { useShortcut } from "@zen-tools/keyboard/registry";
import { useMarkdownStore } from "../store/markdown-store";
import { useVaults } from "./use-vaults";

export function useMarkdownKeyboardNav() {
  const { state, dispatch } = useMarkdownStore();
  const { addVault } = useVaults();

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
    "mod+shift+o",
    () => {
      void addVault();
    },
    !state.searchOpen,
    { fireInInputs: true },
  );

  // Cmd+W closes the active tab when one is open.  Bound here so the
  // editor's vim mode doesn't swallow the keystroke.
  useShortcut(
    "mod+w",
    (e) => {
      e.preventDefault();
      if (state.activeTabId) {
        dispatch({ type: "closeTab", id: state.activeTabId });
      }
    },
    true,
    { fireInInputs: true },
  );

  // Cmd+Opt+T → "close all other tabs", keeping just the active one.
  // Mirrors browsers / VS Code's "Close Others" command.
  useShortcut(
    "mod+alt+t",
    (e) => {
      e.preventDefault();
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
