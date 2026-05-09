/**
 * Top-level Log tab — composes the tab strip + horizontal filter bar
 * + virtualized commit list + detail pane.
 *
 * Filter UI is now a JetBrains-style horizontal row at the top so the
 * commit list and the diff get the full width. The selected commit's
 * file list lives in the activity-bar side panel (Files mode), not in
 * the detail pane — that's a single tree shared between the Log and
 * Merge tabs and switches in place when you change tabs.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Maximize2, Minimize2, RotateCw } from "lucide-react";
import { Button, cn } from "@zen-tools/ui";

import { gitTauri, type Commit, type CommitLogFilter } from "../../lib/tauri";
import { Split } from "../shared/Split";
import { TabStrip } from "../shared/TabStrip";
import { useGitStore } from "../../store/git-store";
import type { GitInitialTab } from "../../GitShell";
import { CommitDetailPane, type RangeSpec } from "./CommitDetailPane";
import { CommitFilterBar } from "./CommitFilterBar";
import { CommitList } from "./CommitList";
import { computeGraphLayout } from "./graph-layout";

const PAGE_SIZE = 200;
// Bumped from `git.log.noMerges` → `git.log.noMerges.v2` when we
// flipped the default from ON to OFF. The graph column added in v2
// only makes sense with merge commits visible — hiding them turns
// every history into a straight line and defeats the point of the
// graph. Bumping the key resets every existing user to the new
// default; people who genuinely want merges hidden can re-toggle
// from the filter bar (the new pref is then persisted under v2).
const NO_MERGES_KEY = "git.log.noMerges.v2";

// Git's universal "empty tree" SHA. Used as the `from` side of a
// range diff when the oldest selected commit is a root commit (has
// no parent). Without this, `<root>^` fails with "unknown revision",
// which manifests as the multi-select range diff silently producing
// an empty file list.
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface CommitLogPaneProps {
  repo: string;
  isDark: boolean;
  activeTab: GitInitialTab;
  onTabChange: (t: GitInitialTab) => void;
  /** Mirror of merge-tab focus mode. When on, the commit list +
   *  filter bar collapse so the diff pane fills the entire surface. */
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
}

function readNoMergesPref(): boolean {
  try {
    const raw = window.localStorage.getItem(NO_MERGES_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    /* ignore */
  }
  // Default OFF — show merge commits so the graph column has
  // something to branch from. `git log --no-merges` strips every
  // multi-parent commit before the data reaches us, leaving only
  // first-parent traversals — i.e. one straight line — which makes
  // the graph useless. If the user prefers a flat first-parent view
  // they can flip this back from the filter bar.
  return false;
}

function writeNoMergesPref(on: boolean) {
  try {
    window.localStorage.setItem(NO_MERGES_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function CommitLogPane({
  repo,
  isDark,
  activeTab,
  onTabChange,
  focusMode = false,
  onToggleFocusMode,
}: CommitLogPaneProps) {
  const { state: storeState, dispatch } = useGitStore();
  const ms = storeState.mergeState;
  const mergeBadge =
    !ms || ms.kind === "none"
      ? null
      : ms.unresolved > 0
        ? `${ms.unresolved}`
        : "✓";

  const [filter, setFilter] = useState<CommitLogFilter>(() => ({
    skip: 0,
    limit: PAGE_SIZE,
    noMerges: readNoMergesPref() || undefined,
  }));

  // Persist noMerges flips so they survive reloads.
  useEffect(() => {
    writeNoMergesPref(!!filter.noMerges);
  }, [filter.noMerges]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // IntelliJ-style graph layout for the loaded commit window. Pure
  // function over `commits`; recomputed on every page extension /
  // filter change. O(n × max_lanes), trivially fast for the
  // few-hundred to few-thousand row windows the log shows.
  const graph = useMemo(() => computeGraphLayout(commits), [commits]);

  const selectedSha = storeState.logSelectedSha;
  const selectedShas = storeState.logSelectedShas;

  /** Handle clicks with modifier keys for multi-select. */
  const onCommitClick = useCallback(
    (sha: string, e: React.MouseEvent) => {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;
      if (isShift && selectedSha) {
        // Shift-click: contiguous range from primary anchor to target.
        // We compute the slice using the loaded commits as the index
        // source — both ends inclusive, regardless of click direction.
        const anchorIdx = commits.findIndex((c) => c.hash === selectedSha);
        const targetIdx = commits.findIndex((c) => c.hash === sha);
        if (anchorIdx === -1 || targetIdx === -1) {
          dispatch({ type: "set-log-selected-sha", sha });
          return;
        }
        const lo = Math.min(anchorIdx, targetIdx);
        const hi = Math.max(anchorIdx, targetIdx);
        const shas = new Set<string>();
        for (let i = lo; i <= hi; i++) shas.add(commits[i].hash);
        dispatch({
          type: "set-log-selected-range",
          shas,
          primary: sha,
        });
        return;
      }
      if (isCmdOrCtrl) {
        dispatch({ type: "toggle-log-selected-sha", sha });
        return;
      }
      dispatch({ type: "set-log-selected-sha", sha });
    },
    [commits, dispatch, selectedSha],
  );

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
        const firstSha = page[0]?.hash ?? null;
        dispatch({ type: "set-log-selected-sha", sha: firstSha });
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
  }, [repo, filter, refreshTick, dispatch]);

  const refresh = useCallback(() => {
    setRefreshTick((n) => n + 1);
  }, []);

  // Cmd-R / Ctrl-R: refresh the visible commit list.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "r" || e.key === "R")) {
        // Only when we're the visible tab — otherwise the merge tab
        // will fight us for the same chord.
        if (activeTab !== "log") return;
        e.preventDefault();
        refresh();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [refresh, activeTab]);

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

  // ── Compute range mode ──────────────────────────────────────────────
  // When the user has multiple commits selected, we collapse them into
  // a `<from>..<to>` range. Order is determined by the position in the
  // loaded `commits` array (which is newest→oldest), so the *highest*
  // index is the oldest selected commit (=> use its parent as `from`)
  // and the *lowest* index is the newest (=> use it as `to`).
  const rangeSpec: RangeSpec | null = useMemo(() => {
    if (selectedShas.size <= 1) return null;
    let oldestIdx = -1;
    let newestIdx = Infinity;
    let oldestCommit: Commit | null = null;
    let newestCommit: Commit | null = null;
    for (let i = 0; i < commits.length; i++) {
      if (!selectedShas.has(commits[i].hash)) continue;
      if (i > oldestIdx) {
        oldestIdx = i;
        oldestCommit = commits[i];
      }
      if (i < newestIdx) {
        newestIdx = i;
        newestCommit = commits[i];
      }
    }
    if (!oldestCommit || !newestCommit) return null;
    // Root commits have no `parents[0]` — fall back to the empty-tree
    // SHA so `git diff` doesn't choke on `<root>^`.
    const from = oldestCommit.parents[0] ?? EMPTY_TREE_SHA;
    return {
      from,
      to: newestCommit.hash,
      oldest: oldestCommit,
      newest: newestCommit,
      count: selectedShas.size,
    };
  }, [commits, selectedShas]);

  // Tab-strip right-side action: commit count + refresh + maximize.
  const rightActions = (
    <>
      <span className="mr-1 text-[11px] text-muted-foreground">
        {loading
          ? "Loading…"
          : selectedShas.size > 1
            ? `${selectedShas.size} of ${commits.length}${hasMore ? "+" : ""} selected`
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
      {onToggleFocusMode && (
        <Button
          size="icon"
          variant="ghost"
          onClick={onToggleFocusMode}
          title={focusMode ? "Exit focus mode" : "Focus on diff"}
          className="h-7 w-7"
        >
          {focusMode ? (
            <Minimize2 className="h-4 w-4" />
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </Button>
      )}
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
      {!focusMode && (
        <CommitFilterBar repo={repo} filter={filter} onChange={setFilter} />
      )}
      {error && (
        <div className="border-b border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-600">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Split
          direction="horizontal"
          storageKey="log.listDetail"
          defaultFirst={420}
          minFirst={240}
          minSecond={300}
          // Focus mode collapses the commit list so the diff fills the
          // entire area. The list state survives because Split keeps
          // both children mounted and just hides the first one.
          disabled={focusMode}
          collapseFirst={focusMode}
        >
          <section className="flex h-full min-h-0 min-w-0 flex-col">
            <CommitList
              commits={commits}
              graph={graph}
              selectedShas={selectedShas}
              primarySha={selectedSha}
              onSelect={onCommitClick}
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
              rangeSpec={rangeSpec}
            />
          </section>
        </Split>
      </div>
    </div>
  );
}
