//! Strongly-typed data model — direct port of `Sources/PRMaster/Models/*.swift`.

pub mod auth;
pub mod author;
pub mod check;
pub mod conversation;
pub mod pull_request;
pub mod repository;
pub mod review;

pub use auth::AuthStatus;
pub use author::Author;
pub use check::{CheckContext, CheckRollupState, CheckState, StatusCheckRollup};
pub use conversation::{
    ConversationGroup, ConversationItem, ConversationKind, ConversationMessage,
};
pub use pull_request::{
    ChangedFile, ChangedFileNodes, CommentInfo, CommitInfo, CommitNode, CommitNodes,
    EnrichedPullRequest, MergedBy, PrDetail, PrRef, PullRequest, ReviewEvent, ReviewNodes,
    ReviewRequestNode, ReviewRequestNodes,
};
pub use repository::Repository;
pub use review::{Review, ReviewAuthor, ReviewDecision, ReviewState, ReviewerKind, RequestedReviewer};
