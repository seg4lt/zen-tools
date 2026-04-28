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
 * A 1-pixel resize handle that lives between two panes. Captures pointer
 * down + mousemove globally so dragging keeps working when the cursor
 * leaves the handle's hitbox.
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

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const raw =
        direction === "x"
          ? e.clientX - startRef.current.pos
          : e.clientY - startRef.current.pos;
      const delta = inverse ? -raw : raw;
      const next = Math.min(max, Math.max(min, startRef.current.size + delta));
      onResize(next);
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, direction, min, max, inverse, onResize]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      startRef.current = {
        pos: direction === "x" ? e.clientX : e.clientY,
        size: initial,
      };
      setDragging(true);
    },
    [direction, initial],
  );

  return (
    <div
      onPointerDown={onPointerDown}
      className={cn(
        "shrink-0 bg-border transition-colors hover:bg-primary/40",
        direction === "x" ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
        dragging && "bg-primary/60",
      )}
      role="separator"
      aria-orientation={direction === "x" ? "vertical" : "horizontal"}
    />
  );
}
