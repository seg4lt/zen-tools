//! Load-testing engine, metrics, assertions, and CSV export.
//!
//! The runner is framework-agnostic — it emits `PerfUpdate` values onto an
//! `mpsc::Sender` so the host application (CLI / Tauri / etc.) can translate
//! them to its own event surface.

#![warn(missing_docs)]

pub mod assertion;
pub mod error;
pub mod export;
pub mod metrics;
pub mod runner;
pub mod stop;

pub use assertion::{Assertion, AssertionResult, CompareOp};
pub use error::PerfError;
pub use export::{export_samples_csv, export_summary_csv, export_to_files, format_summary};
pub use metrics::{MetricsCollector, MetricsSnapshot, RequestSample};
pub use runner::{PerfRunner, PerfUpdate};
pub use stop::StopHandle;
