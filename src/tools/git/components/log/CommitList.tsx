/**
 * Virtualized commit list (TanStack Virtual). Fetches the next page
 * when the user scrolls within `OVERSCAN_TRIGGER` rows of the bottom.
 */

import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { Commit } from "../../lib/tauri";
import { CommitRow } from "./CommitRow";

const ROW_HEIGHT = 28;
const OVERSCAN_TRIGGER = 20;

export interface CommitListProps {
  commits: Commit[];
  selectedSha: string | null;
  onSelect: (sha: string) => void;
  onLoadMore: () => void;
  loading: boolean;
  hasMore: boolean;
}

export function CommitList({
  commits,
  selectedSha,
  onSelect,
  onLoadMore,
  loading,
  hasMore,
}: CommitListProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Lazy-load next page on scroll near bottom.
  useEffect(() => {
    if (loading || !hasMore) return;
    const items = virtualizer.getVirtualItems();
    if (items.length === 0) return;
    const last = items[items.length - 1];
    if (last.index >= commits.length - OVERSCAN_TRIGGER) {
      onLoadMore();
    }
  }, [virtualizer, commits.length, loading, hasMore, onLoadMore]);

  return (
    <div ref={parentRef} className="h-full overflow-auto">
      {commits.length === 0 ? (
        <div className="px-4 py-6 text-xs text-muted-foreground">
          {loading ? "Loading commits…" : "No commits match the current filter."}
        </div>
      ) : (
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "relative",
            width: "100%",
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const commit = commits[vi.index];
            return (
              <div
                key={commit.hash}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${vi.size}px`,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <CommitRow
                  commit={commit}
                  selected={selectedSha === commit.hash}
                  onClick={() => onSelect(commit.hash)}
                />
              </div>
            );
          })}
        </div>
      )}
      {loading && commits.length > 0 && (
        <div className="px-4 py-2 text-center text-[11px] text-muted-foreground">
          Loading more…
        </div>
      )}
    </div>
  );
}
