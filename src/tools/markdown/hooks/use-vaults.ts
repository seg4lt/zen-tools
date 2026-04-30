/**
 * Imperative vault-management helpers.
 *
 * Bootstrap (initial fetch + discovery) lives in `MarkdownStoreProvider`
 * — these are only called from user actions (sidebar buttons,
 * keyboard shortcuts, palette commands).
 */

import { useCallback } from "react";
import { markdownTauri } from "../lib/tauri";
import { useMarkdownStore } from "../store/markdown-store";

export function useVaults() {
  const { dispatch } = useMarkdownStore();

  /** Open the native folder picker, add the chosen folder, and
   *  re-discover so the new vault's file tree shows up immediately. */
  const addVault = useCallback(async () => {
    const picked = await markdownTauri.pickDirectory();
    if (!picked) return null;
    try {
      const next = await markdownTauri.addVault(picked);
      dispatch({ type: "setVaults", vaults: next });
      const files = await markdownTauri.discoverFiles(next);
      dispatch({ type: "setFiles", vaults: files });
      return picked;
    } catch (err) {
      console.error("[markdown] addVault failed", err);
      throw err;
    }
  }, [dispatch]);

  /** Remove a vault by absolute path. */
  const removeVault = useCallback(
    async (path: string) => {
      try {
        const next = await markdownTauri.removeVault(path);
        dispatch({ type: "setVaults", vaults: next });
        // Files dictionary is pruned by the reducer based on `setVaults`,
        // so we don't need a fresh discoverFiles round-trip.
      } catch (err) {
        console.error("[markdown] removeVault failed", err);
      }
    },
    [dispatch],
  );

  /** Re-walk every vault and refresh the file tree. */
  const refresh = useCallback(async () => {
    try {
      const list = await markdownTauri.listVaults();
      dispatch({ type: "setVaults", vaults: list });
      if (list.length > 0) {
        const files = await markdownTauri.discoverFiles(list);
        dispatch({ type: "setFiles", vaults: files });
      }
    } catch (err) {
      console.error("[markdown] refresh failed", err);
    }
  }, [dispatch]);

  return { addVault, removeVault, refresh };
}
