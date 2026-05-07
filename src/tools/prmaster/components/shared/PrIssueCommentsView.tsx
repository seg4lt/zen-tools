/**
 * PR-level "Conversation" view — the timeline of general comments
 * on a pull request, distinct from the inline review comments
 * anchored to specific diff lines.
 *
 * Sourced via `prmasterTauri.listIssueComments` (REST
 * `/repos/.../issues/{n}/comments`). Cached + revalidated through
 * React Query so the same hover prefetch that warms the diff also
 * warms this list — clicking the Comments tab right after entering
 * the review page is instant.
 *
 * Authors can edit their own comments in-app. The edit affordance
 * (pencil icon) is only shown when `comment.authorLogin` matches
 * the current authenticated user. Clicking switches the body to an
 * inline textarea; saving PATCHes the comment via
 * `prmasterTauri.editIssueComment` and refetches the list.
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ExternalLink, Loader2, MessageSquare, Pencil, RefreshCw, X } from "lucide-react";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { Button } from "@zen-tools/ui";
import { MarkdownView } from "@zen-tools/editor";
import { prIssueCommentsQueryOptions } from "../../lib/queries";
import { prmasterTauri } from "../../lib/tauri";
import type { IssueComment, PrRef } from "../../lib/tauri";
import { usePrMasterStore } from "../../store/prmaster-store";

interface Props {
  pr: PrRef;
}

export function PrIssueCommentsView({ pr }: Props) {
  const query = useQuery(prIssueCommentsQueryOptions(pr));
  const comments = query.data ?? [];
  const { state } = usePrMasterStore();
  const currentUser = state.currentUser;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar — counts + refresh, mirrors the Files toolbar so
          the two tabs feel like the same surface. */}
      <div className="flex items-center justify-between gap-2 px-1 pb-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-2">
          <MessageSquare className="size-3" />
          {query.isPending ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" />
              Loading…
            </span>
          ) : query.isError ? (
            <span className="text-destructive">
              Failed to load: {formatError(query.error)}
            </span>
          ) : (
            <span>
              {comments.length} {comments.length === 1 ? "comment" : "comments"}
            </span>
          )}
        </span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          title="Re-fetch general comments from GitHub"
        >
          <RefreshCw
            className={query.isFetching ? "size-3 animate-spin" : "size-3"}
          />
          {query.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {/* Body — scroll-on-overflow list. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isPending ? null : query.isError ? null : comments.length === 0 ? (
          <div className="p-3 text-xs italic text-muted-foreground">
            No general comments on this PR. Inline code comments
            live in the Files tab.
          </div>
        ) : (
          <div className="flex flex-col gap-2 px-1 py-2">
            {comments.map((c) => (
              <CommentCard key={c.id} comment={c} pr={pr} currentUser={currentUser} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CommentCard({
  comment,
  pr,
  currentUser,
}: {
  comment: IssueComment;
  pr: PrRef;
  currentUser: string | null;
}) {
  const queryClient = useQueryClient();
  const [editMode, setEditMode] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isOwn =
    !!currentUser &&
    !!comment.authorLogin &&
    comment.authorLogin === currentUser;

  const avatarUrl = comment.authorLogin
    ? `https://avatars.githubusercontent.com/${comment.authorLogin}?size=64`
    : null;
  const initials = (comment.authorLogin ?? "??").slice(0, 2).toUpperCase();

  async function handleSave() {
    const trimmed = editBody.trim();
    if (!trimmed) return;
    setSaving(true);
    setSaveError(null);
    try {
      await prmasterTauri.editIssueComment({
        pr,
        commentId: comment.id,
        body: trimmed,
      });
      await queryClient.invalidateQueries({ queryKey: prIssueCommentsQueryOptions(pr).queryKey });
      setEditMode(false);
    } catch (err) {
      setSaveError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setEditBody(comment.body);
    setSaveError(null);
    setEditMode(false);
  }

  return (
    <div className="flex items-start gap-3 py-2">
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={comment.authorLogin ?? "avatar"}
          width={32}
          height={32}
          className="size-8 shrink-0 rounded-full bg-muted"
        />
      ) : (
        <div
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
        >
          {initials}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-xs">
          <span className="font-semibold">
            {comment.authorLogin ?? "Unknown"}
          </span>
          <span className="text-muted-foreground">
            {formatRelativeTime(comment.createdAt)}
          </span>
          {comment.updatedAt && comment.updatedAt !== comment.createdAt && (
            <span
              className="text-muted-foreground/70"
              title={`edited ${new Date(comment.updatedAt).toLocaleString()}`}
            >
              · edited
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {isOwn && !editMode && (
              <button
                type="button"
                onClick={() => {
                  setEditBody(comment.body);
                  setSaveError(null);
                  setEditMode(true);
                }}
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                title="Edit this comment"
                aria-label="Edit comment"
              >
                <Pencil className="size-3" />
              </button>
            )}
            {comment.htmlUrl && !editMode && (
              <button
                type="button"
                onClick={() => void openUrl(comment.htmlUrl!)}
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                title="Open this comment on GitHub"
                aria-label="Open on GitHub"
              >
                <ExternalLink className="size-3" />
              </button>
            )}
            {editMode && (
              <button
                type="button"
                onClick={handleCancel}
                disabled={saving}
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
                title="Cancel edit"
                aria-label="Cancel edit"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </div>

        {editMode ? (
          <div className="mt-2 flex flex-col gap-2">
            <textarea
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm leading-relaxed text-foreground outline-none focus:ring-1 focus:ring-ring"
              rows={Math.max(3, editBody.split("\n").length)}
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void handleSave();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  handleCancel();
                }
              }}
              disabled={saving}
              autoFocus
            />
            {saveError && (
              <p className="text-xs text-destructive">{saveError}</p>
            )}
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                onClick={() => void handleSave()}
                disabled={saving || !editBody.trim()}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={handleCancel}
                disabled={saving}
              >
                Cancel
              </Button>
              <span className="text-[10px] text-muted-foreground">
                ⌘+Enter to save · Esc to cancel
              </span>
            </div>
          </div>
        ) : (
          <div className="mt-1 text-sm">
            {comment.body ? (
              <MarkdownView body={comment.body} />
            ) : (
              <span className="italic text-muted-foreground">(no content)</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
