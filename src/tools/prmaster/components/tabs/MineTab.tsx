/**
 * Mine tab — your open PRs with an inline detail panel below the row list.
 *
 * Layout matches PRMaster's compact `MyPRsView`: scrollable list on top,
 * detail panel for the selected row beneath. Selecting a different row
 * swaps the panel; clicking the same row again deselects.
 */

import { useEffect } from "react";
import { loadMine, usePrMasterStore } from "../../store/prmaster-store";
import { EnrichedListView } from "../shared/EnrichedListView";

export function MineTab() {
  const { state, dispatch } = usePrMasterStore();

  useEffect(() => {
    if (state.mine.length === 0 && !state.loading.mine && !state.errors.mine) {
      void loadMine(dispatch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <EnrichedListView
      title="Mine"
      rows={state.mine}
      loading={state.loading.mine}
      error={state.errors.mine}
      emptyText="No open PRs you authored."
      onRefresh={() => void loadMine(dispatch)}
    />
  );
}
