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
import {
  AlertTriangle,
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
  type ReviewComment,
} from "../../lib/tauri";
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

  const [diff, setDiff] = useState<PrDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [comments, setComments] = useState<LocalComment[]>([]);
  // Server-canonical inline review comments fetched from the REST
  // endpoint. Re-loaded every time the PR or refresh tick changes.
  // Merged with the optimistic local set (deduped by id) before being
  // handed to the diff viewer.
  const [reviewComments, setReviewComments] = useState<ReviewComment[]>([]);
  // Visible status of the most recent comment-fetch attempt. Drives
  // the "Comments: …" indicator in the toolbar so the user can see
  // at a glance whether comments loaded, are still loading, or
  // failed — without having to crack open devtools.
  const [commentsStatus, setCommentsStatus] = useState<
    | { kind: "loading" }
    | { kind: "ok"; count: number }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  // Mirror of `selectedPath` so the diff-load effect can read the
  // latest user selection inside its async `.then()` without re-keying
  // on every click (which would re-fire the diff fetch).
  const selectedPathRef = useRef(selectedPath);
  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);
  // UI: tree visibility.
  const [treeOpen, setTreeOpen] = useState(true);
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
  // Bumped by the refresh button to force the load effect to re-run.
  // The local-git path will re-`git fetch` origin and the REST path
  // re-hits the API, so refresh always gets the freshest state.
  const [refreshTick, setRefreshTick] = useState(0);
  // Lit only while the user explicitly clicked Refresh — toggles the
  // button's spinner so they get clear feedback distinct from the
  // initial mount-load state.
  const [refreshing, setRefreshing] = useState(false);

  // Load diff on mount / when the PR changes / when the user clicks
  // refresh. The local-git fetch inside the engine is the
  // authoritative way to pull new commits the user pushed since
  // opening the panel.
  useEffect(() => {
    let cancelled = false;
    // First load shows the full-pane skeleton; subsequent refreshes
    // just spin the toolbar button so the diff stays on screen.
    if (refreshTick === 0) setLoading(true);
    setError(null);
    prmasterTauri
      .getPrDiff(ref, baseRef, headRef)
      .then((d) => {
        if (cancelled) return;
        setDiff(d);
        // Preserve the user's selected file across refreshes when
        // the path still exists; otherwise auto-pick the first
        // non-binary file (mirror initial-load behaviour). The
        // selection lives in the parent so we read it via a ref
        // to avoid re-keying this effect on every click.
        const cur = selectedPathRef.current;
        if (cur && d.files.some((f) => f.path === cur)) {
          return;
        }
        const first = d.files.find((f) => !f.binary && f.patch);
        setSelectedPath(first?.path ?? d.files[0]?.path ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(formatError(err));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ref.owner, ref.repo, ref.number, baseRef, headRef, refreshTick]);

  // Load inline review comments for this PR via the REST endpoint.
  // Re-runs on the same triggers as the diff load so the two stay in
  // sync (refresh ticks both). The status is mirrored into a piece
  // of state so the toolbar can render a visible indicator (count /
  // loading / error) — devtools console isn't always reachable for
  // the user, especially on a shipped build.
  useEffect(() => {
    let cancelled = false;
    setCommentsStatus({ kind: "loading" });
    prmasterTauri
      .listReviewComments(ref)
      .then((cs) => {
        if (cancelled) return;
        console.info(
          `[prmaster] listReviewComments ${ref.owner}/${ref.repo}#${ref.number}:`,
          cs.length,
          "inline comments",
          cs,
        );
        setReviewComments(cs);
        setCommentsStatus({ kind: "ok", count: cs.length });
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[prmaster] listReviewComments failed:", err);
        setCommentsStatus({
          kind: "error",
          message: formatError(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [ref.owner, ref.repo, ref.number, refreshTick]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    setRefreshTick((n) => n + 1);
  }, []);

  const selected = useMemo<FileDiff | null>(() => {
    if (!diff || !selectedPath) return null;
    return diff.files.find((f) => f.path === selectedPath) ?? null;
  }, [diff, selectedPath]);

  // Seed comments derived from the REST review-comments fetch. Pierre
  // groups multiple comments at the same `(side, line)` cell so a
  // thread with replies stacks naturally under the line.
  const seedComments = useMemo<LocalComment[]>(
    () =>
      reviewComments.map((c) => ({
        id: c.id,
        line: c.line,
        side: c.side,
        authorLogin: c.authorLogin ?? null,
        body: c.body,
        filePath: c.path,
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
      const optimisticId = `local-${Date.now()}`;
      setComments((prev) => [
        ...prev,
        {
          id: optimisticId,
          line,
          side,
          authorLogin: null,
          body,
          filePath: path,
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
    [selected, diff, ref],
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-card/40 p-3 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Loading diff…
      </div>
    );
  }
  if (error) {
    return (
      <pre className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
        {error}
      </pre>
    );
  }
  if (!diff || diff.files.length === 0) {
    return (
      <div className="rounded-md border bg-card/40 p-3 text-xs italic text-muted-foreground">
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

  // Two-column layout — file tree (collapsible) on the left, the
  // CodeMirror diff editor on the right. The component fills its
  // container; the parent review page owns viewport sizing.
  const gridColumns = treeOpen
    ? "minmax(180px, 260px) minmax(0, 1fr)"
    : // Collapsed tree → only the diff column. minmax(0, 1fr) prevents
      // the inner CodeMirror's intrinsic min-content from blowing the
      // grid past its container.
      "minmax(0, 1fr)";

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_1fr] gap-1.5">
      {/* Toolbar — counts + actions. The thin underline replaces the
          old card lid so the diff editor underneath is the only
          surface that owns its own border + background. */}
      <div className="flex items-center justify-between gap-2 border-b border-border/40 px-1 pb-1.5 text-[11px] text-muted-foreground">
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
        className="grid min-h-0 gap-1.5 rounded-md"
        style={{
          gridTemplateColumns: gridColumns,
        }}
      >
        {treeOpen && (
          <div className="min-h-0 overflow-hidden rounded border bg-background">
            <PrFileTree
              files={diff.files}
              selectedPath={selectedPath}
              onSelect={setSelectedPath}
              commentsByPath={commentsByPath}
            />
          </div>
        )}
        <div className="min-h-0 min-w-0 overflow-hidden rounded border bg-background">
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
