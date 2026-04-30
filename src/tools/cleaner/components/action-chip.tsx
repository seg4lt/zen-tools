/**
 * The action chip — a tiny inline pill that cycles between three
 * visual states (`none → clean → delete → none`) when the user presses
 * Space or clicks on it. Replaces the IDE-style dropdown the user
 * explicitly didn't want.
 *
 * Visual language:
 *   - `none`   → ghosted outlined dot, low contrast.
 *   - `clean`  → amber background + sparkle icon, "Clean" label.
 *   - `delete` → destructive red background + trash icon, "Delete" label.
 *
 * Animations come from Tailwind v4 transition utilities — there is no
 * spring physics so the chip stays cheap to render in long lists.
 */

import { Sparkles, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";
import type { CleanerNodeAction } from "../lib/tauri";
import { cn } from "@/lib/utils";

export interface ActionChipProps {
  action: CleanerNodeAction;
  /** Repos cycle through three states; globals only `none ↔ delete`. */
  kind: "repo" | "globalPath";
  /** Click handler. Receives the mouse event so callers can stop propagation. */
  onCycle: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Highlight as the keyboard cursor target. */
  active?: boolean;
  /** Disabled (e.g. while a run is in flight). */
  disabled?: boolean;
}

const PALETTE: Record<
  CleanerNodeAction,
  { label: string; classes: string; icon: typeof Sparkles | null }
> = {
  none: {
    label: "Skip",
    classes:
      "border border-dashed border-border/70 text-muted-foreground/70 hover:border-border hover:text-foreground",
    icon: null,
  },
  clean: {
    label: "Clean",
    classes:
      "border border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-300 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.15)]",
    icon: Sparkles,
  },
  delete: {
    label: "Delete",
    classes:
      "border border-destructive/60 bg-destructive/15 text-destructive shadow-[inset_0_0_0_1px_rgba(239,68,68,0.15)]",
    icon: Trash2,
  },
};

export function ActionChip({
  action,
  kind,
  onCycle,
  active,
  disabled,
}: ActionChipProps) {
  const palette = PALETTE[action];
  const Icon = palette.icon;
  const nextHint =
    action === "none"
      ? kind === "repo"
        ? "Press Space to mark Clean"
        : "Press Space to mark Delete"
      : action === "clean"
        ? "Press Space to mark Delete"
        : "Press Space to clear";

  return (
    <button
      type="button"
      onClick={onCycle}
      disabled={disabled}
      data-action={action}
      title={nextHint}
      className={cn(
        // Base layout
        "group/chip inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 font-mono text-[10px] uppercase tracking-wider",
        // Animated transitions on every visual property
        "transition-[background-color,border-color,color,transform,box-shadow] duration-150 ease-out",
        // Hover lift / press squish
        "hover:-translate-y-px active:translate-y-0 active:scale-[0.97]",
        // Focus ring (ours, since the row is a button too)
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        palette.classes,
        active && "ring-2 ring-ring/60 ring-offset-1 ring-offset-background",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {Icon ? (
        <Icon
          className={cn(
            "size-3 shrink-0",
            // Tiny "pop" each time the icon swaps in
            "animate-in fade-in zoom-in-75 duration-150",
          )}
        />
      ) : (
        <span
          aria-hidden
          className="size-1.5 rounded-full bg-current opacity-50"
        />
      )}
      <span className="leading-none">{palette.label}</span>
    </button>
  );
}
