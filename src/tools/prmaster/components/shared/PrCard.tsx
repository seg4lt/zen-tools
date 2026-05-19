/**
 * PR list-row used by Mine / To Review / Done.
 *
 * Design goals:
 *
 *   - **Glanceable status.** A 1.5-px left accent bar carries the
 *     dominant signal for the row (failing CI, conflicts, draft,
 *     approved, needs-you). No reading required to triage.
 *
 *   - **Real avatars.** Author + reviewers use GitHub's image CDN
 *     (`avatars.githubusercontent.com/<login>?size=N`). CSS-fallback
 *     to coloured initials if the image fails — works offline.
 *
 *   - **Two visual rows.** Title + status on top; mono-styled meta
 *     (repo, branch, files, comments, reviewers, age) below. No
 *     truncation tricks — `line-clamp-2` on title is the ceiling.
 *
 *   - **Hover-revealed action.** Open-in-browser jumps straight to
 *     the GitHub PR page without leaving a primary affordance
 *     visible at rest. Matches the existing repo-list / request-list
 *     pattern (`opacity-0 group-hover:opacity-100`).
 *
 *   - **Per-tab variant.** Mine emphasises mergeability + CI,
 *     To Review emphasises the review-required cue, Done emphasises
 *     the resolved decision. The `variant` prop tunes accent
 *     selection without forking the component.
 *
 * Density target: ~58–66 px per row (matches the rest of zen-tools
 * — Linear-grade, not a "card"). Metadata wraps to a third visual
 * line only when the data demands it.
 */

import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleDashed,
  CircleHelp,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  Loader2,
  MessageCircle,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Badge, cn } from "@zen-tools/ui";
import type {
  EnrichedPullRequest,
  ReviewDecision,
  ReviewState,
  StatusCheckRollup,
} from "../../lib/tauri";

export type PrCardVariant = "mine" | "to-review" | "done";

interface Props {
  enriched: EnrichedPullRequest;
  selected?: boolean;
  /**
   * Tab the row is rendered under. Drives subtle accent / emphasis
   * differences only — content + structure stay identical so muscle
   * memory carries across tabs.
   */
  variant?: PrCardVariant;
  onSelect?: () => void;
}

/**
 * The dominant signal we tint the title icon with. Order of
 * precedence (top of the list wins):
 *
 *   1. CI failure                  — destructive
 *   2. Mergeable conflict          — destructive
 *   3. Changes requested           — destructive
 *   4. Draft                       — muted
 *   5. CI pending                  — amber
 *   6. Approved + clean to merge   — emerald (a "go" cue)
 *   7. Needs your review           — primary (indigo)
 *   8. Idle / nothing notable      — foreground (default)
 *
 * Earlier revisions of this component used a 2-px coloured rail
 * down the left edge of every card. The rail bisected the row
 * visually and felt heavier than the data warranted. We now route
 * the same signal through (a) the title icon's colour and (b) the
 * existing right-side chip cluster (CI / Conflicts / Decision),
 * which is how GitHub itself surfaces this state — no foreign
 * visual element on the row.
 */
type AccentTone =
  | "danger"
  | "draft"
  | "warning"
  | "success"
  | "primary"
  | "idle";

function deriveAccent(
  enriched: EnrichedPullRequest,
  variant: PrCardVariant,
): AccentTone {
  const { pr, detail, reviewDecision } = enriched;
  const ci = detail?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  const mergeable = detail?.mergeable;
  if (ci === "FAILURE" || ci === "ERROR") return "danger";
  if (mergeable === "CONFLICTING") return "danger";
  if (reviewDecision === "CHANGES_REQUESTED") return "danger";
  if (pr.isDraft) return "draft";
  if (ci === "PENDING") return "warning";
  if (variant === "mine" && reviewDecision === "APPROVED") return "success";
  if (variant === "to-review" && reviewDecision === "REVIEW_REQUIRED")
    return "primary";
  if (variant === "done" && reviewDecision === "APPROVED") return "success";
  return "idle";
}

/// Tailwind colour tokens for the title icon, keyed by accent tone.
const ICON_TINT: Record<AccentTone, string> = {
  danger: "text-destructive",
  draft: "text-muted-foreground",
  warning: "text-amber-600 dark:text-amber-400",
  success: "text-emerald-600 dark:text-emerald-400",
  primary: "text-primary",
  idle: "text-foreground",
};

/**
 * Whether the PR was updated very recently (≤5 min). Surfaces as a
 * tiny pulsing dot next to the timestamp — gives a sense of which
 * threads are alive without having to re-sort the list.
 */
function isFresh(iso: string): boolean {
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) && ms >= 0 && ms < 5 * 60 * 1000;
}

export function PrCard({
  enriched,
  selected = false,
  variant = "to-review",
  onSelect,
}: Props) {
  const { pr, detail, reviews, requestedReviewers, reviewDecision } = enriched;
  const authorLogin = pr.author?.login ?? null;
  const showTitleAuthor = variant !== "mine" && authorLogin;
  const headRef = detail?.headRefName ?? null;
  const baseRef = detail?.baseRefName ?? null;
  const fileCount = detail?.files?.nodes?.length ?? null;
  const commentCount = detail?.comments?.totalCount ?? 0;
  const ciRollup =
    detail?.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
  const mergeable = detail?.mergeable ?? null;

  const accent = deriveAccent(enriched, variant);

  // Latest review state per reviewer (mirrors `MyPRsView.swift`'s
  // `latestReviewByLogin`). Pending request slots get appended after
  // the actual review entries so the avatar stack reads
  // "decided first, pending last" left-to-right.
  const reviewerChips = useMemo(() => {
    const latestByLogin = new Map<string, ReviewState>();
    for (const r of reviews) {
      if (!r.author?.login) continue;
      latestByLogin.set(r.author.login, r.state);
    }
    const chips: Array<{ login: string; state: ReviewState | "PENDING" }> = [];
    for (const [login, state] of latestByLogin) chips.push({ login, state });
    for (const login of requestedReviewers) {
      if (!latestByLogin.has(login)) chips.push({ login, state: "PENDING" });
    }
    return chips;
  }, [reviews, requestedReviewers]);

  const onOpenInBrowser = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      // Use a real anchor — no Tauri shell-open round-trip needed
      // (CSP is null per `tauri.conf.json`).
      window.open(pr.url, "_blank", "noopener,noreferrer");
    },
    [pr.url],
  );

  const TitleIcon = pr.isDraft ? GitPullRequestDraft : GitPullRequest;
  const fresh = isFresh(pr.updatedAt);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group relative flex w-full items-stretch overflow-hidden rounded-md border bg-card text-left text-sm transition-all duration-150",
        "hover:border-border hover:bg-accent/40 hover:shadow-sm",
        selected && "border-primary/50 bg-accent ring-1 ring-primary/20",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2">
        {/* ── Row 1: avatar + title + right-side status cluster ── */}
        <div className="flex items-start gap-2">
          <Avatar
            login={authorLogin ?? ""}
            isBot={pr.author?.is_bot ?? false}
            size={20}
          />
          <TitleIcon
            className={cn(
              "mt-0.5 size-3.5 shrink-0 transition-colors",
              ICON_TINT[accent],
            )}
            aria-label={`Pull request: ${accent}`}
          />
          <span
            className={cn(
              "line-clamp-2 flex-1 text-sm font-medium leading-snug",
              pr.isDraft && "text-muted-foreground",
            )}
            title={showTitleAuthor ? `${pr.title} by @${authorLogin}` : pr.title}
          >
            {pr.title}
            {showTitleAuthor && (
              <span className="ml-2 whitespace-nowrap font-mono text-[11px] font-normal text-muted-foreground">
                @{authorLogin}
              </span>
            )}
          </span>

          {/* Right cluster: CI badge → mergeable → decision. Order
              matches "what blocks me from merging" → "what's the
              human verdict". */}
          <div className="flex shrink-0 items-center gap-1.5">
            {ciRollup && <CiPill rollup={ciRollup} />}
            {mergeable === "CONFLICTING" && (
              <span
                title="Branch has conflicts and cannot merge"
                className="inline-flex items-center gap-1 rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
              >
                <AlertTriangle className="size-3" />
                Conflicts
              </span>
            )}
            {reviewDecision && reviewDecision !== "Unknown" && (
              <DecisionBadge decision={reviewDecision} />
            )}
            {/* Hover-revealed open-in-browser. Render unconditionally
                so the layout doesn't reflow on hover; opacity flips
                via group-hover. */}
            <span
              role="button"
              tabIndex={-1}
              aria-label="Open on GitHub"
              title="Open on GitHub"
              onClick={onOpenInBrowser}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpenInBrowser(e as unknown as React.MouseEvent);
                }
              }}
              className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
            >
              <ExternalLink className="size-3" />
            </span>
          </div>
        </div>

        {/* ── Row 2: meta strip ──────────────────────────────────
            Wraps freely; everything is mono-styled or icon-led so
            the eye groups it as "context" vs. the title above. */}
        <div className="ml-[28px] flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span className="font-mono text-foreground/80">
            {pr.repository.nameWithOwner}
            <span className="text-muted-foreground">#{pr.number}</span>
          </span>

          {authorLogin && <span className="font-mono">@{authorLogin}</span>}

          {headRef && baseRef && (
            <span
              className="inline-flex max-w-[18rem] items-center gap-1 truncate rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]"
              title={`${headRef} → ${baseRef}`}
            >
              <GitBranch className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{headRef}</span>
              <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{baseRef}</span>
            </span>
          )}

          {fileCount != null && fileCount > 0 && (
            <span
              className="inline-flex items-center gap-1"
              title={`${fileCount} file${fileCount === 1 ? "" : "s"} changed`}
            >
              <FileDiff className="size-3" />
              {fileCount}
            </span>
          )}

          {commentCount > 0 && (
            <span
              className="inline-flex items-center gap-1"
              title={`${commentCount} comment${commentCount === 1 ? "" : "s"}`}
            >
              <MessageCircle className="size-3" />
              {commentCount}
            </span>
          )}

          {mergeable === "MERGEABLE" && variant === "mine" && (
            <span
              className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"
              title="Branch is mergeable"
            >
              <GitMerge className="size-3" />
              Ready
            </span>
          )}

          {reviewerChips.length > 0 && (
            <ReviewerStack chips={reviewerChips} />
          )}

          <span className="ml-auto inline-flex items-center gap-1.5">
            {fresh && (
              <span
                aria-hidden
                title="Updated in the last 5 minutes"
                className="relative flex size-2"
              >
                <span className="absolute inset-0 animate-ping rounded-full bg-primary/60" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
            )}
            <span className="tabular-nums">{relativeTime(pr.updatedAt)}</span>
          </span>
        </div>
      </div>
    </button>
  );
}

// ── CI rollup pill ─────────────────────────────────────────────────
//
// Single inline indicator showing the current CI state. We don't
// expand contexts inline — the detail panel is the right place for
// that. The `title` carries the rollup state so hovering gives a
// precise read.

function CiPill({ rollup }: { rollup: StatusCheckRollup }) {
  const state = rollup.state;
  switch (state) {
    case "SUCCESS":
      return (
        <span
          title="All checks passed"
          className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
        >
          <Check className="size-3" />
          CI
        </span>
      );
    case "FAILURE":
    case "ERROR":
      return (
        <span
          title={state === "ERROR" ? "Checks errored" : "Checks failed"}
          className="inline-flex items-center gap-1 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
        >
          <XCircle className="size-3" />
          CI
        </span>
      );
    case "PENDING":
      return (
        <span
          title="Checks are running"
          className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
        >
          <Loader2 className="size-3 animate-spin" />
          CI
        </span>
      );
    default:
      return null;
  }
}

// ── Decision badge (kept from the previous design) ─────────────────

function DecisionBadge({ decision }: { decision: ReviewDecision }) {
  switch (decision) {
    case "APPROVED":
      return (
        <Badge
          variant="secondary"
          className="border-emerald-500/30 bg-emerald-500/10 text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
        >
          Approved
        </Badge>
      );
    case "CHANGES_REQUESTED":
      return (
        <Badge variant="destructive" className="text-[10px]">
          Changes
        </Badge>
      );
    case "REVIEW_REQUIRED":
      return (
        <Badge
          variant="outline"
          className="border-primary/40 bg-primary/5 text-[10px] font-medium text-primary"
        >
          Needs review
        </Badge>
      );
    default:
      return null;
  }
}

// ── Reviewer avatar stack ──────────────────────────────────────────
//
// Up to 4 visible avatars, then a "+N" overflow chip. Each avatar
// carries a small status dot in its bottom-right corner that mirrors
// the prior single-icon rendering — same colour vocabulary
// (emerald=approved, destructive=changes, blue=commented, muted=pending).
//
// The stack uses negative margin so adjacent avatars overlap by ~6 px,
// matching GitHub's own list rendering.

function ReviewerStack({
  chips,
}: {
  chips: Array<{ login: string; state: ReviewState | "PENDING" }>;
}) {
  const visible = chips.slice(0, 4);
  const overflow = chips.length - visible.length;
  return (
    <span className="inline-flex items-center">
      <span className="inline-flex">
        {visible.map(({ login, state }, idx) => (
          <span
            key={login}
            className="relative -ml-1 inline-flex first:ml-0"
            style={{ zIndex: visible.length - idx }}
          >
            <Avatar
              login={login}
              size={18}
              ringClass="ring-1 ring-card"
              title={reviewerTitle(login, state)}
            />
            <ReviewerStateDot state={state} />
          </span>
        ))}
      </span>
      {overflow > 0 && (
        <span className="ml-1.5 inline-flex h-[18px] items-center justify-center rounded-full bg-muted px-1 text-[9px] font-medium text-muted-foreground">
          +{overflow}
        </span>
      )}
    </span>
  );
}

function reviewerTitle(
  login: string,
  state: ReviewState | "PENDING",
): string {
  switch (state) {
    case "APPROVED":
      return `${login} — approved`;
    case "CHANGES_REQUESTED":
      return `${login} — requested changes`;
    case "COMMENTED":
      return `${login} — commented`;
    case "PENDING":
      return `${login} — review requested`;
    default:
      return `${login} — ${state}`;
  }
}

function ReviewerStateDot({
  state,
}: {
  state: ReviewState | "PENDING";
}) {
  let bg: string;
  let Icon: React.ComponentType<{ className?: string }> | null = null;
  switch (state) {
    case "APPROVED":
      bg = "bg-emerald-500";
      Icon = Check;
      break;
    case "CHANGES_REQUESTED":
      bg = "bg-destructive";
      Icon = X;
      break;
    case "COMMENTED":
      bg = "bg-blue-500";
      Icon = MessageCircle;
      break;
    case "PENDING":
      bg = "bg-muted-foreground/60";
      Icon = CircleDashed;
      break;
    default:
      bg = "bg-muted-foreground/60";
      Icon = CircleHelp;
      break;
  }
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -bottom-0.5 -right-0.5 inline-flex size-[10px] items-center justify-center rounded-full ring-1 ring-card",
        bg,
      )}
    >
      {Icon && <Icon className="size-[7px] text-white" />}
    </span>
  );
}

// ── Avatar with image-load fallback to coloured initials ───────────
//
// Tiny, dependency-free. Renders an `<img>` from GitHub's avatar
// CDN; on any error falls back to a deterministic-coloured circle
// with the first letter of the login. Bots get a generic glyph
// (we suppress the avatar entirely to avoid the noisy generated bot
// image GitHub serves for app accounts).

function Avatar({
  login,
  size,
  isBot = false,
  ringClass,
  title,
}: {
  login: string;
  size: number;
  isBot?: boolean;
  ringClass?: string;
  title?: string;
}) {
  const [errored, setErrored] = useState(false);
  const initial = (login || "?").charAt(0).toUpperCase();
  const hue = useMemo(() => stringHue(login), [login]);
  const showImage = !!login && !isBot && !errored;

  const baseClass = cn(
    "inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-muted text-[9px] font-semibold uppercase text-foreground/80",
    ringClass,
  );

  if (showImage) {
    // GitHub serves crisp DPR-aware avatars when we ask for 2× the
    // CSS pixel size. The host process's WebKit handles caching.
    const src = `https://avatars.githubusercontent.com/${encodeURIComponent(
      login,
    )}?size=${size * 2}`;
    return (
      <img
        src={src}
        alt=""
        title={title ?? `@${login}`}
        loading="lazy"
        decoding="async"
        onError={() => setErrored(true)}
        width={size}
        height={size}
        className={cn(baseClass, "ring-1 ring-border/50")}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      title={title ?? (login ? `@${login}` : undefined)}
      className={baseClass}
      style={{
        width: size,
        height: size,
        backgroundColor: `oklch(0.85 0.06 ${hue})`,
        color: "oklch(0.25 0.05 " + hue + ")",
      }}
    >
      {initial}
    </span>
  );
}

/** Cheap deterministic hue from a login string — stable colours per
 *  user across renders, no extra deps. */
function stringHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
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
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}
