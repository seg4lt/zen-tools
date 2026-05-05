/**
 * Two-pane Files Changed view: tree on the left, diff on the right.
 *
 * Loads the diff via `prmaster_get_pr_diff` (local-git first, gh REST
 * fallback) on mount. Selected file's `patch` feeds the `<DiffViewer>`,
 * which renders a CodeMirror 6 merge view (unified or split, controlled
 * by `viewMode`) with inline-comment widgets. New comments post via
 * `prmaster_add_review_comment` and appear immediately in the local
 * list (full sync happens on the next background refresh).
 *
 * Used exclusively from the dedicated `/prmaster/review/...` page —
 * the surrounding page owns its own header, so this component is a
 * "fill the container" subview with its own toolbar but no extra
 * window-chrome of its own.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
} from "lucide-react";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { Button } from "@zen-tools/ui";
import { DiffViewer, type DiffViewMode, type InlineComment } from "@zen-tools/editor";
import { useTheme } from "@/hooks/use-theme";
import {
  prmasterTauri,
  prRefFor,
  type DiffSide,
  type EnrichedPullRequest,
  type FileDiff,
  type PrDiff,
} from "../../lib/tauri";
import {
  prDiffQueryOptions,
  prReviewCommentsQueryOptions,
} from "../../lib/queries";
import { usePrMasterStore } from "../../store/prmaster-store";
import { PrFileTree } from "./PrFileTree";

interface Props {
  pr: EnrichedPullRequest;
  /** Diff view mode — owned by the parent (review page) so the toggle
   *  can persist user choice. */
  viewMode: DiffViewMode;
}

interface LocalComment extends InlineComment {
  /** Path the comment lives on (so we can filter per-file). */
  filePath: string;
}

export function PrFilesChangedView({ pr, viewMode }: Props) {
  const ref = prRefFor(pr.pr);
  const baseRef = pr.detail?.baseRefName ?? null;
  const headRef = pr.detail?.headRefName ?? null;

  const { theme } = useTheme();
  const isDark = theme === "dark";

  // Current user login (resolved on app boot via `prmaster_whoami`).
  // Used to stamp optimistic inline comments + replies with the
  // right author so the UI doesn't render "Unknown" while the
  // server-canonical version is still in flight.
  const { state } = usePrMasterStore();
  const currentUser = state.currentUser;

  // Diff + inline review comments are loaded via React Query so the
  // hover prefetch on `PrDetailPanel`'s "Review Pull Request" button
  // primes the same cache the page reads from. `staleTime: 0` (set in
  // the shared queryOptions) guarantees a fresh fetch on every mount
  // — the cached data paints instantly while the refetch runs in the
  // background.
  const diffQuery = useQuery<PrDiff>(prDiffQueryOptions(ref, baseRef, headRef));
  const commentsQuery = useQuery(prReviewCommentsQueryOptions(ref));
  const diff = diffQuery.data ?? null;
  const reviewComments = commentsQuery.data ?? [];

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [comments, setComments] = useState<LocalComment[]>([]);
  // UI: tree visibility.
  const [treeOpen, setTreeOpen] = useState(true);
  // Resizable file-tree width. Persisted in localStorage so the
  // user's preferred split survives navigation. Clamped on read so a
  // bad stored value (or a screen that shrank since last session)
  // can't lock the diff out of view.
  const [treeWidth, setTreeWidth] = useState<number>(() => {
    try {
      const stored = Number.parseInt(
        localStorage.getItem("prmaster.reviewTreeWidth") ?? "",
        10,
      );
      if (Number.isFinite(stored)) {
        return Math.min(640, Math.max(140, stored));
      }
    } catch {
      // private browsing / quota — fall through to default.
    }
    return 240;
  });
  useEffect(() => {
    try {
      localStorage.setItem("prmaster.reviewTreeWidth", String(treeWidth));
    } catch {
      // non-fatal
    }
  }, [treeWidth]);
  // Live drag state for the splitter. Set on mousedown; cleared on
  // mouseup. While true the document gets a `col-resize` cursor so
  // the user keeps the resize affordance even when the pointer
  // strays off the 4px handle.
  const [dragging, setDragging] = useState(false);
  // Anchor for the body-cell layout so we can convert pointer X to
  // a tree-width (subtracting the cell's left edge from the pointer
  // position).
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const rect = bodyRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Clamp: a hard floor of 140px keeps the file tree readable;
      // a ceiling of 70% of the row stops the user from accidentally
      // pushing the diff editor off-screen.
      const proposed = e.clientX - rect.left;
      const max = Math.max(200, rect.width * 0.7);
      const clamped = Math.min(max, Math.max(140, proposed));
      setTreeWidth(clamped);
    }
    function onUp() {
      setDragging(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // While dragging, force the resize cursor and disable text
    // selection on the whole document. Otherwise the user's drag
    // would highlight whatever code is under the pointer.
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging]);
  // Hide-comments toggle. When false, the diff editor receives an
  // empty comments array (and `onAddComment` undefined to also hide
  // the gutter "+") so the reviewer can read the code without any
  // overlay. Persisted in localStorage so the choice survives
  // navigating between PRs.
  const [showComments, setShowComments] = useState<boolean>(() => {
    try {
      return localStorage.getItem("prmaster.reviewShowComments") !== "false";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "prmaster.reviewShowComments",
        String(showComments),
      );
    } catch {
      // private browsing / quota — non-fatal.
    }
  }, [showComments]);
  // Auto-pick the first non-binary file when the diff resolves. We
  // run this in an effect so it re-fires when the diff payload
  // changes (e.g., after a refetch reveals a new file added in a
  // recent push). Preserves the user's selection across refreshes
  // when the path still exists.
  useEffect(() => {
    if (!diff) return;
    setSelectedPath((cur) => {
      if (cur && diff.files.some((f) => f.path === cur)) return cur;
      const first = diff.files.find((f) => !f.binary && f.patch);
      return first?.path ?? diff.files[0]?.path ?? null;
    });
  }, [diff]);

  // Refresh button — fire both refetches in parallel. Each query's
  // own `isFetching` powers the toolbar status; we don't need a
  // separate "refreshing" state any more.
  const handleRefresh = useCallback(() => {
    void diffQuery.refetch();
    void commentsQuery.refetch();
  }, [diffQuery, commentsQuery]);

  // Toolbar comment-status chip is derived from the comments query
  // state. Nothing to wire up — `useQuery` exposes everything.
  const commentsStatus = useMemo<
    | { kind: "loading" }
    | { kind: "ok"; count: number }
    | { kind: "error"; message: string }
  >(() => {
    if (commentsQuery.isError) {
      return { kind: "error", message: formatError(commentsQuery.error) };
    }
    if (commentsQuery.isPending) {
      return { kind: "loading" };
    }
    return { kind: "ok", count: reviewComments.length };
  }, [
    commentsQuery.isError,
    commentsQuery.isPending,
    commentsQuery.error,
    reviewComments.length,
  ]);
  // Refreshing indicator — true while EITHER query has a fetch in
  // flight. Drives the spinner on the Refresh toolbar button.
  const refreshing = diffQuery.isFetching || commentsQuery.isFetching;
  const loading = diffQuery.isPending;
  const error = diffQuery.isError ? formatError(diffQuery.error) : null;

  const selected = useMemo<FileDiff | null>(() => {
    if (!diff || !selectedPath) return null;
    return diff.files.find((f) => f.path === selectedPath) ?? null;
  }, [diff, selectedPath]);

  // Seed comments derived from the REST review-comments fetch. Pierre
  // groups multiple comments at the same `(side, line)` cell so a
  // thread with replies stacks naturally under the line. We carry
  // `createdAt` and `inReplyToId` through so the renderer can
  // (a) show a relative timestamp next to each author and (b) know
  // which entry is the thread root for the reply target.
  const seedComments = useMemo<LocalComment[]>(
    () =>
      reviewComments.map((c) => ({
        id: c.id,
        line: c.line,
        side: c.side,
        authorLogin: c.authorLogin ?? null,
        body: c.body,
        filePath: c.path,
        createdAt: c.createdAt,
        inReplyToId: c.inReplyToId,
        threadId: c.threadId,
      })),
    [reviewComments],
  );

  // Server-canonical seed ∪ optimistic local inserts, deduped by id.
  // The local set wins so a freshly-posted comment keeps its
  // optimistic id until the next refresh folds in the server version.
  const allComments = useMemo<LocalComment[]>(() => {
    const seen = new Set<string>();
    const merged: LocalComment[] = [];
    for (const c of [...comments, ...seedComments]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      merged.push(c);
    }
    return merged;
  }, [comments, seedComments]);

  const commentsForSelected = useMemo<InlineComment[]>(() => {
    if (!selected) return [];
    return allComments.filter((c) => c.filePath === selected.path);
  }, [allComments, selected]);

  const commentsByPath = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of allComments) {
      m.set(c.filePath, (m.get(c.filePath) ?? 0) + 1);
    }
    return m;
  }, [allComments]);

  const handleAddComment = useCallback(
    async ({
      line,
      side,
      body,
    }: {
      line: number;
      side: DiffSide;
      body: string;
    }) => {
      if (!selected || !diff?.headSha) {
        throw new Error("No file selected or head SHA missing.");
      }
      const path = selected.path;
      // Optimistic insert so the user sees their comment immediately.
      // Stamp with the current user's login (resolved on app boot)
      // so the avatar + author chip render correctly until the
      // server-canonical version overwrites it on the next refresh.
      const optimisticId = `local-${Date.now()}`;
      setComments((prev) => [
        ...prev,
        {
          id: optimisticId,
          line,
          side,
          authorLogin: currentUser,
          body,
          filePath: path,
          createdAt: new Date().toISOString(),
        },
      ]);
      try {
        await prmasterTauri.addReviewComment({
          pr: ref,
          body,
          commitSha: diff.headSha,
          path,
          line,
          side,
        });
      } catch (err) {
        // Roll back on failure.
        setComments((prev) => prev.filter((c) => c.id !== optimisticId));
        throw err;
      }
    },
    [selected, diff, ref, currentUser],
  );

  // Post a reply to an existing inline thread. We resolve the
  // `parent.line` / `parent.side` / `parent.filePath` from the
  // current `allComments` set so the optimistic insert lands at the
  // same line as its parent (Pierre groups by `(side, line)` so the
  // reply stacks under the thread root automatically).
  //
  // GitHub's `replies` endpoint inherits path/line/side/commit from
  // the parent on the server side, so we don't need to pass them
  // there — only the parent id and the body.
  const handleReply = useCallback(
    async ({ parentId, body }: { parentId: string; body: string }) => {
      const parent = allComments.find((c) => c.id === parentId);
      if (!parent) {
        throw new Error(`Reply target ${parentId} not found in current set`);
      }
      const optimisticId = `local-reply-${Date.now()}`;
      setComments((prev) => [
        ...prev,
        {
          id: optimisticId,
          line: parent.line,
          side: parent.side,
          authorLogin: currentUser,
          body,
          filePath: parent.filePath,
          inReplyToId: parentId,
          createdAt: new Date().toISOString(),
        },
      ]);
      try {
        await prmasterTauri.replyReviewComment({
          pr: ref,
          parentId,
          body,
        });
      } catch (err) {
        setComments((prev) => prev.filter((c) => c.id !== optimisticId));
        throw err;
      }
    },
    [allComments, ref, currentUser],
  );

  // Resolve a single thread by its GraphQL node id. We don't
  // optimistically remove the thread from the local list — the
  // refresh tick after the mutation will fold the new server state
  // in (resolved → filtered out by the engine), and rolling back a
  // failed remove is more error-prone than just waiting one beat.
  const handleResolve = useCallback(
    async ({ threadId }: { threadId: string }) => {
      try {
        await prmasterTauri.resolveReviewThread(threadId);
      } finally {
        // Refetch comments to reflect the new server state — the
        // resolved thread will be filtered out by the engine, so
        // the inline annotation disappears on the next paint.
        void commentsQuery.refetch();
      }
    },
    [commentsQuery],
  );

  // Resolve every unresolved thread on the PR. Sequential rather
  // than `Promise.all` because GitHub rate-limits GraphQL mutations
  // and we'd rather take a few extra seconds than burn the budget.
  // After all calls finish we kick a single refresh.
  //
  // The set of "thread ids to resolve" is derived from
  // `reviewComments` rather than `allComments` so we only target
  // server-canonical threads (optimistic local entries don't have a
  // `threadId` yet).
  const [resolvingAll, setResolvingAll] = useState(false);
  const [resolveAllError, setResolveAllError] = useState<string | null>(null);
  const handleResolveAll = useCallback(async () => {
    if (resolvingAll) return;
    const ids = Array.from(
      new Set(reviewComments.map((c) => c.threadId).filter(Boolean)),
    );
    if (ids.length === 0) return;
    setResolvingAll(true);
    setResolveAllError(null);
    let firstError: string | null = null;
    for (const id of ids) {
      try {
        await prmasterTauri.resolveReviewThread(id);
      } catch (err) {
        if (!firstError) firstError = formatError(err);
        // Continue: one failure shouldn't block the rest. The user
        // sees the first error in the toolbar; subsequent failures
        // are logged.
        console.warn(`[prmaster] resolveReviewThread ${id} failed:`, err);
      }
    }
    setResolvingAll(false);
    setResolveAllError(firstError);
    void commentsQuery.refetch();
  }, [reviewComments, resolvingAll, commentsQuery]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Loading diff…
      </div>
    );
  }
  if (error) {
    return (
      <pre className="whitespace-pre-wrap p-2 text-xs text-destructive">
        {error}
      </pre>
    );
  }
  if (!diff || diff.files.length === 0) {
    return (
      <div className="p-3 text-xs italic text-muted-foreground">
        No files changed.
      </div>
    );
  }

  const totals = diff.files.reduce(
    (acc, f) => {
      acc.add += f.additions;
      acc.del += f.deletions;
      return acc;
    },
    { add: 0, del: 0 },
  );

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_1fr] gap-1.5">
      {/* Toolbar — counts + actions. The thin underline replaces the
          old card lid so the diff editor underneath is the only
          surface that owns its own border + background. */}
      <div className="flex items-center justify-between gap-2 px-1 pb-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-2">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setTreeOpen((v) => !v)}
            title={treeOpen ? "Hide file tree" : "Show file tree"}
            className="h-5 w-5 p-0"
          >
            {treeOpen ? (
              <PanelLeftClose className="size-3" />
            ) : (
              <PanelLeftOpen className="size-3" />
            )}
          </Button>
          <span>
            {diff.files.length} file{diff.files.length === 1 ? "" : "s"}
          </span>
          <span className="text-emerald-600 dark:text-emerald-400">
            +{totals.add}
          </span>
          <span className="text-destructive">−{totals.del}</span>
          <SourceBadge source={diff.source} />
          <CommentsStatus status={commentsStatus} />
        </span>
        <span className="flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setShowComments((v) => !v)}
            title={
              showComments
                ? "Hide review comments — read the code without overlay"
                : "Show review comments back on the diff"
            }
            className="h-5 gap-1 px-1.5"
          >
            {showComments ? (
              <Eye className="size-3" />
            ) : (
              <EyeOff className="size-3" />
            )}
            {showComments ? "Hide comments" : "Show comments"}
          </Button>
          {reviewComments.length > 0 && (
            <Button
              size="xs"
              variant="ghost"
              onClick={handleResolveAll}
              disabled={resolvingAll}
              title={
                resolveAllError
                  ? `Last attempt failed: ${resolveAllError}`
                  : `Resolve every unresolved conversation (${
                      new Set(reviewComments.map((c) => c.threadId)).size
                    } thread${
                      new Set(reviewComments.map((c) => c.threadId)).size === 1
                        ? ""
                        : "s"
                    }) on this PR`
              }
              className="h-5 gap-1 px-1.5"
            >
              {resolvingAll ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
              {resolvingAll ? "Resolving all…" : "Resolve all"}
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            onClick={handleRefresh}
            disabled={refreshing}
            title={
              diff.source === "local_git"
                ? "Re-run `git fetch` + diff against origin"
                : "Re-fetch from GitHub REST API"
            }
          >
            <RefreshCw
              className={refreshing ? "size-3 animate-spin" : "size-3"}
            />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void openUrl(`${pr.pr.url}/files`)}
            title="Open this PR's Files Changed page on GitHub"
          >
            <ExternalLink className="size-3" />
            GitHub
          </Button>
        </span>
      </div>
      <div
        ref={bodyRef}
        className="flex min-h-0 min-w-0"
      >
        {treeOpen && (
          <>
            <div
              className="min-h-0 shrink-0 overflow-hidden"
              style={{ width: treeWidth }}
            >
              <PrFileTree
                files={diff.files}
                selectedPath={selectedPath}
                onSelect={setSelectedPath}
                commentsByPath={commentsByPath}
              />
            </div>
            {/* Drag handle. 1px visible line; 9px hit area via the
                outer div's width + transparent surround so the user
                gets a forgiving pointer target. Cursor switches to
                `col-resize` on hover. Double-click resets to the
                240px default — matches GitHub's split-resize
                affordance. */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize file tree"
              onMouseDown={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDoubleClick={() => setTreeWidth(240)}
              className="group relative flex w-2 shrink-0 cursor-col-resize select-none items-stretch"
              title="Drag to resize · double-click to reset"
            >
              <div
                className={`mx-auto w-px bg-border/60 transition-colors group-hover:bg-border ${
                  dragging ? "bg-primary" : ""
                }`}
              />
            </div>
          </>
        )}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {selected ? (
            selected.binary ? (
              <div className="p-3 text-xs italic text-muted-foreground">
                Binary file — no diff to show.
              </div>
            ) : !selected.patch ? (
              <div className="p-3 text-xs italic text-muted-foreground">
                No patch available (likely too large or unchanged).
              </div>
            ) : (
              <DiffViewer
                patch={selected.patch}
                fileName={selected.path}
                oldContent={selected.oldContent}
                newContent={selected.newContent}
                isDark={isDark}
                viewMode={viewMode}
                comments={showComments ? commentsForSelected : []}
                onAddComment={
                  showComments && diff.headSha ? handleAddComment : undefined
                }
                onReply={showComments ? handleReply : undefined}
                onResolve={showComments ? handleResolve : undefined}
              />
            )
          ) : (
            <div className="p-3 text-xs italic text-muted-foreground">
              Select a file to view its diff.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Toolbar status indicator for the review-comment fetch. Three states:
 *
 *   - **loading** — small spinner, "Loading comments…". The fetch
 *     is still in flight (or just kicked off after a refresh).
 *   - **ok / N>0** — message-square icon + "N comments". Tells the
 *     user the REST endpoint returned something so a missing
 *     annotation in the diff is rendering, not fetching.
 *   - **ok / N=0** — muted "No inline comments". Distinguishes
 *     "fetched, none on this PR" from "still loading".
 *   - **error** — destructive-tinted alert + truncated message.
 *     Reveals "Command not found" (stale dev binary), "401" (gh
 *     auth), etc., right in the UI without making the user open
 *     devtools.
 */
function CommentsStatus({
  status,
}: {
  status:
    | { kind: "loading" }
    | { kind: "ok"; count: number }
    | { kind: "error"; message: string };
}) {
  if (status.kind === "loading") {
    return (
      <span
        className="inline-flex items-center gap-1 text-muted-foreground"
        title="Fetching inline review comments via gh CLI"
      >
        <Loader2 className="size-3 animate-spin" />
        Loading comments…
      </span>
    );
  }
  if (status.kind === "error") {
    const trimmed =
      status.message.length > 80
        ? `${status.message.slice(0, 77)}…`
        : status.message;
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-destructive/40 bg-destructive/10 px-1.5 py-px text-destructive"
        title={status.message}
      >
        <AlertTriangle className="size-3" />
        Comments failed: {trimmed}
      </span>
    );
  }
  if (status.count === 0) {
    return (
      <span
        className="inline-flex items-center gap-1 text-muted-foreground/70"
        title="GitHub returned no inline review comments for this PR"
      >
        <MessageSquare className="size-3" />
        No inline comments
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-muted-foreground"
      title={`${status.count} inline review comment${
        status.count === 1 ? "" : "s"
      } loaded from GitHub`}
    >
      <MessageSquare className="size-3" />
      {status.count} comment{status.count === 1 ? "" : "s"}
    </span>
  );
}

function SourceBadge({ source }: { source: PrDiff["source"] }) {
  const label = source === "local_git" ? "local" : "github";
  return (
    <span
      className="rounded border px-1 py-px text-[9px] uppercase tracking-wide"
      title={
        source === "local_git"
          ? "Diff loaded from your local clone (origin fetched)"
          : "Diff loaded from the GitHub REST API"
      }
    >
      {label}
    </span>
  );
}

function formatError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
