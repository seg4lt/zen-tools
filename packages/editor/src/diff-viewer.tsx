/**
 * `<DiffViewer>` — wraps `@pierre/diffs/react`'s `PatchDiff` with the
 * project's domain types (`InlineComment`, `DiffViewMode`, the
 * `onAddComment` contract).
 *
 * Why Pierre Diffs over the previous CodeMirror-based viewer:
 *   - First-class `diffStyle: 'unified' | 'split'` toggle (no
 *     custom MergeView wiring).
 *   - Native `enableGutterUtility` — the "+" hover affordance ships
 *     with the library, deduplicating the gutter machinery we used
 *     to hand-build with CodeMirror gutters.
 *   - Annotations are React nodes (`renderAnnotation` returns
 *     `ReactNode`), so the comment composer's textarea is just
 *     React and types correctly without the event-routing
 *     workarounds we needed when the composer lived inside a
 *     CodeMirror widget.
 *   - Shiki-based syntax highlighting auto-detected from the patch
 *     header (`diff --git a/foo.ts b/foo.ts`), with paired
 *     `pierre-dark` / `pierre-light` themes that flip on `isDark`.
 *
 * Public API (unchanged from before — callers don't need to know we
 * swapped engines):
 *   - `patch` — unified-diff body (with the `diff --git` header).
 *   - `fileName` — kept for compatibility; Pierre infers from the
 *     patch header so this is currently informational only.
 *   - `isDark`, `comments`, `viewMode`, `onAddComment` — same as
 *     before. `onAddComment` is invoked with `side: "LEFT" | "RIGHT"`
 *     (LEFT = deleted line, RIGHT = added/context). Pierre's
 *     internal `'deletions' | 'additions'` is translated at the
 *     boundary so the rest of the app keeps speaking the GitHub
 *     REST vocabulary.
 */

import { useCallback, useMemo, useState } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import type {
  AnnotationSide,
  DiffLineAnnotation,
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
}

/** Which view to render. */
export type DiffViewMode = "unified" | "split";

export interface DiffViewerProps {
  /** Raw unified-diff body for one file (with the `diff --git` header). */
  patch: string;
  /** Hint for syntax highlighting — Pierre auto-detects from the
   *  patch header so this is currently informational; kept on the
   *  prop set for API parity with earlier consumers. */
  fileName?: string;
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
  fileName: _fileName,
  isDark = false,
  comments = [],
  viewMode = "unified",
  onAddComment,
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
          onCancel={closeComposer}
        />
      );
    },
    [onAddComment, closeComposer],
  );

  // Pierre's `FileDiffOptions` — diff style, theme pair (auto-flips
  // on themeType), and the per-line gutter "+" affordance. The
  // gutter-utility click hands us a SelectedLineRange whose `start`
  // is the line and `side` is `'deletions' | 'additions'` — exactly
  // what we need to open the composer.
  const options = useMemo<FileDiffOptions<AnnotationData>>(() => {
    const opts: FileDiffOptions<AnnotationData> = {
      diffStyle: viewMode,
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: isDark ? "dark" : "light",
    };
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
  }, [viewMode, isDark, onAddComment]);

  return (
    <div className="diff-viewer-host h-full w-full overflow-auto">
      <PatchDiff<AnnotationData>
        patch={patch}
        options={options}
        lineAnnotations={annotations}
        renderAnnotation={renderAnnotation}
        // Worker pool adds complexity (needs a Provider, dynamic
        // imports under a custom protocol) without buying us much
        // for a per-file viewer — disable for now; revisit if
        // we ever review files large enough for it to matter.
        disableWorkerPool
      />
    </div>
  );
}

// ── Annotation block (existing comments + optional composer) ────

interface AnnotationBlockProps {
  line: number;
  side: "LEFT" | "RIGHT";
  comments: InlineComment[];
  composerOpen: boolean;
  onSubmit?: (body: string) => Promise<void> | void;
  onCancel: () => void;
}

function AnnotationBlock({
  line,
  side,
  comments,
  composerOpen,
  onSubmit,
  onCancel,
}: AnnotationBlockProps) {
  return (
    <div className="diff-viewer-annotation">
      {comments.map((c) => (
        <div key={c.id} className="diff-viewer-annotation-comment">
          <span className="diff-viewer-annotation-author">
            {c.authorLogin ? `@${c.authorLogin}` : "(unknown)"}
          </span>
          <span className="diff-viewer-annotation-body">{c.body}</span>
        </div>
      ))}
      {composerOpen && onSubmit && (
        <Composer
          line={line}
          side={side}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

// ── Composer ─────────────────────────────────────────────────────

interface ComposerProps {
  line: number;
  side: "LEFT" | "RIGHT";
  onSubmit: (body: string) => Promise<void> | void;
  onCancel: () => void;
}

function Composer({ line, side, onSubmit, onCancel }: ComposerProps) {
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
      // Host already surfaces failures; just unlock the form so the
      // user can edit + retry.
      setSubmitting(false);
    }
  }, [body, submitting, onSubmit]);

  return (
    <div className="diff-viewer-composer">
      <div className="diff-viewer-composer-hint">
        {side === "LEFT"
          ? `Commenting on deleted line ${line} (LEFT)`
          : `Commenting on line ${line} (RIGHT)`}
      </div>
      <textarea
        ref={taRef}
        className="diff-viewer-composer-textarea"
        rows={3}
        value={body}
        placeholder="Leave a review comment…  (⌘+Enter to submit, Esc to cancel)"
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
      />
      <div className="diff-viewer-composer-actions">
        <button
          type="button"
          className="diff-viewer-composer-cancel"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="button"
          className="diff-viewer-composer-submit"
          onClick={submit}
          disabled={submitting || body.trim().length === 0}
        >
          {submitting ? "Posting…" : "Comment"}
        </button>
      </div>
    </div>
  );
}
