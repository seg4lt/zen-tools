/**
 * Detail panel for a single PR.
 *
 * Layout (top to bottom):
 *
 *   1. **Hero header** — author avatar, opened-when, branch pill,
 *      merge-state pill. The PR title itself is owned by the
 *      surrounding `EnrichedListView`'s back-button bar; we don't
 *      duplicate it.
 *   2. **Status bar** — a polished row of status chips (CI, decision,
 *      reviewers count, files count). One-line summary of "what's
 *      the state of this PR".
 *   3. **Action bar** — Approve / Request Changes / Add me as
 *      reviewer + secondary Open / Copy.
 *   4. **Reviewers + Checks** — two side-by-side blocks.
 *   5. **Review Pull Request** — a single button that navigates to
 *      `/prmaster/review/$owner/$repo/$number` (the dedicated diff
 *      workspace where inline review comments + replies live).
 *
 * All blocks use the same `Section` wrapper so spacing and label
 * styling are consistent.
 */

import { useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  CircleHelp,
  Copy,
  ExternalLink,
  FileDiff,
  GitBranch,
  Loader2,
  MessageSquare,
  ShieldQuestion,
  UserPlus,
  X,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@zen-tools/ui";
import { Button } from "@zen-tools/ui";
import { Label } from "@zen-tools/ui";
import { Textarea } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import {
  prmasterTauri,
  prRefFor,
  type EnrichedPullRequest,
} from "../../lib/tauri";
import { prefetchReviewPageData } from "../../lib/queries";
import { Avatar } from "./Avatar";
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

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ref = prRefFor(pr.pr);
  const detail = pr.detail;
  const rollup = detail?.commits?.nodes[0]?.commit.statusCheckRollup ?? null;
  const isAlreadyReviewer =
    !!currentUser &&
    (pr.requestedReviewers.includes(currentUser) ||
      pr.reviews.some((r) => r.author?.login === currentUser));

  const fileCount = detail?.files?.nodes?.length ?? 0;

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
    <div className="grid gap-3">
      {/* ── 1. Hero header ──────────────────────────────────────── */}
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
        <Avatar login={pr.pr.author?.login ?? ""} size={22} />
        {pr.pr.author?.login && (
          <span className="font-mono text-foreground/90">
            @{pr.pr.author.login}
          </span>
        )}
        <span>·</span>
        <span title={new Date(pr.pr.createdAt).toLocaleString()}>
          opened {relativeDate(pr.pr.createdAt)}
        </span>
        {pr.pr.isDraft && (
          <Badge variant="outline" className="text-[10px] uppercase">
            Draft
          </Badge>
        )}
        {detail?.headRefName && detail?.baseRefName && (
          <span
            className="inline-flex max-w-[22rem] items-center gap-1 truncate rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]"
            title={`${detail.headRefName} → ${detail.baseRefName}`}
          >
            <GitBranch className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{detail.headRefName}</span>
            <span className="text-muted-foreground">→</span>
            <span className="truncate">{detail.baseRefName}</span>
          </span>
        )}
        <MergeStatus
          mergeable={detail?.mergeable ?? null}
          state={detail?.mergeStateStatus ?? null}
        />
      </header>

      {/* ── 2. Status bar — quick-glance counters ───────────────── */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {rollup?.state === "SUCCESS" && (
          <StatChip tone="success" icon={<Check className="size-3" />}>
            CI passing
          </StatChip>
        )}
        {(rollup?.state === "FAILURE" || rollup?.state === "ERROR") && (
          <StatChip tone="danger" icon={<X className="size-3" />}>
            CI {rollup.state === "ERROR" ? "errored" : "failing"}
          </StatChip>
        )}
        {rollup?.state === "PENDING" && (
          <StatChip
            tone="warning"
            icon={<Loader2 className="size-3 animate-spin" />}
          >
            CI pending
          </StatChip>
        )}
        {pr.reviewDecision === "APPROVED" && (
          <StatChip tone="success" icon={<Check className="size-3" />}>
            Approved
          </StatChip>
        )}
        {pr.reviewDecision === "CHANGES_REQUESTED" && (
          <StatChip tone="danger" icon={<X className="size-3" />}>
            Changes requested
          </StatChip>
        )}
        {pr.reviewDecision === "REVIEW_REQUIRED" && (
          <StatChip tone="primary">Needs review</StatChip>
        )}
        <StatChip tone="muted" icon={<MessageSquare className="size-3" />}>
          {detail?.comments?.totalCount ?? 0} comments
        </StatChip>
        <StatChip tone="muted" icon={<FileDiff className="size-3" />}>
          {fileCount} {fileCount === 1 ? "file" : "files"}
        </StatChip>
      </div>

      {/* ── 3. Action bar ───────────────────────────────────────── */}
      {error && (
        <pre className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
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
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="xs"
            className={cn(
              // GitHub-green Approve — explicit colours rather than a
              // theme variant so the rest of the app's primary scheme
              // stays untouched.
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
          <span className="ml-auto flex items-center gap-1">
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
          </span>
        </div>
      )}

      {/* ── 4. Reviewers ────────────────────────────────────────── */}
      <Section label="Reviewers">
        <ReviewerAvatars pr={pr} />
      </Section>

      {/* ── 5. Checks ───────────────────────────────────────────── */}
      <Section label="Checks">
        <CiChecks rollup={rollup} />
      </Section>

      {/* ── 6. Review Pull Request — opens the dedicated review page
              (`/prmaster/review/$owner/$repo/$number`). Replaces the
              previous in-place "Files changed" accordion: reviewing
              now happens on a full-window page where the diff editor
              has room to breathe (and a Unified / Split toggle). */}
      {fileCount > 0 && (
        <Button
          size="sm"
          className="w-full justify-center gap-2"
          onClick={() =>
            void navigate({
              to: "/prmaster/review/$owner/$repo/$number",
              params: {
                owner: ref.owner,
                repo: ref.repo,
                number: String(ref.number),
              },
            })
          }
          // Prefetch on hover/focus so the click feels instant.
          // The review page's `useQuery` reads from the same cache,
          // so the cached payload paints immediately while the
          // mount-time refetch (staleTime: 0) folds in the latest
          // server state in the background.
          onMouseEnter={() =>
            prefetchReviewPageData(
              queryClient,
              ref,
              detail?.baseRefName ?? null,
              detail?.headRefName ?? null,
            )
          }
          onFocus={() =>
            prefetchReviewPageData(
              queryClient,
              ref,
              detail?.baseRefName ?? null,
              detail?.headRefName ?? null,
            )
          }
          title="Open the dedicated review workspace for this PR"
        >
          <FileDiff className="size-3.5" />
          Review Pull Request
          <span className="rounded bg-primary-foreground/15 px-1.5 py-0.5 text-[10px] font-mono">
            {fileCount} {fileCount === 1 ? "file" : "files"}
          </span>
        </Button>
      )}

    </div>
  );
}

// ── Section wrapper ──────────────────────────────────────────────

/**
 * Standard label-on-top block. Used by Reviewers / Checks /
 * Conversations rows to keep spacing + label styling consistent.
 *
 * Previously this also supported a `collapsible` mode used by the
 * Files Changed accordion; that surface is now a "Review Pull
 * Request" navigation button (`/prmaster/review/...`) so the
 * collapsible branch was retired — kept the wrapper non-collapsible
 * so existing call sites (Reviewers, Checks, Conversations) stay
 * unchanged.
 */
function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>{label}</span>
      </div>
      {children}
    </div>
  );
}

// ── Status chip ──────────────────────────────────────────────────

type ChipTone = "success" | "danger" | "warning" | "primary" | "muted";

function StatChip({
  tone,
  icon,
  children,
}: {
  tone: ChipTone;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const styles: Record<ChipTone, string> = {
    success:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    danger: "border-destructive/40 bg-destructive/10 text-destructive",
    warning:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    primary: "border-primary/40 bg-primary/10 text-primary",
    muted: "border-border bg-muted/40 text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium",
        styles[tone],
      )}
    >
      {icon}
      {children}
    </span>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

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
        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <Check className="size-3" /> Ready
        </span>
      );
    default:
      if (mergeable === "MERGEABLE") {
        return (
          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <Check className="size-3" /> Mergeable
          </span>
        );
      }
      return null;
  }
}

function relativeDate(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  const h = Math.floor(s / 3600);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

function formatError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
