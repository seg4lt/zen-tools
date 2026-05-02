/**
 * Generic PR list-row, used by Mine / To Review / Done tabs.
 *
 * Pulls the full `EnrichedPullRequest` rather than the bare `pr` so the
 * row can surface the same per-row chrome the Swift `MyPRRowView` does
 * (branch arrow, individual reviewer state icons), without each tab
 * having to plumb it.
 */

import {
  ArrowDown,
  Check,
  CircleDashed,
  CircleHelp,
  GitBranch,
  GitPullRequest,
  MessageCircle,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  EnrichedPullRequest,
  ReviewDecision,
  ReviewState,
} from "../../lib/tauri";

interface Props {
  enriched: EnrichedPullRequest;
  selected?: boolean;
  onSelect?: () => void;
}

export function PrCard({ enriched, selected = false, onSelect }: Props) {
  const { pr, detail, reviews, requestedReviewers, reviewDecision } = enriched;
  const headRef = detail?.headRefName ?? null;
  const baseRef = detail?.baseRefName ?? null;

  // De-dupe reviews so we only show the latest state per reviewer
  // (mirrors `MyPRsView.swift`'s `latestReviewByLogin`).
  const latestByLogin = new Map<string, ReviewState>();
  for (const r of reviews) {
    if (!r.author?.login) continue;
    latestByLogin.set(r.author.login, r.state);
  }
  const reviewerChips: Array<{ login: string; state: ReviewState | "PENDING" }> =
    [];
  for (const [login, state] of latestByLogin) {
    reviewerChips.push({ login, state });
  }
  for (const login of requestedReviewers) {
    if (!latestByLogin.has(login)) {
      reviewerChips.push({ login, state: "PENDING" });
    }
  }

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
        {reviewDecision && reviewDecision !== "Unknown" && (
          <DecisionBadge decision={reviewDecision} />
        )}
      </div>

      <div className="ml-5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="font-mono">
          {pr.repository.nameWithOwner}#{pr.number}
        </span>
        {pr.author?.login && <span>by @{pr.author.login}</span>}
        {pr.isDraft && (
          <Badge variant="outline" className="text-[10px] uppercase">
            Draft
          </Badge>
        )}
        {headRef && baseRef && (
          <span className="flex items-center gap-1 font-mono">
            <GitBranch className="size-3" />
            {headRef}
            <ArrowDown className="size-3 -rotate-90" />
            {baseRef}
          </span>
        )}
        {detail?.comments && detail.comments.totalCount > 0 && (
          <span className="flex items-center gap-1">
            <MessageCircle className="size-3" />
            {detail.comments.totalCount}
          </span>
        )}
        {reviewerChips.length > 0 && (
          <span className="flex items-center gap-1">
            {reviewerChips.slice(0, 5).map(({ login, state }) => (
              <ReviewerStateIcon key={login} login={login} state={state} />
            ))}
            {reviewerChips.length > 5 && (
              <span className="text-[10px]">+{reviewerChips.length - 5}</span>
            )}
          </span>
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

/** Mirrors Swift's per-reviewer state glyph (`MyPRsView.swift:144-173`):
 *  green check for approved, red X for changes requested, dashed grey
 *  ring for pending request, comment glyph for comment-only. */
function ReviewerStateIcon({
  login,
  state,
}: {
  login: string;
  state: ReviewState | "PENDING";
}) {
  let Icon: React.ComponentType<{ className?: string }>;
  let tone: string;
  let title: string;
  switch (state) {
    case "APPROVED":
      Icon = Check;
      tone = "text-emerald-600 dark:text-emerald-400";
      title = `${login} approved`;
      break;
    case "CHANGES_REQUESTED":
      Icon = X;
      tone = "text-destructive";
      title = `${login} requested changes`;
      break;
    case "COMMENTED":
      Icon = MessageCircle;
      tone = "text-blue-600 dark:text-blue-400";
      title = `${login} commented`;
      break;
    case "PENDING":
      Icon = CircleDashed;
      tone = "text-muted-foreground";
      title = `${login} requested as reviewer (no review yet)`;
      break;
    default:
      Icon = CircleHelp;
      tone = "text-muted-foreground";
      title = `${login} (${state})`;
      break;
  }
  return (
    <span title={title} className="inline-flex items-center">
      <Icon className={cn("size-3", tone)} />
    </span>
  );
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
