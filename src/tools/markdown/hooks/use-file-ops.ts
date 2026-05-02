/**
 * Imperative file-ops helpers for the sidebar's context menus +
 * inline editing.
 *
 * Every method:
 *   1. Hits the corresponding Tauri command.
 *   2. Re-discovers the open vaults so the sidebar reflects disk
 *      truth without manual refresh.
 *   3. Dispatches any local-store cleanup needed (e.g. updating the
 *      open file's path after a rename).
 */

import { useCallback } from "react";
import { markdownTauri } from "../lib/tauri";
import { useMarkdownStore } from "../store/markdown-store";
import { useVaults } from "./use-vaults";

export function useFileOps() {
  const { state, dispatch } = useMarkdownStore();
  const { refresh } = useVaults();

  const createFile = useCallback(
    async (parentDir: string, name: string): Promise<string | null> => {
      try {
        const path = await markdownTauri.createFile(parentDir, name);
        await refresh();
        return path;
      } catch (err) {
        console.error("[markdown] createFile failed", err);
        return null;
      }
    },
    [refresh],
  );

  const createDir = useCallback(
    async (parentDir: string, name: string): Promise<string | null> => {
      try {
        const path = await markdownTauri.createDir(parentDir, name);
        await refresh();
        return path;
      } catch (err) {
        console.error("[markdown] createDir failed", err);
        return null;
      }
    },
    [refresh],
  );

  const renamePath = useCallback(
    async (oldPath: string, newName: string): Promise<string | null> => {
      try {
        const newPath = await markdownTauri.rename(oldPath, newName);
        await refresh();
        // If the user just renamed the currently-open file, mirror
        // the new path into the store so saves go to the right
        // location.  No-op for directory renames.
        dispatch({ type: "renamedFile", oldPath, newPath });
        return newPath;
      } catch (err) {
        console.error("[markdown] rename failed", err);
        return null;
      }
    },
    [dispatch, refresh],
  );

  /**
   * Move a file or directory into a different parent directory.
   *
   * `source` is the absolute path of the entry to move; `targetDir`
   * is the absolute path of the destination folder.  Reuses the
   * `renamedFile` reducer hook so any open tab whose path lives
   * under `source` re-targets to the new location automatically.
   */
  const movePath = useCallback(
    async (source: string, targetDir: string): Promise<string | null> => {
      try {
        const newPath = await markdownTauri.move(source, targetDir);
        await refresh();
        dispatch({ type: "renamedFile", oldPath: source, newPath });
        return newPath;
      } catch (err) {
        console.error("[markdown] move failed", err);
        return null;
      }
    },
    [dispatch, refresh],
  );

  const deletePath = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        // Close every tab whose path matches the deletion target
        // (or lives under it, when a directory is being trashed).
        const prefix = `${path}/`;
        const doomed = state.tabs.filter(
          (t) => t.path === path || t.path.startsWith(prefix),
        );
        for (const t of doomed) {
          dispatch({ type: "closeTab", id: t.id });
        }
        await markdownTauri.deleteToTrash(path);
        await refresh();
        return true;
      } catch (err) {
        console.error("[markdown] delete failed", err);
        return false;
      }
    },
    [dispatch, refresh, state.tabs],
  );

  return { createFile, createDir, renamePath, movePath, deletePath };
}
