/** Deep-linkable PR detail page used by native notification clicks. */

import { useCallback, useEffect, useMemo } from "react";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { Button } from "@zen-tools/ui";
import { PrDetailPanel } from "./components/shared/PrDetailPanel";
import {
  enrichedId,
  refreshAll,
  usePrMasterStore,
} from "./store/prmaster-store";
import type { EnrichedPullRequest } from "./lib/tauri";

function findPr(
  lists: EnrichedPullRequest[][],
  owner: string,
  repo: string,
  number: number,
): EnrichedPullRequest | null {
  const target = `${owner}/${repo}#${number}`;
  for (const list of lists) {
    const hit = list.find((row) => enrichedId(row) === target);
    if (hit) return hit;
  }
  return null;
}

export function PRMasterDetailPage() {
  const params = useParams({
    from: "/prmaster/detail/$owner/$repo/$number",
  });
  const number = Number.parseInt(params.number, 10);
  const navigate = useNavigate();
  const { state, dispatch } = usePrMasterStore();

  const pr = useMemo(
    () =>
      Number.isFinite(number)
        ? findPr(
            [state.toReview, state.reviewed, state.mine],
            params.owner,
            params.repo,
            number,
          )
        : null,
    [number, params.owner, params.repo, state.mine, state.reviewed, state.toReview],
  );

  useEffect(() => {
    if (!pr) return;
    const id = enrichedId(pr);
    if (state.selectedPrId !== id) dispatch({ type: "select", id });
  }, [dispatch, pr, state.selectedPrId]);

  const refresh = useCallback(
    () => void refreshAll(dispatch),
    [dispatch],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="relative flex h-9 shrink-0 items-center border-b bg-card/40 px-2">
        <div className="absolute inset-y-0 left-2 flex items-center">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void navigate({ to: "/prmaster" })}
            aria-label="Back to PRMaster"
          >
            <ArrowLeft className="size-3.5" />
            Back
          </Button>
        </div>
        <div className="mx-auto flex min-w-0 max-w-[60%] items-baseline gap-2">
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {params.owner}/{params.repo}#{params.number}
          </span>
          {pr?.pr.title && (
            <span className="truncate text-sm font-medium" title={pr.pr.title}>
              {pr.pr.title}
            </span>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        {pr ? (
          <PrDetailPanel
            pr={pr}
            currentUser={state.currentUser}
            onActionDone={refresh}
          />
        ) : state.bootstrapping || Object.values(state.loading).some(Boolean) ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading pull request…
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">
              This pull request is no longer in your active PRMaster lists.
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={refresh}>
                Refresh lists
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void openUrl(
                    `https://github.com/${params.owner}/${params.repo}/pull/${params.number}`,
                  )
                }
              >
                <ExternalLink className="size-3.5" />
                Open on GitHub
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
