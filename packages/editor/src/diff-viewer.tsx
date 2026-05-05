/**
 * `<DiffViewer>` — reads a unified-diff patch (the kind `git diff`
 * emits) and renders it via CodeMirror 6 + `@codemirror/merge`'s
 * `unifiedMergeView`. The editor doc is the "after" file; the
 * `original` extension config is the "before" file. CodeMirror does
 * the heavy lifting (line gutters, syntax highlight, +/- block
 * rendering, fold-unchanged).
 *
 * The patch's hunks are reconstructed into "before"/"after" buffers
 * with `@@ ... unchanged ...` placeholders between hunks so the user
 * sees the actual context they reviewed without us having to ship
 * the entire file content.
 *
 * Review-comment UX:
 *   - Existing review comments render as line-anchored block widgets
 *     beneath the line they target.
 *   - A dedicated "add comment" gutter sits left of the line numbers.
 *     A faint "+" icon appears on hover; clicking it opens a single
 *     composer pinned to that line. Earlier we rendered a textarea on
 *     EVERY line — overwhelming on big diffs. Now only one composer
 *     is open at a time, opened deliberately.
 *   - Submitting the composer posts the comment immediately via
 *     `onAddComment` and clears the composer back to the gutter
 *     state. Esc closes without posting.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  EditorState,
  StateEffect,
  StateField,
  RangeSetBuilder,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  Decoration,
  WidgetType,
  GutterMarker,
  gutter,
  lineNumbers,
  drawSelection,
} from "@codemirror/view";
import {
  HighlightStyle,
  bracketMatching,
  syntaxHighlighting,
  foldGutter,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { unifiedMergeView } from "@codemirror/merge";
import { languages } from "@codemirror/language-data";
import { makeEditorTheme } from "./cm-theme";

// ── Types ────────────────────────────────────────────────────────

/** A single inline comment rendered beneath a line. */
export interface InlineComment {
  id: string;
  /** 1-based line number in the editor's doc (the "after" side). */
  line: number;
  /** Side the comment was anchored to. */
  side: "LEFT" | "RIGHT";
  authorLogin: string | null;
  body: string;
}

export interface DiffViewerProps {
  /** Raw unified-diff body for one file (with the `diff --git` header). */
  patch: string;
  /** Hint for syntax highlighting — typically the file extension. */
  fileName?: string;
  /** Whether to render in dark mode. */
  isDark?: boolean;
  /** Existing review comments to display. */
  comments?: InlineComment[];
  /** Called when the user submits a new comment. */
  onAddComment?: (input: {
    line: number;
    side: "LEFT" | "RIGHT";
    body: string;
  }) => Promise<void> | void;
}

// ── Patch reconstruction ─────────────────────────────────────────

/**
 * Parsed unified-diff patch. `before` and `after` are the
 * line-by-line reconstructed sides; `lineMap` lets us translate an
 * "after"-side editor line number back to a `(side, line)` pair so
 * comments anchor correctly even on `-` (deleted) lines.
 */
interface ReconstructedPatch {
  before: string;
  after: string;
  /** Per "after"-side line — null when the line corresponds to a
   *  deleted hunk row. */
  beforeLineByAfter: Map<number, number>;
}

interface Hunk {
  oldStart: number;
  newStart: number;
  lines: string[]; // each starts with ' ', '+', or '-'
}

function parsePatch(raw: string): Hunk[] {
  const out: Hunk[] = [];
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const oldStart = Number.parseInt(m[1] ?? "0", 10);
    const newStart = Number.parseInt(m[3] ?? "0", 10);
    i++;
    const body: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (next.startsWith("@@")) break;
      if (
        next.startsWith("diff ") ||
        next.startsWith("--- ") ||
        next.startsWith("+++ ") ||
        next.startsWith("index ") ||
        next.startsWith("new file") ||
        next.startsWith("deleted file") ||
        next.startsWith("rename ") ||
        next.startsWith("similarity ") ||
        next.startsWith("Binary files")
      ) {
        // pre-hunk header lines after another hunk shouldn't appear,
        // but be defensive — bail out if we hit one.
        break;
      }
      // Skip the trailing "\ No newline at end of file" markers.
      if (next.startsWith("\\ No newline")) {
        i++;
        continue;
      }
      if (
        next.length === 0 ||
        next[0] === " " ||
        next[0] === "+" ||
        next[0] === "-"
      ) {
        body.push(next);
        i++;
      } else {
        break;
      }
    }
    out.push({ oldStart, newStart, lines: body });
  }
  return out;
}

function reconstructPatch(raw: string): ReconstructedPatch {
  const hunks = parsePatch(raw);
  const before: string[] = [];
  const after: string[] = [];
  const beforeLineByAfter = new Map<number, number>();
  let prevOldEnd = 0;
  let prevNewEnd = 0;
  for (const h of hunks) {
    // Add a placeholder marking the unchanged gap between hunks (if
    // any). The placeholder is identical on both sides so it doesn't
    // appear as a change.
    if (
      (h.oldStart > prevOldEnd + 1 && prevOldEnd > 0) ||
      (h.newStart > prevNewEnd + 1 && prevNewEnd > 0)
    ) {
      const gap = `// ── unchanged ──`;
      after.push(gap);
      before.push(gap);
    }
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    for (const line of h.lines) {
      const sign = line[0] ?? " ";
      const text = line.slice(1);
      if (sign === " ") {
        before.push(text);
        after.push(text);
        beforeLineByAfter.set(after.length, before.length);
        oldLine++;
        newLine++;
      } else if (sign === "-") {
        before.push(text);
        oldLine++;
      } else if (sign === "+") {
        after.push(text);
        newLine++;
      }
    }
    prevOldEnd = oldLine - 1;
    prevNewEnd = newLine - 1;
  }
  return {
    before: before.join("\n"),
    after: after.join("\n"),
    beforeLineByAfter,
  };
}

// ── Comment widgets ──────────────────────────────────────────────

interface CommentBundle {
  comments: InlineComment[];
  onAddComment?: DiffViewerProps["onAddComment"];
}

const setComments = StateEffect.define<CommentBundle>();

const commentsField = StateField.define<CommentBundle>({
  create: () => ({ comments: [] }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setComments)) return e.value;
    }
    return value;
  },
});

/**
 * Which line currently has its inline composer open. `null` means
 * no composer is showing. Toggled by the gutter "+" click + the
 * composer's Cancel / submit-success paths.
 */
const setComposerLine = StateEffect.define<number | null>();

const composerLineField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setComposerLine)) return e.value;
    }
    return value;
  },
});

/**
 * Block widget rendered beneath a line. Two reasons it can mount:
 *
 *   1. The line has at least one existing review comment — we list
 *      them so the user can read context. No composer appears.
 *   2. The line === `composerLine` — we show the textarea + Comment
 *      button. Submitting fires `onAdd` immediately (one-click
 *      post — no extra confirmation prompt) and the host clears
 *      `composerLine` on success so the row collapses back to its
 *      gutter-only state.
 *
 * Both reasons can stack: an existing comment plus the open composer
 * for a follow-up reply.
 *
 * `toDOM(view)` receives the live `EditorView` from CodeMirror — we
 * use it to dispatch the close-composer effect on Cancel / submit
 * success.
 */
class CommentBlockWidget extends WidgetType {
  constructor(
    readonly comments: InlineComment[],
    readonly line: number,
    readonly onAdd: DiffViewerProps["onAddComment"],
    readonly showComposer: boolean,
  ) {
    super();
  }

  override eq(other: CommentBlockWidget): boolean {
    // Two widgets are equal when they'd render identically. Cheap
    // structural check — comment ids + count + open-composer flag.
    if (other.line !== this.line) return false;
    if (other.showComposer !== this.showComposer) return false;
    if (other.comments.length !== this.comments.length) return false;
    for (let i = 0; i < this.comments.length; i++) {
      if (other.comments[i]?.id !== this.comments[i]?.id) return false;
      if (other.comments[i]?.body !== this.comments[i]?.body) return false;
    }
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-pr-comment-block";
    for (const c of this.comments) {
      const row = document.createElement("div");
      row.className = "cm-pr-comment";
      const author = document.createElement("span");
      author.className = "cm-pr-comment-author";
      author.textContent = c.authorLogin ? `@${c.authorLogin}` : "(unknown)";
      const body = document.createElement("span");
      body.className = "cm-pr-comment-body";
      body.textContent = c.body;
      row.appendChild(author);
      row.appendChild(body);
      wrap.appendChild(row);
    }
    if (this.showComposer && this.onAdd) {
      const composer = document.createElement("div");
      composer.className = "cm-pr-comment-composer";
      const ta = document.createElement("textarea");
      ta.placeholder = "Leave a review comment…  (⌘+Enter to submit, Esc to cancel)";
      ta.rows = 3;
      ta.className = "cm-pr-comment-textarea";
      // Auto-focus on mount so the user can type immediately after
      // clicking the gutter "+". `requestAnimationFrame` defers past
      // CodeMirror's own focus/blur cycle for the click event.
      requestAnimationFrame(() => ta.focus());

      const actions = document.createElement("div");
      actions.className = "cm-pr-comment-actions";

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.className = "cm-pr-comment-cancel";
      cancel.onclick = () => {
        view.dispatch({ effects: setComposerLine.of(null) });
      };

      const submit = document.createElement("button");
      submit.type = "button";
      submit.textContent = "Comment";
      submit.className = "cm-pr-comment-submit";
      const doSubmit = async () => {
        const body = ta.value.trim();
        if (!body || !this.onAdd) return;
        submit.disabled = true;
        cancel.disabled = true;
        try {
          await this.onAdd({ line: this.line, side: "RIGHT", body });
          // Success — close the composer. The host's next
          // `setComments` dispatch will surface the new comment in
          // the existing-comments list above.
          view.dispatch({ effects: setComposerLine.of(null) });
        } catch {
          submit.disabled = false;
          cancel.disabled = false;
        }
      };
      submit.onclick = doSubmit;

      // Esc cancels, ⌘/Ctrl+Enter submits — same chord pattern as
      // GitHub's own review composer.
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          view.dispatch({ effects: setComposerLine.of(null) });
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void doSubmit();
        }
      });

      actions.appendChild(cancel);
      actions.appendChild(submit);
      composer.appendChild(ta);
      composer.appendChild(actions);
      wrap.appendChild(composer);
    }
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Gutter marker rendered for every line when `onAddComment` is
 * wired up. The "+" icon is hidden by default and reveals on
 * gutter-cell hover (CSS in `diffViewerTheme`). Click toggles the
 * composer for this line via a `setComposerLine` dispatch.
 *
 * `toDOM(view)` receives the live `EditorView` from CodeMirror.
 */
class AddCommentGutterMarker extends GutterMarker {
  constructor(readonly line: number) {
    super();
  }
  override eq(other: AddCommentGutterMarker): boolean {
    return other.line === this.line;
  }
  override toDOM(view: EditorView): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-pr-add-comment-btn";
    btn.title = "Add a review comment on this line";
    btn.textContent = "+";
    btn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      const cur = view.state.field(composerLineField, false) ?? null;
      // Toggle: clicking "+" on the line that's already open closes
      // it; otherwise switches the composer to this line.
      view.dispatch({
        effects: setComposerLine.of(cur === this.line ? null : this.line),
      });
    };
    return btn;
  }
}

/**
 * The "add comment" gutter extension. Renders a "+" marker per line
 * (hidden by default; visible on gutter cell hover via CSS). Only
 * shown when the host supplied `onAddComment` — read-only / GitHub-
 * unavailable diffs skip the gutter entirely.
 */
function addCommentGutter(): Extension {
  return gutter({
    class: "cm-gutter-add-comment",
    lineMarker(view, blockInfo) {
      const bundle = view.state.field(commentsField, false);
      if (!bundle?.onAddComment) return null;
      const line = view.state.doc.lineAt(blockInfo.from).number;
      return new AddCommentGutterMarker(line);
    },
    initialSpacer: () => new AddCommentGutterMarker(0),
  });
}

const commentDecorations = EditorView.decorations.compute(
  [commentsField, composerLineField],
  (state) => {
    const bundle = state.field(commentsField);
    const composerLine = state.field(composerLineField);
    const lineCount = state.doc.lines;
    const byLine = new Map<number, InlineComment[]>();
    for (const c of bundle.comments) {
      const list = byLine.get(c.line) ?? [];
      list.push(c);
      byLine.set(c.line, list);
    }
    const builder = new RangeSetBuilder<Decoration>();
    // Walk lines in order so the RangeSetBuilder receives positions
    // in increasing order.
    for (let n = 1; n <= lineCount; n++) {
      const list = byLine.get(n);
      const showComposer = composerLine === n && !!bundle.onAddComment;
      // No comments AND no open composer here? Skip — the gutter
      // "+" alone is enough on quiet rows; we don't want to burn
      // vertical space on every line of the diff.
      if (!list && !showComposer) continue;
      const line = state.doc.line(n);
      builder.add(
        line.to,
        line.to,
        Decoration.widget({
          widget: new CommentBlockWidget(
            list ?? [],
            n,
            bundle.onAddComment,
            showComposer,
          ),
          side: 1,
          block: true,
        }),
      );
    }
    return builder.finish();
  },
);

// ── Theme additions for comment widgets ──────────────────────────

const diffViewerTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
  // ── Add-comment gutter ─────────────────────────────────────────
  // The gutter sits BEFORE the line numbers (registered first in
  // `extensions`). Its cells are 18px wide; the "+" marker is
  // invisible until the user hovers over the gutter region — that
  // gives big diffs a calm read with the affordance discoverable
  // exactly where you'd expect it (left margin, GitHub-style).
  ".cm-gutter-add-comment": {
    width: "18px",
    cursor: "pointer",
  },
  ".cm-gutter-add-comment .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
  },
  ".cm-pr-add-comment-btn": {
    width: "16px",
    height: "16px",
    padding: "0",
    margin: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--accent, #3b82f6)",
    color: "white",
    border: "none",
    borderRadius: "3px",
    fontSize: "12px",
    lineHeight: "1",
    fontWeight: "600",
    cursor: "pointer",
    opacity: "0",
    transition: "opacity 80ms ease-in-out",
  },
  // Show the "+" only when the gutter cell itself is hovered.
  // Bigger hit area than a plain icon-on-line approach since the
  // gutter cell spans the whole line height.
  ".cm-gutter-add-comment .cm-gutterElement:hover .cm-pr-add-comment-btn": {
    opacity: "1",
  },
  ".cm-pr-add-comment-btn:hover": {
    background: "var(--accent-hover, #2563eb)",
  },
  // ── Comment block (existing comments + composer when open) ─────
  ".cm-pr-comment-block": {
    margin: "4px 0 4px 32px",
    padding: "8px 10px",
    background: "var(--cm-comment-bg, rgba(120, 120, 130, 0.08))",
    borderLeft: "2px solid var(--cm-comment-border, rgba(120, 120, 130, 0.4))",
    borderRadius: "4px",
    fontSize: "12px",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  },
  ".cm-pr-comment": {
    display: "flex",
    gap: "6px",
    margin: "2px 0",
    alignItems: "baseline",
  },
  ".cm-pr-comment-author": {
    fontWeight: "600",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
    fontSize: "11px",
    opacity: "0.8",
  },
  ".cm-pr-comment-body": {
    flex: "1",
    whiteSpace: "pre-wrap",
  },
  ".cm-pr-comment-composer": {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    marginTop: "6px",
  },
  ".cm-pr-comment-textarea": {
    width: "100%",
    minHeight: "60px",
    padding: "6px 8px",
    border: "1px solid rgba(120, 120, 130, 0.3)",
    borderRadius: "4px",
    background: "var(--cm-composer-bg, rgba(255, 255, 255, 0.6))",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "12px",
    lineHeight: "1.5",
    resize: "vertical",
    boxSizing: "border-box",
  },
  ".cm-pr-comment-textarea:focus": {
    outline: "none",
    borderColor: "var(--accent, #3b82f6)",
    boxShadow: "0 0 0 2px rgba(59, 130, 246, 0.15)",
  },
  ".cm-pr-comment-actions": {
    display: "flex",
    gap: "6px",
    justifyContent: "flex-end",
  },
  ".cm-pr-comment-cancel": {
    padding: "4px 12px",
    border: "1px solid rgba(120, 120, 130, 0.3)",
    borderRadius: "4px",
    background: "transparent",
    color: "inherit",
    fontSize: "11px",
    fontWeight: "500",
    cursor: "pointer",
  },
  ".cm-pr-comment-cancel:hover": {
    background: "rgba(120, 120, 130, 0.12)",
  },
  ".cm-pr-comment-submit": {
    padding: "4px 12px",
    border: "1px solid var(--accent, #3b82f6)",
    borderRadius: "4px",
    background: "var(--accent, #3b82f6)",
    color: "white",
    fontSize: "11px",
    fontWeight: "500",
    cursor: "pointer",
  },
  ".cm-pr-comment-submit:hover": {
    background: "var(--accent-hover, #2563eb)",
  },
  ".cm-pr-comment-submit:disabled, .cm-pr-comment-cancel:disabled": {
    opacity: "0.5",
    cursor: "wait",
  },
});

// ── Syntax highlight (matches the rest of the app) ───────────────

const baseHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "#c678dd" },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: "#e06c75" },
  { tag: [t.function(t.variableName), t.labelName], color: "#61afef" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#d19a66" },
  { tag: [t.definition(t.name), t.separator], color: "#abb2bf" },
  { tag: [t.typeName, t.className, t.number, t.changed], color: "#e5c07b" },
  { tag: [t.operator, t.operatorKeyword], color: "#56b6c2" },
  { tag: [t.string, t.special(t.string)], color: "#98c379" },
  { tag: [t.meta, t.comment], color: "#7f848e", fontStyle: "italic" },
  { tag: t.heading, fontWeight: "bold", color: "#e06c75" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "#d19a66" },
]);

// ── Component ────────────────────────────────────────────────────

export function DiffViewer({
  patch,
  fileName,
  isDark = false,
  comments = [],
  onAddComment,
}: DiffViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  const reconstructed = useMemo(() => reconstructPatch(patch), [patch]);
  const [languageExt, setLanguageExt] = useState<Extension | null>(null);

  // Resolve language by filename → @codemirror/language-data dynamic
  // import. Skip when there's no file name (e.g. raw text).
  useEffect(() => {
    let cancelled = false;
    if (!fileName) {
      setLanguageExt(null);
      return;
    }
    const desc = languages.find((l) => l.extensions.some((e) => fileName.endsWith("." + e)))
      ?? languages.find((l) => l.filename?.test(fileName));
    if (!desc) {
      setLanguageExt(null);
      return;
    }
    desc
      .load()
      .then((support) => {
        if (!cancelled) setLanguageExt(support);
      })
      .catch(() => {
        if (!cancelled) setLanguageExt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fileName]);

  const extensions = useMemo<Extension[]>(() => {
    return [
      // Add-comment gutter sits BEFORE the line numbers so the "+"
      // appears at the very left margin — same column users expect
      // from GitHub's diff view.
      addCommentGutter(),
      lineNumbers(),
      foldGutter(),
      drawSelection(),
      bracketMatching(),
      syntaxHighlighting(baseHighlight),
      ...(languageExt ? [languageExt] : []),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      makeEditorTheme(isDark),
      diffViewerTheme,
      unifiedMergeView({
        original: reconstructed.before,
        mergeControls: false,
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: { margin: 3, minSize: 4 },
      }),
      commentsField,
      composerLineField,
      commentDecorations,
    ];
    // languageExt updates after async load; rebuild extensions then.
  }, [reconstructed, isDark, languageExt]);

  // Mount / re-mount when the patch (and therefore extensions) changes.
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: reconstructed.after,
        extensions,
      }),
      parent: hostRef.current,
    });
    view.dispatch({
      effects: setComments.of({ comments, onAddComment }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // We deliberately rebuild on patch changes — the unified merge
    // view's `original` is fixed at construction time.
  }, [extensions, reconstructed.after]);

  // Hot-update comments without rebuilding the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: setComments.of({ comments, onAddComment }),
    });
  }, [comments, onAddComment]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />;
}
