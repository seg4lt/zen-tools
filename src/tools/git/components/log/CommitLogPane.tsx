/**
 * Top-level Log tab — composes filter panel + virtualized list +
 * detail pane. Loads pages of commits as the user scrolls.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCw } from "lucide-react";
import { Button, cn } from "@zen-tools/ui";

import { gitTauri, type Commit, type CommitLogFilter } from "../../lib/tauri";
import { Split } from "../shared/Split";
import { TabStrip } from "../shared/TabStrip";
import { useGitStore } from "../../store/git-store";
import type { GitInitialTab } from "../../GitShell";
import { CommitDetailPane } from "./CommitDetailPane";
import { CommitFilterPanel } from "./CommitFilterPanel";
import { CommitList } from "./CommitList";

const PAGE_SIZE = 200;

export interface CommitLogPaneProps {
  repo: string;
  isDark: boolean;
  activeTab: GitInitialTab;
  onTabChange: (t: GitInitialTab) => void;
}

const EMPTY_FILTER: CommitLogFilter = {
  skip: 0,
  limit: PAGE_SIZE,
};

export function CommitLogPane({
  repo,
  isDark,
  activeTab,
  onTabChange,
}: CommitLogPaneProps) {
  const { state: storeState } = useGitStore();
  const ms = storeState.mergeState;
  const mergeBadge =
    !ms || ms.kind === "none"
      ? null
      : ms.unresolved > 0
        ? `${ms.unresolved}`
        : "✓";
  const [filter, setFilter] = useState<CommitLogFilter>(EMPTY_FILTER);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  // Bumped by the manual refresh button to force the page-0 effect
  // to re-fire even when `filter` and `repo` are unchanged.
  const [refreshTick, setRefreshTick] = useState(0);

  // Reload from page 0 whenever the filter or repo changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const page = await gitTauri.listCommits(repo, {
          ...filter,
          skip: 0,
          limit: PAGE_SIZE,
        });
        if (cancelled) return;
        setCommits(page);
        setHasMore(page.length >= PAGE_SIZE);
        setSelectedSha(page[0]?.hash ?? null);
      } catch (e) {
        if (cancelled) return;
        setError(String(e));
        setCommits([]);
        setHasMore(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, filter, refreshTick]);

  const refresh = useCallback(() => {
    setRefreshTick((n) => n + 1);
  }, []);

  // Cmd-R / Ctrl-R: refresh the visible commit list.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        refresh();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const page = await gitTauri.listCommits(repo, {
        ...filter,
        skip: commits.length,
        limit: PAGE_SIZE,
      });
      // Dedupe in case of overlap.
      const seen = new Set(commits.map((c) => c.hash));
      const fresh = page.filter((c) => !seen.has(c.hash));
      setCommits((prev) => [...prev, ...fresh]);
      setHasMore(page.length >= PAGE_SIZE);
    } catch (e) {
      setError(String(e));
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [repo, filter, commits, loading, hasMore]);

  const selectedCommit = useMemo(
    () => commits.find((c) => c.hash === selectedSha) ?? null,
    [commits, selectedSha],
  );

  // Tab-strip right-side action: just refresh for the Log tab.
  const rightActions = (
    <>
      <span className="mr-1 text-[11px] text-muted-foreground">
        {loading
          ? "Loading…"
          : `${commits.length}${hasMore ? "+" : ""} commit${
              commits.length === 1 ? "" : "s"
            }`}
      </span>
      <Button
        size="icon"
        variant="ghost"
        onClick={refresh}
        disabled={loading}
        title={`Refresh (${
          navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"
        }R)`}
        className="h-7 w-7"
      >
        <RotateCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
      </Button>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TabStrip
        activeTab={activeTab}
        onTabChange={onTabChange}
        mergeBadge={mergeBadge}
        rightActions={rightActions}
      />
      {error && (
        <div className="border-b border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-600">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Split
          direction="horizontal"
          storageKey="log.filterList"
          defaultFirst={220}
          minFirst={140}
          maxFirst={400}
          minSecond={400}
        >
          <aside className="h-full overflow-y-auto">
            <CommitFilterPanel
              repo={repo}
              filter={filter}
              onChange={setFilter}
            />
          </aside>
          <Split
            direction="horizontal"
            storageKey="log.listDetail"
            defaultFirst={420}
            minFirst={240}
            minSecond={300}
          >
            <section className="flex h-full min-h-0 min-w-0 flex-col">
              <CommitList
                commits={commits}
                selectedSha={selectedSha}
                onSelect={setSelectedSha}
                onLoadMore={loadMore}
                loading={loading}
                hasMore={hasMore}
              />
            </section>
            <section className="h-full min-h-0 min-w-0">
              <CommitDetailPane
                repo={repo}
                commit={selectedCommit}
                isDark={isDark}
              />
            </section>
          </Split>
        </Split>
      </div>
    </div>
  );
}
