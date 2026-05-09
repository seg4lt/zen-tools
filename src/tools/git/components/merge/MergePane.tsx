/**
 * Top-level Merge tab — combined tab + merge-state header in one row,
 * then the 3-way editor underneath.
 *
 * The conflict file rail no longer lives here; it's hosted by
 * GitShell's side panel (driven by the activity bar's "Files" mode)
 * so toggling visibility is unified across repos / files.
 *
 * Conflicts state (the list, the active path, and the
 * resolved-this-session set) lives in `git-store` so the side panel
 * and the editor see the same data without a duplicate fetch.
 *
 * Polls `git_merge_state` + `git_list_conflicts` on mount and after
 * every staging mutation so the UI stays in sync with what `git`
 * thinks the working tree looks like.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import { Button, cn } from "@zen-tools/ui";

import {
  gitTauri,
  type ConflictBlobs,
  type MergeState,
} from "../../lib/tauri";
import { useGitStore } from "../../store/git-store";
import { PreMergePreviewDialog } from "./PreMergePreviewDialog";
import { ThreeWayMergeEditor } from "./ThreeWayMergeEditor";
import { TabStrip } from "../shared/TabStrip";
import type { GitInitialTab } from "../../GitShell";

export interface MergePaneProps {
  repo: string;
  isDark: boolean;
  /** When true, the host shell is in focus mode and we should stretch
   *  to fill the entire surface (no tab bar above us). */
  focusMode?: boolean;
  /** Toggle focus mode on/off. Rendered as a button in the header. */
  onToggleFocusMode?: () => void;
  activeTab: GitInitialTab;
  onTabChange: (t: GitInitialTab) => void;
}

const KIND_LABEL: Record<MergeState["kind"], string> = {
  merge: "Merge",
  rebase: "Rebase",
  cherryPick: "Cherry-pick",
  revert: "Revert",
  none: "",
};

/**
 * Pick the seed text for the editable RESULT pane.
 *
 *   1. If the worktree file contains conflict markers (`git merge`
 *      already filled them in), use it verbatim.
 *   2. Otherwise, if the file is on disk without markers, hand it
 *      back as-is — the user may have already started resolving.
 *   3. Otherwise (no worktree file), synthesize a marker-bracketed
 *      block from the stage blobs so the editor always has
 *      something concrete to merge. This handles the AA / DU /
 *      UD edge cases where one side is missing.
 */
function pickWorkingSeed(b: {
  base: string | null;
  local: string | null;
  remote: string | null;
  working: string | null;
}): string {
  if (b.working && /^<{7}/m.test(b.working)) return b.working;
  if (b.working) return b.working;
  const local = b.local ?? "";
  const remote = b.remote ?? "";
  return `<<<<<<< HEAD\n${local}\n=======\n${remote}\n>>>>>>> incoming\n`;
}

export function MergePane({
  repo,
  isDark,
  focusMode = false,
  onToggleFocusMode,
  activeTab,
  onTabChange,
}: MergePaneProps) {
  const { state: storeState, dispatch } = useGitStore();
  const { activeConflictPath, resolvedPaths, mergeState } = storeState;
  const [blobs, setBlobs] = useState<{
    loadedFor: string;
    data: ConflictBlobs;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        gitTauri.mergeState(repo),
        gitTauri.listConflicts(repo).catch(() => []),
      ]);
      dispatch({ type: "set-merge-state", state: s });
      dispatch({ type: "set-conflicts", conflicts: c });
    } catch (e) {
      setError(String(e));
    }
  }, [repo, dispatch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Load blobs whenever the active conflict changes. Clear
  // `blobs` to null *immediately* so the editor unmounts —
  // otherwise the click-then-load gap shows stale content under a
  // new filename.
  useEffect(() => {
    setBlobs(null);
    if (!activeConflictPath) return;
    let cancelled = false;
    const target = activeConflictPath;
    void (async () => {
      try {
        const b = await gitTauri.conflictBlobs(repo, target);
        if (!cancelled) setBlobs({ loadedFor: target, data: b });
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setBlobs(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, activeConflictPath, reloadTick]);

  const refreshAll = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      await refresh();
      setReloadTick((t) => t + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }, [refresh, refreshing]);

  // Cmd-R / Ctrl-R: refresh.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        void refreshAll();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [refreshAll]);

  const onMarkResolved = async (content: string) => {
    if (!activeConflictPath) return;
    setBusy(true);
    setError(null);
    try {
      await gitTauri.writeResolved(repo, activeConflictPath, content);
      dispatch({ type: "mark-conflict-resolved", path: activeConflictPath });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleHeader = (
    fn: (repo: string) => Promise<void>,
    label: string,
  ) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn(repo);
      dispatch({ type: "clear-resolved" });
      await refresh();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`git: ${label} failed`, e);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const headerState: MergeState = useMemo(
    () =>
      mergeState ?? {
        kind: "none",
        head: null,
        incoming: null,
        unresolved: 0,
      },
    [mergeState],
  );
  const idle = headerState.kind === "none";
  const skipSupported =
    headerState.kind === "rebase" ||
    headerState.kind === "cherryPick" ||
    headerState.kind === "revert";

  const editorPane =
    !activeConflictPath ? (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {idle
          ? "Working tree is clean. Use “Preview merge…” to dry-run a merge."
          : "Select a conflicting file to start resolving."}
      </div>
    ) : !blobs || blobs.loadedFor !== activeConflictPath ? (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading {activeConflictPath}…
      </div>
    ) : blobs.data.binary ? (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Binary file — resolve externally and run{" "}
        <code className="mx-1 rounded bg-muted px-1 font-mono">
          git add {activeConflictPath}
        </code>
      </div>
    ) : (
      <ThreeWayMergeEditor
        key={blobs.loadedFor}
        isDark={isDark}
        local={blobs.data.local}
        remote={blobs.data.remote}
        base={blobs.data.base}
        working={pickWorkingSeed(blobs.data)}
        fileName={blobs.loadedFor}
        onMarkResolved={onMarkResolved}
      />
    );

  const mergeBadge = idle
    ? null
    : headerState.unresolved > 0
      ? `${headerState.unresolved}`
      : "✓";
  const tone = idle
    ? "neutral"
    : headerState.unresolved > 0
      ? "amber"
      : "emerald";

  // ── Center cell of the tab strip — describes the in-progress op. ──
  const centerContent = idle ? null : (
    <span className="truncate">
      <span className="font-medium">{KIND_LABEL[headerState.kind]}</span>{" "}
      <span className="text-muted-foreground">in progress</span>
      {headerState.incoming && (
        <>
          {" — "}
          <code className="rounded bg-muted px-1 font-mono text-[11px]">
            {headerState.incoming}
          </code>
        </>
      )}
      {headerState.head && (
        <>
          {" → "}
          <code className="rounded bg-muted px-1 font-mono text-[11px]">
            {headerState.head}
          </code>
        </>
      )}
      {resolvedPaths.size > 0 && (
        <span className="ml-2 text-[11px] text-emerald-600 dark:text-emerald-400">
          {resolvedPaths.size} resolved
        </span>
      )}
      <span className="ml-2 text-[11px] text-muted-foreground">
        · {headerState.unresolved} unresolved
      </span>
    </span>
  );

  // ── Right-side action group: preview / continue / abort + util icons.
  const rightActions = (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setPreviewOpen(true)}
        disabled={busy}
        className="h-7 px-2 text-[11px]"
      >
        Preview…
      </Button>
      {!idle && (
        <>
          <Button
            size="sm"
            onClick={handleHeader(gitTauri.continueOp, "continue")}
            disabled={busy || headerState.unresolved > 0}
            title={
              headerState.unresolved > 0
                ? `Resolve ${headerState.unresolved} file(s) first`
                : "Continue"
            }
            className="h-7 gap-1 px-2 text-[11px]"
          >
            <Play className="h-3 w-3" />
            Continue
          </Button>
          {skipSupported && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleHeader(gitTauri.skipOp, "skip")}
              disabled={busy}
              className="h-7 gap-1 px-2 text-[11px]"
            >
              <Pause className="h-3 w-3" />
              Skip
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            onClick={handleHeader(gitTauri.abortOp, "abort")}
            disabled={busy}
            className="h-7 gap-1 px-2 text-[11px]"
          >
            <RotateCcw className="h-3 w-3" />
            Abort
          </Button>
        </>
      )}
      <span className="mx-0.5 h-4 w-px bg-border/60" aria-hidden />
      <Button
        size="icon"
        variant="ghost"
        onClick={refreshAll}
        disabled={refreshing || busy}
        title={`Refresh (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}R)`}
        className="h-7 w-7"
      >
        <RotateCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
      </Button>
      {onToggleFocusMode && (
        <Button
          size="icon"
          variant="ghost"
          onClick={onToggleFocusMode}
          title={focusMode ? "Exit focus mode" : "Focus on this file"}
          className="h-7 w-7"
        >
          {focusMode ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </Button>
      )}
    </>
  );

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col">
      {/* TabStrip always renders — even in focus mode — so the
          un-maximize button (and Continue/Abort) stay reachable. */}
      <TabStrip
        activeTab={activeTab}
        onTabChange={onTabChange}
        mergeBadge={mergeBadge}
        tone={tone}
        centerContent={centerContent}
        rightActions={rightActions}
      />

      {error && (
        <div className="border-b border-rose-500/30 bg-rose-500/10 px-3 py-1 text-[11px] text-rose-600">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1">{editorPane}</div>

      <PreMergePreviewDialog
        repo={repo}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
      />
    </div>
  );
}
