/**
 * Imperative open / save helpers for the current document.
 *
 * `openFile` is also implemented inline in `vault-sidebar.tsx` (where
 * tree rows fire it) — this hook is the centralised version used by
 * the quick switcher and wikilink navigation.
 */

import { useCallback } from "react";
import {
  basenameNoExt,
  isExcalidrawPath,
  isHtmlPath,
  isMarkdownPath,
  markdownTauri,
  normalizePath,
} from "../lib/tauri";
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
    async (rawPath: string, gotoLine?: number) => {
      // Normalise so `./foo.md` from a relative-link resolution and
      // `foo.md` from the file tree compare equal in the tab dedup.
      // Without this, Cmd+clicking a `[label](./foo.md)` link would
      // open a duplicate tab even when `foo.md` is already open via
      // the sidebar.
      const path = normalizePath(rawPath);
      // Drawings get their own tab kind so the view layer mounts the
      // Excalidraw pane instead of CodeMirror. Markdown docs keep the
      // markdown-specific editor; every other text file uses the plain
      // CodeMirror host with no markdown parsing or live preview.
      const kind = isExcalidrawPath(path)
        ? "excalidraw"
        : isMarkdownPath(path)
          ? "markdown"
          : isHtmlPath(path)
            ? "html"
            : "file";
      try {
        // Avoid re-reading from disk when the file is already open as
        // a tab — we'd clobber any dirty edits the user has made.
        const existing = state.tabs.find((t) => t.path === path);
        if (existing) {
          dispatch({ type: "selectTab", id: existing.id, gotoLine });
        } else if (kind === "excalidraw") {
          dispatch({
            type: "openFile",
            path,
            doc: "",
            gotoLine,
            kind,
          });
        } else {
          const doc = await markdownTauri.readFile(path);
          dispatch({ type: "openFile", path, doc, gotoLine, kind });
        }
        // Expand the sidebar tree so the user can see where the file
        // they just opened lives — same affordance as Obsidian /
        // VS Code's "Reveal in Explorer" but automatic on every open.
        dispatch({ type: "revealPath", path });
        markdownTauri
          .pushRecent(path)
          .then((recents) => dispatch({ type: "setRecents", recents }))
          .catch(() => {});
      } catch (err) {
        console.error("[markdown] openFile failed", rawPath, err);
      }
    },
    [dispatch, state.tabs],
  );

  /** Save the active tab's doc to disk.  No-op if nothing is open.
   *
   *  `overrideContent` is what an external editor (e.g. the
   *  Excalidraw drawing pane) hands us via the `onSave` prop.  A
   *  `string` goes through `writeFile` (text), a `Uint8Array` goes
   *  through `writeBytes` (binary) — the latter path is what
   *  `*.excalidraw.png` saves take.
   */
  const saveCurrent = useCallback(
    async (overrideContent?: string | Uint8Array) => {
      const tab = activeTab(state);
      if (!tab) return;
      try {
        if (overrideContent instanceof Uint8Array) {
          await markdownTauri.writeBytes(tab.path, overrideContent);
        } else {
          const content = overrideContent ?? tab.doc;
          await markdownTauri.writeFile(tab.path, content);
        }
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
