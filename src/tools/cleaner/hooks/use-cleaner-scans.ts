/**
 * Imperative scan helpers — `addFolder`, `removeFolder`, `refreshFolder`,
 * `refreshAll`, `runMarked`.
 *
 * Bootstrap (event listener registration + initial fetch + cache
 * hydration) lives in `CleanerStoreProvider`, *not* here, so it runs
 * exactly once per provider mount instead of once per call site.  This
 * prevents the well-known "first add invisible until second add" race
 * where multiple bootstraps would clobber each other's `setFolders`
 * dispatches.
 *
 * Safe to call from anywhere inside the provider — no side effects on
 * mount, just memoised callbacks reading from the shared store.
 */

import { useCallback } from "react";
import {
  cleanerTauri,
  type CleanerRunActionItem,
  type CleanerNodeAction,
} from "../lib/tauri";
import { useCleanerStore, GLOBALS_KEY, findNode } from "../store/cleaner-store";

export function useCleanerScans() {
  const { state, dispatch } = useCleanerStore();

  const startScan = useCallback(
    async (folder: string) => {
      dispatch({ type: "setScanStatus", key: folder, status: "scanning" });
      try {
        await cleanerTauri.scanFolder(folder, folder);
      } catch (err) {
        dispatch({
          type: "setScanStatus",
          key: folder,
          status: "error",
          error: String(
            (err as { message?: string })?.message ?? err ?? "scan failed",
          ),
        });
      }
    },
    [dispatch],
  );

  const refreshGlobals = useCallback(async () => {
    dispatch({ type: "setScanStatus", key: GLOBALS_KEY, status: "scanning" });
    try {
      const section = await cleanerTauri.discoverGlobals();
      dispatch({ type: "setTree", key: GLOBALS_KEY, roots: [section] });
      dispatch({ type: "setScanStatus", key: GLOBALS_KEY, status: "ready" });
    } catch (err) {
      dispatch({
        type: "setScanStatus",
        key: GLOBALS_KEY,
        status: "error",
        error: String((err as { message?: string })?.message ?? err),
      });
    }
  }, [dispatch]);

  const addFolder = useCallback(async () => {
    const picked = await cleanerTauri.pickDirectory();
    if (!picked) return null;
    try {
      const next = await cleanerTauri.addScanFolder(picked);
      dispatch({ type: "setFolders", folders: next });
      // Kick a scan iff this is a new entry (the backend dedupes).
      if (next.includes(picked) && !state.trees[picked]) {
        void startScan(picked);
      }
      return picked;
    } catch (err) {
      console.error("[cleaner] add folder failed", err);
      throw err;
    }
  }, [dispatch, startScan, state.trees]);

  const removeFolder = useCallback(
    async (folder: string) => {
      try {
        const next = await cleanerTauri.removeScanFolder(folder);
        dispatch({ type: "setFolders", folders: next });
      } catch (err) {
        console.error("[cleaner] remove folder failed", err);
      }
    },
    [dispatch],
  );

  const refreshFolder = useCallback(
    (folder: string) => {
      if (folder === GLOBALS_KEY) return refreshGlobals();
      return startScan(folder);
    },
    [refreshGlobals, startScan],
  );

  const refreshAll = useCallback(async () => {
    await Promise.all([
      refreshGlobals(),
      ...state.folders.map((f) => startScan(f)),
    ]);
  }, [refreshGlobals, startScan, state.folders]);

  const runMarked = useCallback(async () => {
    if (Object.keys(state.actions).length === 0) return;
    dispatch({ type: "startRun" });
    const items: CleanerRunActionItem[] = [];
    for (const [id, action] of Object.entries(state.actions)) {
      const node = findNode(state.trees, id);
      if (!node) continue;
      if (node.kind === "section") continue;
      // Globals can't be cleaned — defensive.
      if (node.kind === "globalPath" && action === "clean") continue;
      if (action === "none") continue;
      items.push({
        kind: node.kind as "repo" | "globalPath",
        label: node.label,
        path: node.path,
        action: action as Exclude<CleanerNodeAction, "none">,
      });
    }
    try {
      const results = await cleanerTauri.runActions(items);
      dispatch({ type: "finishRun", results });
      // Refresh every folder a successful action touched so sizes settle.
      const touched = new Set<string>();
      for (const it of items) {
        // Find the folder root that contains this path.
        const root = state.folders.find((f) => it.path.startsWith(f));
        if (root) touched.add(root);
        if (it.kind === "globalPath") touched.add(GLOBALS_KEY);
      }
      for (const key of touched) void refreshFolder(key);
    } catch (err) {
      console.error("[cleaner] run failed", err);
      dispatch({
        type: "finishRun",
        results: {
          successes: [],
          failures: items.map((it) => ({
            item: `[${it.action}] ${it.path}`,
            error: String((err as { message?: string })?.message ?? err),
          })),
        },
      });
    }
  }, [dispatch, refreshFolder, state.actions, state.folders, state.trees]);

  return {
    addFolder,
    removeFolder,
    refreshFolder,
    refreshAll,
    runMarked,
  };
}
