//! GitHub client backed entirely by the `gh` CLI.
//!
//! Every GitHub interaction shells out to `gh` via
//! [`zen_shell::ShellExecutor`] — there is **no** direct HTTP, no OAuth,
//! no token storage. Authentication is delegated to the user's
//! `gh auth login` state, which means the user's existing two-factor
//! setup, SSO, enterprise hosts, and credential rotation all keep
//! working without anything in this crate to maintain.
//!
//! ## Reliability
//!
//! `gh` calls go through `gh_retry` (3 attempts, 1 → 2 → 4 s exponential
//! backoff) so a transient network blip doesn't bubble up as a hard
//! failure. Auth and not-found errors short-circuit immediately.
//!
//! ## Public surface
//!
//! * [`GhClient`] — cheap-to-clone `Arc`-backed handle owning the executor
//!   and the rolling call log.
//! * [`models`] — DTOs covering PRs, reviews, repositories, conversation
//!   threads, CI checks, and auth state.
//! * [`GhCall`] / [`call_log_snapshot`](GhClient::call_log_snapshot) —
//!   feeds the PRMaster API Stats tab so the user can see every `gh`
//!   invocation with timing + success/fail.
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
