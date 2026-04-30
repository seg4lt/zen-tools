/**
 * Imperative open / save helpers for the current document.
 *
 * `openFile` is also implemented inline in `vault-sidebar.tsx` (where
 * tree rows fire it) — this hook is the centralised version used by
 * the quick switcher and wikilink navigation.
 */

import { useCallback } from "react";
import { markdownTauri, basenameNoExt } from "../lib/tauri";
import { useMarkdownStore } from "../store/markdown-store";

export function useOpenFile() {
  const { state, dispatch } = useMarkdownStore();

  /** Open `path` in the editor.  Reads the file, dispatches
   *  `openFile`, and pushes onto the recents ring. */
  const openFile = useCallback(
    async (path: string) => {
      try {
        const doc = await markdownTauri.readFile(path);
        dispatch({ type: "openFile", path, doc });
        markdownTauri
          .pushRecent(path)
          .then((recents) => dispatch({ type: "setRecents", recents }))
          .catch(() => {});
      } catch (err) {
        console.error("[markdown] openFile failed", path, err);
      }
    },
    [dispatch],
  );

  /** Save the current doc to disk.  No-op if nothing is open. */
  const saveCurrent = useCallback(
    async (overrideContent?: string) => {
      if (!state.currentFile) return;
      const content = overrideContent ?? state.currentFile.doc;
      try {
        await markdownTauri.writeFile(state.currentFile.path, content);
        dispatch({ type: "markSaved" });
      } catch (err) {
        console.error("[markdown] save failed", err);
      }
    },
    [dispatch, state.currentFile],
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
