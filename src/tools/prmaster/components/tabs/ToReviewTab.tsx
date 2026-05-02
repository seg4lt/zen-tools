/**
 * To Review tab — open PRs requesting your review (where you haven't yet
 * approved or requested changes; comment-only reviews keep them here,
 * matching PRMaster's classification).
 */

import { useEffect } from "react";
import {
  loadToReview,
  usePrMasterStore,
} from "../../store/prmaster-store";
import { EnrichedListView } from "../shared/EnrichedListView";

export function ToReviewTab() {
  const { state, dispatch } = usePrMasterStore();

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

  return (
    <EnrichedListView
      title="To Review"
      rows={state.toReview}
      loading={state.loading.toReview}
      error={state.errors.toReview}
      emptyText="No PRs are awaiting your review."
      onRefresh={() => void loadToReview(dispatch)}
    />
  );
}
