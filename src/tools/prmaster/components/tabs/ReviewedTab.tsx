/**
 * Reviewed ("Done") tab — open PRs you've approved or requested changes on.
 * Mirrors PRMaster's "Done" classification.
 */

import { useEffect } from "react";
import {
  loadReviewed,
  usePrMasterStore,
} from "../../store/prmaster-store";
import { EnrichedListView } from "../shared/EnrichedListView";

export function ReviewedTab() {
  const { state, dispatch } = usePrMasterStore();

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

  return (
    <EnrichedListView
      title="Done"
      rows={state.reviewed}
      loading={state.loading.reviewed}
      error={state.errors.reviewed}
      emptyText="You haven't reviewed any open PRs yet."
      onRefresh={() => void loadReviewed(dispatch)}
    />
  );
}
