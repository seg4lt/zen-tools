/**
 * To Review tab — open PRs requesting your review (where you haven't yet
 * approved or requested changes; comment-only reviews keep them here,
 * matching PRMaster's classification).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  enrichedId,
  loadToReview,
  usePrMasterStore,
} from "../../store/prmaster-store";
import { EnrichedListView } from "../shared/EnrichedListView";
import {
  applyPrFilters,
  emptyFilterState,
  PrFilterBar,
  type PrFilterState,
  useSavedFilterMatches,
} from "../shared/PrFilterBar";
import {
  prmasterTauri,
  type EnrichedPullRequest,
  type NotificationFilter,
} from "../../lib/tauri";

function compareByTitle(
  left: EnrichedPullRequest,
  right: EnrichedPullRequest,
): number {
  const leftTitle = left.pr.title.toLowerCase();
  const rightTitle = right.pr.title.toLowerCase();
  if (leftTitle < rightTitle) return -1;
  if (leftTitle > rightTitle) return 1;

  // Ensure duplicate titles also have a deterministic order.
  const leftId = enrichedId(left);
  const rightId = enrichedId(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

export function ToReviewTab() {
  const { state, dispatch } = usePrMasterStore();
  const [filter, setFilter] = useState<PrFilterState>(emptyFilterState);
  const [savedFilters, setSavedFilters] = useState<NotificationFilter[]>([]);
  const [lowPriorityIds, setLowPriorityIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (
      state.toReview.length === 0 &&
      !state.loading.toReview &&
      !state.errors.toReview
    ) {
      void loadToReview(dispatch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [filters, priorityIds] = await Promise.allSettled([
        prmasterTauri.listFilters(),
        prmasterTauri.getLowPriorityPrs(),
      ]);
      if (!alive) return;
      if (filters.status === "fulfilled") {
        setSavedFilters(filters.value);
      }
      if (priorityIds.status === "fulfilled") {
        setLowPriorityIds(new Set(priorityIds.value));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const savedFilterMatches = useSavedFilterMatches(
    state.toReview,
    filter.savedFilterIds,
  );
  const filteredRows = useMemo(
    () =>
      [...applyPrFilters(state.toReview, filter, savedFilterMatches)].sort(
        compareByTitle,
      ),
    [state.toReview, filter, savedFilterMatches],
  );

  const toggleLowPriority = useCallback(async (id: string) => {
    try {
      const priorityIds = await prmasterTauri.setLowPriorityPr(
        id,
        !lowPriorityIds.has(id),
      );
      setLowPriorityIds(new Set(priorityIds));
    } catch (error) {
      console.warn("[prmaster] failed to update PR priority:", error);
    }
  }, [lowPriorityIds]);

  return (
    <EnrichedListView
      title="Review Queue"
      variant="to-review"
      rows={filteredRows}
      lowPriorityIds={lowPriorityIds}
      onToggleLowPriority={toggleLowPriority}
      loading={state.loading.toReview}
      error={state.errors.toReview}
      emptyText="No PRs are awaiting your review or being watched."
      onRefresh={() => void loadToReview(dispatch)}
      filterBar={
        <PrFilterBar
          rows={state.toReview}
          state={filter}
          savedFilters={savedFilters}
          onChange={setFilter}
        />
      }
    />
  );
}
