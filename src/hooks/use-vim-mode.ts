/**
 * Persisted Vim-mode toggle. App-shell-level: shared by every editor
 * tool (HTTP runner, Database Explorer, Markdown). Reads + writes the
 * same on-disk preferences blob so the user's choice survives across
 * sessions and propagates instantly to other tools.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  PREFERENCES_KEY,
  getPreferences,
  savePreferences,
} from "@zen-tools/ipc";

interface UseVimModeResult {
  /** Current preference (`true` until the user disables it). */
  vimMode: boolean;
  /** Whether the underlying preferences blob has loaded yet. */
  isLoaded: boolean;
  /** Flip the toggle and persist. */
  setVimMode: (next: boolean) => Promise<void>;
}

export function useVimMode(): UseVimModeResult {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: PREFERENCES_KEY,
    queryFn: () => getPreferences(),
    staleTime: Infinity,
  });

  const setVimMode = useCallback(
    async (next: boolean) => {
      // Read-modify-write so we don't clobber other tools' prefs
      // (open projects, vault list, db connections, …) that this
      // hook doesn't own.
      const current = await getPreferences();
      await savePreferences({ ...current, vimMode: next });
      await queryClient.invalidateQueries({ queryKey: PREFERENCES_KEY });
    },
    [queryClient],
  );

  return {
    vimMode: data?.vimMode ?? true,
    isLoaded: !isLoading,
    setVimMode,
  };
}
