//! Review-related enums + types — mirror of
//! `Sources/PRMaster/Models/ReviewStatus.swift`.

use serde::{Deserialize, Serialize};

/// Top-level review decision on a PR (the GraphQL `reviewDecision` field).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ReviewDecision {
    /// `APPROVED`.
    #[serde(rename = "APPROVED")]
    Approved,
    /// `CHANGES_REQUESTED`.
    #[serde(rename = "CHANGES_REQUESTED")]
    ChangesRequested,
    /// `REVIEW_REQUIRED`.
    #[serde(rename = "REVIEW_REQUIRED")]
    ReviewRequired,
    /// Anything else / missing.
    #[serde(other)]
    Unknown,
}

impl ReviewDecision {
    /// Human label matching the Swift `displayText`.
    pub fn display_text(self) -> &'static str {
        match self {
            ReviewDecision::Approved => "Approved",
            ReviewDecision::ChangesRequested => "Changes Requested",
            ReviewDecision::ReviewRequired => "Needs Review",
            ReviewDecision::Unknown => "Unknown",
        }
    }
}

/// State of a single submitted review.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ReviewState {
    /// `APPROVED`.
    #[serde(rename = "APPROVED")]
    Approved,
    /// `CHANGES_REQUESTED`.
    #[serde(rename = "CHANGES_REQUESTED")]
    ChangesRequested,
    /// `COMMENTED`.
    #[serde(rename = "COMMENTED")]
    Commented,
    /// `PENDING`.
    #[serde(rename = "PENDING")]
    Pending,
    /// `DISMISSED`.
    #[serde(rename = "DISMISSED")]
    Dismissed,
    /// Anything else / missing.
    #[serde(other)]
    Unknown,
}

/// One submitted review (subset of GraphQL `Review`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Review {
    /// Reviewer (may be missing for ghost users).
    #[serde(default)]
    pub author: Option<ReviewAuthor>,
    /// Review state.
    pub state: ReviewState,
}

/// Reviewer login wrapper — matches Swift's `ReviewAuthor`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewAuthor {
    /// Reviewer login.
    pub login: String,
}

/// Pending requested reviewer — may be a `User` (login) or a `Team` (name).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestedReviewer {
    /// User login or team name (whichever GitHub returned).
    #[serde(default)]
    pub login: Option<String>,
    /// Team name (if the requested reviewer was a team).
    #[serde(default)]
    pub name: Option<String>,
}

impl RequestedReviewer {
    /// Best-effort display name.
    pub fn display_name(&self) -> &str {
        self.login
            .as_deref()
            .or(self.name.as_deref())
            .unwrap_or("Unknown")
    }
}

/// Type of requested reviewer used in [`PrDetail::requested_reviewers`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewerKind {
    /// Individual user.
    User,
    /// Team.
    Team,
}
