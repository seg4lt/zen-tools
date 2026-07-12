/**
 * To Review tab — open PRs requesting your review (where you haven't yet
 * approved or requested changes; comment-only reviews keep them here,
 * matching PRMaster's classification).
 */

import { useEffect, useMemo, useState } from "react";
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
} from "../shared/PrFilterBar";
import { prmasterTauri, type NotificationFilter } from "../../lib/tauri";

export function ToReviewTab() {
  const { state, dispatch } = usePrMasterStore();
  const [filter, setFilter] = useState<PrFilterState>(emptyFilterState);
  const [savedFilters, setSavedFilters] = useState<NotificationFilter[]>([]);
  const [watchedRows, setWatchedRows] = useState<typeof state.toReview>([]);
  const [watchLoading, setWatchLoading] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);

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

  async function loadWatchedAuthors() {
    setWatchError(null);
    try {
      const settings = await prmasterTauri.getSettings();
      const authors = settings.watched_authors ?? [];
      if (authors.length === 0) {
        setWatchedRows([]);
        return;
      }
      setWatchLoading(true);
      const results = await Promise.all(
        authors.map((author) => prmasterTauri.getOpenPrsByAuthor(author)),
      );
      setWatchedRows(results.flat());
    } catch (err) {
      setWatchError(err instanceof Error ? err.message : String(err));
    } finally {
      setWatchLoading(false);
    }
  }

  useEffect(() => {
    void loadWatchedAuthors();
    // Settings can be changed in the full window while this tab remains
    // mounted. Re-read the saved watchlist when the app regains focus.
    const onFocus = () => void loadWatchedAuthors();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
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

  const queueRows = useMemo(() => {
    // Active review requests take precedence; watched-author PRs append only
    // when they are not already in that queue. This is the merge point that
    // prevents a watched teammate's PR from appearing twice.
    const seen = new Set(state.toReview.map(enrichedId));
    return [
      ...state.toReview,
      ...watchedRows.filter((row) => {
        const id = enrichedId(row);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      }),
    ];
  }, [state.toReview, watchedRows]);

  const filteredRows = useMemo(
    () => applyPrFilters(queueRows, filter, savedFilters),
    [queueRows, filter, savedFilters],
  );

  return (
    <EnrichedListView
      title="Review Queue"
      variant="to-review"
      rows={filteredRows}
      loading={watchLoading || state.loading.toReview}
      error={watchError ?? state.errors.toReview}
      emptyText="No PRs are awaiting your review or being watched."
      onRefresh={() => {
        void loadToReview(dispatch);
        void loadWatchedAuthors();
      }}
      filterBar={
        <PrFilterBar
          rows={queueRows}
          state={filter}
          onChange={setFilter}
        />
      }
    />
  );
}
