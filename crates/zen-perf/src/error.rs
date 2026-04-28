//! Error types for the perf engine.

use thiserror::Error;

/// Errors raised by the perf runner.
#[derive(Debug, Error)]
pub enum PerfError {
    /// Catch-all string error from the runner inner loop.
    #[error("{0}")]
    Runtime(String),

    /// I/O error during CSV export.
    #[error("export failed: {0}")]
    Export(#[from] std::io::Error),
}
