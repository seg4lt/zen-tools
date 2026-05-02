//! Mirror of `Sources/PRMaster/Models/Author.swift`.

use serde::{Deserialize, Serialize};

/// PR author / commenter as returned by `gh search prs --json author`.
#[derive(Debug, Default, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Author {
    /// Stable id (node-id or user-id depending on the call).
    #[serde(default)]
    pub id: String,
    /// GitHub login (e.g. `"octocat"`).
    #[serde(default)]
    pub login: String,
    /// `true` for `Bot` accounts.
    #[serde(default, rename = "is_bot")]
    pub is_bot: bool,
    /// `User`, `Bot`, `Organization`, etc.
    #[serde(default, rename = "type")]
    pub kind: String,
    /// Profile URL.
    #[serde(default)]
    pub url: String,
}

impl Author {
    /// `"@login"` for display in the UI.
    pub fn display_name(&self) -> String {
        format!("@{}", self.login)
    }
}
