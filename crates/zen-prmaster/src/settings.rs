//! Persisted PRMaster settings — port of the various `@AppStorage` keys
//! and `LocalRepoMappingService` from the Swift app.
//!
//! All settings live under a single `"prmaster"` key in zen-tools'
//! `UserConfig` SQLite store. The Tauri command layer (re-)reads this
//! key each time, so the engine doesn't need a long-lived `ArcSwap` —
//! settings are eventually consistent across the popover + main window
//! within one refresh cycle.

use serde::{Deserialize, Serialize};

/// Which PR list a [`BadgeSourceConfig`] derives its count from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BadgeSource {
    /// Number of PRs in the **To Review** bucket.
    ToReview,
    /// Number of PRs in the **Done** bucket.
    Reviewed,
    /// Number of your own open PRs.
    MyPrs,
    /// Number of PRs across all buckets matching a stored filter id.
    Filter,
}

/// One entry in the menu-bar badge config — the rendered badge text is
/// the concatenation of `prefix + count + suffix` for each enabled source
/// whose count is non-zero, joined by spaces.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BadgeSourceConfig {
    /// Which list this entry counts.
    pub source: BadgeSource,
    /// Filter id when `source == Filter`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter_id: Option<String>,
    /// Text inserted before the count (e.g. `""`, `"PR "`, `"📥 "`).
    #[serde(default)]
    pub prefix: String,
    /// Text inserted after the count.
    #[serde(default)]
    pub suffix: String,
    /// Skip this entry without removing it.
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// Local checkout backing a remote `{owner}/{repo}` — mirrors the Swift
/// `LocalRepoMapping` model. Used by the AI Summary tab to read commits
/// via local `git log` instead of `gh api repos/{repo}/commits`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalRepoMapping {
    /// Repo full name (e.g. `"octo/repo"`).
    pub repo: String,
    /// Absolute path to the local checkout.
    pub local_path: String,
}

/// Persistent PRMaster settings. Written to / read from `UserConfig` under
/// the `"prmaster"` key. The defaults match the original PRMaster `@AppStorage`
/// values exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PrMasterSettings {
    /// Master switch — when `false` the background loop is paused and
    /// the tray badge is cleared. Defaults to `true`.
    pub enabled: bool,
    /// Foreground refresh interval (seconds). Default 300 (5 min) —
    /// matches PRMaster's hardcoded `loadIfNeeded` debounce.
    pub polling_interval_secs: u64,
    /// macOS Launch-at-Login toggle. Persisted but applied lazily by the
    /// settings panel via Tauri's autostart plugin in a later phase.
    pub launch_at_login: bool,
    /// Whether the global hotkey (⌥⌘⇧P) is registered.
    pub global_shortcut_enabled: bool,
    /// Master notification toggle.
    pub notifications_enabled: bool,
    /// When `true`, only PRs matched by an enabled filter raise notifications.
    pub only_filter_notifications: bool,
    /// Whether your own PRs raise notifications when reviews / comments land.
    pub my_pr_notifications_enabled: bool,
    /// Menu-bar badge configuration (zero or more sources).
    pub badge_configs: Vec<BadgeSourceConfig>,
    /// Active AI provider tag (`"claude" | "copilot"`).
    pub ai_provider: String,
    /// Provider-specific model id (e.g. `"sonnet"`, `"opus"`, `"haiku"`).
    pub ai_model: String,
    /// Approximate token budget multiplier (1–8). Higher = larger diff
    /// chunks fed to the AI.
    pub ai_token_ratio: u32,
    /// Repos selected for AI Summary (full `owner/repo` names).
    pub selected_repos: Vec<String>,
    /// Cached repo list (full `owner/repo` names), refreshed via
    /// `gh repo list` and the org enumeration.
    pub cached_repos: Vec<String>,
    /// Wall-clock UNIX millis of the last cache refresh.
    pub cached_repos_at_ms: Option<i64>,
    /// Local checkout mappings used by AI Summary.
    pub repo_mappings: Vec<LocalRepoMapping>,
    /// Additional commit-author search terms for the AI Summary
    /// commit fetcher. Combined (OR) with the primary author resolved
    /// from `git config user.email` / `user.name` of each mapped
    /// repo. Useful when the user's git identity has shifted over
    /// time (job changes, multiple emails) or when they want to
    /// roll up a teammate's work into the same report. Each entry
    /// becomes a separate `--author=<value>` flag passed to
    /// `git log`, which `git` matches as a substring against
    /// author name / email — so `"alice"` matches both
    /// `Alice Smith <alice@…>` and `alice@github.com`.
    pub extra_authors: Vec<String>,
    /// Override base directory for AI Review worktrees. When `None`
    /// (default), worktrees go under
    /// `<app_data>/prmaster/ai-review/worktrees/`. When set, they
    /// go under `<value>/zen-tools-ai-review/`.
    /// Persisted reports remain in `<app_data>` regardless — only
    /// the temporary detached checkout moves, which is the slice
    /// users typically want to point at a fast scratch SSD or a
    /// directory git already has on PATH.
    #[serde(default)]
    pub ai_review_worktrees_dir: Option<String>,
}

impl Default for PrMasterSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            polling_interval_secs: 300,
            launch_at_login: false,
            global_shortcut_enabled: true,
            notifications_enabled: true,
            only_filter_notifications: false,
            my_pr_notifications_enabled: true,
            // Default to no badge sources — the menu-bar tray stays
            // pristine until the user opts into a counter from
            // Settings. Mirrors the Swift `@AppStorage("badgeConfig",
            // "[]")` default.
            badge_configs: Vec::new(),
            ai_provider: "claude".to_string(),
            ai_model: "sonnet".to_string(),
            ai_token_ratio: 2,
            selected_repos: Vec::new(),
            cached_repos: Vec::new(),
            cached_repos_at_ms: None,
            repo_mappings: Vec::new(),
            extra_authors: Vec::new(),
            ai_review_worktrees_dir: None,
        }
    }
}

/// Compute the menu-bar badge string from a settings + counts pair.
/// Mirrors the Swift `MenuBarLabel` rendering loop.
pub fn render_badge(
    configs: &[BadgeSourceConfig],
    to_review: usize,
    reviewed: usize,
    mine: usize,
    filter_count: impl Fn(&str) -> usize,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    for cfg in configs.iter().filter(|c| c.enabled) {
        let count = match cfg.source {
            BadgeSource::ToReview => to_review,
            BadgeSource::Reviewed => reviewed,
            BadgeSource::MyPrs => mine,
            BadgeSource::Filter => match cfg.filter_id.as_deref() {
                Some(id) => filter_count(id),
                None => 0,
            },
        };
        if count == 0 {
            continue;
        }
        parts.push(format!("{}{}{}", cfg.prefix, count, cfg.suffix));
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_skips_zero_counts() {
        let cfg = vec![
            BadgeSourceConfig {
                source: BadgeSource::ToReview,
                filter_id: None,
                prefix: "↕ ".into(),
                suffix: "".into(),
                enabled: true,
            },
            BadgeSourceConfig {
                source: BadgeSource::MyPrs,
                filter_id: None,
                prefix: "M".into(),
                suffix: "".into(),
                enabled: true,
            },
        ];
        let out = render_badge(&cfg, 3, 0, 0, |_| 0);
        assert_eq!(out, "↕ 3");
    }

    #[test]
    fn render_skips_disabled() {
        let cfg = vec![BadgeSourceConfig {
            source: BadgeSource::ToReview,
            filter_id: None,
            prefix: "".into(),
            suffix: "".into(),
            enabled: false,
        }];
        let out = render_badge(&cfg, 5, 0, 0, |_| 0);
        assert_eq!(out, "");
    }

    #[test]
    fn render_joins_multiple() {
        let cfg = vec![
            BadgeSourceConfig {
                source: BadgeSource::ToReview,
                filter_id: None,
                prefix: "R".into(),
                suffix: "".into(),
                enabled: true,
            },
            BadgeSourceConfig {
                source: BadgeSource::MyPrs,
                filter_id: None,
                prefix: "M".into(),
                suffix: "".into(),
                enabled: true,
            },
        ];
        let out = render_badge(&cfg, 2, 0, 4, |_| 0);
        assert_eq!(out, "R2 M4");
    }

    #[test]
    fn defaults_match_prmaster() {
        let s = PrMasterSettings::default();
        assert!(s.enabled);
        assert_eq!(s.polling_interval_secs, 300);
        assert!(s.notifications_enabled);
        assert!(s.my_pr_notifications_enabled);
        assert_eq!(s.ai_provider, "claude");
        assert_eq!(s.ai_token_ratio, 2);
        assert!(
            s.badge_configs.is_empty(),
            "default badge_configs should be empty — matches Swift `@AppStorage(\"badgeConfig\", \"[]\")`"
        );
    }
}
