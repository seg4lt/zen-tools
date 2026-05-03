/**
 * Recursive renderer for a `SplitNode` tree.
 *
 * Each branch becomes a flex container (row for `vertical` splits,
 * column for `horizontal`) whose children are sized by `flex-basis: 0`
 * + `flex-grow: ratio` / `flex-grow: 1 - ratio`, with a draggable
 * 1-px separator between them. Each leaf is rendered by the caller's
 * `renderLeaf(id, focused)` function.
 *
 * The layout owns the resize gesture (pointer-capture, ratio
 * clamping) but doesn't own the split-tree state itself: the host
 * passes the `root` and receives `onResize(branchPath, ratio)`
 * dispatches.
 */

import {
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { SplitDirection, SplitNode } from "./split-tree";

export interface SplitLayoutProps {
  /** Root of the split tree. */
  root: SplitNode;
  /** Currently focused leaf id (for visual highlight + click-to-focus parity). */
  focusedLeafId: string | null;
  /** Render the editor + chrome for the leaf with the given id. */
  renderLeaf: (leafId: string, focused: boolean) => ReactNode;
  /** Fire when the user clicks anywhere inside a leaf — host updates focus state. */
  onFocusLeaf: (leafId: string) => void;
  /**
   * Fire when the user drags a separator. `path` is a sequence of
   * `0` / `1` characters describing the descent from the root to the
   * branch (`""` = root branch).
   */
  onResize: (branchPath: string, ratio: number) => void;
}

export function SplitLayout({
  root,
  focusedLeafId,
  renderLeaf,
  onFocusLeaf,
  onResize,
}: SplitLayoutProps) {
  return (
    <RenderNode
      node={root}
      path=""
      focused={focusedLeafId}
      renderLeaf={renderLeaf}
      onFocus={onFocusLeaf}
      onResize={onResize}
    />
  );
}

interface RenderNodeProps {
  node: SplitNode;
  path: string;
  focused: string | null;
  renderLeaf: (id: string, focused: boolean) => ReactNode;
  onFocus: (id: string) => void;
  onResize: (path: string, ratio: number) => void;
}

function RenderNode({
  node,
  path,
  focused,
  renderLeaf,
  onFocus,
  onResize,
}: RenderNodeProps) {
  if (node.kind === "leaf") {
    const isFocused = focused === node.id;
    // `pointerdown` at capture phase keeps focus tracking working
    // even when the leaf's editor stops the event from bubbling.
    return (
      <div
        className="flex h-full w-full min-h-0 min-w-0"
        onPointerDownCapture={() => onFocus(node.id)}
      >
        {renderLeaf(node.id, isFocused)}
      </div>
    );
  }

  const isVertical = node.direction === "vertical";
  const containerClass = isVertical
    ? "flex h-full w-full min-h-0 min-w-0 flex-row"
    : "flex h-full w-full min-h-0 min-w-0 flex-col";
  const firstStyle: CSSProperties = {
    flex: `${node.ratio} 1 0`,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  };
  const secondStyle: CSSProperties = {
    flex: `${1 - node.ratio} 1 0`,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  };

  return (
    <div className={containerClass}>
      <div style={firstStyle}>
        <RenderNode
          node={node.first}
          path={path + "0"}
          focused={focused}
          renderLeaf={renderLeaf}
          onFocus={onFocus}
          onResize={onResize}
        />
      </div>
      <SplitHandle
        direction={node.direction}
        onChange={(ratio) => onResize(path, ratio)}
      />
      <div style={secondStyle}>
        <RenderNode
          node={node.second}
          path={path + "1"}
          focused={focused}
          renderLeaf={renderLeaf}
          onFocus={onFocus}
          onResize={onResize}
        />
      </div>
    </div>
  );
}

/**
 * Drag handle between two siblings. Uses pointer capture so the
 * gesture survives the cursor leaving the webview (matches the
 * pattern in the app's existing `<DragHandle>`).
 *
 * Computes the new ratio off the parent flex container's
 * bounding-rect — independent of nesting depth, since each
 * branch's "parent" is its own flex row/column.
 */
function SplitHandle({
  direction,
  onChange,
}: {
  direction: SplitDirection;
  onChange: (ratio: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const isVertical = direction === "vertical";

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const parent = e.currentTarget.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const ratio = isVertical
      ? (e.clientX - rect.left) / Math.max(1, rect.width)
      : (e.clientY - rect.top) / Math.max(1, rect.height);
    onChange(ratio);
  };

  const stop = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  };

  // Visible separator is 1 px; the interactive area is widened to
  // ~6 px via negative margins so the cursor doesn't have to land
  // on a single pixel (mirrors the app's existing `<DragHandle>`).
  const baseClass = "group relative shrink-0 z-10 select-none touch-none";
  const orientationClass = isVertical
    ? "w-1.5 -mx-[3px] cursor-col-resize"
    : "h-1.5 -my-[3px] cursor-row-resize";

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      role="separator"
      aria-orientation={isVertical ? "vertical" : "horizontal"}
      className={`${baseClass} ${orientationClass}`}
    >
      <div
        aria-hidden
        className={
          isVertical
            ? `absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary/40 ${dragging ? "bg-primary/60" : ""}`
            : `absolute left-0 top-1/2 w-full h-px -translate-y-1/2 bg-border transition-colors group-hover:bg-primary/40 ${dragging ? "bg-primary/60" : ""}`
        }
      />
    </div>
  );
}
