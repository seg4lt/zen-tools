import { Check, CircleDashed, Loader2, Sparkles } from "lucide-react";
import { cn } from "@zen-tools/ui";
import type { PrReviewSlot } from "../../store/ai-review-store";

export type AiReviewIndicatorState = "none" | "done" | "reviewing";

export function aiReviewIndicatorState(
  slot: PrReviewSlot,
): AiReviewIndicatorState {
  if (slot.status === "starting" || slot.status === "running") {
    return "reviewing";
  }
  if (slot.status === "done" || slot.hasCompletedReview) return "done";
  return "none";
}

export function AiReviewStatusBadge({
  slot,
  className,
}: {
  slot: PrReviewSlot;
  className?: string;
}) {
  const state = aiReviewIndicatorState(slot);

  return (
    <span
      title={
        state === "reviewing"
          ? "AI code review is running"
          : state === "done"
            ? "AI code review completed"
            : "No completed AI code review"
      }
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium",
        state === "reviewing" &&
          "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
        state === "done" &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        state === "none" &&
          "border-border bg-muted/40 text-muted-foreground",
        className,
      )}
    >
      <Sparkles className="size-3" />
      {state === "reviewing" ? (
        <Loader2 className="size-3 animate-spin" />
      ) : state === "done" ? (
        <Check className="size-3" />
      ) : (
        <CircleDashed className="size-3" />
      )}
      {state === "reviewing"
        ? "Reviewing"
        : state === "done"
          ? "AI review done"
          : "No AI review"}
    </span>
  );
}
