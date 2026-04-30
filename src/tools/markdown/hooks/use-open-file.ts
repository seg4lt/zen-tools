/**
 * Imperative open / save helpers for the current document.
 *
 * `openFile` is also implemented inline in `vault-sidebar.tsx` (where
 * tree rows fire it) — this hook is the centralised version used by
 * the quick switcher and wikilink navigation.
 */

import { useCallback } from "react";
import { markdownTauri, basenameNoExt } from "../lib/tauri";
import { activeTab, useMarkdownStore } from "../store/markdown-store";

export function useOpenFile() {
  const { state, dispatch } = useMarkdownStore();

  /**
   * Open `path` in the editor.
   *
   * `gotoLine` (1-based) tells the editor to scroll to a specific
   * line after opening — used by the content-search row click flow
   * so the user lands directly on the matching line instead of the
   * top of the file.
   */
  const openFile = useCallback(
    async (path: string, gotoLine?: number) => {
      try {
        // Avoid re-reading from disk when the file is already open as
        // a tab — we'd clobber any dirty edits the user has made.
        const existing = state.tabs.find((t) => t.path === path);
        if (existing) {
          dispatch({ type: "selectTab", id: existing.id, gotoLine });
        } else {
          const doc = await markdownTauri.readFile(path);
          dispatch({ type: "openFile", path, doc, gotoLine });
        }
        markdownTauri
          .pushRecent(path)
          .then((recents) => dispatch({ type: "setRecents", recents }))
          .catch(() => {});
      } catch (err) {
        console.error("[markdown] openFile failed", path, err);
      }
    },
    [dispatch, state.tabs],
  );

  /** Save the active tab's doc to disk.  No-op if nothing is open. */
  const saveCurrent = useCallback(
    async (overrideContent?: string) => {
      const tab = activeTab(state);
      if (!tab) return;
      const content = overrideContent ?? tab.doc;
      try {
        await markdownTauri.writeFile(tab.path, content);
        dispatch({ type: "markSaved" });
      } catch (err) {
        console.error("[markdown] save failed", err);
      }
    },
    [dispatch, state],
  );

  /**
   * Resolve a wikilink label (`Foo` from `[[Foo]]`) to a path by
   * scanning every vault.  Returns the path of a unique match or
   * `null` if no match / multiple matches.
   */
  const resolveWikilink = useCallback(
    (label: string): string | null => {
      const lower = label.trim().toLowerCase();
      const matches: string[] = [];
      for (const vault of Object.values(state.files)) {
        for (const item of vault.items) {
          if (item.isDir) continue;
          if (basenameNoExt(item.path).toLowerCase() === lower) {
            matches.push(item.path);
          }
        }
      }
      return matches.length === 1 ? matches[0] : null;
    },
    [state.files],
  );

  return { openFile, saveCurrent, resolveWikilink };
}
