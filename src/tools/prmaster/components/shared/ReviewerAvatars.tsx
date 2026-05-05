/**
 * Compact reviewer chips for the PR detail panel.
 *
 * Each entry is a small avatar+dot pill: 18 px GitHub avatar with a
 * status dot overlay (green = approved, red = changes requested,
 * amber = commented, muted = pending). Hover shows `@login · state`.
 * Way shorter than the previous full `<Badge>` which doubled the row
 * height for no real signal.
 */

import { cn } from "@zen-tools/ui";
import type { EnrichedPullRequest, ReviewState } from "../../lib/tauri";
import { Avatar, type AvatarDotTone } from "./Avatar";

interface Props {
  pr: EnrichedPullRequest;
}

export function ReviewerAvatars({ pr }: Props) {
  const submitted = new Map<string, ReviewState>();
  for (const r of pr.reviews) {
    if (r.author?.login) submitted.set(r.author.login, r.state);
  }
  const everyone = new Set<string>([
    ...submitted.keys(),
    ...pr.requestedReviewers,
  ]);
  if (everyone.size === 0) {
    return (
      <span className="text-xs italic text-muted-foreground">No reviewers</span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {[...everyone].map((login) => (
        <ReviewerChip
          key={login}
          login={login}
          state={submitted.get(login) ?? null}
        />
      ))}
    </div>
  );
}

function ReviewerChip({
  login,
  state,
}: {
  login: string;
  state: ReviewState | null;
}) {
  const { label, tone } = describe(state);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full pl-0.5 pr-1.5",
        "text-[10px] text-foreground/80",
        "hover:bg-accent/40",
      )}
      title={`@${login} · ${label}`}
    >
      <Avatar login={login} size={18} dot={tone} />
      <span className="font-mono">{login}</span>
    </span>
  );
}

function describe(state: ReviewState | null): {
  label: string;
  tone: AvatarDotTone;
} {
  switch (state) {
    case "APPROVED":
      return { label: "approved", tone: "success" };
    case "CHANGES_REQUESTED":
      return { label: "changes requested", tone: "danger" };
    case "COMMENTED":
      return { label: "commented", tone: "warning" };
    case "DISMISSED":
      return { label: "dismissed", tone: "muted" };
    case "PENDING":
    case null:
      return { label: "pending", tone: "muted" };
    default:
      return { label: String(state ?? "?"), tone: "muted" };
  }
}
