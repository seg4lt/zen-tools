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

import { useShortcut } from "@/lib/keyboard/registry";
import { useMarkdownStore } from "../store/markdown-store";
import { useVaults } from "./use-vaults";

export function useMarkdownKeyboardNav() {
  const { state, dispatch } = useMarkdownStore();
  const { addVault } = useVaults();

  // Cmd+P → Files mode.  When already open in any mode, re-pressing
  // closes (so Cmd+P is a true toggle); when open *and* in Content
  // mode it just swaps modes instead of closing.
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
  );

  // Legacy: Cmd+Shift+O still opens the native folder picker for
  // adding a vault.
  useShortcut(
    "mod+shift+o",
    () => {
      void addVault();
    },
    !state.searchOpen,
  );
}
