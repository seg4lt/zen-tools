/**
 * Keyboard bindings for the markdown tool.
 *
 * Bound through the shared `useShortcut` registry — single window
 * keydown listener, auto-skipped while focus is inside an `<input>`
 * or the CodeMirror `.cm-content` surface (so vim keystrokes pass
 * through cleanly).
 */

import { useShortcut } from "@/lib/keyboard/registry";
import { useMarkdownStore } from "../store/markdown-store";
import { useVaults } from "./use-vaults";

export function useMarkdownKeyboardNav() {
  const { state, dispatch } = useMarkdownStore();
  const { addVault } = useVaults();

  // The Cmd+O quick switcher is the most-used global shortcut.  We
  // gate it on no other overlay being open, so it doesn't fight with
  // a focused dialog.
  useShortcut(
    "mod+o",
    (e) => {
      e.preventDefault();
      dispatch({ type: "setQuickSwitcher", open: true });
    },
    !state.quickSwitcherOpen,
  );

  // Cmd+Shift+O is a habit some Obsidian users have for "open vault"
  // — wire to the native folder picker.
  useShortcut(
    "mod+shift+o",
    () => {
      void addVault();
    },
    !state.quickSwitcherOpen,
  );
}
