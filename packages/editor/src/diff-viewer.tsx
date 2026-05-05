/**
 * `<DiffViewer>` — wraps `@pierre/diffs/react` with the project's
 * domain types (`InlineComment`, `DiffViewMode`, the `onAddComment`
 * contract).
 *
 * Two render paths, picked based on what the host gives us:
 *
 *   - **Full-file mode** (preferred): when `oldContent` and
 *     `newContent` are both supplied, mounts `<MultiFileDiff>` with
 *     the complete pre/post images. This unlocks Pierre's
 *     `expandUnchanged` affordance — the "..." button between hunks
 *     that lets the reviewer expand surrounding context all the way
 *     to the entire file. It's the experience reviewers actually
 *     want when reading non-trivial PRs.
 *   - **Patch-only mode** (fallback): when full contents aren't
 *     available (gh-REST source path), mounts `<PatchDiff>` with the
 *     unified-diff string. Hunk expansion isn't possible here — the
 *     patch only contains the changed regions plus a few lines of
 *     surrounding context — but everything else (syntax highlight,
 *     gutter "+", inline annotations) works identically.
 *
 * Public API (`InlineComment`, `viewMode`, `comments`, `onAddComment`)
 * is unchanged. Callers just pass `oldContent`/`newContent` when
 * they have them and the viewer picks the right mode.
 *
 * Pierre's internal `'deletions' | 'additions'` side vocabulary is
 * translated to `'LEFT' | 'RIGHT'` at the boundary so the rest of
 * the stack keeps speaking the GitHub REST dialect.
 */

import { useCallback, useMemo, useState } from "react";
import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";
import type {
  AnnotationSide,
  DiffLineAnnotation,
  FileContents,
  FileDiffOptions,
  SelectedLineRange,
} from "@pierre/diffs";

// ── Types ────────────────────────────────────────────────────────

/** A single inline comment rendered next to a line. */
export interface InlineComment {
  id: string;
  /** 1-based line number, in the side's own line numbering
   *  (RIGHT=after-image line, LEFT=before-image line). */
  line: number;
  /** Side the comment was anchored to. */
  side: "LEFT" | "RIGHT";
  authorLogin: string | null;
  body: string;
  /** ISO-8601 timestamp the comment was created. Drives the relative
   *  "3h" / "2d" timestamp next to the author name. */
  createdAt?: string;
  /** Parent comment id, when this entry is a reply. The thread root
   *  is identified by `inReplyToId == null`. */
  inReplyToId?: string;
  /** Thread identifier shared by every comment in the same thread.
   *  Opaque to the editor — passed verbatim to `onResolve` so the
   *  host can turn it into whatever its forge needs (GitHub uses a
   *  GraphQL node id; other forges may use something different). */
  threadId?: string;
}

/** Which view to render. */
export type DiffViewMode = "unified" | "split";

export interface DiffViewerProps {
  /** Raw unified-diff body for one file (with the `diff --git` header).
   *  Used as a fallback when `oldContent`/`newContent` aren't both
   *  available — in that case hunks can't expand. */
  patch: string;
  /** Hint for syntax highlighting and `MultiFileDiff` headers. Pierre
   *  also infers from the patch header in patch-only mode. */
  fileName?: string;
  /** Full file contents at the base revision. When supplied alongside
   *  `newContent`, the viewer renders `<MultiFileDiff>` and unlocks
   *  hunk expansion (click "..." between hunks to reveal more
   *  context, all the way to the whole file). */
  oldContent?: string;
  /** Full file contents at the head revision. See `oldContent`. */
  newContent?: string;
  /** Whether to render in dark mode. */
  isDark?: boolean;
  /** Existing review comments to display. */
  comments?: InlineComment[];
  /** Unified or side-by-side. */
  viewMode?: DiffViewMode;
  /** Called when the user submits a new comment. */
  onAddComment?: (input: {
    line: number;
    side: "LEFT" | "RIGHT";
    body: string;
  }) => Promise<void> | void;
  /** Called when the user replies to an existing comment thread.
   *  `parentId` is the id of the thread root (or any comment in the
   *  thread — GitHub attaches the reply to the same thread either
   *  way). Omit to hide the "Add reply" affordance. */
  onReply?: (input: {
    parentId: string;
    body: string;
  }) => Promise<void> | void;
  /** Called when the user resolves a thread via the per-thread
   *  "Resolve" button. `threadId` comes from the comment's
   *  `threadId` field. Omit to hide the "Resolve" affordance — only
   *  threads whose root comment carries a `threadId` AND whose
   *  parent has `onResolve` get the button. */
  onResolve?: (input: { threadId: string }) => Promise<void> | void;
}

// ── Side translation ─────────────────────────────────────────────

/** Domain `LEFT|RIGHT` → Pierre `deletions|additions`. */
function toPierreSide(side: "LEFT" | "RIGHT"): AnnotationSide {
  return side === "LEFT" ? "deletions" : "additions";
}

/** Pierre `deletions|additions` → domain `LEFT|RIGHT`. */
function fromPierreSide(side: AnnotationSide): "LEFT" | "RIGHT" {
  return side === "deletions" ? "LEFT" : "RIGHT";
}

// ── Annotation payload ───────────────────────────────────────────

/**
 * What we hang off each `DiffLineAnnotation.metadata`. One annotation
 * per `(side, line)` cell — it carries every existing comment for
 * that cell plus a flag for whether the composer is currently open
 * there.
 */
interface AnnotationData {
  comments: InlineComment[];
  composerOpen: boolean;
}

interface ComposerTarget {
  line: number;
  side: "LEFT" | "RIGHT";
}

// ── Component ────────────────────────────────────────────────────

export function DiffViewer({
  patch,
  fileName,
  oldContent,
  newContent,
  isDark = false,
  comments = [],
  viewMode = "unified",
  onAddComment,
  onReply,
  onResolve,
}: DiffViewerProps) {
  const [composer, setComposer] = useState<ComposerTarget | null>(null);

  // Build the annotation list every render. We bucket existing
  // comments by `(side, line)` so multi-comment cells render once
  // (Pierre would happily render a row per duplicate annotation
  // otherwise).
  const annotations = useMemo<DiffLineAnnotation<AnnotationData>[]>(() => {
    const buckets = new Map<string, AnnotationData>();
    const keyFor = (side: AnnotationSide, line: number) =>
      `${side}:${line}`;
    for (const c of comments) {
      const side = toPierreSide(c.side);
      const k = keyFor(side, c.line);
      const bucket = buckets.get(k) ?? {
        comments: [],
        composerOpen: false,
      };
      bucket.comments.push(c);
      buckets.set(k, bucket);
    }
    if (composer && onAddComment) {
      const side = toPierreSide(composer.side);
      const k = keyFor(side, composer.line);
      const bucket = buckets.get(k) ?? {
        comments: [],
        composerOpen: false,
      };
      bucket.composerOpen = true;
      buckets.set(k, bucket);
    }
    const out: DiffLineAnnotation<AnnotationData>[] = [];
    for (const [k, metadata] of buckets) {
      const [sideStr, lineStr] = k.split(":");
      out.push({
        side: sideStr as AnnotationSide,
        lineNumber: Number(lineStr),
        metadata,
      });
    }
    return out;
  }, [comments, composer, onAddComment]);

  const closeComposer = useCallback(() => setComposer(null), []);

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<AnnotationData>) => {
      const meta = annotation.metadata;
      if (!meta) return null;
      const domainSide = fromPierreSide(annotation.side);
      return (
        <AnnotationBlock
          line={annotation.lineNumber}
          side={domainSide}
          comments={meta.comments}
          composerOpen={meta.composerOpen}
          onSubmit={
            onAddComment
              ? async (body) => {
                  await onAddComment({
                    line: annotation.lineNumber,
                    side: domainSide,
                    body,
                  });
                  // Host's next `comments` update will surface the
                  // freshly-posted comment in the list above; close
                  // the composer either way so the textarea drops.
                  setComposer(null);
                }
              : undefined
          }
          onReply={
            onReply
              ? async (parentId, body) => {
                  await onReply({ parentId, body });
                }
              : undefined
          }
          onResolve={
            onResolve
              ? async (threadId) => {
                  await onResolve({ threadId });
                }
              : undefined
          }
          onCancel={closeComposer}
        />
      );
    },
    [onAddComment, onReply, onResolve, closeComposer],
  );

  // Pierre's `FileDiffOptions` — diff style, theme pair (auto-flips
  // on themeType), the per-line gutter "+" affordance, and (when
  // we're in full-file mode) hunk expansion.
  const fullFileMode = oldContent != null && newContent != null;
  const options = useMemo<FileDiffOptions<AnnotationData>>(() => {
    const opts: FileDiffOptions<AnnotationData> = {
      diffStyle: viewMode,
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: isDark ? "dark" : "light",
    };
    if (fullFileMode) {
      // Pierre's default: unchanged regions are *collapsed* with
      // "N unmodified lines" expand controls (chevron up / down /
      // dot-dot-dot, matching GitHub's PR diff layout). The user
      // clicks to reveal more context, all the way to the whole
      // file. We deliberately leave `expandUnchanged` unset (false)
      // — setting it to `true` expands EVERYTHING by default,
      // which is the wrong UX for a code review (you want to see
      // the changes, not skim the whole file).
      //
      // `expansionLineCount` is how many lines a single click
      // reveals; default in Pierre is 100. Bumping it down to 20
      // gives finer-grained expansion that matches GitHub's
      // step-size and feels less jarring on long unchanged blocks.
      opts.expansionLineCount = 20;
    }
    if (onAddComment) {
      opts.enableGutterUtility = true;
      opts.onGutterUtilityClick = (range: SelectedLineRange) => {
        const sideStr = (range.side ?? "additions") as AnnotationSide;
        setComposer({
          line: range.start,
          side: fromPierreSide(sideStr),
        });
      };
    }
    return opts;
  }, [viewMode, isDark, onAddComment, fullFileMode]);

  // Stable `FileContents` objects — Pierre's `MultiFileDiff` re-runs
  // diff parsing whenever `oldFile`/`newFile` reference change, so
  // recreating these on every render would burn cycles for nothing.
  const oldFile = useMemo<FileContents | null>(
    () =>
      oldContent != null
        ? { name: fileName ?? "before", contents: oldContent }
        : null,
    [oldContent, fileName],
  );
  const newFile = useMemo<FileContents | null>(
    () =>
      newContent != null
        ? { name: fileName ?? "after", contents: newContent }
        : null,
    [newContent, fileName],
  );

  return (
    <div className="diff-viewer-host h-full w-full overflow-auto">
      {fullFileMode && oldFile && newFile ? (
        <MultiFileDiff<AnnotationData>
          oldFile={oldFile}
          newFile={newFile}
          options={options}
          lineAnnotations={annotations}
          renderAnnotation={renderAnnotation}
          disableWorkerPool
        />
      ) : (
        <PatchDiff<AnnotationData>
          patch={patch}
          options={options}
          lineAnnotations={annotations}
          renderAnnotation={renderAnnotation}
          disableWorkerPool
        />
      )}
    </div>
  );
}

// ── Annotation block (threaded card matching diffs.com pattern) ─

interface AnnotationBlockProps {
  line: number;
  side: "LEFT" | "RIGHT";
  comments: InlineComment[];
  composerOpen: boolean;
  /** New top-level comment (when no comments exist yet at this line). */
  onSubmit?: (body: string) => Promise<void> | void;
  /** Reply to an existing thread. The block resolves the parent id
   *  internally — the host just needs to know how to POST a reply. */
  onReply?: (parentId: string, body: string) => Promise<void> | void;
  /** Resolve the entire thread. Only rendered when both this prop
   *  and the thread root's `threadId` are present. */
  onResolve?: (threadId: string) => Promise<void> | void;
  onCancel: () => void;
}

/**
 * Renders one inline thread, matching diffs.com's annotation
 * pattern: avatar + author + relative time at the top of each
 * comment, followed by the body, replies stacked below, and an
 * "Add reply" affordance at the bottom.
 *
 * Inline styles instead of className for the same reason as before:
 * Pierre projects this into a Shadow DOM via `<slot>` and the
 * `:host` sheet on the inner element sets font/line-height/color
 * variables that override Tailwind utilities in some browsers.
 * Inline styles bypass the cascade reliably.
 */
function AnnotationBlock({
  line,
  side,
  comments,
  composerOpen,
  onSubmit,
  onReply,
  onResolve,
  onCancel,
}: AnnotationBlockProps) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  // Last error string from a failed top-level submit (the new-comment
  // composer). The reply composer surfaces its own errors via the
  // same path — both share `submitError`. Cleared when the user
  // edits the composer body or cancels it.
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Thread root = first comment chronologically. We pass its id to
  // GitHub's `replies` endpoint; GitHub attaches the reply to the
  // same thread regardless, so this is robust even if the user
  // tries to reply to a mid-thread comment.
  const threadRoot = comments[0];

  const cardStyle: React.CSSProperties = {
    margin: "8px 0 8px 32px",
    padding: "12px 14px",
    background:
      "color-mix(in oklch, var(--muted, rgba(120,120,130,0.12)) 60%, transparent)",
    border: "1px solid rgba(120,120,130,0.25)",
    borderRadius: 8,
    fontSize: 13,
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    lineHeight: 1.5,
    color: "inherit",
  };

  // Wrap the parent's submit so we can catch errors and surface them
  // inline without losing the composer's typed body. Re-throws so the
  // Composer's own catch path resets `submitting` state (re-enables
  // the buttons) and keeps `body` populated for retry.
  const wrappedSubmit = onSubmit
    ? async (body: string) => {
        setSubmitError(null);
        try {
          await onSubmit(body);
        } catch (err) {
          setSubmitError(formatSubmitError(err));
          throw err;
        }
      }
    : undefined;

  const wrappedReply = onReply
    ? async (parentId: string, body: string) => {
        setSubmitError(null);
        try {
          await onReply(parentId, body);
          setReplyOpen(false);
        } catch (err) {
          setSubmitError(formatSubmitError(err));
          throw err;
        }
      }
    : undefined;

  // Stable keys on every conditional child so the Composer's React
  // identity survives the `comments.length` 0→1→0 transition that
  // happens during an optimistic insert + rollback. Without keys,
  // React reconciles by index — when an earlier child appears the
  // Composer at a later index gets remounted, wiping the user's
  // typed body mid-submit. With keys, Composer at key="composer"
  // matches across renders → its `useState body` is preserved →
  // the user keeps their text on a failed POST and can retry.
  const hasComments = comments.length > 0;
  const showActions =
    hasComments && (!!wrappedReply || (!!onResolve && !!threadRoot?.threadId));

  return (
    <div style={cardStyle}>
      {hasComments && (
        <div
          key="comments-list"
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          {comments.map((c) => (
            <CommentRow key={c.id} comment={c} />
          ))}
        </div>
      )}

      {showActions && (
        <div key="actions-row" style={{ marginTop: 12 }}>
          {replyOpen && wrappedReply && threadRoot ? (
            <Composer
              key="reply-composer"
              line={line}
              side={side}
              hideHint
              placeholder="Write a reply…  (⌘+Enter to submit, Esc to cancel)"
              submitLabel="Reply"
              onSubmit={(body) => wrappedReply(threadRoot.id, body)}
              onCancel={() => {
                setReplyOpen(false);
                setSubmitError(null);
              }}
            />
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
              }}
            >
              {wrappedReply && (
                <button
                  type="button"
                  onClick={() => {
                    setSubmitError(null);
                    setReplyOpen(true);
                  }}
                  style={{
                    background: "transparent",
                    border: 0,
                    color: "var(--primary, #3b82f6)",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 13,
                    fontWeight: 500,
                    fontFamily: "inherit",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                  title="Add a reply to this thread"
                >
                  <span aria-hidden style={{ opacity: 0.7 }}>
                    ↩
                  </span>
                  Add reply…
                </button>
              )}
              {onResolve && threadRoot?.threadId && (
                <button
                  type="button"
                  disabled={resolving}
                  onClick={async () => {
                    if (resolving || !threadRoot.threadId) return;
                    setResolving(true);
                    try {
                      await onResolve(threadRoot.threadId);
                    } finally {
                      setResolving(false);
                    }
                  }}
                  style={{
                    background: "transparent",
                    border: 0,
                    color: "var(--primary, #3b82f6)",
                    cursor: resolving ? "wait" : "pointer",
                    padding: 0,
                    fontSize: 13,
                    fontWeight: 500,
                    fontFamily: "inherit",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    opacity: resolving ? 0.6 : 1,
                  }}
                  title="Mark this conversation as resolved on GitHub"
                >
                  <span aria-hidden style={{ opacity: 0.7 }}>
                    ✓
                  </span>
                  {resolving ? "Resolving…" : "Resolve"}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {composerOpen && wrappedSubmit && (
        <div
          key="new-composer-wrap"
          style={{ marginTop: hasComments ? 12 : 0 }}
        >
          <Composer
            key="new-composer"
            line={line}
            side={side}
            onSubmit={wrappedSubmit}
            onCancel={() => {
              setSubmitError(null);
              onCancel();
            }}
          />
        </div>
      )}

      {submitError && (
        <div
          key="submit-error"
          style={{
            marginTop: 8,
            padding: "6px 10px",
            background: "rgba(239, 68, 68, 0.12)",
            border: "1px solid rgba(239, 68, 68, 0.4)",
            borderRadius: 4,
            color: "rgb(239, 68, 68)",
            fontSize: 12,
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
          }}
          title={submitError}
        >
          <span aria-hidden>⚠</span>
          <span style={{ flex: 1, wordBreak: "break-word" }}>
            Failed to post: {submitError}
          </span>
          <button
            type="button"
            onClick={() => setSubmitError(null)}
            style={{
              background: "transparent",
              border: 0,
              color: "inherit",
              cursor: "pointer",
              padding: 0,
              fontSize: 14,
              opacity: 0.7,
            }}
            aria-label="Dismiss error"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

/** Best-effort message extraction from whatever the host's onSubmit
 *  callback rejected with. Tauri commands surface as Error subclasses
 *  with a `message`; engine errors come through as strings. */
function formatSubmitError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** One comment row inside an annotation card — avatar + author +
 *  relative timestamp on the header line, body underneath. Matches
 *  GitHub / diffs.com layout. */
function CommentRow({ comment }: { comment: InlineComment }) {
  const avatarUrl = comment.authorLogin
    ? `https://avatars.githubusercontent.com/${comment.authorLogin}?size=40`
    : null;
  const initials = (comment.authorLogin ?? "??")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={comment.authorLogin ?? "avatar"}
          width={28}
          height={28}
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            flexShrink: 0,
            background: "rgba(120,120,130,0.2)",
          }}
        />
      ) : (
        <div
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            flexShrink: 0,
            background: "rgba(120,120,130,0.25)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontWeight: 600,
            opacity: 0.8,
          }}
        >
          {initials}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            marginBottom: 2,
          }}
        >
          <span style={{ fontWeight: 600 }}>
            {comment.authorLogin ?? "Unknown"}
          </span>
          {comment.createdAt && (
            <span style={{ opacity: 0.6, fontSize: 12 }}>
              {formatRelativeTime(comment.createdAt)}
            </span>
          )}
        </div>
        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {comment.body}
        </div>
      </div>
    </div>
  );
}

/** Compact GitHub-style relative time: "just now", "5m", "3h",
 *  "2d", "3mo", "1y". Falls back to the locale date for anything
 *  malformed so we never crash on a bad timestamp. */
function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}

// ── Composer ─────────────────────────────────────────────────────

interface ComposerProps {
  line: number;
  side: "LEFT" | "RIGHT";
  onSubmit: (body: string) => Promise<void> | void;
  onCancel: () => void;
  /** Suppress the "Commenting on line X (SIDE)" hint — used by the
   *  reply variant where the parent context is already obvious. */
  hideHint?: boolean;
  placeholder?: string;
  submitLabel?: string;
}

function Composer({
  line,
  side,
  onSubmit,
  onCancel,
  hideHint = false,
  placeholder = "Leave a review comment…  (⌘+Enter to submit, Esc to cancel)",
  submitLabel = "Comment",
}: ComposerProps) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Auto-focus on mount via the ref-callback pattern — clicking the
  // gutter "+" should leave the textarea ready to type immediately.
  const taRef = useCallback((el: HTMLTextAreaElement | null) => {
    if (el) el.focus();
  }, []);

  const submit = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
    } catch {
      setSubmitting(false);
    }
  }, [body, submitting, onSubmit]);

  // Inline styles for the same reason as AnnotationBlock — Pierre's
  // shadow DOM `:host` rules can win over utility classes.
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        marginTop: 6,
      }}
    >
      {!hideHint && (
        <div
          style={{
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            opacity: 0.7,
          }}
        >
          {side === "LEFT"
            ? `Commenting on deleted line ${line} (LEFT)`
            : `Commenting on line ${line} (RIGHT)`}
        </div>
      )}
      <textarea
        ref={taRef}
        rows={3}
        value={body}
        placeholder={placeholder}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        disabled={submitting}
        style={{
          width: "100%",
          minHeight: 60,
          padding: "6px 8px",
          border: "1px solid rgba(120,120,130,0.4)",
          borderRadius: 4,
          background: "var(--background, rgba(255,255,255,0.6))",
          color: "inherit",
          fontFamily: "inherit",
          fontSize: 12,
          lineHeight: 1.5,
          resize: "vertical",
          boxSizing: "border-box",
        }}
      />
      <div
        style={{
          display: "flex",
          gap: 6,
          justifyContent: "flex-end",
        }}
      >
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          style={{
            padding: "4px 12px",
            border: "1px solid rgba(120,120,130,0.4)",
            borderRadius: 4,
            background: "transparent",
            color: "inherit",
            fontSize: 11,
            fontWeight: 500,
            cursor: submitting ? "not-allowed" : "pointer",
            opacity: submitting ? 0.5 : 1,
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting || body.trim().length === 0}
          style={{
            padding: "4px 12px",
            border: "1px solid var(--primary, #3b82f6)",
            borderRadius: 4,
            background: "var(--primary, #3b82f6)",
            color: "var(--primary-foreground, #fff)",
            fontSize: 11,
            fontWeight: 500,
            cursor: submitting || body.trim().length === 0 ? "not-allowed" : "pointer",
            opacity: submitting || body.trim().length === 0 ? 0.5 : 1,
          }}
        >
          {submitting ? "Posting…" : submitLabel}
        </button>
      </div>
    </div>
  );
}
