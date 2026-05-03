/**
 * Detail panel for a single PR.
 *
 * The detail view already lives in its own routed area with a back-
 * button header — wrapping the body in another bordered card adds
 * nothing but visual noise (the user's words: "no card when I just
 * view the item, why need card that is my own space"). So this is a
 * flat layout: a metadata strip, two `Reviewers` / `Checks` blocks,
 * a separator, and the action row (Approve / Request Changes / Add me
 * as reviewer / Open / Copy). The Request-Changes flow swaps the
 * action row for a Textarea + Submit/Cancel pair.
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
import { Badge } from "@zen-tools/ui";
import { Button } from "@zen-tools/ui";
import { Label } from "@zen-tools/ui";
import { Separator } from "@zen-tools/ui";
import { Textarea } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import {
  prmasterTauri,
  prRefFor,
  type EnrichedPullRequest,
} from "../../lib/tauri";
import { CiChecks } from "./CiChecks";
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
    <div className="grid gap-2.5">
      {/* Metadata strip — flat, no card chrome (the routed detail view
          already owns the surrounding chrome). */}
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

      <div className="grid gap-2">
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
          <div className="grid gap-1.5">
            <Label
              htmlFor="request-body"
              className="text-[10px] uppercase tracking-wide text-muted-foreground"
            >
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
            <div className="flex gap-1">
              <Button
                size="xs"
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
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <X className="size-3" />
                )}
                Submit
              </Button>
              <Button
                size="xs"
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
          <div className="flex flex-wrap gap-1">
            <Button
              size="xs"
              className={cn(
                // GitHub-green Approve button — explicit colours rather
                // than a global theme variant so the rest of the app's
                // primary-colour scheme stays untouched.
                "bg-emerald-600 text-white hover:bg-emerald-700",
                "focus-visible:ring-emerald-600/30",
                "dark:bg-emerald-600 dark:hover:bg-emerald-500",
              )}
              disabled={pending !== null}
              onClick={() =>
                withPending("approve", () => prmasterTauri.approve(ref))
              }
            >
              {pending === "approve" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
              Approve
            </Button>
            <Button
              size="xs"
              variant="destructive"
              disabled={pending !== null}
              onClick={() => setShowRequestForm(true)}
            >
              <X className="size-3" />
              Request changes
            </Button>
            {currentUser && !isAlreadyReviewer && (
              <Button
                size="xs"
                variant="outline"
                disabled={pending !== null}
                onClick={() =>
                  withPending("add", () =>
                    prmasterTauri.addSelfReviewer(ref, currentUser),
                  )
                }
              >
                {pending === "add" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <UserPlus className="size-3" />
                )}
                Add me as reviewer
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void openUrl(pr.pr.url)}
            >
              <ExternalLink className="size-3" />
              Open
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void writeText(pr.pr.url)}
            >
              <Copy className="size-3" />
              Copy link
            </Button>
          </div>
        )}
      </div>
    </div>
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
