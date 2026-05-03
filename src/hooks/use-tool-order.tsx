/**
 * User-defined ordering AND disable state of the title-bar tool pills.
 *
 * Two independent prefs share this hook:
 *
 *   - `preferences.toolOrder: string[]` — saved order of `Tool.id`s.
 *   - `preferences.disabledTools: string[]` — ids the user has turned off.
 *
 * The hook reconciles both with the canonical `TOOLS` array on every
 * render:
 *
 *   - tools missing from the saved order (e.g. brand-new tool just
 *     added to `TOOLS`) get appended in canonical order;
 *   - ids in either saved list that are no longer in `TOOLS`
 *     (renamed / removed tool) are silently dropped;
 *   - `tools` returns only the **enabled** ordered set (consumed by
 *     the title-bar pills, which should never see disabled apps);
 *   - `allTools` returns the full ordered set (consumed by the
 *     settings page, which still needs to render disabled rows so
 *     the user can re-enable them).
 *
 * `setDisabled` writes through the dedicated `set_tool_disabled`
 * Tauri command rather than `save_preferences` directly so the
 * backend can react to the toggle (PRMaster's tray, polling, hotkey,
 * and broadcast bridge are spun up / torn down live in the same
 * call).
 */
import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { TOOLS, type Tool } from "@/config/tools";
import {
  PREFERENCES_KEY,
  getPreferences,
  savePreferences,
} from "@zen-tools/ipc";

interface UseToolOrderResult {
  /** Enabled tools in user order. Title-bar pills consume this. */
  tools: Tool[];
  /** All tools in user order (enabled + disabled). Settings UI consumes this. */
  allTools: Tool[];
  /** Fast lookup of disabled ids. */
  disabledIds: Set<string>;
  isLoaded: boolean;
  /** Persist a new order (across both enabled and disabled tools). */
  setOrder: (orderedIds: string[]) => Promise<void>;
  /** Toggle a single tool on or off. */
  setDisabled: (toolId: string, disabled: boolean) => Promise<void>;
}

export function useToolOrder(): UseToolOrderResult {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: PREFERENCES_KEY,
    queryFn: () => getPreferences(),
    staleTime: Infinity,
  });

  const allTools = useMemo<Tool[]>(() => {
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

  const disabledIds = useMemo<Set<string>>(
    () => new Set(data?.disabledTools ?? []),
    [data?.disabledTools],
  );

  const tools = useMemo<Tool[]>(
    () => allTools.filter((t) => !disabledIds.has(t.id)),
    [allTools, disabledIds],
  );

  const setOrder = useCallback(
    async (orderedIds: string[]) => {
      const current = await getPreferences();
      await savePreferences({ ...current, toolOrder: orderedIds });
      await queryClient.invalidateQueries({ queryKey: PREFERENCES_KEY });
    },
    [queryClient],
  );

  const setDisabled = useCallback(
    async (toolId: string, disabled: boolean) => {
      // Routed through the backend command so PRMaster's lifecycle
      // (tray + polling + hotkey + broadcast bridge) is started or
      // stopped atomically with the preference write. For tools with
      // no backend lifecycle the command is a no-op past the write.
      await invoke<void>("set_tool_disabled", { toolId, disabled });
      await queryClient.invalidateQueries({ queryKey: PREFERENCES_KEY });
    },
    [queryClient],
  );

  return {
    tools,
    allTools,
    disabledIds,
    isLoaded: !isLoading,
    setOrder,
    setDisabled,
  };
}
