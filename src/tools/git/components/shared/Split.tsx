/**
 * Tiny resizable split-pane primitive — two children, a draggable
 * gutter between them, persisted size in `localStorage`. Used by
 * the Git tool wherever the user wants to claw back screen real
 * estate (sidebar/main, file-rail/editor, log filter/list/detail,
 * 3-way editor LOCAL/REMOTE rows + top/RESULT row).
 *
 *   <Split direction="horizontal" storageKey="git.shell" defaultFirst={240}>
 *     <Sidebar />
 *     <Main />
 *   </Split>
 *
 * The first child is sized in pixels (resizable); the second child
 * is `flex: 1`. Drag the divider to resize. Min/max can be clamped
 * via `minFirst` / `maxFirst`. When `disabled` is true the divider
 * is hidden and the first child renders at its current size — used
 * by `<Split>` consumers to gate resize behind a "focus mode" or
 * "minimized" state.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@zen-tools/ui";

const STORAGE_PREFIX = "git.split:";

export interface SplitProps {
  /** "horizontal" → first child is the LEFT pane (resizable along X).
   *  "vertical"   → first child is the TOP pane (resizable along Y). */
  direction: "horizontal" | "vertical";
  /** Persisted-size key (`localStorage`). Omit for ephemeral sizes. */
  storageKey?: string;
  /** Initial pixel size of the first pane when no persisted value exists. */
  defaultFirst: number;
  /** Lower clamp for the first pane (default: 80). */
  minFirst?: number;
  /** Upper clamp for the first pane (default: 1000). */
  maxFirst?: number;
  /** Lower clamp for the second pane (default: 200). The drag is
   *  rejected if it would shrink the second pane below this. */
  minSecond?: number;
  /** Hide the gutter and freeze the size — useful when the host
   *  wants to "collapse" or "focus-mode" one side. */
  disabled?: boolean;
  /** When true, render only the second child (collapse first to 0). */
  collapseFirst?: boolean;
  /** Children: exactly two. */
  children: [ReactNode, ReactNode];
  /** Extra classes for the outer flex container. */
  className?: string;
}

export function Split({
  direction,
  storageKey,
  defaultFirst,
  minFirst = 80,
  maxFirst = 1000,
  minSecond = 200,
  disabled = false,
  collapseFirst = false,
  children,
  className,
}: SplitProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const isHorizontal = direction === "horizontal";

  const [first, setFirst] = useState<number>(() =>
    readPersisted(storageKey, defaultFirst, minFirst, maxFirst),
  );

  // If the host swaps the storage key (e.g. sidebar collapsed → expanded),
  // re-read the persisted size for the new key.
  useEffect(() => {
    setFirst(readPersisted(storageKey, defaultFirst, minFirst, maxFirst));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const persist = useCallback(
    (value: number) => {
      if (!storageKey) return;
      try {
        window.localStorage.setItem(STORAGE_PREFIX + storageKey, String(value));
      } catch {
        /* ignore */
      }
    },
    [storageKey],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled || collapseFirst) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      draggingRef.current = true;
      document.body.style.cursor = isHorizontal
        ? "col-resize"
        : "row-resize";
      document.body.style.userSelect = "none";
    },
    [disabled, collapseFirst, isHorizontal],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const total = isHorizontal ? rect.width : rect.height;
      const offset = isHorizontal
        ? e.clientX - rect.left
        : e.clientY - rect.top;
      const upper = Math.min(maxFirst, total - minSecond);
      const next = clamp(offset, minFirst, upper);
      setFirst(next);
    },
    [isHorizontal, maxFirst, minFirst, minSecond],
  );

  const stopDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    persist(first);
  }, [persist, first]);

  // Belt-and-suspenders: also stop on global pointerup so a drag that
  // ends outside the gutter element still releases.
  useEffect(() => {
    const onUp = () => stopDrag();
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [stopDrag]);

  const firstStyle = collapseFirst
    ? { display: "none" as const }
    : isHorizontal
      ? { width: first, flex: "0 0 auto" as const }
      : { height: first, flex: "0 0 auto" as const };

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex h-full min-h-0 w-full min-w-0",
        isHorizontal ? "flex-row" : "flex-col",
        className,
      )}
    >
      <div
        style={firstStyle}
        className="relative min-h-0 min-w-0 overflow-hidden"
      >
        {children[0]}
      </div>
      {!disabled && !collapseFirst && (
        <div
          role="separator"
          aria-orientation={isHorizontal ? "vertical" : "horizontal"}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={stopDrag}
          className={cn(
            "group relative shrink-0 bg-border transition-colors hover:bg-primary/40",
            isHorizontal
              ? "w-px cursor-col-resize"
              : "h-px cursor-row-resize",
          )}
        >
          {/* Wider hit-target overlay so the gutter is easy to grab
              without the visible bar being chunky. */}
          <span
            className={cn(
              "absolute z-10",
              isHorizontal
                ? "-left-1.5 -right-1.5 inset-y-0"
                : "-top-1.5 -bottom-1.5 inset-x-0",
            )}
          />
        </div>
      )}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {children[1]}
      </div>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function readPersisted(
  storageKey: string | undefined,
  fallback: number,
  lo: number,
  hi: number,
): number {
  if (storageKey) {
    try {
      const raw = window.localStorage.getItem(STORAGE_PREFIX + storageKey);
      if (raw !== null) {
        const n = Number.parseInt(raw, 10);
        if (Number.isFinite(n)) return clamp(n, lo, hi);
      }
    } catch {
      /* ignore */
    }
  }
  return clamp(fallback, lo, hi);
}
