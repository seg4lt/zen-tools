/**
 * Live-preview ViewPlugin.
 *
 * Walks the markdown syntax tree under the visible viewport on every
 * doc/selection change and emits CodeMirror `Decoration`s that:
 *
 *   1. Hide markup characters (`#`, `*`, `**`, backticks, link
 *      brackets) on lines where the cursor isn't currently parked.
 *   2. Apply heading line classes (`cm-md-h1` … `cm-md-h6`) so CSS
 *      can size them like Obsidian.
 *   3. Swap `![alt](path)` for an inline image widget when the line
 *      doesn't have the cursor.
 *   4. Mark `[[wikilinks]]` with a clickable class.  The actual click
 *      → navigate behaviour is wired separately in `wikilink.ts` so
 *      the store dispatch lives outside the plugin.
 *
 * The plugin is intentionally read-only — it never edits the document.
 * Saved state is just the current `DecorationSet`, which is recomputed
 * from scratch on each update; for our typical doc sizes (a few KB to
 * a few hundred KB) that's measurably cheaper than tracking diffs.
 */

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { ImageWidget, resolveImageSrc } from "./image-widget";

/** Wikilink `[[Note Name]]` — basic regex, doesn't support escapes. */
const WIKILINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

/**
 * Build the decoration set for the current doc + selection.
 *
 * Lifecycle (called on every update + on first construct):
 *   1. Iterate the syntax tree for syntactically-tagged markup.
 *   2. Iterate every visible line again for wikilink detection (lezer-
 *      markdown doesn't know `[[…]]`).
 *
 * Decorations are emitted in **document order** — `RangeSetBuilder`
 * enforces that and would throw otherwise.  We pre-collect everything
 * into an array so we can sort once at the end.
 */
function buildDecorations(
  state: EditorState,
  docDir: string,
): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const lineDecorations: Range<Decoration>[] = [];
  const cursor = state.selection.main.head;
  const cursorLine = state.doc.lineAt(cursor).number;
  const tree = syntaxTree(state);

  // ── Pass 1: syntax-tree walk ────────────────────────────────────
  tree.iterate({
    from: 0,
    to: state.doc.length,
    enter: (node) => {
      const type = node.type.name;

      // Heading lines: ATXHeading1..6 → cm-md-hN line decoration.
      if (type.startsWith("ATXHeading")) {
        const level = parseInt(type.slice("ATXHeading".length), 10);
        if (level >= 1 && level <= 6) {
          const line = state.doc.lineAt(node.from);
          lineDecorations.push(
            Decoration.line({ class: `cm-md-h${level}` }).range(line.from),
          );
        }
        return; // children (HeaderMark, etc.) handled by mark hiding below
      }

      // Block quote lines.
      if (type === "Blockquote") {
        let pos = node.from;
        while (pos <= node.to) {
          const line = state.doc.lineAt(pos);
          lineDecorations.push(
            Decoration.line({ class: "cm-md-blockquote" }).range(line.from),
          );
          if (line.to >= node.to) break;
          pos = line.to + 1;
        }
        return;
      }

      // Image: replace the entire `![alt](path)` with the widget when
      // the cursor isn't on that line.  We pull the raw text once and
      // parse with a small regex — the lezer tree gives us LinkMark /
      // URL nodes but stitching them together is fiddlier than just
      // using the full image text.
      //
      // No `block: true` — that mode requires the range to span line
      // boundaries, which an Image node's `from..to` doesn't.  An
      // inline replace works for both "image alone on a line" and
      // "image embedded in a paragraph" cases; the widget's CSS gives
      // it block-level visual layout.
      if (type === "Image") {
        const line = state.doc.lineAt(node.from);
        if (line.number === cursorLine) return; // editable
        const text = state.doc.sliceString(node.from, node.to);
        const m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(text);
        if (m) {
          const [, alt, src] = m;
          const { resolved, isLocal } = resolveImageSrc(src, docDir);
          decorations.push(
            Decoration.replace({
              widget: new ImageWidget(resolved, alt, isLocal),
            }).range(node.from, node.to),
          );
        }
        return;
      }

      // Inline-code: monospace/bg style.  The backticks are inside
      // CodeMark children which we hide separately below.
      if (type === "InlineCode") {
        decorations.push(
          Decoration.mark({ class: "cm-md-inline-code" }).range(
            node.from,
            node.to,
          ),
        );
        return;
      }

      // Bold / italic / strikethrough body.
      if (type === "StrongEmphasis") {
        decorations.push(
          Decoration.mark({ class: "cm-md-bold" }).range(node.from, node.to),
        );
        return;
      }
      if (type === "Emphasis") {
        decorations.push(
          Decoration.mark({ class: "cm-md-italic" }).range(node.from, node.to),
        );
        return;
      }
      if (type === "Strikethrough") {
        decorations.push(
          Decoration.mark({ class: "cm-md-strikethrough" }).range(
            node.from,
            node.to,
          ),
        );
        return;
      }

      // Standard markdown links — style the body, hide brackets.
      // We also pull the URL out of the lezer subtree and stash it on
      // the decoration as `data-link-url`; the click handler below
      // reads that attribute to navigate without re-walking the tree.
      if (type === "Link") {
        let url = "";
        const cur = node.node.cursor();
        if (cur.firstChild()) {
          do {
            if (cur.type.name === "URL") {
              url = state.doc.sliceString(cur.from, cur.to).trim();
              break;
            }
          } while (cur.nextSibling());
        }
        decorations.push(
          Decoration.mark({
            class: "cm-md-link",
            attributes: url ? { "data-link-url": url } : {},
          }).range(node.from, node.to),
        );
        return;
      }

      // Mark-character hiding.  Any of these node types represents a
      // run of literal markup chars that we want to vanish on lines
      // where the cursor isn't.
      const isMarkup =
        type === "HeaderMark" ||
        type === "EmphasisMark" ||
        type === "CodeMark" ||
        type === "LinkMark" ||
        type === "QuoteMark" ||
        type === "ListMark";
      if (isMarkup) {
        const line = state.doc.lineAt(node.from);
        if (line.number === cursorLine) return; // leave visible while editing
        // Skip empty markers (defensive — lezer can produce zero-width
        // nodes near edge cases).
        if (node.to === node.from) return;
        decorations.push(
          Decoration.replace({}).range(node.from, node.to),
        );
      }
    },
  });

  // ── Pass 2: wikilink scan ──────────────────────────────────────
  // lezer-markdown doesn't know `[[…]]`, so we scan visible lines
  // ourselves.  Cheap (typical doc has a handful of wikilinks).
  const docText = state.doc.toString();
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(docText)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const line = state.doc.lineAt(start);
    if (line.number === cursorLine) {
      // While editing the line keep the brackets visible but still
      // mark the inner text — visual hint that the link will resolve.
      decorations.push(
        Decoration.mark({ class: "cm-md-wikilink" }).range(start, end),
      );
    } else {
      // Hide the brackets; render only `Note Name` styled.
      decorations.push(
        Decoration.replace({}).range(start, start + 2),
      );
      decorations.push(
        Decoration.mark({
          class: "cm-md-wikilink",
          attributes: { "data-wikilink": m[1] },
        }).range(start + 2, end - 2),
      );
      decorations.push(
        Decoration.replace({}).range(end - 2, end),
      );
    }
  }

  // CodeMirror's RangeSetBuilder requires sorted, non-overlapping
  // ranges.  Sort by start, then by end (line decorations have zero
  // length and must come before mark/replace decorations starting at
  // the same offset).
  decorations.sort((a, b) => a.from - b.from || a.to - b.to);
  lineDecorations.sort((a, b) => a.from - b.from);

  // Merge: line decorations first per offset, then mark/replace.
  // RangeSet's `.update({ add })` is the easiest way to combine two
  // pre-sorted arrays without re-doing the sort.
  const out = new RangeSetBuilder<Decoration>();
  let i = 0;
  let j = 0;
  while (i < lineDecorations.length || j < decorations.length) {
    const next =
      i < lineDecorations.length &&
      (j >= decorations.length ||
        lineDecorations[i].from <= decorations[j].from)
        ? lineDecorations[i++]
        : decorations[j++];
    out.add(next.from, next.to, next.value);
  }
  return out.finish();
}

/**
 * Public extension factory.  `getDocDir()` is a callback so the plugin
 * can re-resolve image paths whenever the open document changes
 * without needing a `Compartment` reconfigure.
 */
export function livePreviewPlugin(getDocDir: () => string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view.state, getDocDir());
      }

      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) {
          this.decorations = buildDecorations(u.state, getDocDir());
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}
