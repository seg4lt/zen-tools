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
 *      reviewers count, files count, conversations count). One-line
 *      summary of "what's the state of this PR".
 *   3. **Action bar** — Approve / Request Changes / Add me as
 *      reviewer + secondary Open / Copy. Primary actions on the
 *      left, secondary on the right.
 *   4. **Reviewers + Checks** — two side-by-side blocks (collapses
 *      to stacked on narrow widths) so the heaviest detail is
 *      visible without scrolling.
 *   5. **Files changed** — collapsible list of file paths (we only
 *      have paths today; per-file diffs are a future enhancement).
 *   6. **Conversations** — review threads + @-mention comments on
 *      this PR, filtered out of the global conversations list. Same
 *      `ConversationThreadRow` component the firehose tab uses, so
 *      a thread looks identical in both places.
 *
 * All blocks use the same `Section` wrapper so spacing and label
 * styling are consistent. The wrapper keeps spacing tight (Linear-
 * style) without adding heavyweight card chrome — the surrounding
 * routed view already owns the page-level chrome.
 */

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
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
import { Badge } from "@zen-tools/ui";
import { Button } from "@zen-tools/ui";
import { Label } from "@zen-tools/ui";
import { Textarea } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { usePrMasterStore } from "../../store/prmaster-store";
import {
  prmasterTauri,
  prRefFor,
  type EnrichedPullRequest,
} from "../../lib/tauri";
import { CiChecks } from "./CiChecks";
import {
  ConversationSection,
  conversationNeedsUserReply,
} from "./ConversationThread";
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
  const [filesOpen, setFilesOpen] = useState(false);

  const { state } = usePrMasterStore();
  const ref = prRefFor(pr.pr);
  const detail = pr.detail;
  const rollup = detail?.commits?.nodes[0]?.commit.statusCheckRollup ?? null;
  const isAlreadyReviewer =
    !!currentUser &&
    (pr.requestedReviewers.includes(currentUser) ||
      pr.reviews.some((r) => r.author?.login === currentUser));

  // Conversations belong to a flat global firehose; filter to just
  // this PR by matching `repoNameWithOwner` + `prNumber` (the
  // ConversationGroup's prId is GitHub's GraphQL node id which we
  // don't have on the row, so we match on the human-readable pair).
  const prConversations = useMemo(() => {
    const group = state.conversations.find(
      (g) =>
        g.repoNameWithOwner === pr.pr.repository.nameWithOwner &&
        g.prNumber === pr.pr.number,
    );
    if (!group) return { needsReply: [], others: [], total: 0 };
    const needsReply = group.conversations.filter((c) =>
      conversationNeedsUserReply(c, currentUser),
    );
    const others = group.conversations.filter(
      (c) => !conversationNeedsUserReply(c, currentUser),
    );
    return {
      needsReply,
      others,
      total: group.conversations.length,
    };
  }, [state.conversations, pr.pr.repository.nameWithOwner, pr.pr.number, currentUser]);

  const fileCount = detail?.files?.nodes?.length ?? 0;
  const filePaths = detail?.files?.nodes?.map((f) => f.path) ?? [];

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
        {prConversations.total > 0 && (
          <StatChip
            tone={prConversations.needsReply.length > 0 ? "danger" : "muted"}
            icon={<MessageSquare className="size-3" />}
          >
            {prConversations.total} thread
            {prConversations.total === 1 ? "" : "s"}
            {prConversations.needsReply.length > 0 &&
              ` · ${prConversations.needsReply.length} need${
                prConversations.needsReply.length === 1 ? "s" : ""
              } reply`}
          </StatChip>
        )}
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

      {/* ── 4. Reviewers + Checks (two-column on wider widths) ──── */}
      <div className="grid gap-3 md:grid-cols-2">
        <Section label="Reviewers">
          <ReviewerAvatars pr={pr} />
        </Section>
        <Section label="Checks">
          <CiChecks rollup={rollup} />
        </Section>
      </div>

      {/* ── 5. Files changed ────────────────────────────────────── */}
      {fileCount > 0 && (
        <Section
          label={`Files changed (${fileCount})`}
          collapsible
          open={filesOpen}
          onToggle={() => setFilesOpen((o) => !o)}
        >
          {filesOpen && (
            <ul className="grid gap-0.5 rounded-md border bg-card/40 p-1.5">
              {filePaths.map((path) => (
                <li
                  key={path}
                  className="flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[11px] text-foreground/90 hover:bg-accent/40"
                >
                  <FileDiff className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate" title={path}>
                    {path}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {/* ── 6. Conversations on this PR ─────────────────────────── */}
      {prConversations.total > 0 && (
        <Section label="Conversations">
          <ConversationSection
            label="Needs your reply"
            emphasis
            items={prConversations.needsReply}
          />
          <ConversationSection
            label="Other threads"
            items={prConversations.others}
          />
        </Section>
      )}
    </div>
  );
}

// ── Section wrapper ──────────────────────────────────────────────

/**
 * Standard label-on-top block. Optionally collapsible — used by the
 * Files changed list and (in the future) the diff viewer to keep
 * the panel digestible when there are many files.
 */
function Section({
  label,
  children,
  collapsible = false,
  open = true,
  onToggle,
}: {
  label: string;
  children: React.ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  const Header = collapsible ? "button" : "div";
  return (
    <div className="grid gap-1.5">
      <Header
        type={collapsible ? "button" : undefined}
        onClick={collapsible ? onToggle : undefined}
        className={cn(
          "flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground",
          collapsible && "cursor-pointer hover:text-foreground",
        )}
      >
        {collapsible &&
          (open ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          ))}
        <span>{label}</span>
      </Header>
      {(!collapsible || open) && children}
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

// ── Avatar (lifted from PrCard) ──────────────────────────────────

function Avatar({ login, size }: { login: string; size: number }) {
  const initial = (login || "?").charAt(0).toUpperCase();
  const hue = stringHue(login);
  const showImage = !!login;
  if (showImage) {
    const src = `https://avatars.githubusercontent.com/${encodeURIComponent(
      login,
    )}?size=${size * 2}`;
    return (
      <img
        src={src}
        alt=""
        title={login ? `@${login}` : undefined}
        loading="lazy"
        decoding="async"
        width={size}
        height={size}
        className="inline-flex shrink-0 select-none overflow-hidden rounded-full bg-muted ring-1 ring-border/50"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="inline-flex shrink-0 select-none items-center justify-center rounded-full text-[9px] font-semibold uppercase text-foreground/80"
      style={{
        width: size,
        height: size,
        backgroundColor: `oklch(0.85 0.06 ${hue})`,
        color: `oklch(0.25 0.05 ${hue})`,
      }}
    >
      {initial}
    </span>
  );
}

function stringHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
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
