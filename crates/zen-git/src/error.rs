//! Error type returned by every fallible [`GitEngine`](crate::GitEngine) method.

use std::path::PathBuf;
use thiserror::Error;

/// Errors raised by [`GitEngine`](crate::GitEngine).
#[derive(Debug, Error)]
pub enum GitError {
    /// `git` itself returned a non-zero exit, was missing, or timed out.
    #[error(transparent)]
    Shell(#[from] zen_shell::ShellError),

    /// I/O error reading or writing one of the on-disk JSON files
    /// (currently just the repo registry).
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    /// The repo registry's JSON could not be parsed.
    #[error("repo registry: {0}")]
    Registry(#[from] serde_json::Error),

    /// Caller passed a path that is not a git working tree.
    #[error("not a git working tree: {0}")]
    NotARepo(PathBuf),

    /// Caller asked for an op (continue/abort/skip) but no merge /
    /// rebase / cherry-pick is in progress.
    #[error("no merge, rebase, or cherry-pick in progress")]
    NoOpInProgress,

    /// Caller asked for `--skip` on a plain merge (which has no skip
    /// semantics).
    #[error("--skip is not supported for `git merge`; use abort or resolve manually")]
    SkipNotSupported,

    /// `git` exited 0 but its stdout could not be parsed in the way the
    /// caller expected (used for the custom-format `git log` parser).
    #[error("failed to parse `git` output: {0}")]
    Parse(String),

    /// Catch-all for ad-hoc errors.
    #[error("{0}")]
    Other(String),
}

/// Convenience alias used by every fallible engine method.
pub type GitResult<T> = Result<T, GitError>;
