/**
 * Working-dir (project) management hook. Wraps the React Query slot for
 * the open project list and persists changes to a JSON file in the
 * OS-specific app-data directory (resolved by Tauri's
 * `app_data_dir()`):
 *
 * - macOS:   `~/Library/Application Support/com.zen.tools/preferences.json`
 * - Linux:   `~/.local/share/com.zen.tools/preferences.json`
 * - Windows: `%APPDATA%\com.zen.tools\preferences.json`
 *
 * Replaces the previous `localStorage` approach so user preferences
 * survive even when the embedded WebView's storage is cleared.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { tauri } from "../lib/tauri";

/** Read the persisted preferences. Resolves to defaults on first launch. */
async function readPrefs() {
  return tauri.getPreferences();
}

/**
 * Persist the projects list — preserves any other preference fields by
 * fetching the current file first, mutating only `workingDirs`, then
 * writing back. Cheap because the file is small.
 */
async function persistWorkingDirs(workingDirs: string[]): Promise<void> {
  const prefs = await readPrefs();
  prefs.workingDirs = workingDirs;
  await tauri.savePreferences(prefs);
}

/**
 * Reactive accessor for the open project list. Cached under
 * `["working-dirs"]`; mutations elsewhere just need to invalidate that
 * key to refetch.
 */
export function useWorkingDirs() {
  return useQuery({
    queryKey: ["working-dirs"],
    queryFn: () => tauri.listWorkingDirs(),
    staleTime: Infinity,
  });
}

/**
 * One-shot bootstrap: on first mount, re-add every project the user
 * previously had open from the on-disk preferences file. Skips paths
 * the backend rejects (folder deleted/unmounted) so a stale entry
 * doesn't crash startup.
 *
 * Safe to call multiple times — internal ref prevents the bootstrap
 * from running more than once per page lifetime.
 */
export function useProjectsBootstrap() {
  const queryClient = useQueryClient();
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        // Skip the bootstrap if the backend already has projects
        // registered (e.g. dev mode hot-reload preserved the state).
        const current = await tauri.listWorkingDirs();
        if (current.length > 0) {
          await queryClient.invalidateQueries({ queryKey: ["working-dirs"] });
          await queryClient.invalidateQueries({ queryKey: ["http-files"] });
          return;
        }
        const prefs = await readPrefs();
        if (prefs.workingDirs.length === 0) return;
        for (const p of prefs.workingDirs) {
          try {
            await tauri.addWorkingDir(p);
          } catch (err) {
            console.warn(`zen-tools: skipping missing project ${p}`, err);
          }
        }
        if (cancelled) return;
        // Persist the surviving subset so the next start doesn't keep
        // retrying broken paths.
        const surviving = await tauri.listWorkingDirs();
        if (surviving.length !== prefs.workingDirs.length) {
          await persistWorkingDirs(surviving);
        }
        await queryClient.invalidateQueries({ queryKey: ["working-dirs"] });
        await queryClient.invalidateQueries({ queryKey: ["http-files"] });
        await queryClient.invalidateQueries({ queryKey: ["environments"] });
        await queryClient.invalidateQueries({ queryKey: ["env-vars"] });
        await queryClient.invalidateQueries({ queryKey: ["extracted-vars"] });
        // Surface the auto-picked env (if any) — matches the
        // single-project path in `useProjectActions.addProject`.
        if (surviving.length > 0) {
          const env = await tauri.getActiveEnvironment();
          if (env) {
            window.dispatchEvent(
              new CustomEvent<{ env: string }>("zen:env-auto-selected", {
                detail: { env },
              }),
            );
          }
        }
      } catch (err) {
        console.error("zen-tools: project bootstrap failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queryClient]);
}

/**
 * Imperative project add/remove. Both flavours invalidate the relevant
 * queries and persist the surviving list to the on-disk preferences
 * file.
 */
export function useProjectActions() {
  const queryClient = useQueryClient();

  const addProject = useCallback(async (): Promise<string | null> => {
    const picked = await tauri.pickDirectory();
    if (!picked) return null;
    const before = await tauri.listWorkingDirs();
    const list = await tauri.addWorkingDir(picked);
    await persistWorkingDirs(list);
    await queryClient.invalidateQueries({ queryKey: ["working-dirs"] });
    await queryClient.invalidateQueries({ queryKey: ["http-files"] });
    // The env list can change every time a project is added (a new
    // root might surface its own env file once we open a file inside
    // it). Always invalidate, not just on first-project — the
    // previous gate left the dropdown stale on the 2nd+ project.
    await queryClient.invalidateQueries({ queryKey: ["environments"] });
    await queryClient.invalidateQueries({ queryKey: ["env-vars"] });
    await queryClient.invalidateQueries({ queryKey: ["extracted-vars"] });
    // First project just got added → surface the auto-picked env (if
    // any) the same way the old picker did.
    if (before.length === 0 && list.length === 1) {
      const env = await tauri.getActiveEnvironment();
      if (env) {
        window.dispatchEvent(
          new CustomEvent<{ env: string }>("zen:env-auto-selected", {
            detail: { env },
          }),
        );
      }
    }
    return picked;
  }, [queryClient]);

  const removeProject = useCallback(
    async (path: string): Promise<void> => {
      const list = await tauri.removeWorkingDir(path);
      await persistWorkingDirs(list);
      await queryClient.invalidateQueries({ queryKey: ["working-dirs"] });
      await queryClient.invalidateQueries({ queryKey: ["http-files"] });
    },
    [queryClient],
  );

  return { addProject, removeProject };
}
