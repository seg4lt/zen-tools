//! Error types for HTTP execution and dependency resolution.

use std::path::PathBuf;
use thiserror::Error;

/// Errors raised by HTTP execution.
#[derive(Debug, Error)]
pub enum HttpError {
    /// Underlying transport error (DNS, connect, TLS, etc).
    #[error("request failed: {0}")]
    Transport(#[from] reqwest::Error),

    /// HTTP method string did not match a known method.
    #[error("unknown HTTP method: {0}")]
    UnknownMethod(String),

    /// Failed to read response body.
    #[error("failed to read response body: {0}")]
    BodyRead(String),
}

/// Local-only dependency-graph errors.
#[derive(Debug, Error)]
pub enum DependencyError {
    /// Target request id was not present in the file.
    #[error("target request not found: {0}")]
    TargetNotFound(String),
    /// A dependency referenced an unknown name.
    #[error("dependency not found: {0}")]
    DependencyNotFound(String),
    /// `petgraph::toposort` reported a cycle.
    #[error("circular dependency detected")]
    CycleDetected,
}

/// Cross-file dependency resolution errors.
#[derive(Debug, Error)]
pub enum CrossFileDependencyError {
    /// Source file could not be located.
    #[error("file not found: {0}")]
    FileNotFound(String),
    /// Dependency request name not found in the resolved file.
    #[error("request '{request}' not found in '{file}'")]
    RequestNotFound {
        /// Resolved file path.
        file: String,
        /// Requested name.
        request: String,
    },
    /// Cycle in cross-file dependency graph.
    #[error("circular cross-file dependency involving: {0}")]
    CycleDetected(String),
    /// Disk read failure.
    #[error("failed to read file {0}: {1}")]
    FileReadError(String, String),
}

/// File-registry errors.
#[derive(Debug, Error)]
pub enum FileRegistryError {
    /// File does not exist on disk.
    #[error("file not found: {0}")]
    FileNotFound(PathBuf),
    /// I/O error while reading the file.
    #[error("failed to read file {path}: {source}")]
    ReadError {
        /// File path.
        path: PathBuf,
        /// Underlying I/O error.
        source: std::io::Error,
    },
    /// Path could not be resolved (no parent for relative resolution).
    #[error("invalid path: {0}")]
    InvalidPath(String),
}
