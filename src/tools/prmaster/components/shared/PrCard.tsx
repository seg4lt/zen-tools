/**
 * Generic PR list-row, used by Mine / To Review / Done tabs.
 *
 * shadcn `Card` with a clickable button surface. Visuals lean entirely on
 * theme tokens (`accent`, `muted-foreground`, `secondary`, `destructive`).
 */

import { GitPullRequest } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PullRequest, ReviewDecision } from "../../lib/tauri";

interface Props {
  pr: PullRequest;
  selected?: boolean;
  decision?: ReviewDecision | null;
  onSelect?: () => void;
}

export function PrCard({ pr, selected = false, decision, onSelect }: Props) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex w-full flex-col gap-0.5 rounded-md border bg-card px-2.5 py-1.5 text-left text-sm transition-colors",
        "hover:bg-accent/60",
        selected && "border-ring bg-accent",
      )}
    >
      <div className="flex items-start gap-2">
        <GitPullRequest
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            pr.isDraft ? "text-muted-foreground" : "text-foreground",
          )}
        />
        <span className="line-clamp-2 flex-1 text-sm font-medium">
          {pr.title}
        </span>
        {decision && decision !== "Unknown" && (
          <DecisionBadge decision={decision} />
        )}
      </div>
      <div className="ml-5 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">
          {pr.repository.nameWithOwner}#{pr.number}
        </span>
        {pr.author?.login && <span>by @{pr.author.login}</span>}
        {pr.isDraft && (
          <Badge variant="outline" className="text-[10px] uppercase">
            Draft
          </Badge>
        )}
        <span className="ml-auto">{relativeTime(pr.updatedAt)}</span>
      </div>
    </button>
  );
}

function DecisionBadge({ decision }: { decision: ReviewDecision }) {
  switch (decision) {
    case "APPROVED":
      return <Badge variant="secondary">Approved</Badge>;
    case "CHANGES_REQUESTED":
      return <Badge variant="destructive">Changes</Badge>;
    case "REVIEW_REQUIRED":
      return <Badge variant="outline">Needs review</Badge>;
    default:
      return null;
  }
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
