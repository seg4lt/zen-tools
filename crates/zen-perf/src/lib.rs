//! Load-testing engine, metrics, assertions, and CSV export.
//!
//! The runner is framework-agnostic — it emits `PerfUpdate` values onto an
//! `mpsc::Sender` so the host application (CLI / Tauri / etc.) can translate
//! them to its own event surface.
