/**
 * Workspace context — the bridge between vim ex-commands (registered
 * once globally on the `Vim` singleton) and the per-tool reducer that
 * actually owns the split tree.
 *
 * Each tool builds a `WorkspaceContext` from its own state +
 * dispatch and calls `useWorkspaceVim(context)` from its top-level
 * view. Because zen-tools uses route-based mounting (only one tool's
 * view is mounted at a time), whichever tool is currently visible
 * "owns" the ex-commands until it unmounts.
 */

import type { MoveDirection, SplitDirection } from "./split-tree";

export interface WorkspaceContext {
  /**
   * `:q` handler. Tool decides what's "active": typically close the
   * focused split if there are multiple, otherwise close the active
   * tab. HTTP Runner, which has no tab strip, no-ops when only one
   * leaf is present.
   */
  closeActive: () => void;
  /** `:vsplit` / `:hsplit` handler — split the focused leaf. */
  split: (direction: SplitDirection) => void;
  /**
   * `<C-w> h/j/k/l` handler — move focus between split panes.
   * Wired through vim's `mapCommand` so it's intercepted by vim's
   * own normal-mode key handler (a CodeMirror keymap can't see
   * h/j/k/l in normal mode — vim swallows them as motions before
   * the keymap fires).
   */
  moveFocus: (dir: MoveDirection) => void;
}
