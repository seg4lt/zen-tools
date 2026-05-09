/**
 * Top-level Merge tab. Composes header + conflict file rail + 3-way
 * editor. Polls `git_merge_state` + `git_list_conflicts` on mount and
 * after every staging mutation so the UI stays in sync with what
 * `git` thinks the working tree looks like.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Maximize2, Minimize2, RotateCw } from "lucide-react";
import { Button, cn } from "@zen-tools/ui";

import {
  gitTauri,
  type ConflictBlobs,
  type ConflictFile,
  type MergeState,
} from "../../lib/tauri";
import { useGitStore } from "../../store/git-store";
import { ConflictFileList } from "./ConflictFileList";
import { MergeHeader } from "./MergeHeader";
import { PreMergePreviewDialog } from "./PreMergePreviewDialog";
import { ThreeWayMergeEditor } from "./ThreeWayMergeEditor";
import { Split } from "../shared/Split";

export interface MergePaneProps {
  repo: string;
  isDark: boolean;
  /** When true, the host shell is in focus mode and we should stretch
   *  to fill the entire surface (no tab bar above us). */
  focusMode?: boolean;
  /** Toggle focus mode on/off. Rendered as a button in the header. */
  onToggleFocusMode?: () => void;
}

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
  // For AA (both added), surfaces the disagreement immediately.
  return `<<<<<<< HEAD\n${local}\n=======\n${remote}\n>>>>>>> incoming\n`;
}

export function MergePane({
  repo,
  isDark,
  focusMode = false,
  onToggleFocusMode,
}: MergePaneProps) {
  const { dispatch } = useGitStore();
  const [state, setState] = useState<MergeState | null>(null);
  const [conflicts, setConflicts] = useState<ConflictFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  /**
   * Loaded blobs + the path they belong to. We track `loadedFor`
   * separately so a click-during-load doesn't paint stale content
   * under a new filename. The 3-way editor only mounts when
   * `loadedFor === activePath`.
   */
  const [blobs, setBlobs] = useState<{
    loadedFor: string;
    data: ConflictBlobs;
  } | null>(null);
  const [resolved, setResolved] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Bumped by the manual refresh button to force the blob-loading
  // effect to re-run even when `activePath` and `repo` are unchanged.
  const [reloadTick, setReloadTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        gitTauri.mergeState(repo),
        gitTauri.listConflicts(repo).catch(() => []),
      ]);
      setState(s);
      dispatch({ type: "set-merge-state", state: s });
      setConflicts(c);
      // Drop active selection if the path is no longer in conflict.
      setActivePath((prev) => {
        if (prev && c.some((f) => f.path === prev)) return prev;
        return c[0]?.path ?? null;
      });
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
  // new filename. `reloadTick` is included so the manual refresh
  // button can force a re-fetch of the same file's blobs.
  useEffect(() => {
    setBlobs(null);
    if (!activePath) return;
    let cancelled = false;
    const target = activePath;
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
  }, [repo, activePath, reloadTick]);

  /**
   * Manual refresh: re-fetch merge state, conflicts, and the active
   * file's blobs. Discards in-memory resolutions for the active
   * file (the user is asking to see what's on disk *now*; if they
   * had unsaved accept-LOCAL/REMOTE choices, those are reset).
   */
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
    if (!activePath) return;
    setBusy(true);
    setError(null);
    try {
      await gitTauri.writeResolved(repo, activePath, content);
      setResolved((prev) => {
        const next = new Set(prev);
        next.add(activePath);
        return next;
      });
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
      setResolved(new Set());
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
      state ?? {
        kind: "none",
        head: null,
        incoming: null,
        unresolved: 0,
      },
    [state],
  );

  const editorPane =
    !activePath ? (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {headerState.kind === "none"
          ? "Working tree is clean. Use “Preview merge…” to dry-run a merge."
          : "Select a conflicting file to start resolving."}
      </div>
    ) : !blobs || blobs.loadedFor !== activePath ? (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading {activePath}…
      </div>
    ) : blobs.data.binary ? (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Binary file — resolve externally and run{" "}
        <code className="mx-1 rounded bg-muted px-1 font-mono">
          git add {activePath}
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

  const fileRail = (
    <ConflictFileList
      conflicts={conflicts}
      activePath={activePath}
      onSelect={setActivePath}
      resolvedPaths={resolved}
    />
  );

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-stretch border-b">
        <div className="flex-1 min-w-0">
          <MergeHeader
            state={headerState}
            busy={busy}
            onContinue={handleHeader(gitTauri.continueOp, "continue")}
            onAbort={handleHeader(gitTauri.abortOp, "abort")}
            onSkip={handleHeader(gitTauri.skipOp, "skip")}
            onPreview={() => setPreviewOpen(true)}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1 self-center pr-2">
          <Button
            size="icon"
            variant="ghost"
            onClick={refreshAll}
            disabled={refreshing || busy}
            title={`Refresh from git (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}R)`}
          >
            <RotateCw
              className={cn("h-4 w-4", refreshing && "animate-spin")}
            />
          </Button>
          {onToggleFocusMode && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onToggleFocusMode}
              title={focusMode ? "Exit focus mode" : "Focus on this file"}
            >
              {focusMode ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="border-b border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-600">
          {error}
        </div>
      )}

      {focusMode ? (
        <div className="min-h-0 flex-1">{editorPane}</div>
      ) : (
        <div className="min-h-0 flex-1">
          <Split
            direction="horizontal"
            storageKey="merge.fileList"
            defaultFirst={240}
            minFirst={160}
            maxFirst={500}
            minSecond={400}
          >
            <aside className="h-full">{fileRail}</aside>
            <section className="h-full min-h-0 min-w-0">{editorPane}</section>
          </Split>
        </div>
      )}

      <PreMergePreviewDialog
        repo={repo}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
      />
    </div>
  );
}
