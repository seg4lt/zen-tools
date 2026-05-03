/**
 * User-defined ordering of the title-bar tool pills.
 *
 * Persisted as `preferences.toolOrder: string[]` (a list of `Tool.id`
 * values). The hook reconciles that saved order with the canonical
 * `TOOLS` array on every render, so:
 *
 *   - tools missing from the saved list (e.g. brand-new tool just
 *     added to `TOOLS`) get appended in canonical order;
 *   - ids in the saved list that are no longer in `TOOLS` (renamed /
 *     removed tool) are silently dropped.
 *
 * The result is always a permutation of the live `TOOLS` array — the
 * UI never has to handle "missing" or "stale" entries.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { TOOLS, type Tool } from "@/config/tools";
import {
  PREFERENCES_KEY,
  getPreferences,
  savePreferences,
} from "@zen-tools/ipc";

interface UseToolOrderResult {
  /** `TOOLS` reordered per user preference. Always a full permutation. */
  tools: Tool[];
  isLoaded: boolean;
  /** Persist a new order. The argument is the desired list of tool ids. */
  setOrder: (orderedIds: string[]) => Promise<void>;
}

export function useToolOrder(): UseToolOrderResult {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: PREFERENCES_KEY,
    queryFn: () => getPreferences(),
    staleTime: Infinity,
  });

  const tools = useMemo<Tool[]>(() => {
    const saved = data?.toolOrder ?? [];
    const byId = new Map(TOOLS.map((t) => [t.id, t]));
    const out: Tool[] = [];
    const seen = new Set<string>();
    // 1) Honour saved order, dropping ids that no longer exist.
    for (const id of saved) {
      const t = byId.get(id);
      if (t && !seen.has(id)) {
        out.push(t);
        seen.add(id);
      }
    }
    // 2) Append any newly-introduced tools at the tail in canonical order.
    for (const t of TOOLS) {
      if (!seen.has(t.id)) out.push(t);
    }
    return out;
  }, [data?.toolOrder]);

  const setOrder = useCallback(
    async (orderedIds: string[]) => {
      const current = await getPreferences();
      await savePreferences({ ...current, toolOrder: orderedIds });
      await queryClient.invalidateQueries({ queryKey: PREFERENCES_KEY });
    },
    [queryClient],
  );

  return { tools, isLoaded: !isLoading, setOrder };
}
