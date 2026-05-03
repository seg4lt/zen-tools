/**
 * Register `:q`, `:vsplit` (`:vsp`), `:hsplit` / `:split` (`:sp`)
 * vim ex-commands and dispatch them through whichever tool is
 * currently mounted.
 *
 * `Vim.defineEx` is module-global — there's only one handler per
 * command name. To make these commands work in every tool without
 * the last `useWorkspaceVim` call clobbering the previous one, we:
 *
 *   1. Register the ex-commands exactly once (idempotent module
 *      side-effect via `ensureRegistered`).
 *   2. Each registered handler reads from a module-level
 *      `activeContextRef` at *call time*, not at registration time.
 *   3. Each `useWorkspaceVim(context)` call sets `activeContextRef`
 *      while the tool is mounted, via a small proxy that always
 *      reads the latest `context` (so prop changes mid-mount take
 *      effect immediately).
 *
 * The runtime mount/unmount lifecycle of the host tool naturally
 * gates ownership: zen-tools renders a single tool view per route,
 * so only one tool sets the ref at any time.
 */

import { useEffect, useRef } from "react";
import { Vim } from "@replit/codemirror-vim";
import type { WorkspaceContext } from "./workspace-context";

const activeContextRef: { current: WorkspaceContext | null } = {
  current: null,
};

let registered = false;

function ensureRegistered() {
  if (registered) return;
  registered = true;
  Vim.defineEx("quit", "q", () => {
    activeContextRef.current?.closeActive();
  });
  Vim.defineEx("vsplit", "vsp", () => {
    activeContextRef.current?.split("vertical");
  });
  Vim.defineEx("split", "sp", () => {
    activeContextRef.current?.split("horizontal");
  });
  // Vim doesn't have `:hsplit` natively but the user asked for it as
  // an alias for `:split` — register so muscle memory works.
  Vim.defineEx("hsplit", "hs", () => {
    activeContextRef.current?.split("horizontal");
  });

  // `<C-w> h/j/k/l` — vim normal-mode window-focus chord. Has to go
  // through vim's own keymap (NOT a CodeMirror keymap) because vim
  // intercepts h/j/k/l as motions in normal mode at the DOM-event
  // level, before any keymap fires.
  //
  // CRITICAL: `@replit/codemirror-vim` ships a default mapping
  // `<C-w>` → `idle` in normal mode (an explicit no-op). vim's
  // `matchCommand` returns the FIRST full match it finds even when
  // partial matches for longer chords also exist — so without
  // removing the default, our `<C-w>h` registration never gets a
  // chance to wait for `h`. Unmap the idle binding first so
  // `<C-w>` becomes a partial match for our chord and vim waits
  // for the second keystroke.
  Vim.unmap("<C-w>", "normal");
  Vim.defineAction("zenMoveFocusH", () => {
    activeContextRef.current?.moveFocus("h");
  });
  Vim.defineAction("zenMoveFocusJ", () => {
    activeContextRef.current?.moveFocus("j");
  });
  Vim.defineAction("zenMoveFocusK", () => {
    activeContextRef.current?.moveFocus("k");
  });
  Vim.defineAction("zenMoveFocusL", () => {
    activeContextRef.current?.moveFocus("l");
  });
  Vim.mapCommand("<C-w>h", "action", "zenMoveFocusH", {}, { context: "normal" });
  Vim.mapCommand("<C-w>j", "action", "zenMoveFocusJ", {}, { context: "normal" });
  Vim.mapCommand("<C-w>k", "action", "zenMoveFocusK", {}, { context: "normal" });
  Vim.mapCommand("<C-w>l", "action", "zenMoveFocusL", {}, { context: "normal" });
}

/**
 * Wires the tool's `WorkspaceContext` to the global vim ex-commands
 * for as long as this hook's component is mounted. Safe to call
 * conditionally (it only registers globally on first invocation).
 */
export function useWorkspaceVim(context: WorkspaceContext) {
  ensureRegistered();

  // Keep a ref pointing at the latest `context` so the proxy below
  // always delegates to the current closures (otherwise the
  // ex-command handler would capture a stale `state.focusedLeafId`
  // from when the tool first mounted).
  const ctxRef = useRef(context);
  ctxRef.current = context;

  useEffect(() => {
    const proxy: WorkspaceContext = {
      closeActive: () => ctxRef.current.closeActive(),
      split: (dir) => ctxRef.current.split(dir),
      moveFocus: (dir) => ctxRef.current.moveFocus(dir),
    };
    activeContextRef.current = proxy;
    return () => {
      if (activeContextRef.current === proxy) {
        activeContextRef.current = null;
      }
    };
  }, []);
}
