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
      // Click "..." between hunks to reveal more context. Without
      // full file contents Pierre can't honour this option (the
      // patch alone doesn't carry the unchanged lines), so we only
      // turn it on when we're rendering MultiFileDiff.
      opts.expandUnchanged = true;
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
  // Inline styles, not className: Pierre slots annotations into a Shadow
  // DOM via `<slot>` projection. Slotted content technically inherits
  // document CSS, but Pierre's `:host` sheet sets a number of variables
  // (font, line-height, color-scheme) that win over our utility classes
  // in some browsers. Inline styles bypass that entirely so the comment
  // block is always visible regardless of host theme drift.
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        margin: "4px 0 4px 32px",
        padding: "8px 10px",
        background: "color-mix(in oklch, var(--muted, rgba(120,120,130,0.12)) 70%, transparent)",
        borderLeft: "3px solid var(--primary, #3b82f6)",
        borderRadius: 4,
        fontSize: 12,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        lineHeight: 1.5,
      }}
    >
      {comments.map((c) => (
        <div
          key={c.id}
          style={{
            display: "flex",
            gap: 6,
            alignItems: "baseline",
          }}
        >
          <span
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
              fontSize: 11,
              fontWeight: 600,
              opacity: 0.85,
              flexShrink: 0,
            }}
          >
            {c.authorLogin ? `@${c.authorLogin}` : "(unknown)"}
          </span>
          <span
            style={{
              flex: 1,
              whiteSpace: "pre-wrap",
            }}
          >
            {c.body}
          </span>
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
      <textarea
        ref={taRef}
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
          {submitting ? "Posting…" : "Comment"}
        </button>
      </div>
    </div>
  );
}
