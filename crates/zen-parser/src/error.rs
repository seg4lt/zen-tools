//! Error types for parsing operations.

use thiserror::Error;

/// All errors raised by the `zen-parser` crate.
#[derive(Debug, Error)]
pub enum ParserError {
    /// Disk read failed.
    #[error("failed to read {path}: {source}")]
    Io {
        /// Source path the read was attempted on.
        path: String,
        /// Underlying I/O error.
        source: std::io::Error,
    },

    /// JSON deserialisation failure (env files).
    #[error("invalid JSON in {path}: {source}")]
    InvalidJson {
        /// File path.
        path: String,
        /// Underlying serde error.
        source: serde_json::Error,
    },

    /// YAML deserialisation failure (perf configs and variables).
    #[error("invalid YAML in {path}: {source}")]
    InvalidYaml {
        /// File path.
        path: String,
        /// Underlying serde error.
        source: serde_yaml::Error,
    },
}
