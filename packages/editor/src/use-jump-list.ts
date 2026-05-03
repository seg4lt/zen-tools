/**
 * Cross-tab / cross-split jump list (Phase 1).
 *
 * Mirrors vim's jump list at the *workspace* level: each entry
 * records "I was looking at this tab in this leaf at this offset".
 * Used by `Ctrl+O` / `Ctrl+I` to jump back / forward across tab
 * switches and split focus changes that vim's per-view jump list
 * can't see.
 *
 * Within-buffer cursor jumps (search, `gg`, `G`, `%`, marks) stay
 * with `@replit/codemirror-vim`'s internal stack: the editor-level
 * `Ctrl+O`/`Ctrl+I` keymap consults this hook first and only takes
 * over when there's a cross-tab jump available, otherwise it falls
 * through to vim.
 */

import { useCallback, useRef } from "react";

export interface JumpEntry {
  /** Stable id of the leaf the user was in. */
  leafId: string;
  /** Stable tab/file/request id within that leaf. `null` for empty leaves. */
  tabId: string | null;
  /** 0-based document offset of the primary cursor. */
  cursorOffset: number;
}

/** Maximum number of entries kept in the ring buffer. */
const MAX_ENTRIES = 100;

export interface JumpListApi {
  /**
   * Push a new entry. If the cursor is sitting "after" the latest
   * back-jump (i.e. there are forward entries in the list), they
   * are discarded — same semantics as vim's jump list.
   */
  push: (entry: JumpEntry) => void;
  /**
   * Step back one entry. Returns the entry to navigate to, or
   * `null` if there's nothing earlier. The jump list's internal
   * cursor moves so a subsequent `forward()` returns the entry we
   * just left.
   */
  back: () => JumpEntry | null;
  /** Step forward one entry. Returns `null` at the head. */
  forward: () => JumpEntry | null;
}

/**
 * Per-tool jump list. The host stores it in a stable ref; the
 * returned API is stable across renders, so passing it down to
 * editor props is cheap.
 *
 * The state is kept in a `useRef` (not `useState`) on purpose —
 * `Ctrl+O` / `Ctrl+I` shouldn't trigger React re-renders, they just
 * navigate. The host re-renders naturally when it dispatches the
 * resulting tab/leaf change.
 */
export function useJumpList(): JumpListApi {
  const stateRef = useRef<{ entries: JumpEntry[]; index: number }>({
    entries: [],
    index: -1,
  });

  const push = useCallback((entry: JumpEntry) => {
    const s = stateRef.current;
    // Don't record consecutive duplicates — common case is the
    // user clicking inside the already-active tab.
    const top = s.entries[s.index];
    if (
      top &&
      top.leafId === entry.leafId &&
      top.tabId === entry.tabId &&
      top.cursorOffset === entry.cursorOffset
    ) {
      return;
    }
    // Drop forward history past the cursor.
    const trimmed = s.entries.slice(0, s.index + 1);
    trimmed.push(entry);
    while (trimmed.length > MAX_ENTRIES) trimmed.shift();
    stateRef.current = { entries: trimmed, index: trimmed.length - 1 };
  }, []);

  const back = useCallback((): JumpEntry | null => {
    const s = stateRef.current;
    if (s.index <= 0) return null;
    const next = s.entries[s.index - 1];
    stateRef.current = { entries: s.entries, index: s.index - 1 };
    return next ?? null;
  }, []);

  const forward = useCallback((): JumpEntry | null => {
    const s = stateRef.current;
    if (s.index < 0 || s.index >= s.entries.length - 1) return null;
    const next = s.entries[s.index + 1];
    stateRef.current = { entries: s.entries, index: s.index + 1 };
    return next ?? null;
  }, []);

  // Stable identity across renders.
  const apiRef = useRef<JumpListApi | null>(null);
  if (!apiRef.current) {
    apiRef.current = { push, back, forward };
  }
  return apiRef.current;
}
