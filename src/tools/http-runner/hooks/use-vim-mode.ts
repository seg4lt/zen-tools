/**
 * Persisted Vim-mode toggle. Reads + writes the same on-disk
 * preferences file as the project list, so the user's choice survives
 * across sessions without an extra storage mechanism.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { tauri } from "../lib/tauri";
import { PREFERENCES_KEY } from "@/lib/preferences-key";

interface UseVimModeResult {
  /** Current preference (`true` until the user disables it). */
  vimMode: boolean;
  /** Whether the underlying preferences file has loaded yet. */
  isLoaded: boolean;
  /** Flip the toggle and persist. */
  setVimMode: (next: boolean) => Promise<void>;
}

export function useVimMode(): UseVimModeResult {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: PREFERENCES_KEY,
    queryFn: () => tauri.getPreferences(),
    staleTime: Infinity,
  });

  const setVimMode = useCallback(
    async (next: boolean) => {
      // Read-modify-write so we don't clobber other prefs (open
      // projects, expanded paths) that this hook doesn't own.
      const current = await tauri.getPreferences();
      await tauri.savePreferences({ ...current, vimMode: next });
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
