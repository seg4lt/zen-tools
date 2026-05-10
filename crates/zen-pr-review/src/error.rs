//! Error type for `zen-pr-review`.
//!
//! Wraps the underlying shell / I/O / serialisation errors plus a small
//! set of domain-specific conditions so the Tauri layer can map each to
//! a useful user-facing message without `String`-matching.

use std::path::PathBuf;

use thiserror::Error;
use zen_shell::ShellError;
use zen_storage::StorageError;

/// Errors raised while preparing or running an AI review.
#[derive(Debug, Error)]
pub enum ReviewError {
    /// The user has not registered a local clone for this PR's repo in
    /// PRMaster Settings → Repo Mappings.
    #[error("local clone not registered for {repo}; add it in PRMaster Settings → Repo Mappings")]
    LocalRepoMissing {
        /// `owner/repo` slug the caller asked about.
        repo: String,
    },

    /// The configured local repo path doesn't exist on disk.
    #[error("local clone path does not exist: {0}")]
    LocalRepoPathMissing(PathBuf),

    /// We tried to start a duplicate review for the same `(pr, head_sha)`
    /// while another one was still running.
    #[error("an AI review is already running for this PR + head commit")]
    AlreadyRunning,

    /// The Claude CLI exited 0 but did not write the expected report
    /// HTML at the agreed location.
    #[error("Claude finished but did not produce a review report at {path}")]
    ReportMissing {
        /// Path we expected the report at.
        path: PathBuf,
    },

    /// The Claude CLI was killed (cancel or timeout).
    #[error("AI review was cancelled")]
    Cancelled,

    /// The configured wall-clock timeout was hit.
    #[error("AI review timed out after {secs} seconds")]
    Timeout {
        /// The timeout that was exceeded, in seconds.
        secs: u64,
    },

    /// The configured AI provider doesn't match what this engine
    /// supports — for v1 we only run Claude.
    #[error("AI provider {provider:?} is not supported by review (only \"claude\")")]
    UnsupportedProvider {
        /// Provider tag from settings.
        provider: String,
    },

    /// The caller asked us to look up a `run_id` that we don't know
    /// about (could be a stale frontend state after a backend restart).
    #[error("unknown review run_id: {0}")]
    UnknownRun(String),

    /// We persisted a finding index but couldn't find the requested id
    /// inside it.
    #[error("unknown finding_id: {0}")]
    UnknownFinding(String),

    /// Underlying shell-out failed.
    #[error(transparent)]
    Shell(#[from] ShellError),

    /// Filesystem I/O failure.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    /// JSON parsing / serialisation failure.
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    /// Persisted state (KvStore) failure.
    #[error(transparent)]
    Storage(#[from] StorageError),

    /// Catch-all for ad-hoc errors.
    #[error("{0}")]
    Other(String),
}

/// Convenience alias used everywhere in the crate.
pub type ReviewResult<T> = Result<T, ReviewError>;
