//! Mirror of `Sources/PRMaster/Models/Repository.swift`.

use serde::{Deserialize, Serialize};

/// A GitHub repository — only the fields we need for PRMaster's UI.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Repository {
    /// Bare repo name (e.g. `"zen-tools"`).
    pub name: String,
    /// `"{owner}/{repo}"` — the canonical id.
    #[serde(rename = "nameWithOwner")]
    pub name_with_owner: String,
}

impl Repository {
    /// `"{owner}/{repo}"` — the canonical id.
    pub fn id(&self) -> &str {
        &self.name_with_owner
    }

    /// Parse `name_with_owner` into `(owner, repo)`. Falls back to
    /// `("", &self.name)` for malformed inputs.
    pub fn split(&self) -> (&str, &str) {
        match self.name_with_owner.split_once('/') {
            Some((owner, repo)) => (owner, repo),
            None => ("", &self.name),
        }
    }

    /// Owner segment (first half of `name_with_owner`).
    pub fn owner(&self) -> &str {
        self.split().0
    }

    /// Bare repo segment (second half of `name_with_owner`), or `name` as
    /// fallback.
    pub fn short_name(&self) -> &str {
        self.split().1
    }
}
