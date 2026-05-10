/**
 * Inline error card shown when the user tries to start an AI review
 * for a repo that isn't registered in PR Master Settings → Repo
 * Mappings. The CTA navigates them to Settings on the same window.
 */

import { Button } from "@zen-tools/ui";
import { ArrowRight, FolderSearch } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

interface Props {
  repo: string;
  onDismiss: () => void;
}

export function AiReviewMissingRepo({ repo, onDismiss }: Props) {
  const navigate = useNavigate();
  return (
    <div className="flex h-full min-h-0 items-center justify-center">
      <div className="grid max-w-md gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-5 text-center text-xs text-foreground">
        <FolderSearch className="mx-auto size-6 text-amber-500" />
        <div className="text-sm font-medium">Local clone not registered</div>
        <p className="text-muted-foreground">
          AI Review needs a local clone of{" "}
          <span className="font-mono">{repo}</span> so it can spin up a
          detached worktree at the PR's head commit. Add the path under
          PR Master → Settings → Repo Mappings.
        </p>
        <div className="flex justify-center gap-2">
          <Button
            size="xs"
            variant="default"
            onClick={() => {
              onDismiss();
              void navigate({ to: "/prmaster", search: { tab: "settings" } as never });
            }}
          >
            Open Settings
            <ArrowRight className="size-3" />
          </Button>
          <Button size="xs" variant="outline" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}
