//! Status surfaced by `gh auth status` + `gh --version`.

use serde::{Deserialize, Serialize};

/// Health summary for the `gh` CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStatus {
    /// Whether the `gh` binary was found on the augmented `$PATH`.
    pub installed: bool,
    /// `gh --version` output (`None` when not installed).
    pub version: Option<String>,
    /// Whether `gh auth status` reports an authenticated session.
    pub authenticated: bool,
    /// Login string of the active user (if authenticated).
    pub login: Option<String>,
    /// Hostname (e.g. `github.com` or an enterprise host).
    pub host: Option<String>,
    /// Raw stdout/stderr from `gh auth status` for diagnostics.
    pub raw: String,
}

impl AuthStatus {
    /// Convenience for the disabled / never-checked state.
    pub fn unknown() -> Self {
        Self {
            installed: false,
            version: None,
            authenticated: false,
            login: None,
            host: None,
            raw: String::new(),
        }
    }
}
