//! General PR / issue comment DTO — the timeline conversation that
//! lives on github.com's "Conversation" tab, distinct from the
//! inline review comments anchored to specific diff lines (those
//! are [`super::review_comment::ReviewComment`]).
//!
//! Sourced from the REST `/repos/{owner}/{repo}/issues/{n}/comments`
//! endpoint. PRs are issues for the purposes of this endpoint, so
//! the same DTO covers both.

use serde::{Deserialize, Serialize};

/// One general comment on a PR (or issue).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssueComment {
    /// Numeric REST id, stringified at the boundary so the frontend
    /// can use it as a stable key without JS Number precision drift.
    pub id: String,
    /// Comment body, as authored. Markdown — frontend renders as
    /// plain text for now.
    pub body: String,
    /// Author's GitHub login. `None` for comments by deleted users.
    #[serde(rename = "authorLogin", skip_serializing_if = "Option::is_none")]
    pub author_login: Option<String>,
    /// ISO-8601 created timestamp.
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// ISO-8601 updated timestamp. Equal to `created_at` when the
    /// comment hasn't been edited.
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Direct URL to the comment on github.com (so the frontend can
    /// link out for editing / quoting).
    #[serde(rename = "htmlUrl", skip_serializing_if = "Option::is_none")]
    pub html_url: Option<String>,
}
