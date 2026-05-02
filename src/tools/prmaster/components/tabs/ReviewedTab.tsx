/**
 * Reviewed ("Done") tab — open PRs you've approved or requested changes on.
 * Mirrors PRMaster's "Done" classification.
 */

import { useEffect, useMemo, useState } from "react";
import {
  loadReviewed,
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

export function ReviewedTab() {
  const { state, dispatch } = usePrMasterStore();
  const [filter, setFilter] = useState<PrFilterState>(emptyFilterState);
  const [savedFilters, setSavedFilters] = useState<NotificationFilter[]>([]);

  useEffect(() => {
    if (
      state.reviewed.length === 0 &&
      !state.loading.reviewed &&
      !state.errors.reviewed
    ) {
      void loadReviewed(dispatch);
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
        // non-fatal
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const filteredRows = useMemo(
    () => applyPrFilters(state.reviewed, filter, savedFilters),
    [state.reviewed, filter, savedFilters],
  );

  return (
    <EnrichedListView
      title="Done"
      rows={filteredRows}
      loading={state.loading.reviewed}
      error={state.errors.reviewed}
      emptyText="You haven't reviewed any open PRs yet."
      onRefresh={() => void loadReviewed(dispatch)}
      filterBar={
        <PrFilterBar
          rows={state.reviewed}
          state={filter}
          onChange={setFilter}
        />
      }
    />
  );
}
