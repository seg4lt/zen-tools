/**
 * CodeMirror extension that paints conflict-region "hunks" in the
 * 3-way merge editor.
 *
 * Each pane (LOCAL / REMOTE / BASE / RESULT) installs the same
 * extension. Callers dispatch a [`setHunks`] effect whenever the set
 * of conflict ranges or the active conflict changes; the field
 * stores the current ranges and the view-plugin emits a `Decoration.line`
 * per affected line with classes:
 *
 *   `.cm-merge-line .cm-merge-{variant}`            — idle conflict
 *   `.cm-merge-line .cm-merge-{variant} .cm-merge-active` — active hunk
 *
 * The CSS for those classes lives in `merge-editor.css`.
 *
 * `dispatchHunks` and `scrollToHunk` are convenience helpers — the
 * 3-way editor captures each pane's `EditorView` via the editor's
 * `onView` callback and calls these in a `useEffect` keyed on
 * (parsed, activeIdx).
 */

import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

/** One conflict-region span in line-number space. */
export interface HunkSpan {
  /** 1-based line number, inclusive. */
  fromLine: number;
  /** 1-based line number, inclusive. */
  toLine: number;
  /** `true` for the conflict the user is currently navigating. */
  active: boolean;
  /** Pane variant — drives the colour palette. */
  variant: "local" | "remote" | "base" | "result";
}

/** Replace the current hunk set on a view. */
export const setHunks = StateEffect.define<HunkSpan[]>();

const hunkField = StateField.define<HunkSpan[]>({
  create: () => [],
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setHunks)) return e.value;
    }
    return value;
  },
});

const VARIANT_CLASS: Record<HunkSpan["variant"], string> = {
  local: "cm-merge-line cm-merge-local",
  remote: "cm-merge-line cm-merge-remote",
  base: "cm-merge-line cm-merge-base",
  result: "cm-merge-line cm-merge-result",
};

function buildDecorations(state: EditorState): DecorationSet {
  const ranges = state.field(hunkField);
  if (ranges.length === 0) return Decoration.none;
  // RangeSetBuilder requires monotonically-increasing offsets.
  const sorted = [...ranges].sort((a, b) => a.fromLine - b.fromLine);
  const total = state.doc.lines;
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of sorted) {
    const lo = Math.max(1, r.fromLine);
    const hi = Math.min(total, r.toLine);
    if (hi < lo) continue;
    const cls =
      VARIANT_CLASS[r.variant] + (r.active ? " cm-merge-active" : "");
    for (let l = lo; l <= hi; l++) {
      const line = state.doc.line(l);
      builder.add(
        line.from,
        line.from,
        Decoration.line({ attributes: { class: cls } }),
      );
    }
  }
  return builder.finish();
}

const hunkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.startState.field(hunkField) !== u.state.field(hunkField)
      ) {
        this.decorations = buildDecorations(u.state);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Add to a CodeEditor's `extensions` to enable hunk decorations. */
export const hunkHighlight: Extension = [hunkField, hunkPlugin];

/** Replace the entire hunk set on a view. Idempotent if `next`
 *  matches the current value. */
export function dispatchHunks(view: EditorView, next: HunkSpan[]): void {
  view.dispatch({ effects: setHunks.of(next) });
}

/** Center `fromLine` (1-based) in the visible viewport. Clamps to
 *  the document's line count so callers don't have to. */
export function scrollToHunk(view: EditorView, fromLine: number): void {
  const total = view.state.doc.lines;
  const target = Math.max(1, Math.min(total, fromLine));
  const line = view.state.doc.line(target);
  view.dispatch({
    effects: EditorView.scrollIntoView(line.from, { y: "center" }),
  });
}
