/**
 * Typed wrappers around the `prmaster_*` Tauri commands plus future event
 * subscriptions. Shapes mirror the Rust DTOs in
 * `src-tauri/src/commands/prmaster.rs` and the `zen-github` crate.
 *
 * The P1 surface covers the **Mine** tab: list mine, action buttons (approve,
 * request changes, add reviewer), the auth probe used by Settings, and the
 * call log read for the API Stats tab. Phases P2–P7 add commands without
 * changing existing signatures.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ────────────────────────────────────────────────────────────────────────
// Domain types — keep in sync with the Rust DTOs in zen-github & prmaster.rs.
// ────────────────────────────────────────────────────────────────────────

export interface Repository {
  name: string;
  nameWithOwner: string;
}

export interface Author {
  id: string;
  login: string;
  is_bot: boolean;
  type: string;
  url: string;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  author: Author | null;
  repository: Repository;
}

export type ReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | "Unknown";

export type ReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "PENDING"
  | "DISMISSED"
  | "Unknown";

export interface Review {
  author: { login: string } | null;
  state: ReviewState;
}

export interface CheckContext {
  name: string | null;
  status: string | null;
  conclusion: string | null;
  detailsUrl: string | null;
  context: string | null;
  state: string | null;
  targetUrl: string | null;
}

export interface StatusCheckRollup {
  state: "SUCCESS" | "PENDING" | "FAILURE" | "ERROR" | "Unknown";
  contexts: { nodes: CheckContext[] } | null;
}

export interface ChangedFile {
  path: string;
}

/** Status of a file in a PR diff. Mirrors `zen_github::FileStatus`. */
export type FileStatus =
  | "added"
  | "modified"
  | "removed"
  | "renamed"
  | "changed"
  | "copied"
  | "unchanged";

/** Per-file diff entry. Mirrors `zen_github::FileDiff`. */
export interface FileDiff {
  path: string;
  /** Pre-rename path, if applicable. */
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** Unified-diff body for this file, including the `diff --git` header. */
  patch: string;
  binary: boolean;
  /** Full file contents at the base revision (populated by the
   *  local-git path). When present alongside `newContent`, the diff
   *  viewer can expand unchanged hunks all the way to the whole
   *  file. Absent for the gh-REST fallback path. */
  oldContent?: string;
  /** Full file contents at the head revision. See `oldContent`. */
  newContent?: string;
}

/** Where the diff payload came from. */
export type DiffSource = "local_git" | "gh_rest";

/** Bundle returned by `prmaster_get_pr_diff`. */
export interface PrDiff {
  files: FileDiff[];
  /** Head commit SHA — needed when posting an inline review comment. */
  headSha: string | null;
  source: DiffSource;
}

/** Side a comment is attached to (LEFT = old, RIGHT = new). */
export type DiffSide = "LEFT" | "RIGHT";

/**
 * One general (non-code-anchored) PR comment — the timeline
 * conversation. Mirrors `zen_github::IssueComment`. PRs are issues
 * for this REST endpoint, so the same DTO covers both.
 */
export interface IssueComment {
  /** Stable id (REST numeric id stringified). */
  id: string;
  body: string;
  authorLogin?: string;
  /** ISO-8601 created timestamp. */
  createdAt: string;
  /** ISO-8601 updated timestamp. Equal to `createdAt` when unedited. */
  updatedAt?: string;
  /** Direct URL to the comment on github.com. */
  htmlUrl?: string;
}

/**
 * One inline review comment on a PR. Mirrors `zen_github::ReviewComment`.
 * Sourced from GraphQL `pullRequest.reviewThreads` — resolved + outdated
 * threads are filtered at the engine boundary, so every entry the
 * frontend sees has a valid `(path, line, side)` anchor and an
 * unresolved thread parent.
 *
 * Replies inherit `path`/`line`/`side` from their parent comment, so
 * grouping a thread with N replies just means picking out every entry
 * with the same triple — no extra plumbing needed. The `threadId` is
 * shared by every comment in the same thread, and is what the
 * `resolveReviewThread` mutation needs.
 */
export interface ReviewComment {
  /** Stable id (REST `databaseId` stringified). */
  id: string;
  /** GraphQL node id of the thread this comment belongs to (e.g.
   *  `"PRRT_kwDO..."`). All comments in a thread share the same
   *  value; passed to the resolve mutation when the user clicks
   *  "Resolve". */
  threadId: string;
  path: string;
  /** 1-based line number on the side this comment is anchored to. */
  line: number;
  side: DiffSide;
  body: string;
  authorLogin?: string;
  /** Parent comment's id, when this entry is a reply. */
  inReplyToId?: string;
  /** ISO-8601 timestamp the comment was created at. */
  createdAt: string;
}

export interface PrDetail {
  headRefName: string | null;
  baseRefName: string | null;
  reviewDecision: ReviewDecision | null;
  reviews: { nodes: Review[] } | null;
  reviewRequests: {
    nodes: Array<{
      requestedReviewer: { login?: string; name?: string } | null;
    }>;
  } | null;
  comments: { totalCount: number } | null;
  mergedBy: { login: string } | null;
  mergedAt: string | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  commits: {
    nodes: Array<{
      commit: { statusCheckRollup: StatusCheckRollup | null };
    }>;
  } | null;
  files: { nodes: ChangedFile[] } | null;
}

export interface EnrichedPullRequest {
  pr: PullRequest;
  reviewDecision: ReviewDecision | null;
  reviews: Review[];
  requestedReviewers: string[];
  mergedBy: string | null;
  mergedAt: string | null;
  detail: PrDetail | null;
}

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export function prRefFor(pr: PullRequest): PrRef {
  const [owner, repo] = pr.repository.nameWithOwner.split("/", 2);
  return { owner: owner ?? "", repo: repo ?? pr.repository.name, number: pr.number };
}

export interface GhStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  login: string | null;
  host: string | null;
  raw: string;
}

export interface GhCall {
  timestamp: string;
  command: string;
  duration_ms: number;
  success: boolean;
}

/** One AI summary invocation, captured for the API Stats diagnostics
 *  panel. The fields here mirror the Rust `zen_prmaster::AiRunRecord`
 *  exactly — they're recorded inside the engine after every run, NOT
 *  reconstructed from the prompt, so they reflect the *actual* values
 *  handed to the AI CLI (catches "I configured Sonnet but Haiku ran"). */
export interface AiRunRecord {
  /** UNIX millis when the run started. */
  timestamp: number;
  /** Provider tag (`"claude"` / `"copilot"`). */
  provider: string;
  /** Resolved model handed to the CLI. `null` when the user hasn't
   *  picked one and the CLI's default applies. */
  model: string | null;
  /** Repository the run targeted (`owner/repo`). */
  repo: string;
  /** ISO-8601 inclusive start. */
  since: string;
  /** ISO-8601 exclusive end. */
  until: string;
  /** Wall-clock duration, ms. */
  duration_ms: number;
  /** Whether the underlying provider call resolved without error. */
  success: boolean;
  /** Number of commits fed into the prompt (0 when the run errored
   *  before commits were fetched). */
  commit_count: number;
  /** Cost reported by the provider when available. */
  cost_usd: number | null;
  /** Per-model token-usage breakdown reported by the provider (Claude
   *  Code lists every model that consumed tokens for this run; Copilot
   *  doesn't expose this). For the common "I asked for Sonnet but I
   *  see Haiku in the JSON" case, this column makes both models
   *  visible — Haiku is the routing model the CLI uses internally,
   *  Sonnet/Opus is the answer model. Empty when the field wasn't
   *  reported (or for cache hits). */
  model_usage?: ModelUsageEntry[];
}

/** Per-model token usage as reported by the provider's CLI. Mirrors
 *  `zen_ai_cli::ModelUsageEntry`. */
export interface ModelUsageEntry {
  model: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cost_usd?: number | null;
}

export type NotificationActionKind =
  | "sound_banner"
  | "silent_banner"
  | "badge_only"
  | "mute";

export interface NotificationFilter {
  id: string;
  name: string;
  authors: string[];
  repos: string[];
  file_globs: string[];
  title_regex: string | null;
  action: NotificationActionKind;
  enabled: boolean;
  created_at_ms: number;
  updated_at_ms: number;
}

export type BadgeSourceKind = "to_review" | "reviewed" | "my_prs" | "filter";

export interface BadgeSourceConfig {
  source: BadgeSourceKind;
  filter_id?: string | null;
  prefix: string;
  suffix: string;
  enabled: boolean;
}

export interface LocalRepoMapping {
  repo: string;
  local_path: string;
}

export interface PrMasterSettings {
  enabled: boolean;
  polling_interval_secs: number;
  launch_at_login: boolean;
  global_shortcut_enabled: boolean;
  notifications_enabled: boolean;
  only_filter_notifications: boolean;
  my_pr_notifications_enabled: boolean;
  badge_configs: BadgeSourceConfig[];
  ai_provider: string;
  ai_model: string;
  ai_token_ratio: number;
  selected_repos: string[];
  cached_repos: string[];
  cached_repos_at_ms: number | null;
  repo_mappings: LocalRepoMapping[];
  /** Extra commit-author search terms — combined (OR) with the
   *  primary author resolved from the mapped repo's local git
   *  identity (`user.email` / `user.name`). Each entry becomes a
   *  separate `git log --author=<value>` flag, so substring matches
   *  against author name AND email work — e.g. `"alice"` matches
   *  both `Alice Smith <alice@…>` and `alice@github.com`. */
  extra_authors: string[];
  /** Override base directory for AI Review worktrees. `null` /
   *  empty → `<app_data>/prmaster/ai-review/worktrees/`. Otherwise
   *  worktrees go under `<value>/zen-tools-ai-review/`. */
  ai_review_worktrees_dir?: string | null;
}

export interface RefreshSnapshot {
  current_user: string | null;
  to_review: EnrichedPullRequest[];
  reviewed: EnrichedPullRequest[];
  mine: EnrichedPullRequest[];
  fetched_at_ms: number;
}

export interface PendingNotification {
  id: string;
  title: string;
  body: string;
  url: string;
  silent: boolean;
  badge_only: boolean;
  muted: boolean;
}

// ────────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────────

export const prmasterTauri = {
  whoami: () => invoke<string>("prmaster_whoami"),
  ghStatus: () => invoke<GhStatus>("prmaster_get_gh_status"),
  getMine: () => invoke<EnrichedPullRequest[]>("prmaster_get_mine"),
  getToReview: () => invoke<EnrichedPullRequest[]>("prmaster_get_to_review"),
  getReviewed: () => invoke<EnrichedPullRequest[]>("prmaster_get_reviewed"),
  /**
   * Every inline review comment on `pr` (sourced from the REST
   * endpoint, paginated). Drives the diff editor's inline annotations
   * on the dedicated review page. Outdated comments are filtered at
   * the engine boundary so every result has a valid line anchor.
   */
  listReviewComments: (pr: PrRef) =>
    invoke<ReviewComment[]>("prmaster_list_review_comments", { pr }),
  /**
   * Every general (non-code-anchored) PR comment — the timeline
   * conversation that lives on github.com's "Conversation" tab.
   * Drives the Comments tab on the dedicated review page.
   */
  listIssueComments: (pr: PrRef) =>
    invoke<IssueComment[]>("prmaster_list_issue_comments", { pr }),
  approve: (pr: PrRef) => invoke<void>("prmaster_approve_pr", { pr }),
  requestChanges: (pr: PrRef, body: string) =>
    invoke<void>("prmaster_request_changes", { pr, body }),
  addSelfReviewer: (pr: PrRef, login: string) =>
    invoke<void>("prmaster_add_self_reviewer", { pr, login }),
  getPrDiff: (pr: PrRef, baseRef: string | null, headRef: string | null) =>
    invoke<PrDiff>("prmaster_get_pr_diff", { pr, baseRef, headRef }),
  addReviewComment: (params: {
    pr: PrRef;
    body: string;
    commitSha: string;
    path: string;
    line: number;
    side: DiffSide;
  }) => invoke<void>("prmaster_add_review_comment", params),
  /**
   * Reply to an existing inline review comment. The reply inherits
   * path/line/side/commit from the parent on GitHub's side, so the
   * caller only needs the parent id and the body. `parentId` is the
   * stringified REST numeric id (matches `ReviewComment.id`).
   */
  replyReviewComment: (params: {
    pr: PrRef;
    parentId: string;
    body: string;
  }) => invoke<void>("prmaster_reply_review_comment", params),
  /**
   * Edit an existing inline review comment. `commentId` is the
   * stringified REST numeric id (matches `ReviewComment.id`).
   */
  editReviewComment: (params: {
    pr: PrRef;
    commentId: string;
    body: string;
  }) => invoke<void>("prmaster_edit_review_comment", params),
  /**
   * Edit an existing general (issue) comment. `commentId` is the
   * stringified REST numeric id (matches `IssueComment.id`).
   */
  editIssueComment: (params: {
    pr: PrRef;
    commentId: string;
    body: string;
  }) => invoke<void>("prmaster_edit_issue_comment", params),
  /**
   * Mark a review thread as resolved. `threadId` is the GraphQL node
   * id (matches `ReviewComment.threadId`). Idempotent.
   */
  resolveReviewThread: (threadId: string) =>
    invoke<void>("prmaster_resolve_review_thread", { threadId }),
  getCallLog: () => invoke<GhCall[]>("prmaster_get_call_log"),
  getAiRuns: () => invoke<AiRunRecord[]>("prmaster_get_ai_runs"),
  refresh: () => invoke<void>("prmaster_refresh"),
  getSettings: () => invoke<PrMasterSettings>("prmaster_get_settings"),
  saveSettings: (settings: PrMasterSettings) =>
    invoke<void>("prmaster_save_settings", { settings }),
  listFilters: () => invoke<NotificationFilter[]>("prmaster_list_filters"),
  saveFilter: (filter: NotificationFilter) =>
    invoke<void>("prmaster_save_filter", { filter }),
  deleteFilter: (id: string) => invoke<void>("prmaster_delete_filter", { id }),
  testFilterNotification: (id: string) =>
    invoke<void>("prmaster_test_filter_notification", { id }),
  hidePopover: () => invoke<void>("prmaster_hide_popover"),
  setBadge: (badge: string) => invoke<void>("prmaster_set_badge", { badge }),
  openFullWindow: () => invoke<void>("prmaster_open_full_window"),
  quit: () => invoke<void>("prmaster_quit_app"),
  aiSummary: (params: AiSummaryParams) =>
    invoke<SummaryCard>("prmaster_ai_summary", { params }),
  aiListModels: () => invoke<string[]>("prmaster_ai_list_models"),
  clearAiCache: () => invoke<void>("prmaster_clear_ai_cache"),
  loadAiSummaries: () =>
    invoke<SummaryCard[]>("prmaster_load_ai_summaries"),
  saveAiSummaries: (summaries: SummaryCard[]) =>
    invoke<void>("prmaster_save_ai_summaries", { summaries }),
  clearAiSummaries: () => invoke<void>("prmaster_clear_ai_summaries"),
  loadPrSnapshot: () =>
    invoke<RefreshSnapshot | null>("prmaster_load_pr_snapshot"),
  listAccessibleRepos: () => invoke<RepoListResult>("prmaster_list_repos"),
  fetchRepos: () => invoke<RepoListResult>("prmaster_fetch_repos"),
  // ── AI code review tab (third tab on the PR review page) ──────────
  /**
   * Spawn a new AI code review for `pr` at `headSha`. Returns
   * immediately; live progress arrives on the
   * `prmaster:ai-review:event` Tauri event channel (see
   * `listenAiReviewEvent`). Re-attach to a still-running review via
   * `aiReviewStatus(runId)`.
   */
  aiReviewStart: (params: {
    pr: PrRef;
    headSha: string;
    headBranch: string | null;
    baseBranch: string | null;
    model: string | null;
    promptOverride?: string | null;
  }) => invoke<AiReviewStartResp>("prmaster_ai_review_start", params),
  aiReviewPreviewPrompt: (params: {
    pr: PrRef;
    headSha: string;
    headBranch: string | null;
    baseBranch: string | null;
  }) => invoke<string>("prmaster_ai_review_preview_prompt", params),
  aiReviewStatus: (runId: string) =>
    invoke<AiReviewStatusResp | null>("prmaster_ai_review_status", { runId }),
  aiReviewCancel: (runId: string) =>
    invoke<boolean>("prmaster_ai_review_cancel", { runId }),
  aiReviewGetReport: (runId: string) =>
    invoke<AiReviewReportResp>("prmaster_ai_review_get_report", { runId }),
  aiReviewListRuns: (pr: PrRef) =>
    invoke<AiReviewRunSummary[]>("prmaster_ai_review_list_runs", { pr }),
  /**
   * Return the default formatted comment body for a finding — what
   * would be posted if the user clicked Post without editing. The
   * inline editor pre-fills its textarea with this string.
   */
  aiReviewPreviewFindingBody: (runId: string, findingId: string) =>
    invoke<string>("prmaster_ai_review_preview_finding_body", {
      runId,
      findingId,
    }),
  /**
   * Post a finding (by `findingId`) as a real GitHub inline review
   * comment, anchored at the head SHA the review ran against. The
   * `body` is taken verbatim from the inline editor — empty bodies
   * are rejected by the backend.
   */
  aiReviewPostFinding: (runId: string, findingId: string, body: string) =>
    invoke<void>("prmaster_ai_review_post_finding", {
      runId,
      findingId,
      body,
    }),
  aiReviewCleanupMerged: (visibleSlugs: string[]) =>
    invoke<number>("prmaster_ai_review_cleanup_merged", { visibleSlugs }),
  /**
   * Reveal `<app_data>/prmaster/ai-review/reports/` in the system
   * file manager. Surfaced from the global Settings → Paths section
   * so users can inspect the persisted reports / findings JSON
   * directly when they want to.
   */
  aiReviewOpenReportsDir: () =>
    invoke<void>("prmaster_ai_review_open_reports_dir"),
};

// ────────────────────────────────────────────────────────────────────────
// AI code review — types
// ────────────────────────────────────────────────────────────────────────

export type AiReviewStatusKind =
  | "starting"
  | "running"
  | "done"
  | "error"
  | "cancelled";

/**
 * One unit of streaming output from a Claude review run. Matches the
 * `#[serde(tag = "kind")]` discriminated-union shape on the Rust side
 * (`zen_pr_review::AiReviewEvent`).
 */
export type AiReviewEvent =
  | { kind: "stdout"; line: string }
  | { kind: "thought"; text: string }
  | { kind: "tool_use"; name: string; input_preview: string }
  | {
      kind: "tool_result";
      name: string;
      output_preview: string;
      is_error: boolean;
    }
  | { kind: "text"; text: string }
  | {
      kind: "done";
      cost_usd: number | null;
      duration_ms: number;
      report_path: string | null;
      findings_count: number | null;
    }
  | { kind: "error"; message: string };

/** Wire payload of one `prmaster:ai-review:event` Tauri event. */
export interface AiReviewEventPayload {
  run_id: string;
  ts_ms: number;
  /** Inlined event fields (`kind` + per-variant data). */
  kind: AiReviewEvent["kind"];
  // The remaining variant-specific keys are present at the top level
  // because the Rust side `#[serde(flatten)]`s the event into the
  // payload. We type-narrow at the call site.
  [extra: string]: unknown;
}

/** Reconstruct a discriminated `AiReviewEvent` from the flat
 *  Tauri payload emitted by the backend (which `#[serde(flatten)]`s
 *  the variant data alongside `run_id`/`ts_ms`). */
export function parseAiReviewEvent(payload: AiReviewEventPayload): AiReviewEvent {
  switch (payload.kind) {
    case "stdout":
      return { kind: "stdout", line: String(payload.line ?? "") };
    case "thought":
      return { kind: "thought", text: String(payload.text ?? "") };
    case "tool_use":
      return {
        kind: "tool_use",
        name: String(payload.name ?? ""),
        input_preview: String(payload.input_preview ?? ""),
      };
    case "tool_result":
      return {
        kind: "tool_result",
        name: String(payload.name ?? ""),
        output_preview: String(payload.output_preview ?? ""),
        is_error: Boolean(payload.is_error),
      };
    case "text":
      return { kind: "text", text: String(payload.text ?? "") };
    case "done":
      return {
        kind: "done",
        cost_usd: typeof payload.cost_usd === "number" ? payload.cost_usd : null,
        duration_ms:
          typeof payload.duration_ms === "number" ? payload.duration_ms : 0,
        report_path:
          typeof payload.report_path === "string"
            ? (payload.report_path as string)
            : null,
        findings_count:
          typeof payload.findings_count === "number"
            ? (payload.findings_count as number)
            : null,
      };
    case "error":
      return { kind: "error", message: String(payload.message ?? "") };
    default:
      return { kind: "stdout", line: JSON.stringify(payload) };
  }
}

/** One finding parsed from `report.json`. Mirrors `zen_pr_review::Finding`. */
export interface AiReviewFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | string;
  title: string;
  path: string;
  /** 1-based start line of the **finding itself** (the anchor for
   *  posting an inline GitHub review comment). May be inside the
   *  middle of `current` when context lines are included above. */
  start_line: number;
  /** 1-based, inclusive end line of the finding (anchor end). */
  end_line: number;
  side: "LEFT" | "RIGHT" | string;
  /** 1-based line number the first character of `current`
   *  corresponds to. Falls back to `start_line` for older records. */
  snippet_start_line?: number | null;
  current: string;
  suggested: string;
  /** Lowercase language id used by the syntax highlighter. */
  language?: string;
  rationale: string;
}

export interface AiReviewStartResp {
  run_id: string;
  worktree_path: string;
  head_sha: string;
}

export interface AiReviewStatusResp {
  status: AiReviewStatusKind;
  events: AiReviewEvent[];
  report_path: string | null;
  pr: { owner: string; repo: string; number: number };
  head_sha: string;
  model: string;
  started_at_ms: number;
  finished_at_ms: number | null;
  cost_usd: number | null;
}

export interface AiReviewReportResp {
  /** Legacy self-contained HTML body (older runs only). The React
   *  renderer uses `findings` directly; `html` is kept around as a
   *  fall-back / debug artefact. */
  html: string | null;
  findings: AiReviewFinding[];
  /** Streaming events captured while the run was live (drives the
   *  History panel's "Log" action). Empty for runs that errored
   *  before they buffered anything, or for older records persisted
   *  before this field existed. */
  events: AiReviewEvent[];
  /** One-sentence verdict copied from `report.json`'s `summary`. */
  overall_summary: string;
  /** High-level bullet summary copied from `report.json`'s `change_summary`. */
  change_summary: string[];
  /** The exact prompt the run sent to `claude -p`. */
  prompt: string;
  pr: { owner: string; repo: string; number: number };
  head_sha: string;
  model: string;
  cost_usd: number | null;
  finished_at_ms: number | null;
}

export interface AiReviewRunSummary {
  run_id: string;
  head_sha: string;
  model: string;
  started_at_ms: number;
  finished_at_ms: number | null;
  status: AiReviewStatusKind;
  cost_usd: number | null;
}

/**
 * Subscribe to AI review events. The frontend wires this once at app
 * boot and demuxes by `run_id` into the global `ai-review-store`.
 */
export function listenAiReviewEvent(
  cb: (payload: AiReviewEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<AiReviewEventPayload>("prmaster:ai-review:event", (e) =>
    cb(e.payload),
  );
}

export interface RepoListResult {
  repos: string[];
  /** UNIX millis when the cache was last refreshed (null if never). */
  cached_at_ms: number | null;
  /** True when the cache is older than the 7-day TTL. */
  stale: boolean;
}

export interface AiSummaryParams {
  repo: string;
  /** ISO-8601 with offset, e.g. `"2024-01-01T00:00:00Z"`. */
  since: string;
  /** ISO-8601 with offset. */
  until: string;
  author?: string | null;
  model?: string | null;
  force?: boolean;
}

export interface SummaryCard {
  repo: string;
  since: string;
  until: string;
  commit_count: number;
  summary: string;
  cost_usd: number | null;
  generated_at_ms: number;
  /** Per-model breakdown reported by the provider when available.
   *  Optional (older cached cards persisted before this field
   *  existed don't have it). */
  model_usage?: ModelUsageEntry[];
}

// ────────────────────────────────────────────────────────────────────────
// Engine event subscriptions (broadcast bridge in `src-tauri/src/lib.rs`).
// ────────────────────────────────────────────────────────────────────────

export function listenRefresh(
  cb: (snapshot: RefreshSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<RefreshSnapshot>("prmaster:refreshed", (e) => cb(e.payload));
}

export function listenBadge(cb: (text: string) => void): Promise<UnlistenFn> {
  return listen<string>("prmaster:badge-changed", (e) => cb(e.payload));
}

export function listenNotification(
  cb: (note: PendingNotification) => void,
): Promise<UnlistenFn> {
  return listen<PendingNotification>("prmaster:notification", (e) =>
    cb(e.payload),
  );
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

export function checkKind(c: CheckContext): "success" | "pending" | "failed" | "unknown" {
  const conclusion = (c.conclusion ?? "").toUpperCase();
  const state = (c.state ?? "").toUpperCase();
  const status = (c.status ?? "").toUpperCase();
  if (conclusion === "SUCCESS" || state === "SUCCESS") return "success";
  const failedConclusions = new Set([
    "FAILURE",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
  ]);
  const failedStates = new Set(["FAILURE", "ERROR"]);
  if (failedConclusions.has(conclusion) || failedStates.has(state)) return "failed";
  if ((status && status !== "COMPLETED") || state === "PENDING") return "pending";
  return "unknown";
}

export function checkDisplayName(c: CheckContext): string {
  return c.name ?? c.context ?? "Unknown";
}

export function checkUrl(c: CheckContext): string | null {
  return c.detailsUrl ?? c.targetUrl;
}
