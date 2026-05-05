//! Tauri command surface for the PRMaster tool.
//!
//! All commands proxy to [`zen_prmaster::PrMasterEngine`] held inside
//! [`AppState`]. The engine itself wraps a `gh`-CLI-backed GitHub client —
//! see `crates/zen-github` for the underlying transport.
//!
//! The surface exposed here is the **P1 cut**: enough for the **Mine** tab
//! (list mine, get detail, approve / request-changes / add-self-as-reviewer)
//! plus the auth probe used by the Settings panel. Subsequent phases extend
//! this module without churning existing signatures.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use zen_github::{
    AuthStatus, CheckContext, ConversationGroup, ConversationItem, DiffSide, EnrichedPullRequest,
    GhCall, PrDiff, PrRef,
};
use zen_prmaster::{
    AiSummaryParams, NotificationFilter, PrMasterSettings, SummaryCard,
};

use crate::user_config::UserConfig;

use crate::error::AppResult;
use crate::state::AppState;

/// Snapshot of a single CI check used by the Mine tab's detail panel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckSummaryDto {
    /// Display label (CheckRun name → StatusContext context).
    pub name: String,
    /// `success | pending | failed | unknown`.
    pub kind: &'static str,
    /// Click-through URL (if the provider supplied one).
    pub url: Option<String>,
}

impl From<&CheckContext> for CheckSummaryDto {
    fn from(c: &CheckContext) -> Self {
        let kind = if c.is_success() {
            "success"
        } else if c.is_pending() {
            "pending"
        } else if c.is_failed() {
            "failed"
        } else {
            "unknown"
        };
        Self {
            name: c.display_name().to_string(),
            kind,
            url: c.url().map(|s| s.to_string()),
        }
    }
}

fn engine(state: &AppState) -> zen_prmaster::PrMasterEngine {
    state.prmaster.clone()
}

/// Return the current GitHub user's login (`gh api user --jq .login`).
#[tauri::command]
pub async fn prmaster_whoami(state: State<'_, Mutex<AppState>>) -> AppResult<String> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(engine.whoami().await?)
}

/// Return the combined `gh --version` + `gh auth status` health check.
#[tauri::command]
pub async fn prmaster_get_gh_status(
    state: State<'_, Mutex<AppState>>,
) -> AppResult<AuthStatus> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(engine.auth_status().await?)
}

/// Open PRs the current user authored, enriched with reviewer + check
/// detail (drives the **Mine** tab).
#[tauri::command]
pub async fn prmaster_get_mine(
    state: State<'_, Mutex<AppState>>,
) -> AppResult<Vec<EnrichedPullRequest>> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(engine.list_mine().await?)
}

/// Open PRs requesting the current user as reviewer, enriched with
/// reviewer / check / mergeable detail (drives the **To Review** tab).
#[tauri::command]
pub async fn prmaster_get_to_review(
    state: State<'_, Mutex<AppState>>,
) -> AppResult<Vec<EnrichedPullRequest>> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(engine.list_to_review().await?)
}

/// Open PRs the current user has reviewed, enriched (drives the **Done**
/// tab).
#[tauri::command]
pub async fn prmaster_get_reviewed(
    state: State<'_, Mutex<AppState>>,
) -> AppResult<Vec<EnrichedPullRequest>> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(engine.list_reviewed().await?)
}

/// Submit an APPROVE review on `pr`.
#[tauri::command]
pub async fn prmaster_approve_pr(
    state: State<'_, Mutex<AppState>>,
    pr: PrRef,
) -> AppResult<()> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    engine.approve(&pr).await?;
    Ok(())
}

/// Submit a REQUEST_CHANGES review on `pr` with `body`.
#[tauri::command]
pub async fn prmaster_request_changes(
    state: State<'_, Mutex<AppState>>,
    pr: PrRef,
    body: String,
) -> AppResult<()> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    engine.request_changes(&pr, &body).await?;
    Ok(())
}

/// Fetch the per-file diff for `pr`. Uses a local clone (when the
/// repo is mapped in settings) for an instant, offline-friendly diff
/// that's always up-to-date against `origin`; otherwise falls back to
/// the GitHub REST `/pulls/{n}/files` endpoint.
#[tauri::command]
pub async fn prmaster_get_pr_diff(
    state: State<'_, Mutex<AppState>>,
    config: State<'_, UserConfig>,
    pr: PrRef,
    base_ref: Option<String>,
    head_ref: Option<String>,
) -> AppResult<PrDiff> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    let settings = config
        .get::<PrMasterSettings>(PRMASTER_SETTINGS_KEY)?
        .unwrap_or_default();
    Ok(engine
        .pr_diff(&pr, base_ref.as_deref(), head_ref.as_deref(), &settings)
        .await?)
}

/// Post a single inline review comment on `pr` at `path`:`line`,
/// anchored at `commit_sha` on `side` (LEFT = old, RIGHT = new).
#[tauri::command]
pub async fn prmaster_add_review_comment(
    state: State<'_, Mutex<AppState>>,
    pr: PrRef,
    body: String,
    commit_sha: String,
    path: String,
    line: u32,
    side: DiffSide,
) -> AppResult<()> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    engine
        .add_review_comment(&pr, &body, &commit_sha, &path, line, side)
        .await?;
    Ok(())
}

/// Add `login` as a requested reviewer on `pr`. The frontend supplies the
/// login (typically the result of [`prmaster_whoami`]).
#[tauri::command]
pub async fn prmaster_add_self_reviewer(
    state: State<'_, Mutex<AppState>>,
    pr: PrRef,
    login: String,
) -> AppResult<()> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    engine.add_reviewer(&pr, &login).await?;
    Ok(())
}

/// Conversation groups — unresolved review threads and top-level @mentions
/// on PRs the user is involved in.
#[tauri::command]
pub async fn prmaster_get_conversations(
    state: State<'_, Mutex<AppState>>,
) -> AppResult<Vec<ConversationGroup>> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(engine.list_conversations().await?)
}

/// Every unresolved review thread and top-level comment on a single PR —
/// returns the full set regardless of whether the current user is
/// involved. Drives the Conversations footer on the dedicated review
/// page (`/prmaster/review/$owner/$repo/$number`), where a reviewer
/// needs to see every open discussion, not just the threads naming
/// them.
#[tauri::command]
pub async fn prmaster_get_pr_conversations(
    state: State<'_, Mutex<AppState>>,
    pr: PrRef,
) -> AppResult<Vec<ConversationItem>> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(engine.list_pr_conversations(&pr).await?)
}

/// Snapshot of the rolling `gh` call log (drives the API Stats tab — P7
/// renders a UI; this command is exposed early because the call log is
/// always populated regardless of which tab is open).
#[tauri::command]
pub async fn prmaster_get_call_log(
    state: State<'_, Mutex<AppState>>,
) -> AppResult<Vec<GhCall>> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(engine.call_log())
}

/// Return the rolling AI-summary run log, newest-first. Drives the
/// "AI runs" panel on the API Stats tab so the user can verify the
/// resolved provider + model their settings produced.
#[tauri::command]
pub async fn prmaster_get_ai_runs(
    state: State<'_, Mutex<AppState>>,
) -> AppResult<Vec<zen_prmaster::AiRunRecord>> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(engine.ai_runs())
}

/// Storage key under [`UserConfig`] for the PRMaster settings blob.
const PRMASTER_SETTINGS_KEY: &str = "prmaster";

/// Force a refresh + notification diff. Mirrors the Swift
/// `PRListViewModel.refresh()` user-driven path; the 5-minute background
/// loop calls the engine directly without going through this command.
#[tauri::command]
pub async fn prmaster_refresh(
    state: State<'_, Mutex<AppState>>,
    config: State<'_, UserConfig>,
) -> AppResult<()> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    let settings = config
        .get::<PrMasterSettings>(PRMASTER_SETTINGS_KEY)?
        .unwrap_or_default();
    engine.refresh_lists_and_notify(&settings).await?;
    Ok(())
}

/// Read persisted PRMaster settings (returns defaults if nothing saved).
#[tauri::command]
pub async fn prmaster_get_settings(
    config: State<'_, UserConfig>,
) -> AppResult<PrMasterSettings> {
    Ok(config
        .get::<PrMasterSettings>(PRMASTER_SETTINGS_KEY)?
        .unwrap_or_default())
}

/// Persist updated PRMaster settings.
#[tauri::command]
pub async fn prmaster_save_settings(
    config: State<'_, UserConfig>,
    settings: PrMasterSettings,
) -> AppResult<()> {
    config.set(PRMASTER_SETTINGS_KEY, &settings)?;
    Ok(())
}

/// List every persisted notification filter (oldest first).
#[tauri::command]
pub async fn prmaster_list_filters(
    state: State<'_, Mutex<AppState>>,
) -> AppResult<Vec<NotificationFilter>> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    engine
        .list_filters()
        .map_err(|e| crate::error::AppError::Other(format!("filter store: {e}")))
}

/// Insert or update a notification filter. The frontend supplies the full
/// row; the engine bumps `updated_at_ms` and persists.
#[tauri::command]
pub async fn prmaster_save_filter(
    state: State<'_, Mutex<AppState>>,
    filter: NotificationFilter,
) -> AppResult<()> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    engine
        .save_filter(&filter)
        .map_err(|e| crate::error::AppError::Other(format!("filter store: {e}")))
}

/// Fire a synthetic notification through the same broadcast bridge a
/// real PRMaster notification uses. The frontend wires this to the
/// per-row "test" button on the Filters tab.
#[tauri::command]
pub async fn prmaster_test_filter_notification(
    state: State<'_, Mutex<AppState>>,
    id: String,
) -> AppResult<()> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    let filters = engine
        .list_filters()
        .map_err(|e| crate::error::AppError::Other(format!("filter store: {e}")))?;
    let Some(filter) = filters.into_iter().find(|f| f.id == id) else {
        return Err(crate::error::AppError::Other(format!(
            "no filter with id {id}"
        )));
    };
    engine
        .fire_test_notification(&filter)
        .map_err(|e| crate::error::AppError::Other(format!("filter test: {e}")))
}

/// Delete a filter by id.
#[tauri::command]
pub async fn prmaster_delete_filter(
    state: State<'_, Mutex<AppState>>,
    id: String,
) -> AppResult<()> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    engine
        .delete_filter(&id)
        .map_err(|e| crate::error::AppError::Other(format!("filter store: {e}")))
}

/// Destroy the menu-bar popover window. Called by the popover shell on
/// `blur` so the WKWebView's `WebContent` subprocess is freed when the
/// user clicks away (the next tray click rebuilds it). Renamed from
/// `prmaster_hide_popover` — the JS side still invokes the old name
/// during a transitional period; both routes through the same destroy.
#[tauri::command]
pub async fn prmaster_hide_popover(app: AppHandle) -> AppResult<()> {
    crate::prmaster_tray::destroy_popover(&app);
    Ok(())
}

/// Update the menu-bar tray badge text. Pass an empty string to clear it.
/// The 5-minute background refresh loop in `lib.rs` calls this via the
/// broadcast bridge; surfacing it as a command also lets the frontend
/// nudge the badge directly (e.g. after an optimistic action).
#[tauri::command]
pub async fn prmaster_set_badge(app: AppHandle, badge: String) -> AppResult<()> {
    crate::prmaster_tray::set_badge(&app, &badge);
    Ok(())
}

/// Generate (or return cached) AI summary for `(repo, since, until)`.
#[tauri::command]
pub async fn prmaster_ai_summary(
    state: State<'_, Mutex<AppState>>,
    config: State<'_, UserConfig>,
    params: AiSummaryParams,
) -> AppResult<SummaryCard> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    let settings = config
        .get::<PrMasterSettings>(PRMASTER_SETTINGS_KEY)?
        .unwrap_or_default();
    let card = engine
        .ai_summary(&params, &settings)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("ai summary: {e}")))?;
    Ok(card)
}

/// List the active provider's supported model identifiers.
#[tauri::command]
pub async fn prmaster_ai_list_models(
    state: State<'_, tokio::sync::Mutex<crate::state::AppState>>,
    config: State<'_, UserConfig>,
) -> AppResult<Vec<String>> {
    let settings = config
        .get::<PrMasterSettings>(PRMASTER_SETTINGS_KEY)?
        .unwrap_or_default();
    let engine = state.lock().await.prmaster.clone();
    engine
        .ai_list_models(&settings)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("ai list_models: {e}")))
}

/// Storage key for the AI Summary tab's persistent card list — the
/// flat collection of completed `SummaryCard`s the user has generated
/// over time. Mirrors the Swift `AISummaryCacheService` (`UserDefaults`
/// `aiSummaryCache` key).
const PRMASTER_AI_SUMMARIES_KEY: &str = "prmaster_ai_summaries";

/// Storage key for the most-recent `RefreshSnapshot`. The frontend
/// bootstraps from this so cold-start shows the user's last-seen PR
/// lists instead of an empty state, mirroring Swift's `CacheService`
/// behaviour (`PRListViewModel.swift:102–116`).
const PRMASTER_PR_SNAPSHOT_KEY: &str = "prmaster_pr_snapshot";

/// Read the persisted PR snapshot. Returns `None` on first launch (or
/// after a `Clear` op) so the frontend can decide whether to seed the
/// store or wait for the first poll.
#[tauri::command]
pub async fn prmaster_load_pr_snapshot(
    config: State<'_, UserConfig>,
) -> AppResult<Option<zen_prmaster::RefreshSnapshot>> {
    Ok(config.get::<zen_prmaster::RefreshSnapshot>(PRMASTER_PR_SNAPSHOT_KEY)?)
}

/// Persist a `RefreshSnapshot`. Wired up by the Tauri broadcast bridge
/// in `src-tauri/src/lib.rs` so every successful refresh updates the
/// on-disk cache without explicit calls from the frontend.
pub fn persist_pr_snapshot(
    config: &UserConfig,
    snapshot: &zen_prmaster::RefreshSnapshot,
) {
    if let Err(e) = config.set(PRMASTER_PR_SNAPSHOT_KEY, snapshot) {
        tracing::warn!(error = %e, "persist pr snapshot failed");
    }
}

/// Load every persisted summary card for the AI tab. Returns an empty
/// list if the user has never generated one.
#[tauri::command]
pub async fn prmaster_load_ai_summaries(
    config: State<'_, UserConfig>,
) -> AppResult<Vec<SummaryCard>> {
    Ok(config
        .get::<Vec<SummaryCard>>(PRMASTER_AI_SUMMARIES_KEY)?
        .unwrap_or_default())
}

/// Replace the persisted summary card list. The frontend owns the
/// ordering / dedup policy; we just round-trip the JSON.
#[tauri::command]
pub async fn prmaster_save_ai_summaries(
    config: State<'_, UserConfig>,
    summaries: Vec<SummaryCard>,
) -> AppResult<()> {
    config.set(PRMASTER_AI_SUMMARIES_KEY, &summaries)?;
    Ok(())
}

/// Drop the persisted summary card list (the AI tab's "Clear cache"
/// button). Independent of the engine-level prompt-response cache
/// cleared by [`prmaster_clear_ai_cache`].
#[tauri::command]
pub async fn prmaster_clear_ai_summaries(
    config: State<'_, UserConfig>,
) -> AppResult<()> {
    config.set::<Vec<SummaryCard>>(PRMASTER_AI_SUMMARIES_KEY, &Vec::new())?;
    Ok(())
}

/// Drop every cached AI summary card.
#[tauri::command]
pub async fn prmaster_clear_ai_cache(
    state: State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    engine
        .clear_ai_cache()
        .map_err(|e| crate::error::AppError::Io(e))
}

/// Result shape for `prmaster_list_repos` / `prmaster_fetch_repos` —
/// returns the cached list, when it was last refreshed, and whether the
/// cache has aged past the 7-day TTL (so the UI can prompt for a Fetch).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoListResult {
    /// The cached repository list (`owner/repo`).
    pub repos: Vec<String>,
    /// UNIX millis of the last successful fetch (`None` until first fetch).
    pub cached_at_ms: Option<i64>,
    /// `true` when the cached list is older than [`REPO_CACHE_TTL_MS`].
    pub stale: bool,
}

/// 7-day cache TTL for the accessible-repo list. Beyond this we mark
/// the cache as `stale` so the UI can highlight the Fetch button.
const REPO_CACHE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

fn is_stale(cached_at_ms: Option<i64>) -> bool {
    match cached_at_ms {
        None => true,
        Some(ts) => {
            let now = chrono::Utc::now().timestamp_millis();
            (now - ts) > REPO_CACHE_TTL_MS
        }
    }
}

/// Read the cached accessible-repo list. If nothing has been cached yet
/// **or** the cache is older than 7 days, this transparently fetches
/// fresh data from GitHub and updates the cache. Otherwise it returns
/// the cached list immediately (no network).
#[tauri::command]
pub async fn prmaster_list_repos(
    state: State<'_, Mutex<AppState>>,
    config: State<'_, UserConfig>,
) -> AppResult<RepoListResult> {
    let mut settings = config
        .get::<PrMasterSettings>(PRMASTER_SETTINGS_KEY)?
        .unwrap_or_default();

    // Cold cache or stale cache → re-fetch transparently.
    if settings.cached_repos.is_empty() || is_stale(settings.cached_repos_at_ms) {
        let engine = {
            let s = state.lock().await;
            engine(&s)
        };
        match engine.list_accessible_repos().await {
            Ok(fresh) => {
                settings.cached_repos = fresh;
                settings.cached_repos_at_ms =
                    Some(chrono::Utc::now().timestamp_millis());
                config.set(PRMASTER_SETTINGS_KEY, &settings)?;
            }
            Err(e) => {
                // Network/auth failure: fall back to whatever's cached
                // (possibly empty). Don't error — the UI will surface
                // an empty list rather than a hard failure.
                tracing::warn!(error = %e, "list_accessible_repos failed; returning cache");
            }
        }
    }

    Ok(RepoListResult {
        repos: settings.cached_repos.clone(),
        cached_at_ms: settings.cached_repos_at_ms,
        stale: is_stale(settings.cached_repos_at_ms),
    })
}

/// Force re-fetch the accessible-repo list from GitHub, ignoring the
/// 7-day cache. Surfaced behind a "Fetch from GitHub" button in
/// Settings and on the AI Summary tab.
#[tauri::command]
pub async fn prmaster_fetch_repos(
    state: State<'_, Mutex<AppState>>,
    config: State<'_, UserConfig>,
) -> AppResult<RepoListResult> {
    let engine = {
        let s = state.lock().await;
        engine(&s)
    };
    let fresh = engine.list_accessible_repos().await?;
    let now = chrono::Utc::now().timestamp_millis();

    let mut settings = config
        .get::<PrMasterSettings>(PRMASTER_SETTINGS_KEY)?
        .unwrap_or_default();
    settings.cached_repos = fresh.clone();
    settings.cached_repos_at_ms = Some(now);
    config.set(PRMASTER_SETTINGS_KEY, &settings)?;

    Ok(RepoListResult {
        repos: fresh,
        cached_at_ms: Some(now),
        stale: false,
    })
}

/// Quit the entire application. Surfaced as a command so the
/// SettingsTab "Quit" button doesn't need the autostart / process
/// plugin (which is not installed in this workspace). Equivalent to
/// the menu-bar tray's "Quit PRMaster" item.
#[tauri::command]
pub async fn prmaster_quit_app(app: AppHandle) -> AppResult<()> {
    app.exit(0);
    Ok(())
}

/// Bring the main window forward and switch back to the regular macOS
/// activation policy (so the Dock icon reappears if we were running in
/// background-agent / accessory mode).
#[tauri::command]
pub async fn prmaster_open_full_window(app: AppHandle) -> AppResult<()> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
    }
    Ok(())
}
