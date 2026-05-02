//! CI status checks — mirror of the `StatusCheckRollup` / `CheckContext`
//! types in `Sources/PRMaster/Models/PullRequest.swift`.

use serde::{Deserialize, Serialize};

/// Top-level rollup state across all checks on a commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CheckRollupState {
    /// All checks succeeded.
    #[serde(rename = "SUCCESS")]
    Success,
    /// At least one check is still running.
    #[serde(rename = "PENDING")]
    Pending,
    /// At least one check failed.
    #[serde(rename = "FAILURE")]
    Failure,
    /// At least one check errored.
    #[serde(rename = "ERROR")]
    Error,
    /// Anything else / missing.
    #[serde(other)]
    Unknown,
}

/// State of a single legacy `StatusContext` check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CheckState {
    /// `SUCCESS`.
    #[serde(rename = "SUCCESS")]
    Success,
    /// `PENDING`.
    #[serde(rename = "PENDING")]
    Pending,
    /// `FAILURE`.
    #[serde(rename = "FAILURE")]
    Failure,
    /// `ERROR`.
    #[serde(rename = "ERROR")]
    Error,
    /// Anything else / missing.
    #[serde(other)]
    Unknown,
}

/// One check on a commit. GitHub's GraphQL `StatusCheckRollupContext` is a
/// union of `CheckRun` (Actions) and `StatusContext` (legacy Jenkins-style)
/// — we flatten both into a single struct with optional fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckContext {
    // CheckRun fields
    /// `name` field on `CheckRun` (e.g. `"build / test"`).
    #[serde(default)]
    pub name: Option<String>,
    /// `QUEUED | IN_PROGRESS | COMPLETED`.
    #[serde(default)]
    pub status: Option<String>,
    /// `SUCCESS | FAILURE | NEUTRAL | CANCELLED | TIMED_OUT | ACTION_REQUIRED | SKIPPED`.
    #[serde(default)]
    pub conclusion: Option<String>,
    /// Click-through URL for the run.
    #[serde(default, rename = "detailsUrl")]
    pub details_url: Option<String>,

    // StatusContext fields (legacy)
    /// `context` field (e.g. `"continuous-integration/jenkins"`).
    #[serde(default)]
    pub context: Option<String>,
    /// `SUCCESS | PENDING | FAILURE | ERROR`.
    #[serde(default)]
    pub state: Option<String>,
    /// Click-through URL for the legacy status.
    #[serde(default, rename = "targetUrl")]
    pub target_url: Option<String>,
}

impl CheckContext {
    /// Best display name (CheckRun `name` → StatusContext `context` → `"Unknown"`).
    pub fn display_name(&self) -> &str {
        self.name
            .as_deref()
            .or(self.context.as_deref())
            .unwrap_or("Unknown")
    }

    /// Click-through URL (CheckRun → StatusContext).
    pub fn url(&self) -> Option<&str> {
        self.details_url
            .as_deref()
            .or(self.target_url.as_deref())
    }

    /// Truncated label for narrow badges (matches Swift's 30-char limit).
    pub fn badge_display_name(&self) -> String {
        const MAX: usize = 30;
        let name = self.display_name();
        if name.chars().count() <= MAX {
            name.to_string()
        } else {
            let take = MAX.saturating_sub(3);
            let truncated: String = name.chars().take(take).collect();
            format!("{truncated}...")
        }
    }

    fn upper(opt: &Option<String>) -> Option<String> {
        opt.as_deref().map(|s| s.to_ascii_uppercase())
    }

    /// Whether the check is in a success state (CheckRun conclusion or
    /// StatusContext state == `SUCCESS`).
    pub fn is_success(&self) -> bool {
        matches!(Self::upper(&self.conclusion), Some(ref s) if s == "SUCCESS")
            || matches!(Self::upper(&self.state), Some(ref s) if s == "SUCCESS")
    }

    /// Whether the check is still running.
    pub fn is_pending(&self) -> bool {
        if let Some(status) = Self::upper(&self.status) {
            if status != "COMPLETED" {
                return true;
            }
        }
        matches!(Self::upper(&self.state), Some(ref s) if s == "PENDING")
    }

    /// Whether the check has failed (covers both unions).
    pub fn is_failed(&self) -> bool {
        const FAILED_CONCLUSIONS: &[&str] =
            &["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"];
        const FAILED_STATES: &[&str] = &["FAILURE", "ERROR"];
        if let Some(c) = Self::upper(&self.conclusion) {
            if FAILED_CONCLUSIONS.contains(&c.as_str()) {
                return true;
            }
        }
        if let Some(s) = Self::upper(&self.state) {
            if FAILED_STATES.contains(&s.as_str()) {
                return true;
            }
        }
        false
    }
}

/// Rollup wrapping the list of [`CheckContext`]s plus the overall state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusCheckRollup {
    /// Top-level rollup state.
    pub state: CheckRollupState,
    /// Individual contexts (optional — `gh` may omit when there are none).
    #[serde(default)]
    pub contexts: Option<CheckContextNodes>,
}

/// GraphQL `nodes` envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckContextNodes {
    /// The actual checks.
    pub nodes: Vec<CheckContext>,
}
