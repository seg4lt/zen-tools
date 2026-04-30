/**
 * Keyboard bindings for the cleaner tool.
 *
 * All bindings register through the shared `useShortcut` hook so they
 * play nicely with the rest of the app (single window-level keydown
 * listener; auto-skipped while focus is inside an `<input>`).
 *
 * Bindings are *disabled* whenever a modal overlay is open — the
 * Radix dialogs already handle Escape themselves, so we don't need to
 * compete for the keystroke.
 */

import { useCallback, useEffect, useRef } from "react";
import { useShortcut } from "@/lib/keyboard/registry";
import {
  GLOBALS_KEY,
  REPOS_SECTION_ID,
  useCleanerStore,
  type SortMode,
} from "../store/cleaner-store";
import { useCleanerScans } from "../hooks/use-cleaner-scans";

const CHORD_WINDOW_MS = 600;

export function useKeyboardNav() {
  const { state, dispatch } = useCleanerStore();
  const { addFolder, refreshAll, refreshFolder, removeFolder } =
    useCleanerScans();

  // Disable bindings while an overlay is open — the Dialog/Sheet/cmdk
  // primitives manage their own keyboard surface.
  const overlayOpen =
    state.paletteOpen ||
    state.helpOpen ||
    state.runState === "confirming" ||
    state.runState === "running" ||
    state.runState === "done";
  const enabled = !overlayOpen;

  // Track the last `g` press for the `gg` chord.
  const lastGRef = useRef<number>(0);

  const cursor = state.cursor;
  const cursorRef = useRef(cursor);
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  // Helper: figure out the folder a given node id belongs to. Used by
  // `r`, Backspace and friends. Returns:
  //   - `GLOBALS_KEY` for the globals section / global leaves
  //   - the absolute folder path for a repo leaf
  //   - `null` for the merged Repositories section header (no single
  //     folder applies — caller should fall back to "all folders").
  const folderForCursor = useCallback((): string | null => {
    const id = cursorRef.current;
    if (!id) return null;
    if (id === GLOBALS_KEY || id.startsWith("globals/")) return GLOBALS_KEY;
    if (id === REPOS_SECTION_ID) return null;
    // Repo leaf ids look like `repos/<absolute folder path>/<rel...>`.
    // Pick the first folder whose path is a prefix.
    const inner = id.startsWith("repos/") ? id.slice("repos/".length) : id;
    return (
      state.folders.find((f) => inner === f || inner.startsWith(`${f}/`)) ??
      null
    );
  }, [state.folders]);

  // Movement
  useShortcut("j", () => dispatch({ type: "moveCursor", delta: 1 }), enabled);
  useShortcut("ArrowDown", () => dispatch({ type: "moveCursor", delta: 1 }), enabled);
  useShortcut("k", () => dispatch({ type: "moveCursor", delta: -1 }), enabled);
  useShortcut("ArrowUp", () => dispatch({ type: "moveCursor", delta: -1 }), enabled);

  useShortcut(
    "g",
    () => {
      const now = Date.now();
      if (now - lastGRef.current < CHORD_WINDOW_MS) {
        dispatch({ type: "cursorTop" });
        lastGRef.current = 0;
      } else {
        lastGRef.current = now;
      }
    },
    enabled,
  );
  useShortcut("shift+g", () => dispatch({ type: "cursorBottom" }), enabled);

  // Expansion
  useShortcut(
    "h",
    () => {
      const id = cursorRef.current;
      if (id) dispatch({ type: "setExpanded", nodeId: id, open: false });
    },
    enabled,
  );
  useShortcut(
    "ArrowLeft",
    () => {
      const id = cursorRef.current;
      if (id) dispatch({ type: "setExpanded", nodeId: id, open: false });
    },
    enabled,
  );
  useShortcut(
    "l",
    () => {
      const id = cursorRef.current;
      if (id) dispatch({ type: "setExpanded", nodeId: id, open: true });
    },
    enabled,
  );
  useShortcut(
    "ArrowRight",
    () => {
      const id = cursorRef.current;
      if (id) dispatch({ type: "setExpanded", nodeId: id, open: true });
    },
    enabled,
  );

  // Marking
  useShortcut(
    "space",
    () => {
      const id = cursorRef.current;
      if (id) dispatch({ type: "cycleAction", nodeId: id });
    },
    enabled,
  );
  useShortcut(
    "c",
    () => {
      const id = cursorRef.current;
      if (id) dispatch({ type: "setAction", nodeId: id, action: "clean" });
    },
    enabled,
  );
  useShortcut(
    "d",
    () => {
      const id = cursorRef.current;
      if (id) dispatch({ type: "setAction", nodeId: id, action: "delete" });
    },
    enabled,
  );
  useShortcut(
    "x",
    () => {
      const id = cursorRef.current;
      if (id) dispatch({ type: "setAction", nodeId: id, action: "none" });
    },
    enabled,
  );

  // Run / overlays
  useShortcut(
    "Enter",
    () => {
      dispatch({ type: "openConfirm" });
    },
    enabled,
  );
  useShortcut(
    "mod+k",
    () => {
      dispatch({ type: "setPalette", open: true });
    },
    enabled,
  );
  // On a US layout the user types `?` via shift+/, but `e.key` reports
  // the *resolved* character (`?`), so we bind on the character itself.
  useShortcut(
    "shift+?",
    () => {
      dispatch({ type: "setHelp", open: true });
    },
    enabled,
  );

  // Folder management
  useShortcut(
    "a",
    () => {
      void addFolder();
    },
    enabled,
  );
  useShortcut(
    "r",
    () => {
      const folder = folderForCursor();
      if (folder) {
        void refreshFolder(folder);
      } else if (cursorRef.current === REPOS_SECTION_ID) {
        // Cursor on the merged Repositories header → refresh all
        // configured folders (the header doesn't represent any single
        // one).
        void refreshAll();
      }
    },
    enabled,
  );
  useShortcut(
    "shift+r",
    () => {
      void refreshAll();
    },
    enabled,
  );

  // Cycle sort: alpha → clean → delete → alpha
  useShortcut(
    "s",
    () => {
      const order: SortMode[] = ["alpha", "clean", "delete"];
      const next = order[(order.indexOf(state.sort) + 1) % order.length];
      dispatch({ type: "setSort", sort: next });
    },
    enabled,
  );
  useShortcut(
    "Backspace",
    () => {
      const folder = folderForCursor();
      // Don't let Backspace eat globals (they're auto-discovered).
      if (folder && folder !== GLOBALS_KEY) {
        void removeFolder(folder);
      }
    },
    enabled,
  );
}
