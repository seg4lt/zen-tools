/**
 * Inline detail panel for a single PR — built on shadcn Card + Textarea
 * + Button so it shares the visual idiom of every other PRMaster form.
 *
 * Layout: header (title, repo#number, branches, mergeable status),
 * Reviewers, Checks, Action row (Approve / Request Changes / Add me /
 * Open / Copy). The Request-Changes flow swaps the action row for a
 * shadcn Textarea + Submit/Cancel pair.
 */

import { useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  CircleHelp,
  Copy,
  ExternalLink,
  GitBranch,
  Loader2,
  ShieldQuestion,
  UserPlus,
  X,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  prmasterTauri,
  prRefFor,
  type EnrichedPullRequest,
} from "../../lib/tauri";
import { CiChecks } from "./CiChecks";
import { Panel, PanelContent, PanelHeader } from "./density";
import { ReviewerAvatars } from "./ReviewerAvatars";

interface Props {
  pr: EnrichedPullRequest;
  /** Current user's login — drives the "Add me as reviewer" enable state. */
  currentUser: string | null;
  /** Called after a successful action so the parent can refetch the list. */
  onActionDone: () => void;
}

type Pending = "approve" | "request" | "add" | null;

export function PrDetailPanel({ pr, currentUser, onActionDone }: Props) {
  const [pending, setPending] = useState<Pending>(null);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [requestBody, setRequestBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  const ref = prRefFor(pr.pr);
  const detail = pr.detail;
  const rollup = detail?.commits?.nodes[0]?.commit.statusCheckRollup ?? null;
  const isAlreadyReviewer =
    !!currentUser &&
    (pr.requestedReviewers.includes(currentUser) ||
      pr.reviews.some((r) => r.author?.login === currentUser));

  async function withPending<T>(kind: Pending, fn: () => Promise<T>) {
    setError(null);
    setPending(kind);
    try {
      await fn();
      onActionDone();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <Panel>
      <PanelHeader className="flex flex-col items-stretch gap-1.5 px-3 py-2">
        <div className="flex items-start gap-2">
          <h3 className="flex-1 text-sm leading-tight font-semibold">
            {pr.pr.title}
          </h3>
          <span className="font-mono text-xs text-muted-foreground">
            {pr.pr.repository.nameWithOwner}#{pr.pr.number}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
          {pr.pr.author?.login && <span>by @{pr.pr.author.login}</span>}
          <span>opened {new Date(pr.pr.createdAt).toLocaleDateString()}</span>
          {pr.pr.isDraft && (
            <Badge variant="outline" className="text-[10px] uppercase">
              Draft
            </Badge>
          )}
          {detail?.headRefName && detail?.baseRefName && (
            <span className="flex items-center gap-1 font-mono">
              <GitBranch className="size-3" />
              {detail.headRefName}
              <ArrowDown className="size-3 -rotate-90" />
              {detail.baseRefName}
            </span>
          )}
          <MergeStatus
            mergeable={detail?.mergeable ?? null}
            state={detail?.mergeStateStatus ?? null}
          />
        </div>
      </PanelHeader>

      <PanelContent className="grid gap-2 p-2.5">
        <div className="grid gap-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Reviewers
          </Label>
          <ReviewerAvatars pr={pr} />
        </div>

        <div className="grid gap-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Checks
          </Label>
          <CiChecks rollup={rollup} />
        </div>

        <Separator />

        {error && (
          <pre className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs whitespace-pre-wrap text-destructive">
            {error}
          </pre>
        )}

        {showRequestForm ? (
          <div className="grid gap-2">
            <Label htmlFor="request-body" className="text-xs">
              Request changes — message
            </Label>
            <Textarea
              id="request-body"
              value={requestBody}
              onChange={(e) => setRequestBody(e.target.value)}
              rows={4}
              placeholder="What needs to change?"
              className="font-mono text-xs"
            />
            <div className="flex gap-2">
              <Button
                variant="destructive"
                disabled={pending !== null || requestBody.trim().length === 0}
                onClick={() =>
                  withPending("request", async () => {
                    await prmasterTauri.requestChanges(ref, requestBody.trim());
                    setShowRequestForm(false);
                    setRequestBody("");
                  })
                }
              >
                {pending === "request" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <X className="size-4" />
                )}
                Submit
              </Button>
              <Button
                variant="ghost"
                disabled={pending !== null}
                onClick={() => {
                  setShowRequestForm(false);
                  setRequestBody("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={pending !== null}
              onClick={() =>
                withPending("approve", () => prmasterTauri.approve(ref))
              }
            >
              {pending === "approve" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Approve
            </Button>
            <Button
              variant="destructive"
              disabled={pending !== null}
              onClick={() => setShowRequestForm(true)}
            >
              <X className="size-4" />
              Request changes
            </Button>
            {currentUser && !isAlreadyReviewer && (
              <Button
                variant="outline"
                disabled={pending !== null}
                onClick={() =>
                  withPending("add", () =>
                    prmasterTauri.addSelfReviewer(ref, currentUser),
                  )
                }
              >
                {pending === "add" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <UserPlus className="size-4" />
                )}
                Add me as reviewer
              </Button>
            )}
            <Button variant="ghost" onClick={() => void openUrl(pr.pr.url)}>
              <ExternalLink className="size-4" />
              Open
            </Button>
            <Button variant="ghost" onClick={() => void writeText(pr.pr.url)}>
              <Copy className="size-4" />
              Copy link
            </Button>
          </div>
        )}
      </PanelContent>
    </Panel>
  );
}

function MergeStatus({
  mergeable,
  state,
}: {
  mergeable: string | null;
  state: string | null;
}) {
  if (mergeable === "CONFLICTING" || state === "DIRTY") {
    return (
      <span className="flex items-center gap-1 text-destructive">
        <AlertTriangle className="size-3" /> Conflicts
      </span>
    );
  }
  switch (state) {
    case "BLOCKED":
      return (
        <span className="flex items-center gap-1">
          <ShieldQuestion className="size-3" /> Blocked
        </span>
      );
    case "BEHIND":
      return (
        <span className="flex items-center gap-1">
          <ArrowDown className="size-3" /> Behind
        </span>
      );
    case "UNSTABLE":
      return (
        <span className="flex items-center gap-1">
          <CircleHelp className="size-3" /> Unstable
        </span>
      );
    case "CLEAN":
      return (
        <span className="flex items-center gap-1">
          <Check className="size-3" /> Ready
        </span>
      );
    default:
      if (mergeable === "MERGEABLE") {
        return (
          <span className="flex items-center gap-1">
            <Check className="size-3" /> Mergeable
          </span>
        );
      }
      return null;
  }
}

function formatError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
