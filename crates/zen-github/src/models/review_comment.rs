//! Inline review comment DTO — what the frontend uses to render
//! comments anchored to specific diff lines.
//!
//! Sourced from the REST `/repos/{owner}/{repo}/pulls/{n}/comments`
//! endpoint (paginated). Replies inherit `path`/`line`/`side` from the
//! comment they reply to, so the frontend can group everything that
//! shares those three values into a single inline thread without any
//! extra plumbing — Pierre's annotation pipeline does exactly that.

use serde::{Deserialize, Serialize};

use super::diff::DiffSide;

/// One inline review comment on a PR.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewComment {
    /// Numeric REST `databaseId`, stringified at the boundary so the
    /// frontend can use it as a stable key without worrying about
    /// JS Number precision drift on very large repos.
    pub id: String,
    /// GraphQL node id of the **thread** this comment belongs to
    /// (e.g. `"PRRT_kwDO..."`). Required by GitHub's
    /// `resolveReviewThread` mutation — the REST `databaseId` won't
    /// work there. All comments in a thread share the same
    /// `threadId`, so the frontend resolves a thread by sending the
    /// `threadId` of any of its comments.
    #[serde(rename = "threadId")]
    pub thread_id: String,
    /// Repo-relative path of the file the comment anchors to.
    pub path: String,
    /// 1-based line number on the side specified by [`Self::side`].
    /// Always populated for "fresh" comments (i.e. comments that
    /// still anchor to a line in the current diff). Threads whose
    /// `line` came back null from GitHub (because the line they
    /// targeted no longer exists in the latest commit) are dropped
    /// at the parsing stage rather than surfaced here.
    pub line: u32,
    /// LEFT (deleted lines) or RIGHT (added/context lines).
    pub side: DiffSide,
    /// Comment body, as authored. Markdown — the frontend renders
    /// it as plain text for now and can upgrade to a markdown
    /// component without touching this struct.
    pub body: String,
    /// Author's GitHub login. `None` for comments by deleted users.
    #[serde(rename = "authorLogin", skip_serializing_if = "Option::is_none")]
    pub author_login: Option<String>,
    /// Reply-to id (`databaseId` of the parent comment), stringified
    /// the same way as [`Self::id`]. `None` for thread roots.
    #[serde(rename = "inReplyToId", skip_serializing_if = "Option::is_none")]
    pub in_reply_to_id: Option<String>,
    /// ISO-8601 timestamp the comment was created. Drives the order
    /// inside an inline thread.
    #[serde(rename = "createdAt")]
    pub created_at: String,
}
