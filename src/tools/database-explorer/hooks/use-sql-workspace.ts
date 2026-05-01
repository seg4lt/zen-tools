/**
 * Hooks for the SQL-file workspace:
 *  - `useSqlProjects()`     — list of discovered projects (TanStack Query)
 *  - `useSqlProjectActions()` — add / remove project folder
 *  - `useSqlProjectsBootstrap()` — re-add saved project list on mount
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import {
  sqlWorkspaceTauri,
  type DiscoveredSqlProject,
} from "../lib/tauri";
import { tauri as httpTauri } from "@/tools/http-runner/lib/tauri";

const PROJECTS_KEY = ["sql-workspace", "projects"] as const;
const DIRS_KEY = ["sql-workspace", "dirs"] as const;

export function useSqlProjects() {
  return useQuery<DiscoveredSqlProject[]>({
    queryKey: PROJECTS_KEY,
    queryFn: () => sqlWorkspaceTauri.discover(),
    staleTime: 5_000,
  });
}

export function useSqlProjectActions() {
  const queryClient = useQueryClient();

  const addProject = useCallback(async () => {
    const picked = await sqlWorkspaceTauri.pickDirectory();
    if (!picked) return null;
    await sqlWorkspaceTauri.add(picked);
    await queryClient.invalidateQueries({ queryKey: DIRS_KEY });
    await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    return picked;
  }, [queryClient]);

  const removeProject = useCallback(
    async (path: string) => {
      await sqlWorkspaceTauri.remove(path);
      await queryClient.invalidateQueries({ queryKey: DIRS_KEY });
      await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
    [queryClient],
  );

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
  }, [queryClient]);

  return { addProject, removeProject, refresh };
}

/**
 * Re-hydrate `sql_workspace_dirs` into AppState on mount. Idempotent —
 * if the backend already has the list (hot reload), this is a no-op.
 */
export function useSqlProjectsBootstrap() {
  const queryClient = useQueryClient();
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    void (async () => {
      try {
        const live = await sqlWorkspaceTauri.list();
        if (live.length > 0) {
          await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
          return;
        }
        const prefs = await httpTauri.getPreferences();
        const saved = (prefs as { sqlWorkspaceDirs?: string[] })
          .sqlWorkspaceDirs;
        if (!saved || saved.length === 0) return;
        for (const p of saved) {
          try {
            await sqlWorkspaceTauri.add(p);
          } catch {
            // Stale path — skip silently.
          }
        }
        await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("sql workspace bootstrap failed", err);
      }
    })();
  }, [queryClient]);
}
