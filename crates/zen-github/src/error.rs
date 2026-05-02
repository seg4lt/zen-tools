//! Error type returned by every fallible [`GhClient`](crate::GhClient) method.

use thiserror::Error;

/// Errors that can be returned from [`GhClient`](crate::GhClient).
#[derive(Debug, Error)]
pub enum GhError {
    /// `gh` itself returned a non-zero exit, was missing, or timed out.
    #[error(transparent)]
    Shell(#[from] zen_shell::ShellError),

    /// `gh` exited 0 but its stdout could not be parsed as the expected JSON.
    #[error("failed to parse `gh` JSON output: {context}: {source}")]
    Decode {
        /// Human label (e.g. `"search prs"`) for the call whose output failed
        /// to decode.
        context: String,
        /// Underlying serde error.
        #[source]
        source: serde_json::Error,
    },

    /// A GraphQL response carried an `errors` array — surfaces the first
    /// message verbatim.
    #[error("GraphQL error: {0}")]
    Graphql(String),

    /// Catch-all for unexpected response shapes that aren't a clean decode
    /// error (e.g. missing fields).
    #[error("unexpected response shape: {0}")]
    Unexpected(String),
}

/// Result alias used by every [`GhClient`](crate::GhClient) method.
pub type GhResult<T> = Result<T, GhError>;

impl GhError {
    /// Build a [`GhError::Decode`] with the given context label.
    pub fn decode(context: impl Into<String>, source: serde_json::Error) -> Self {
        GhError::Decode {
            context: context.into(),
            source,
        }
    }
}
