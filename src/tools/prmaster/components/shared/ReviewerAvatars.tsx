/**
 * Per-reviewer chips for the PR detail panel. Uses shadcn Badge variants.
 */

import { Badge } from "@/components/ui/badge";
import type { EnrichedPullRequest, ReviewState } from "../../lib/tauri";

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
    <div className="flex flex-wrap gap-1.5">
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
  const { label, variant } = (() => {
    switch (state) {
      case "APPROVED":
        return { label: "approved", variant: "secondary" as const };
      case "CHANGES_REQUESTED":
        return { label: "changes", variant: "destructive" as const };
      case "COMMENTED":
        return { label: "commented", variant: "outline" as const };
      case "DISMISSED":
        return { label: "dismissed", variant: "outline" as const };
      case "PENDING":
      case null:
        return { label: "pending", variant: "outline" as const };
      default:
        return { label: String(state ?? "?"), variant: "outline" as const };
    }
  })();
  return (
    <Badge variant={variant} className="gap-1">
      <span className="font-medium">@{login}</span>
      <span className="opacity-70">· {label}</span>
    </Badge>
  );
}
