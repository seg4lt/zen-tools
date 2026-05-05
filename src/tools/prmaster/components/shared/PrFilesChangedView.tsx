/**
 * Two-pane Files Changed view: tree on the left, diff on the right.
 *
 * Loads the diff via `prmaster_get_pr_diff` (local-git first, gh REST
 * fallback) on mount. Selected file's `patch` feeds the `<DiffViewer>`,
 * which renders a CodeMirror 6 unified merge view with inline-comment
 * widgets. New comments post via `prmaster_add_review_comment` and
 * appear immediately in the local list (full sync happens on the next
 * background refresh).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { Button } from "@zen-tools/ui";
import { DiffViewer, type InlineComment } from "@zen-tools/editor";
import { useTheme } from "@/hooks/use-theme";
import {
  prmasterTauri,
  prRefFor,
  type DiffSide,
  type EnrichedPullRequest,
  type FileDiff,
  type PrDiff,
} from "../../lib/tauri";
import { PrFileTree } from "./PrFileTree";

interface Props {
  pr: EnrichedPullRequest;
}

interface LocalComment extends InlineComment {
  /** Path the comment lives on (so we can filter per-file). */
  filePath: string;
}

export function PrFilesChangedView({ pr }: Props) {
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

  // Load diff on mount / when the PR changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    prmasterTauri
      .getPrDiff(ref, baseRef, headRef)
      .then((d) => {
        if (cancelled) return;
        setDiff(d);
        // Auto-select the first non-binary file.
        const first = d.files.find((f) => !f.binary && f.patch);
        setSelectedPath(first?.path ?? d.files[0]?.path ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(formatError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ref.owner, ref.repo, ref.number, baseRef, headRef]);

  const selected = useMemo<FileDiff | null>(() => {
    if (!diff || !selectedPath) return null;
    return diff.files.find((f) => f.path === selectedPath) ?? null;
  }, [diff, selectedPath]);

  const commentsForSelected = useMemo<InlineComment[]>(() => {
    if (!selected) return [];
    return comments.filter((c) => c.filePath === selected.path);
  }, [comments, selected]);

  const commentsByPath = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments) {
      m.set(c.filePath, (m.get(c.filePath) ?? 0) + 1);
    }
    return m;
  }, [comments]);

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

  return (
    <div className="grid gap-1.5 rounded-md border bg-card/40 p-1.5">
      <div className="flex items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-2">
          <span>
            {diff.files.length} file{diff.files.length === 1 ? "" : "s"}
          </span>
          <span className="text-emerald-600 dark:text-emerald-400">
            +{totals.add}
          </span>
          <span className="text-destructive">−{totals.del}</span>
          <SourceBadge source={diff.source} />
        </span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void openUrl(`${pr.pr.url}/files`)}
        >
          <ExternalLink className="size-3" />
          GitHub
        </Button>
      </div>
      <div
        className="grid min-h-0 gap-1.5 rounded-md"
        style={{
          gridTemplateColumns: "minmax(180px, 260px) minmax(0, 1fr)",
          height: "min(70vh, 640px)",
        }}
      >
        <div className="min-h-0 overflow-hidden rounded border bg-background">
          <PrFileTree
            files={diff.files}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
            commentsByPath={commentsByPath}
          />
        </div>
        <div className="min-h-0 overflow-hidden rounded border bg-background">
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
                isDark={isDark}
                comments={commentsForSelected}
                onAddComment={
                  diff.headSha ? handleAddComment : undefined
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
