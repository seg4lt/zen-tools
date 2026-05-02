//! Conversation DTOs — mirror of `Sources/PRMaster/Models/Conversation.swift`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Whether a [`ConversationItem`] originated as an unresolved review thread
/// or as a top-level @mention comment on the PR.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationKind {
    /// PR review thread (line-level discussion).
    ReviewThread,
    /// Top-level PR comment containing a @mention of the current user.
    MentionComment,
}

impl ConversationKind {
    /// Short badge label: `"Thread"` or `"Mention"`.
    pub fn badge_label(self) -> &'static str {
        match self {
            ConversationKind::ReviewThread => "Thread",
            ConversationKind::MentionComment => "Mention",
        }
    }
}

/// One message inside a [`ConversationItem`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationMessage {
    /// Stable id (GraphQL node id).
    pub id: String,
    /// Author login (may be missing for ghost users).
    #[serde(default, rename = "authorLogin")]
    pub author_login: Option<String>,
    /// Markdown body.
    pub body: String,
    /// Created-at timestamp.
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    /// Permalink to the message on github.com.
    pub url: String,
}

/// A single conversation — either an unresolved review thread or a single
/// @mention top-level comment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationItem {
    /// Stable id.
    pub id: String,
    /// Owning PR id (`"{owner}/{repo}#{number}"`).
    #[serde(rename = "prId")]
    pub pr_id: String,
    /// PR title.
    #[serde(rename = "prTitle")]
    pub pr_title: String,
    /// PR number.
    #[serde(rename = "prNumber")]
    pub pr_number: u64,
    /// `"{owner}/{repo}"`.
    #[serde(rename = "repoNameWithOwner")]
    pub repo_name_with_owner: String,
    /// PR URL.
    #[serde(rename = "prUrl")]
    pub pr_url: String,
    /// Thread vs mention.
    pub kind: ConversationKind,
    /// File path (review threads only).
    #[serde(default, rename = "filePath")]
    pub file_path: Option<String>,
    /// Line number (review threads only).
    #[serde(default, rename = "lineNumber")]
    pub line_number: Option<u64>,
    /// Most recent activity timestamp.
    #[serde(rename = "latestActivityAt")]
    pub latest_activity_at: DateTime<Utc>,
    /// Direct link to the thread/comment.
    #[serde(rename = "exactUrl")]
    pub exact_url: String,
    /// Messages in chronological order.
    pub messages: Vec<ConversationMessage>,
    /// Login of the current user (used for "needs reply" classification).
    #[serde(default, rename = "currentUserLogin")]
    pub current_user_login: Option<String>,
}

/// A group of [`ConversationItem`]s belonging to one PR.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationGroup {
    /// PR id (`"{owner}/{repo}#{number}"`).
    #[serde(rename = "prId")]
    pub pr_id: String,
    /// PR title.
    #[serde(rename = "prTitle")]
    pub pr_title: String,
    /// PR number.
    #[serde(rename = "prNumber")]
    pub pr_number: u64,
    /// `"{owner}/{repo}"`.
    #[serde(rename = "repoNameWithOwner")]
    pub repo_name_with_owner: String,
    /// PR URL.
    #[serde(rename = "prUrl")]
    pub pr_url: String,
    /// All conversations on this PR.
    pub conversations: Vec<ConversationItem>,
}

impl ConversationGroup {
    /// Most recent activity across all conversations in the group.
    pub fn latest_activity_at(&self) -> Option<DateTime<Utc>> {
        self.conversations.iter().map(|c| c.latest_activity_at).max()
    }
}
