/**
 * PRMaster — dedicated review page.
 *
 * Mounted at `/prmaster/review/$owner/$repo/$number`. The page is a
 * full-window workspace for reviewing one PR: header (back + title +
 * Unified/Split toggle) on top, `<PrFilesChangedView>` filling the
 * rest. The route is deep-linkable (URL-driven) so reload, "open in
 * new window", and the back/forward stack all work without losing
 * context.
 *
 * Why a dedicated page instead of an in-place expand: the previous
 * inline accordion squashed the diff into the right-hand detail
 * panel — fine for a glance, terrible for actually reading code.
 * Pressing **Review Pull Request** in `PrDetailPanel` now navigates
 * here so the diff editor has the entire viewport to breathe.
 *
 * Resolving the PR object: we look up the URL-pinned `(owner, repo,
 * number)` triple inside the global store's three lists (toReview,
 * reviewed, mine). The store is hydrated by the bootstrap snapshot
 * + the periodic `prmaster:refreshed` broadcast, so on a normal
 * navigation the row is always present. Direct hits before the
 * snapshot lands fall through to a "loading…" notice.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Columns2,
  FileDiff,
  MessageSquare,
  Rows2,
  Sparkles,
} from "lucide-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Button, Tabs, TabsList, TabsTrigger, cn } from "@zen-tools/ui";
import type { DiffViewMode } from "@zen-tools/editor";
import { PrFilesChangedView } from "./components/shared/PrFilesChangedView";
import { PrIssueCommentsView } from "./components/shared/PrIssueCommentsView";
import { PrAiReviewView } from "./components/shared/PrAiReviewView";
import {
  enrichedId,
  usePrMasterStore,
} from "./store/prmaster-store";
import { prRefFor, type EnrichedPullRequest } from "./lib/tauri";

const VIEW_MODE_KEY = "prmaster.reviewViewMode";

/** Top-level tab on the review page. */
type ReviewTab = "files" | "comments" | "ai-review";

/** Read the user's last selected view mode from localStorage. Falls
 *  back to `"unified"` when never set / storage unavailable / value
 *  malformed. The localStorage write happens in the toggle handler. */
function readStoredViewMode(): DiffViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY);
    return v === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

function findPr(
  state: ReturnType<typeof usePrMasterStore>["state"],
  owner: string,
  repo: string,
  number: number,
): EnrichedPullRequest | null {
  const target = `${owner}/${repo}#${number}`;
  for (const list of [state.toReview, state.reviewed, state.mine]) {
    const hit = list.find((row) => enrichedId(row) === target);
    if (hit) return hit;
  }
  return null;
}

export function PRMasterReviewPage() {
  const params = useParams({
    from: "/prmaster/review/$owner/$repo/$number",
  });
  const owner = params.owner;
  const repo = params.repo;
  const number = Number.parseInt(params.number, 10);

  const navigate = useNavigate();
  const { state, dispatch } = usePrMasterStore();

  const pr = useMemo(
    () =>
      Number.isFinite(number) ? findPr(state, owner, repo, number) : null,
    [state, owner, repo, number],
  );

  // Persisted view-mode choice. Lazy-init from localStorage so the
  // very first render already shows the user's preferred layout —
  // no flash of unified-view-then-flip-to-split on mount.
  const [viewMode, setViewMode] = useState<DiffViewMode>(() =>
    readStoredViewMode(),
  );

  // Top-level tab: Files (the diff workspace) vs Comments (the
  // general PR-level conversation). Defaults to Files since that's
  // the primary review surface; not persisted because each PR visit
  // should start on the diff.
  const [tab, setTab] = useState<ReviewTab>("files");

  const onChangeMode = useCallback((next: DiffViewMode) => {
    setViewMode(next);
    try {
      localStorage.setItem(VIEW_MODE_KEY, next);
    } catch {
      // Private browsing / quota exhaustion / Tauri webview without
      // storage — non-fatal, the toggle still works in-session.
    }
  }, []);

  // Keep the store's `selectedPrId` in sync with the route. When the
  // user clicks Back, we want the list view to show the PR detail
  // panel for this PR (not jump back to the bare list).
  useEffect(() => {
    if (pr) {
      const id = enrichedId(pr);
      if (state.selectedPrId !== id) {
        dispatch({ type: "select", id });
      }
    }
  }, [pr, dispatch, state.selectedPrId]);

  const onBack = useCallback(() => {
    void navigate({ to: "/prmaster" });
  }, [navigate]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* Header rail — back left, title + Files/Comments tabs in
          the middle, Unified/Split toggle on the right (only when
          on the Files tab; the Comments tab has nothing to toggle). */}
      <header className="relative flex h-9 shrink-0 items-center border-b bg-card/40 px-2">
        <div className="absolute inset-y-0 left-2 flex items-center">
          <Button
            size="xs"
            variant="ghost"
            onClick={onBack}
            aria-label="Back to PR detail"
          >
            <ArrowLeft className="size-3.5" />
            Back
          </Button>
        </div>
        <div className="mx-auto flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {owner}/{repo}#{number}
            </span>
            {pr?.pr.title && (
              <span
                className="truncate text-sm font-medium"
                title={pr.pr.title}
              >
                {pr.pr.title}
              </span>
            )}
          </div>
          <Tabs value={tab} onValueChange={(v) => setTab(v as ReviewTab)}>
            <TabsList className="h-6 gap-0.5 bg-transparent p-0">
              <SectionTabTrigger
                value="files"
                icon={<FileDiff className="size-3" />}
                label="Files"
              />
              <SectionTabTrigger
                value="comments"
                icon={<MessageSquare className="size-3" />}
                label="Comments"
              />
              <SectionTabTrigger
                value="ai-review"
                icon={<Sparkles className="size-3" />}
                label="AI review"
              />
            </TabsList>
          </Tabs>
        </div>
        {tab === "files" && (
          <div className="absolute inset-y-0 right-2 flex items-center">
            <Tabs
              value={viewMode}
              onValueChange={(v) => onChangeMode(v as DiffViewMode)}
            >
              <TabsList className="h-6 gap-0.5 bg-transparent p-0">
                <ViewToggleTrigger
                  value="unified"
                  icon={<Rows2 className="size-3" />}
                  label="Unified"
                />
                <ViewToggleTrigger
                  value="split"
                  icon={<Columns2 className="size-3" />}
                  label="Split"
                />
              </TabsList>
            </Tabs>
          </div>
        )}
      </header>

      {/* Body — Files tab renders the diff workspace; Comments tab
          renders the general PR-conversation list. Both fill the
          remaining vertical space. */}
      <div className="flex min-h-0 flex-1 flex-col p-2">
        {pr ? (
          tab === "files" ? (
            <PrFilesChangedView pr={pr} viewMode={viewMode} />
          ) : tab === "comments" ? (
            <PrIssueCommentsView pr={prRefFor(pr.pr)} />
          ) : (
            <PrAiReviewView pr={pr} />
          )
        ) : (
          <NotLoaded
            owner={owner}
            repo={repo}
            number={number}
            bootstrapping={state.bootstrapping}
            onBack={onBack}
          />
        )}
      </div>
    </div>
  );
}

function SectionTabTrigger({
  value,
  icon,
  label,
}: {
  value: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <TabsTrigger
      value={value}
      className={cn(
        "h-6 gap-1 rounded px-2 text-[11px] data-[state=active]:bg-accent",
      )}
      title={`Show ${label.toLowerCase()}`}
    >
      {icon}
      {label}
    </TabsTrigger>
  );
}

function ViewToggleTrigger({
  value,
  icon,
  label,
}: {
  value: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <TabsTrigger
      value={value}
      className={cn(
        "h-6 gap-1 rounded px-2 text-[11px] data-[state=active]:bg-accent",
      )}
      title={`${label} view`}
    >
      {icon}
      {label}
    </TabsTrigger>
  );
}

function NotLoaded({
  owner,
  repo,
  number,
  bootstrapping,
  onBack,
}: {
  owner: string;
  repo: string;
  number: number;
  bootstrapping: boolean;
  onBack: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center">
      <div className="grid max-w-md gap-3 rounded-md border bg-card/40 p-4 text-center text-xs text-muted-foreground">
        {bootstrapping ? (
          <>
            <span>Loading PR list…</span>
            <span>
              {owner}/{repo}#{Number.isFinite(number) ? number : "?"} will
              appear once the snapshot finishes loading.
            </span>
          </>
        ) : (
          <>
            <span>
              Couldn’t find {owner}/{repo}#
              {Number.isFinite(number) ? number : "?"} in the loaded PR
              lists.
            </span>
            <span>
              Open it from the Review / Done / Mine tabs, or refresh
              the list and try again.
            </span>
          </>
        )}
        <div className="flex justify-center">
          <Button size="xs" variant="outline" onClick={onBack}>
            <ArrowLeft className="size-3" />
            Back to PR list
          </Button>
        </div>
      </div>
    </div>
  );
}
