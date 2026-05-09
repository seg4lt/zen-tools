/**
 * Visual connector strip drawn between two CodeMirror editors. For
 * each pair of matching conflict ranges (`local` ↔ `remote`) we emit
 * an SVG quadrilateral that links the LOCAL hunk's y-range to the
 * REMOTE hunk's y-range, plus a small "accept this side" button
 * floating at the midpoint. Mirrors VSCode's merge-editor connector.
 *
 * Y-coordinates are pulled from each `EditorView` via `lineBlockAt`,
 * minus its `scrollDOM.scrollTop`, so the ribbons stay glued to their
 * lines as the user scrolls either pane. We re-render on:
 *   - scroll on either editor
 *   - resize on either scroll container
 *   - changes to the input `pairs` array (parsed change / active flip)
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { cn } from "@zen-tools/ui";

export interface HunkPair {
  blockId: string;
  /** LOCAL pane: 1-based start line, inclusive. */
  localFrom: number;
  /** LOCAL pane: 1-based end line, inclusive. */
  localTo: number;
  /** REMOTE pane: 1-based start line, inclusive. */
  remoteFrom: number;
  /** REMOTE pane: 1-based end line, inclusive. */
  remoteTo: number;
  /** `true` for the conflict the user is currently navigating. */
  active: boolean;
  /** `true` once the user accepts a side; renders the ribbon dimmed. */
  resolved: boolean;
}

export interface HunkConnectorProps {
  pairs: HunkPair[];
  localView: EditorView | null;
  remoteView: EditorView | null;
  /** Width of the SVG strip, px. */
  width?: number;
  onAcceptLocal: (blockId: string) => void;
  onAcceptRemote: (blockId: string) => void;
}

interface RibbonRect {
  blockId: string;
  active: boolean;
  resolved: boolean;
  yLT: number; // local top
  yLB: number; // local bottom
  yRT: number; // remote top
  yRB: number; // remote bottom
}

export function HunkConnector({
  pairs,
  localView,
  remoteView,
  width = 56,
  onAcceptLocal,
  onAcceptRemote,
}: HunkConnectorProps) {
  const [rects, setRects] = useState<RibbonRect[]>([]);
  const [height, setHeight] = useState(0);
  // Ref to the strip's own DOM node so we can measure where the SVG
  // (0,0) actually paints in the page. Using the local editor's
  // `getBoundingClientRect().top` instead — like the previous
  // version did — was wrong: each `<Pane>` wraps its CodeEditor with
  // a header bar, but the connector strip is a *direct sibling* of
  // the panes with no header. So the connector's top sits at the
  // row top, while `localScrollDOM.top` sits below the LOCAL pane's
  // header. Subtracting `ldTop` from screen-y values therefore
  // over-shifted every ribbon up by exactly the pane header height.
  const stripRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!localView || !remoteView) {
      setRects([]);
      return;
    }

    const recompute = () => {
      const strip = stripRef.current;
      if (!strip) return;
      // Single shared origin: the connector strip's own screen-y.
      // Every line's y is converted to screen-space via
      // `lineScreenY` (which uses `view.documentTop` so it already
      // folds in `scrollTop`, contentDOM padding, and any chrome
      // above the editor) and then re-expressed relative to the
      // strip's top, so the SVG element placed at that y lands
      // exactly on the painted line.
      const stripTop = strip.getBoundingClientRect().top;
      const next: RibbonRect[] = [];
      for (const p of pairs) {
        const lFrom = lineScreenY(localView, p.localFrom, "top") - stripTop;
        const lTo = lineScreenY(localView, p.localTo, "bottom") - stripTop;
        const rFrom = lineScreenY(remoteView, p.remoteFrom, "top") - stripTop;
        const rTo = lineScreenY(remoteView, p.remoteTo, "bottom") - stripTop;
        next.push({
          blockId: p.blockId,
          active: p.active,
          resolved: p.resolved,
          yLT: lFrom,
          yLB: lTo,
          yRT: rFrom,
          yRB: rTo,
        });
      }
      setRects(next);
      // Track the strip's own height so the SVG canvas covers the
      // full vertical extent the connector occupies — using the
      // local editor's `clientHeight` would clip the bottom by the
      // pane-header height (mirror of the origin bug above).
      setHeight(strip.clientHeight);
    };

    recompute();
    const onLocalScroll = () => recompute();
    const onRemoteScroll = () => recompute();
    localView.scrollDOM.addEventListener("scroll", onLocalScroll, {
      passive: true,
    });
    remoteView.scrollDOM.addEventListener("scroll", onRemoteScroll, {
      passive: true,
    });
    const ro = new ResizeObserver(recompute);
    ro.observe(localView.scrollDOM);
    ro.observe(remoteView.scrollDOM);
    // Also watch the strip itself — its height drives the SVG canvas
    // size, and a parent flex change (e.g. drag-resizing the
    // RESULT/top split) only fires `resize` on the strip, not on the
    // editor scroll containers.
    if (stripRef.current) ro.observe(stripRef.current);
    return () => {
      localView.scrollDOM.removeEventListener("scroll", onLocalScroll);
      remoteView.scrollDOM.removeEventListener("scroll", onRemoteScroll);
      ro.disconnect();
    };
  }, [pairs, localView, remoteView]);

  return (
    <div
      ref={stripRef}
      className="relative shrink-0 select-none border-x bg-muted/30"
      style={{ width }}
    >
      <svg
        width={width}
        height={height}
        className="pointer-events-none absolute inset-0"
      >
        {rects.map((r) => (
          <polygon
            key={r.blockId}
            points={`0,${r.yLT} ${width},${r.yRT} ${width},${r.yRB} 0,${r.yLB}`}
            className={cn(
              "transition-opacity",
              r.resolved
                ? "fill-emerald-500/15 stroke-emerald-500/40"
                : r.active
                  ? "fill-orange-500/35 stroke-orange-500"
                  : "fill-rose-500/10 stroke-rose-400/40",
            )}
            strokeWidth={r.active ? 1.5 : 1}
          />
        ))}
      </svg>

      {/* Accept-side buttons positioned at each ribbon's vertical
          midpoint. Pointer-events on the buttons themselves so the
          SVG underneath stays click-through. */}
      {rects.map((r) => {
        const midY = (Math.min(r.yLT, r.yRT) + Math.max(r.yLB, r.yRB)) / 2;
        return (
          <div
            key={r.blockId}
            className="absolute left-0 right-0 flex items-center justify-between px-0.5"
            style={{ top: midY - 12, height: 24 }}
          >
            <button
              type="button"
              onClick={() => onAcceptLocal(r.blockId)}
              disabled={r.resolved}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-sm border text-rose-500 transition-colors",
                r.resolved
                  ? "border-transparent opacity-30"
                  : "border-rose-500/40 bg-background hover:bg-rose-500/20",
              )}
              title="Accept LOCAL side"
            >
              <ChevronRight className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => onAcceptRemote(r.blockId)}
              disabled={r.resolved}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-sm border text-emerald-600 transition-colors",
                r.resolved
                  ? "border-transparent opacity-30"
                  : "border-emerald-500/40 bg-background hover:bg-emerald-500/20",
              )}
              title="Accept REMOTE side"
            >
              <ChevronLeft className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Screen-space y of `line` (1-based) in the editor — the absolute
 *  page coordinate where the row's top (or bottom) is currently
 *  painted. Caller is expected to subtract its own reference point
 *  (e.g. the connector wrapper's screen top) to convert into a local
 *  layout coordinate.
 *
 *  Implementation: `view.documentTop` is the screen-y of the
 *  contentDOM's origin and is recomputed by CodeMirror on every
 *  measurement pass — so it already accounts for the editor's
 *  current `scrollTop`, the contentDOM's padding, and any chrome
 *  rendered above the editor (toolbars, headers, etc). Adding the
 *  block's content-space `top` therefore gives an honest screen-y.
 *  We deliberately don't use `coordsAtPos` because it returns `null`
 *  when the line is outside the rendered viewport, which would make
 *  the ribbon disappear during scroll. */
function lineScreenY(
  view: EditorView,
  line: number,
  edge: "top" | "bottom",
): number {
  const total = view.state.doc.lines;
  const clamped = Math.max(1, Math.min(total, line));
  const pos = view.state.doc.line(clamped).from;
  const block = view.lineBlockAt(pos);
  const docTop = view.documentTop;
  return edge === "top" ? block.top + docTop : block.bottom + docTop;
}
