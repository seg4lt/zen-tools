//! GitHub client backed entirely by the `gh` CLI.
//!
//! This crate is a faithful Rust port of `Sources/PRMaster/Services/GitHubService.swift`
//! from the upstream Swift PRMaster app: every GitHub interaction shells out
//! to `gh` via [`zen_shell::ShellExecutor`] — there is **no** direct HTTP, no
//! OAuth, no token storage. Authentication is delegated to the user's
//! `gh auth login` state.
//!
//! Public surface:
//!
//! * [`GhClient`] — cheap-to-clone `Arc`-backed handle owning the executor and
//!   the rolling call log.
//! * [`models`] — DTOs that mirror the Swift `Models/*` layer.
//! * [`GhCall`] / [`call_log_snapshot`](GhClient::call_log_snapshot) — feeds
//!   the API Stats tab.
//! * [`GhError`] — surfaces shell failures and JSON decode problems with
//!   enough context to render in the UI.

#![allow(clippy::module_inception)]

pub mod call_log;
pub mod client;
pub mod error;
pub mod models;

pub use call_log::GhCall;
pub use client::GhClient;
pub use error::{GhError, GhResult};
pub use models::*;
