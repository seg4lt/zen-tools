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

export type ConversationKind = "review_thread" | "mention_comment";

export interface ConversationMessage {
  id: string;
  authorLogin: string | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface ConversationItem {
  id: string;
  prId: string;
  prTitle: string;
  prNumber: number;
  repoNameWithOwner: string;
  prUrl: string;
  kind: ConversationKind;
  filePath: string | null;
  lineNumber: number | null;
  latestActivityAt: string;
  exactUrl: string;
  messages: ConversationMessage[];
  currentUserLogin: string | null;
}

export interface ConversationGroup {
  prId: string;
  prTitle: string;
  prNumber: number;
  repoNameWithOwner: string;
  prUrl: string;
  conversations: ConversationItem[];
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
  getConversations: () =>
    invoke<ConversationGroup[]>("prmaster_get_conversations"),
  approve: (pr: PrRef) => invoke<void>("prmaster_approve_pr", { pr }),
  requestChanges: (pr: PrRef, body: string) =>
    invoke<void>("prmaster_request_changes", { pr, body }),
  addSelfReviewer: (pr: PrRef, login: string) =>
    invoke<void>("prmaster_add_self_reviewer", { pr, login }),
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
};

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
