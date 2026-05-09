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
import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (!localView || !remoteView) {
      setRects([]);
      return;
    }

    const recompute = () => {
      const ld = localView.scrollDOM;
      const rd = remoteView.scrollDOM;
      const ldTop = ld.getBoundingClientRect().top;
      // The connector strip is positioned absolutely against the
      // wrapper that contains both editors; its (0,0) lines up with
      // the top of the local editor's scroll container in the
      // page's coordinate space. We use a single reference point
      // (the local editor's box) so y-values for both sides are
      // expressed in the same coordinate system.
      const next: RibbonRect[] = [];
      for (const p of pairs) {
        const lFrom = lineY(localView, p.localFrom, "top") - ld.scrollTop;
        const lTo = lineY(localView, p.localTo, "bottom") - ld.scrollTop;
        const rFrom = lineY(remoteView, p.remoteFrom, "top") - rd.scrollTop;
        const rTo = lineY(remoteView, p.remoteTo, "bottom") - rd.scrollTop;
        // Adjust by the offset between the two scroll containers so
        // both columns share a single y-origin. Their tops are in
        // the same flex row, so this is usually 0.
        const remoteOffset = rd.getBoundingClientRect().top - ldTop;
        next.push({
          blockId: p.blockId,
          active: p.active,
          resolved: p.resolved,
          yLT: lFrom,
          yLB: lTo,
          yRT: rFrom + remoteOffset,
          yRB: rTo + remoteOffset,
        });
      }
      setRects(next);
      // Track parent height so the SVG fills the wrapper.
      setHeight(ld.clientHeight);
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
    return () => {
      localView.scrollDOM.removeEventListener("scroll", onLocalScroll);
      remoteView.scrollDOM.removeEventListener("scroll", onRemoteScroll);
      ro.disconnect();
    };
  }, [pairs, localView, remoteView]);

  return (
    <div
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

/** Pixel y of `line` (1-based) in the editor's content coordinate
 *  space (`top` of the line block, or `bottom`). Returns 0 for an
 *  out-of-range line. */
function lineY(view: EditorView, line: number, edge: "top" | "bottom"): number {
  const total = view.state.doc.lines;
  const clamped = Math.max(1, Math.min(total, line));
  const pos = view.state.doc.line(clamped).from;
  const block = view.lineBlockAt(pos);
  return edge === "top" ? block.top : block.bottom;
}
