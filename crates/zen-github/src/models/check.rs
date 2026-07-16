//! CI status checks — mirror of the `StatusCheckRollup` / `CheckContext`
//! types in `Sources/PRMaster/Models/PullRequest.swift`.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
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
    /// Numeric GraphQL id for a `CheckRun`. Used as a stable tie-breaker
    /// when GitHub returns multiple attempts for the same logical check.
    #[serde(default, rename = "databaseId")]
    pub database_id: Option<u64>,
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
    /// Start time for a CheckRun attempt.
    #[serde(default, rename = "startedAt")]
    pub started_at: Option<DateTime<Utc>>,
    /// Completion time for a CheckRun attempt.
    #[serde(default, rename = "completedAt")]
    pub completed_at: Option<DateTime<Utc>>,
    /// Workflow identity, used to collapse re-runs without collapsing jobs
    /// that happen to share a name across separate workflows.
    #[serde(default, rename = "checkSuite")]
    pub check_suite: Option<CheckSuiteRef>,

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
    /// Creation time for a legacy StatusContext.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// GitHub App that produced a check run.
pub struct CheckApp {
    /// Stable app slug, such as `github-actions`.
    #[serde(default)]
    pub slug: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Minimal check-suite identity needed for check-run normalization.
pub struct CheckSuiteRef {
    /// Producer app for this suite.
    #[serde(default)]
    pub app: Option<CheckApp>,
    /// Actions workflow run associated with this suite, when present.
    #[serde(default, rename = "workflowRun")]
    pub workflow_run: Option<WorkflowRunRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Minimal Actions workflow-run reference.
pub struct WorkflowRunRef {
    /// Workflow definition that produced the run.
    #[serde(default)]
    pub workflow: Option<WorkflowRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Minimal Actions workflow definition.
pub struct WorkflowRef {
    /// Display name declared by the workflow.
    #[serde(default)]
    pub name: Option<String>,
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
        self.details_url.as_deref().or(self.target_url.as_deref())
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

    fn logical_key(&self) -> String {
        if let Some(name) = self.name.as_deref() {
            let app = self
                .check_suite
                .as_ref()
                .and_then(|suite| suite.app.as_ref())
                .and_then(|app| app.slug.as_deref())
                .unwrap_or("");
            let workflow = self
                .check_suite
                .as_ref()
                .and_then(|suite| suite.workflow_run.as_ref())
                .and_then(|run| run.workflow.as_ref())
                .and_then(|workflow| workflow.name.as_deref())
                .unwrap_or("");
            format!("check:{app}:{workflow}:{name}")
        } else if let Some(context) = self.context.as_deref() {
            format!("status:{context}")
        } else {
            "unknown".to_string()
        }
    }

    fn observed_at(&self) -> Option<DateTime<Utc>> {
        self.started_at.or(self.completed_at).or(self.created_at)
    }

    fn is_newer_than(&self, other: &Self) -> bool {
        match (self.observed_at(), other.observed_at()) {
            (Some(a), Some(b)) if a != b => a > b,
            (Some(_), None) => true,
            (None, Some(_)) => false,
            _ => self.database_id.unwrap_or_default() > other.database_id.unwrap_or_default(),
        }
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

impl StatusCheckRollup {
    /// GitHub's GraphQL rollup can contain older attempts for the same check
    /// when a workflow is re-run against an unchanged commit. Keep only the
    /// newest attempt for each logical check name and recompute the rollup so
    /// an older failure cannot make the current result look stale.
    pub fn retain_latest_contexts(&mut self) {
        let Some(contexts) = self.contexts.as_mut() else {
            return;
        };

        let mut latest: HashMap<String, CheckContext> = HashMap::new();
        let mut order = Vec::new();
        for context in contexts.nodes.drain(..) {
            let key = context.logical_key();
            if !latest.contains_key(&key) {
                order.push(key.clone());
            }
            match latest.get(&key) {
                Some(current) if !context.is_newer_than(current) => {}
                _ => {
                    latest.insert(key, context);
                }
            }
        }
        contexts.nodes = order
            .into_iter()
            .filter_map(|key| latest.remove(&key))
            .collect();

        self.state = rollup_state(&contexts.nodes);
    }
}

fn rollup_state(contexts: &[CheckContext]) -> CheckRollupState {
    if contexts.iter().any(|context| {
        context
            .state
            .as_deref()
            .is_some_and(|state| state.eq_ignore_ascii_case("ERROR"))
    }) {
        CheckRollupState::Error
    } else if contexts.iter().any(CheckContext::is_failed) {
        CheckRollupState::Failure
    } else if contexts.iter().any(CheckContext::is_pending) {
        CheckRollupState::Pending
    } else if contexts.is_empty() {
        CheckRollupState::Unknown
    } else {
        CheckRollupState::Success
    }
}

/// GraphQL `nodes` envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckContextNodes {
    /// The actual checks.
    pub nodes: Vec<CheckContext>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(id: u64, name: &str, conclusion: &str, completed_at: &str) -> CheckContext {
        CheckContext {
            database_id: Some(id),
            name: Some(name.into()),
            status: Some("COMPLETED".into()),
            conclusion: Some(conclusion.into()),
            details_url: None,
            started_at: None,
            completed_at: Some(completed_at.parse().unwrap()),
            check_suite: Some(CheckSuiteRef {
                app: Some(CheckApp {
                    slug: Some("github-actions".into()),
                }),
                workflow_run: Some(WorkflowRunRef {
                    workflow: Some(WorkflowRef {
                        name: Some("CI".into()),
                    }),
                }),
            }),
            context: None,
            state: None,
            target_url: None,
            created_at: None,
        }
    }

    #[test]
    fn keeps_only_newest_attempt_and_recomputes_state() {
        let mut rollup = StatusCheckRollup {
            state: CheckRollupState::Failure,
            contexts: Some(CheckContextNodes {
                nodes: vec![
                    check(10, "test", "FAILURE", "2026-07-16T10:00:00Z"),
                    check(11, "lint", "SUCCESS", "2026-07-16T10:01:00Z"),
                    check(12, "test", "SUCCESS", "2026-07-16T10:02:00Z"),
                ],
            }),
        };

        rollup.retain_latest_contexts();

        let nodes = &rollup.contexts.unwrap().nodes;
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].database_id, Some(12));
        assert_eq!(nodes[1].database_id, Some(11));
        assert_eq!(rollup.state, CheckRollupState::Success);
    }

    #[test]
    fn preserves_same_named_jobs_from_different_workflows() {
        let mut first = check(20, "test", "SUCCESS", "2026-07-16T10:00:00Z");
        first
            .check_suite
            .as_mut()
            .unwrap()
            .workflow_run
            .as_mut()
            .unwrap()
            .workflow
            .as_mut()
            .unwrap()
            .name = Some("Backend".into());
        let mut second = check(21, "test", "SUCCESS", "2026-07-16T10:01:00Z");
        second
            .check_suite
            .as_mut()
            .unwrap()
            .workflow_run
            .as_mut()
            .unwrap()
            .workflow
            .as_mut()
            .unwrap()
            .name = Some("Frontend".into());
        let mut rollup = StatusCheckRollup {
            state: CheckRollupState::Success,
            contexts: Some(CheckContextNodes {
                nodes: vec![first, second],
            }),
        };

        rollup.retain_latest_contexts();

        assert_eq!(rollup.contexts.unwrap().nodes.len(), 2);
    }
}
