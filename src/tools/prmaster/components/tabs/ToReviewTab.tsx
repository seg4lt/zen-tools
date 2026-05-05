/**
 * To Review tab — open PRs requesting your review (where you haven't yet
 * approved or requested changes; comment-only reviews keep them here,
 * matching PRMaster's classification).
 */

import { useEffect, useMemo, useState } from "react";
import {
  loadToReview,
  usePrMasterStore,
} from "../../store/prmaster-store";
import { EnrichedListView } from "../shared/EnrichedListView";
import {
  applyPrFilters,
  emptyFilterState,
  PrFilterBar,
  type PrFilterState,
} from "../shared/PrFilterBar";
import { prmasterTauri, type NotificationFilter } from "../../lib/tauri";

export function ToReviewTab() {
  const { state, dispatch } = usePrMasterStore();
  const [filter, setFilter] = useState<PrFilterState>(emptyFilterState);
  const [savedFilters, setSavedFilters] = useState<NotificationFilter[]>([]);

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
      try {
        const list = await prmasterTauri.listFilters();
        if (alive) setSavedFilters(list);
      } catch {
        // non-fatal — Filters tab surfaces errors
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const filteredRows = useMemo(
    () => applyPrFilters(state.toReview, filter, savedFilters),
    [state.toReview, filter, savedFilters],
  );

  return (
    <EnrichedListView
      title="To Review"
      variant="to-review"
      rows={filteredRows}
      loading={state.loading.toReview}
      error={state.errors.toReview}
      emptyText="No PRs are awaiting your review."
      onRefresh={() => void loadToReview(dispatch)}
      filterBar={
        <PrFilterBar
          rows={state.toReview}
          state={filter}
          onChange={setFilter}
        />
      }
    />
  );
}
