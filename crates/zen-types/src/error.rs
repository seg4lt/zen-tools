//! Crate-level error type for `zen-types` operations.

use thiserror::Error;

/// Errors raised by helpers in `zen-types`.
#[derive(Debug, Error)]
pub enum ZenTypesError {
    /// JSON deserialisation failure.
    #[error("invalid environment JSON: {0}")]
    InvalidEnvironmentJson(#[from] serde_json::Error),
}
