//! Pull request DTOs — mirror of `Sources/PRMaster/Models/PullRequest.swift`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::author::Author;
use super::check::StatusCheckRollup;
use super::repository::Repository;
use super::review::{RequestedReviewer, Review, ReviewDecision};

/// Top-level PR list-view DTO returned by `gh search prs --json …`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullRequest {
    /// PR number within the repo.
    pub number: u64,
    /// PR title.
    pub title: String,
    /// `https://github.com/owner/repo/pull/N`.
    pub url: String,
    /// `OPEN | CLOSED | MERGED` (uppercase from GraphQL, `gh search`
    /// returns lowercased — accept either via case-insensitive helpers).
    pub state: String,
    /// Created-at timestamp.
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    /// Updated-at timestamp.
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
    /// Whether the PR is a draft.
    #[serde(default, rename = "isDraft")]
    pub is_draft: bool,
    /// PR author (may be missing for ghost users).
    #[serde(default)]
    pub author: Option<Author>,
    /// The repository this PR lives in.
    pub repository: Repository,
}

impl PullRequest {
    /// Stable id used as React `key` and in cache lookups.
    pub fn id(&self) -> String {
        format!("{}#{}", self.repository.name_with_owner, self.number)
    }

    /// Case-insensitive `OPEN` check.
    pub fn is_open(&self) -> bool {
        self.state.eq_ignore_ascii_case("open")
    }
}

/// Composite reference to a PR — `(owner, repo, number)`. Tauri commands
/// receive this from the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PrRef {
    /// Repository owner (e.g. `"octocat"`).
    pub owner: String,
    /// Repository name (e.g. `"hello-world"`).
    pub repo: String,
    /// PR number.
    pub number: u64,
}

impl PrRef {
    /// Build a `PrRef` by splitting `owner/name` and supplying the number.
    pub fn from_name_with_owner(name_with_owner: &str, number: u64) -> Option<Self> {
        let (owner, repo) = name_with_owner.split_once('/')?;
        Some(Self {
            owner: owner.to_string(),
            repo: repo.to_string(),
            number,
        })
    }
}

/// `event` value accepted by `POST /repos/.../pulls/{n}/reviews`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewEvent {
    /// Submit an approving review.
    Approve,
    /// Submit a changes-requested review.
    RequestChanges,
    /// Submit a comment-only review.
    Comment,
}

impl ReviewEvent {
    /// Wire-format string passed to `-f event=...`.
    pub fn as_wire(self) -> &'static str {
        match self {
            ReviewEvent::Approve => "APPROVE",
            ReviewEvent::RequestChanges => "REQUEST_CHANGES",
            ReviewEvent::Comment => "COMMENT",
        }
    }
}

/// Detail fields fetched via the batched GraphQL query — mirror of Swift's
/// `PRDetail`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PrDetail {
    /// `headRefName` (the source branch).
    #[serde(default, rename = "headRefName")]
    pub head_ref_name: Option<String>,
    /// `baseRefName` (the target branch).
    #[serde(default, rename = "baseRefName")]
    pub base_ref_name: Option<String>,
    /// `reviewDecision`.
    #[serde(default, rename = "reviewDecision")]
    pub review_decision: Option<ReviewDecision>,
    /// Submitted reviews.
    #[serde(default)]
    pub reviews: Option<ReviewNodes>,
    /// Pending review requests.
    #[serde(default, rename = "reviewRequests")]
    pub review_requests: Option<ReviewRequestNodes>,
    /// Comment count.
    #[serde(default)]
    pub comments: Option<CommentInfo>,
    /// Who merged the PR (may be `null` for unmerged).
    #[serde(default, rename = "mergedBy")]
    pub merged_by: Option<MergedBy>,
    /// `mergedAt` timestamp.
    #[serde(default, rename = "mergedAt")]
    pub merged_at: Option<DateTime<Utc>>,
    /// `MERGEABLE | CONFLICTING | UNKNOWN`.
    #[serde(default)]
    pub mergeable: Option<String>,
    /// `mergeStateStatus` — `BLOCKED | BEHIND | DIRTY | UNSTABLE | HAS_HOOKS | CLEAN | UNKNOWN`.
    #[serde(default, rename = "mergeStateStatus")]
    pub merge_state_status: Option<String>,
    /// Last commit (carries the rollup).
    #[serde(default)]
    pub commits: Option<CommitNodes>,
    /// Files changed in the PR.
    #[serde(default)]
    pub files: Option<ChangedFileNodes>,
}

impl PrDetail {
    /// Pull the rollup off the most recent commit.
    pub fn status_check_rollup(&self) -> Option<&StatusCheckRollup> {
        self.commits
            .as_ref()
            .and_then(|c| c.nodes.first())
            .and_then(|n| n.commit.status_check_rollup.as_ref())
    }

    /// Whether GitHub flagged the PR as conflicting.
    pub fn has_conflicts(&self) -> bool {
        matches!(self.mergeable.as_deref(), Some("CONFLICTING"))
    }
}

/// `nodes` envelope around the submitted reviews list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewNodes {
    /// The actual reviews.
    pub nodes: Vec<Review>,
}

/// `nodes` envelope around the pending review-request list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewRequestNodes {
    /// Each entry wraps a `requestedReviewer` (User or Team).
    pub nodes: Vec<ReviewRequestNode>,
}

/// One pending review request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewRequestNode {
    /// The reviewer (User login or Team name).
    #[serde(default, rename = "requestedReviewer")]
    pub requested_reviewer: Option<RequestedReviewer>,
}

/// `comments.totalCount` envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentInfo {
    /// Total comment count on the PR.
    #[serde(rename = "totalCount")]
    pub total_count: u64,
}

/// User who merged the PR.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergedBy {
    /// Their login.
    pub login: String,
}

/// `nodes` envelope around the head-commit list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitNodes {
    /// Commits — we only ever read `[0]`.
    pub nodes: Vec<CommitNode>,
}

/// Wrapper around the inner `commit` field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitNode {
    /// The commit details.
    pub commit: CommitInfo,
}

/// Commit fields needed for the rollup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitInfo {
    /// Status-check rollup attached to the commit.
    #[serde(default, rename = "statusCheckRollup")]
    pub status_check_rollup: Option<StatusCheckRollup>,
}

/// `nodes` envelope around the changed-files list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangedFileNodes {
    /// Changed files.
    pub nodes: Vec<ChangedFile>,
}

/// One changed file in a PR.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangedFile {
    /// Repo-relative file path.
    pub path: String,
}

/// Composite of [`PullRequest`] + [`PrDetail`] used by the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichedPullRequest {
    /// The list-view PR.
    pub pr: PullRequest,
    /// `reviewDecision` lifted from the detail (convenience).
    #[serde(default, rename = "reviewDecision")]
    pub review_decision: Option<ReviewDecision>,
    /// All submitted reviews on the PR.
    #[serde(default)]
    pub reviews: Vec<Review>,
    /// Logins/team names that still owe a review.
    #[serde(default, rename = "requestedReviewers")]
    pub requested_reviewers: Vec<String>,
    /// Who merged it (`None` if unmerged).
    #[serde(default, rename = "mergedBy")]
    pub merged_by: Option<String>,
    /// When it was merged.
    #[serde(default, rename = "mergedAt")]
    pub merged_at: Option<DateTime<Utc>>,
    /// Full detail — kept around for the inline detail panel.
    #[serde(default)]
    pub detail: Option<PrDetail>,
}

impl EnrichedPullRequest {
    /// Stable id (delegates to the underlying [`PullRequest`]).
    pub fn id(&self) -> String {
        self.pr.id()
    }

    /// Reviewers with a pending request who haven't yet submitted a review
    /// — mirror of Swift's `pendingReviewers` getter.
    pub fn pending_reviewers(&self) -> Vec<String> {
        let reviewed: std::collections::HashSet<&str> = self
            .reviews
            .iter()
            .filter_map(|r| r.author.as_ref().map(|a| a.login.as_str()))
            .collect();
        self.requested_reviewers
            .iter()
            .filter(|name| !reviewed.contains(name.as_str()))
            .cloned()
            .collect()
    }
}
