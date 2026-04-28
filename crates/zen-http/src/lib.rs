//! HTTP execution, variable substitution, and dependency resolution.
//!
//! Built on `reqwest` and `tokio`. The public surface is framework-agnostic:
//! the Tauri layer composes this crate without leaking Tauri types into it.
