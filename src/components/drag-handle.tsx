import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface DragHandleProps {
  /** Initial pixel size of the pane this handle controls. */
  initial: number;
  /** Minimum size in px. */
  min?: number;
  /** Maximum size in px. */
  max?: number;
  /** Direction this handle drags in. `"x"` resizes width, `"y"` resizes height. */
  direction?: "x" | "y";
  /**
   * Set when the controlled pane sits **after** the handle in flow order
   * (i.e. to the right for x, or below for y). Inverts the delta so that
   * dragging the handle towards the pane shrinks it, not grows it.
   */
  inverse?: boolean;
  /** Called whenever the pane size changes. */
  onResize: (size: number) => void;
}

/**
 * Resize handle between two panes.
 *
 * Uses the **Pointer Events API with element-level capture** rather than
 * window-scoped `mousemove`/`mouseup` listeners. This is what fixes the
 * "drag continues after I let go" symptom: when the cursor leaves the
 * Tauri webview during a drag, macOS would swallow the matching
 * `mouseup`, leaving our `dragging` flag stuck `true`. With
 * `setPointerCapture` the OS forwards every subsequent pointer event
 * (including `pointerup` and `pointercancel`) to the captured element
 * regardless of where the cursor actually is.
 *
 * The visible separator is 1 px to keep the layout tight; the
 * **interactive area is widened to ~6 px** via negative margins so the
 * cursor doesn't have to land on a single pixel.
 */
export function DragHandle({
  initial,
  min = 100,
  max = 1200,
  direction = "x",
  inverse = false,
  onResize,
}: DragHandleProps) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ pos: 0, size: initial });

  const stopDrag = useCallback(
    (el: HTMLDivElement, pointerId: number) => {
      if (el.hasPointerCapture(pointerId)) {
        el.releasePointerCapture(pointerId);
      }
      setDragging(false);
    },
    [],
  );

  // Aggressive on-mount safety net: if any *previous* version of this
  // component (or some other stale code path) left
  // `body.style.userSelect = "none"` behind, the editor — and every
  // other contenteditable surface — becomes un-selectable for the
  // rest of the session. Wipe any inline body styles we might have
  // ever set, on every DragHandle mount, regardless of who set them.
  useEffect(() => {
    if (document.body.style.userSelect) document.body.style.userSelect = "";
    if (document.body.style.cursor) document.body.style.cursor = "";
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Don't let CodeMirror or any other element behind us see the
      // press — its selection logic would steal focus and break the
      // capture mid-drag.
      e.preventDefault();
      e.stopPropagation();
      startRef.current = {
        pos: direction === "x" ? e.clientX : e.clientY,
        size: initial,
      };
      // Capture means subsequent pointer{move,up,cancel} fire on this
      // element no matter where the cursor goes — selection can't
      // start in another surface because those mousedown events
      // won't reach it. No body-level user-select toggling needed.
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
    },
    [direction, initial],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const raw =
        direction === "x"
          ? e.clientX - startRef.current.pos
          : e.clientY - startRef.current.pos;
      const delta = inverse ? -raw : raw;
      const next = Math.min(max, Math.max(min, startRef.current.size + delta));
      onResize(next);
    },
    [dragging, direction, min, max, inverse, onResize],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      stopDrag(e.currentTarget, e.pointerId);
    },
    [stopDrag],
  );

  // pointercancel fires when the OS interrupts the drag (window
  // dragged off-screen, app loses focus, etc.). Without this branch
  // the handle would be left stuck in its `dragging` state.
  const onPointerCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      stopDrag(e.currentTarget, e.pointerId);
    },
    [stopDrag],
  );

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      role="separator"
      aria-orientation={direction === "x" ? "vertical" : "horizontal"}
      className={cn(
        "group relative shrink-0 z-10 select-none touch-none",
        direction === "x"
          ? "w-1.5 -mx-[3px] cursor-col-resize"
          : "h-1.5 -my-[3px] cursor-row-resize",
      )}
    >
      <div
        aria-hidden
        className={cn(
          "absolute bg-border transition-colors group-hover:bg-primary/40",
          direction === "x"
            ? "left-1/2 top-0 h-full w-px -translate-x-1/2"
            : "left-0 top-1/2 w-full h-px -translate-y-1/2",
          dragging && "bg-primary/60",
        )}
      />
    </div>
  );
}
