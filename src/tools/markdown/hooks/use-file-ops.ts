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

  const deletePath = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        // If the user is deleting the open file (or one of its
        // ancestors), close it first so the editor doesn't try to
        // save back to a now-trashed location.
        const open = state.currentFile?.path ?? null;
        if (open && (open === path || open.startsWith(`${path}/`))) {
          dispatch({ type: "closeFile" });
        }
        await markdownTauri.deleteToTrash(path);
        await refresh();
        return true;
      } catch (err) {
        console.error("[markdown] delete failed", err);
        return false;
      }
    },
    [dispatch, refresh, state.currentFile?.path],
  );

  return { createFile, createDir, renamePath, deletePath };
}
