//! Domain controller for the PRMaster tool.
//!
//! Direct port of the Swift `PRListViewModel` + the various `*Service`
//! types from PRMaster, brought up phase-by-phase:
//!
//! * **P1**: minimal [`PrMasterEngine`] wrapping a [`zen_github::GhClient`]
//!   so the Tauri command layer has something to call. Surfaces enough for
//!   the **Mine** tab.
//! * **P2** (current): adds the **client-side reclassification** that the
//!   Swift `refresh()` performs — `gh search prs --review-requested @me`
//!   and `--reviewed-by @me` overlap, so PRs are split into "To Review"
//!   vs "Done" by inspecting whether the current user has submitted an
//!   approving / changes-requested review. A short-lived in-memory cache
//!   (30 s TTL) avoids re-fetching when the user clicks between tabs.
//! * **P5** will add the 300 s background refresh loop, the notification
//!   diff, and broadcast events on top of [`refresh_lists`].
//! * **P6** will add the AI Summary orchestration on top of `zen-ai-cli`.
//!
//! Keeping the public surface stable from P1 onwards means the Tauri
//! command layer doesn't churn between phases.

pub mod filters;
pub mod notifications;
pub mod settings;
pub mod summary;

pub use filters::{FilterStore, FilterStoreError, NotificationAction, NotificationFilter};
pub use notifications::{
    MyPrNotificationReason, NotificationStore, PrNotificationState, ReviewNotificationReason,
};
pub use settings::{
    render_badge, BadgeSource, BadgeSourceConfig, LocalRepoMapping, PrMasterSettings,
};
pub use summary::{
    AiSummaryCache, AiSummaryParams, SummaryCard, SummaryError,
};

use std::sync::Arc;
use std::time::{Duration, Instant};

use arc_swap::ArcSwapOption;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tracing::warn;
use zen_github::{
    ConversationGroup, EnrichedPullRequest, GhCall, GhClient, GhResult, PrRef, PullRequest,
    ReviewEvent, ReviewState,
};


/// How long the engine reuses its last refresh result before re-fetching.
/// Mirrors the Swift `loadIfNeeded` debounce — 30 s is short enough that
/// switching tabs doesn't show stale data, long enough that opening Mine
/// then Done within a single user gesture doesn't issue 6 redundant `gh`
/// invocations.
const REFRESH_TTL: Duration = Duration::from_secs(30);

/// Bucket-by-tab snapshot of the PR universe at one point in time.
/// Stored inside [`PrMasterEngine`] so subsequent tab loads can serve from
/// cache; broadcast verbatim to the frontend via `prmaster:refreshed` once
/// P5 wires up the refresh loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshSnapshot {
    /// Login of the current user at the moment of the refresh.
    pub current_user: Option<String>,
    /// PRs requesting your review where you haven't yet approved or
    /// requested changes.
    pub to_review: Vec<EnrichedPullRequest>,
    /// PRs you've approved or requested changes on.
    pub reviewed: Vec<EnrichedPullRequest>,
    /// Your own open PRs.
    pub mine: Vec<EnrichedPullRequest>,
    /// Wall-clock instant the snapshot was built (UNIX millis).
    pub fetched_at_ms: i64,
}

/// Top-level controller. Cheap to clone — the inner state is `Arc`-backed.
#[derive(Debug, Clone)]
pub struct PrMasterEngine {
    inner: Arc<EngineInner>,
}

#[derive(Debug)]
struct EngineInner {
    gh: GhClient,
    snapshot: ArcSwapOption<RefreshSnapshot>,
    /// `Instant` cache marker — if the snapshot was built less than
    /// `REFRESH_TTL` ago, [`refresh_lists`] returns it without refetching.
    refresh_lock: Mutex<Option<Instant>>,
    /// SQLite-backed filter store. Lazily opened on first access — none
    /// of the cargo unit tests should touch the real on-disk DB.
    filter_store: Mutex<Option<FilterStore>>,
    /// JSON-file-backed notification-state cache. Lazily opened.
    notification_store: Mutex<Option<notifications::NotificationStore>>,
    /// JSON-file-backed AI summary cache. Lazily opened.
    summary_cache: Mutex<Option<AiSummaryCache>>,
    /// Fan-out channel for refresh / badge / notification events. Held
    /// for the engine's lifetime so subscribers can be added at any time.
    tx: broadcast::Sender<PrMasterEvent>,
}

/// Events broadcast by the engine to the Tauri command layer (which
/// re-emits them as Tauri events, see `lib.rs` in `src-tauri`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "payload")]
pub enum PrMasterEvent {
    /// A refresh just finished — payload is the new snapshot.
    Refreshed(RefreshSnapshot),
    /// Tray badge text changed — payload is the new string (`""` clears).
    BadgeChanged(String),
    /// A notification should be presented — payload describes it.
    Notification(PendingNotification),
}

/// A user-visible notification waiting to be presented through
/// `tauri-plugin-notification`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingNotification {
    /// Stable id (`{pr_id}:{kind}`) — useful for deduping in the UI.
    pub id: String,
    /// Notification banner title.
    pub title: String,
    /// Body text.
    pub body: String,
    /// PR url to open when the user clicks the banner.
    pub url: String,
    /// Whether to suppress the system sound (only Sound+Banner uses it).
    pub silent: bool,
    /// Whether the banner should be hidden completely (badge-only / mute).
    pub badge_only: bool,
    /// Whether the notification should be muted entirely.
    pub muted: bool,
}

impl PrMasterEngine {
    /// Build an engine with the standard [`GhClient`] (PATH-augmented `gh`).
    pub fn new() -> Self {
        Self {
            inner: Arc::new(EngineInner {
                gh: GhClient::new(),
                snapshot: ArcSwapOption::const_empty(),
                refresh_lock: Mutex::new(None),
                filter_store: Mutex::new(None),
                notification_store: Mutex::new(None),
                summary_cache: Mutex::new(None),
                tx: broadcast::channel(64).0,
            }),
        }
    }

    /// Build an engine wrapping a caller-provided client.
    pub fn with_gh_client(gh: GhClient) -> Self {
        Self {
            inner: Arc::new(EngineInner {
                gh,
                snapshot: ArcSwapOption::const_empty(),
                refresh_lock: Mutex::new(None),
                filter_store: Mutex::new(None),
                notification_store: Mutex::new(None),
                summary_cache: Mutex::new(None),
                tx: broadcast::channel(64).0,
            }),
        }
    }

    /// Subscribe to engine events. The broadcast is fan-out — every
    /// subscriber sees every event from the moment they subscribed.
    pub fn subscribe(&self) -> broadcast::Receiver<PrMasterEvent> {
        self.inner.tx.subscribe()
    }

    /// Spawn the 5-minute background-refresh task (mirrors the hardcoded
    /// `Timer.scheduledTimer(withTimeInterval: 300, repeats: true)` in
    /// the Swift app). Returns the [`JoinHandle`] so the caller can
    /// abort / await on shutdown.
    ///
    /// **Caller must already be inside a tokio runtime**, otherwise
    /// `tokio::spawn` panics. Tauri's `setup` callback runs on the AppKit
    /// main thread, *not* a tokio worker — to spawn from there, use
    /// `tauri::async_runtime::spawn` directly with the same loop body
    /// (see `src-tauri/src/lib.rs`).
    pub fn start_background_loop(self) -> JoinHandle<()> {
        let engine = self;
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(300));
            // Skip the immediate first tick — the foreground UI fires its
            // own refresh on mount; we don't want to compete with that.
            tick.tick().await;
            loop {
                tick.tick().await;
                if let Err(e) = engine.refresh_lists_and_notify(&PrMasterSettings::default()).await {
                    tracing::warn!(error = %e, "background refresh failed");
                }
            }
        })
    }

    fn notification_store(&self) -> std::io::Result<NotificationStore> {
        let mut slot = self.inner.notification_store.lock();
        if let Some(s) = slot.as_ref() {
            return Ok(s.clone());
        }
        let dir = dirs::data_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("com.zen-tools.app")
            .join("prmaster");
        let store = NotificationStore::open_in(&dir)?;
        *slot = Some(store.clone());
        Ok(store)
    }

    /// Refresh + diff against the notification cache + broadcast every
    /// resulting event. Used by the background loop and by the
    /// `prmaster_refresh` Tauri command, which passes its current
    /// settings so notifications respect the user's preferences.
    pub async fn refresh_lists_and_notify(
        &self,
        settings: &PrMasterSettings,
    ) -> GhResult<Arc<RefreshSnapshot>> {
        let snapshot = self.refresh_lists().await?;
        let _ = self.inner.tx.send(PrMasterEvent::Refreshed((*snapshot).clone()));

        if settings.notifications_enabled {
            let store = match self.notification_store() {
                Ok(s) => Some(s),
                Err(e) => {
                    warn!(error = %e, "notification_store open failed");
                    None
                }
            };
            let filters = self.list_filters().unwrap_or_default();

            if let Some(store) = store.as_ref() {
                for pr in &snapshot.to_review {
                    if let Some(reason) = store.check_review_notification(pr) {
                        if let Some(note) =
                            build_review_notification(pr, reason, &filters, settings)
                        {
                            let _ = self.inner.tx.send(PrMasterEvent::Notification(note));
                        }
                    } else {
                        store.mark_seen(pr);
                    }
                }

                if settings.my_pr_notifications_enabled {
                    for pr in &snapshot.mine {
                        if let Some(reason) = store.check_my_pr_notification(pr) {
                            if let Some(note) = build_my_pr_notification(pr, &reason, settings) {
                                let _ = self.inner.tx.send(PrMasterEvent::Notification(note));
                            }
                        }
                    }
                }
            }
        }

        // Pre-compute filter counts only if any badge entry actually
        // requests one. Each match runs against the To Review bucket
        // (mirrors the Swift `MenuBarLabel.countFor("filter:…")`).
        let needs_filters = settings
            .badge_configs
            .iter()
            .any(|c| matches!(c.source, BadgeSource::Filter) && c.enabled);
        let filters: Vec<NotificationFilter> = if needs_filters {
            self.list_filters().unwrap_or_default()
        } else {
            Vec::new()
        };

        let filter_count = |id: &str| -> usize {
            let Some(filter) = filters.iter().find(|f| f.id == id && f.enabled) else {
                return 0;
            };
            snapshot
                .to_review
                .iter()
                .filter(|enriched| {
                    let file_paths: Vec<String> = enriched
                        .detail
                        .as_ref()
                        .and_then(|d| d.files.as_ref())
                        .map(|f| f.nodes.iter().map(|n| n.path.clone()).collect())
                        .unwrap_or_default();
                    filter.matches(&enriched.pr, &file_paths)
                })
                .count()
        };

        let badge = render_badge(
            &settings.badge_configs,
            snapshot.to_review.len(),
            snapshot.reviewed.len(),
            snapshot.mine.len(),
            filter_count,
        );
        let _ = self.inner.tx.send(PrMasterEvent::BadgeChanged(badge));

        Ok(snapshot)
    }

    /// Borrow the inner [`GhClient`] (used by the API Stats tab).
    pub fn gh(&self) -> &GhClient {
        &self.inner.gh
    }

    /// Snapshot of the rolling `gh` call log.
    pub fn call_log(&self) -> Vec<GhCall> {
        self.inner.gh.call_log_snapshot()
    }

    // ─── Filters (SQLite-backed) ─────────────────────────────────────────

    /// Lazy-open + return the filter store. Opens at the standard data
    /// dir on first access; subsequent calls reuse the cached connection.
    fn filter_store(&self) -> Result<FilterStore, FilterStoreError> {
        let mut slot = self.inner.filter_store.lock();
        if let Some(s) = slot.as_ref() {
            return Ok(s.clone());
        }
        let store = FilterStore::open_default()?;
        *slot = Some(store.clone());
        Ok(store)
    }

    /// List every persisted filter.
    pub fn list_filters(&self) -> Result<Vec<NotificationFilter>, FilterStoreError> {
        self.filter_store()?.list()
    }

    /// Insert or update a filter — bumps `updated_at_ms` automatically.
    pub fn save_filter(
        &self,
        filter: &NotificationFilter,
    ) -> Result<(), FilterStoreError> {
        let store = self.filter_store()?;
        let mut to_save = filter.clone();
        to_save.updated_at_ms = chrono::Utc::now().timestamp_millis();
        store.save(&to_save)
    }

    /// Delete a filter by id (no-op if absent).
    pub fn delete_filter(&self, id: &str) -> Result<(), FilterStoreError> {
        self.filter_store()?.delete(id)
    }

    /// Broadcast a synthetic notification described by `filter` so the
    /// user can preview how a saved rule will sound / look. Mirrors
    /// Swift's `sendTestNotification(for:)` from `FiltersView`. The
    /// payload is dispatched on the same broadcast channel as real
    /// notifications, so the Tauri bridge takes the same code path.
    pub fn fire_test_notification(
        &self,
        filter: &NotificationFilter,
    ) -> Result<(), FilterStoreError> {
        use NotificationAction as Action;
        let (silent, badge_only, muted) = match filter.action {
            Action::SoundBanner => (false, false, false),
            Action::SilentBanner => (true, false, false),
            Action::BadgeOnly => (false, true, false),
            Action::Mute => (false, false, true),
        };
        let note = PendingNotification {
            id: format!("test:{}", filter.id),
            title: format!("PRMaster filter test — {}", filter.name),
            body: format!(
                "This is a preview of how the “{}” rule will fire.",
                filter.name
            ),
            url: String::new(),
            silent,
            badge_only,
            muted,
        };
        let _ = self.inner.tx.send(PrMasterEvent::Notification(note));
        Ok(())
    }

    // ─── AI Summary ──────────────────────────────────────────────────────

    fn summary_cache(&self) -> std::io::Result<AiSummaryCache> {
        let mut slot = self.inner.summary_cache.lock();
        if let Some(s) = slot.as_ref() {
            return Ok(s.clone());
        }
        let dir = dirs::data_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("com.zen-tools.app")
            .join("prmaster");
        let cache = AiSummaryCache::open_in(&dir)?;
        *slot = Some(cache.clone());
        Ok(cache)
    }

    /// Fetch (or reuse cached) AI Summary cards for `(repo, since, until)`.
    /// Picks the local-git path when a [`LocalRepoMapping`] is configured
    /// for the repo.
    pub async fn ai_summary(
        &self,
        params: &summary::AiSummaryParams,
        settings: &PrMasterSettings,
    ) -> Result<SummaryCard, SummaryError> {
        let cache = self.summary_cache().map_err(SummaryError::Io)?;
        let key = AiSummaryCache::key(&params.repo, params.since, params.until);
        if !params.force {
            if let Some(card) = cache.get(&key) {
                return Ok(card);
            }
        }

        let provider_kind =
            zen_ai_cli::AiProviderType::from_wire(settings.ai_provider.as_str());
        let provider = zen_ai_cli::build_provider(provider_kind);
        let mapping = settings
            .repo_mappings
            .iter()
            .find(|m| m.repo.eq_ignore_ascii_case(&params.repo));

        let mut effective = params.clone();
        if effective.model.is_none() && !settings.ai_model.is_empty() {
            effective.model = Some(settings.ai_model.clone());
        }
        let card = summary::generate_summary(
            &effective,
            provider.as_ref(),
            &self.inner.gh,
            mapping,
            settings.ai_token_ratio as usize,
        )
        .await?;
        cache.put(key, card.clone());
        Ok(card)
    }

    /// Drop every cached AI Summary card.
    pub fn clear_ai_cache(&self) -> std::io::Result<()> {
        self.summary_cache()?.clear();
        Ok(())
    }

    /// Enumerate every repo the current user can see — personal repos
    /// plus every org's repos. Mirrors Swift `fetchAccessibleRepos`.
    /// Result is sorted + deduped; per-org failures are logged and
    /// skipped (matches Swift's "log + continue").
    pub async fn list_accessible_repos(&self) -> GhResult<Vec<String>> {
        let mut all: Vec<String> = self.inner.gh.list_repos().await.unwrap_or_default();
        let orgs = self.inner.gh.list_orgs().await.unwrap_or_default();
        for org in orgs {
            match self.inner.gh.list_org_repos(&org).await {
                Ok(list) => all.extend(list),
                Err(e) => tracing::warn!(org, error = %e, "list_org_repos failed"),
            }
        }
        let mut seen = ahash::AHashSet::new();
        all.retain(|r| seen.insert(r.clone()));
        all.sort();
        Ok(all)
    }

    // ─── Identity ────────────────────────────────────────────────────────

    /// Current GitHub user login.
    pub async fn whoami(&self) -> GhResult<String> {
        self.inner.gh.whoami().await
    }

    /// Surface `gh --version` + `gh auth status`.
    pub async fn auth_status(&self) -> GhResult<zen_github::AuthStatus> {
        self.inner.gh.auth_status().await
    }

    // ─── PR lists (cached behind a 30 s TTL refresh) ─────────────────────

    /// Force a full refresh: parallel fetch of `to_review`, `reviewed`,
    /// `mine`; enrich each via the batched GraphQL query; classify into
    /// To Review / Done buckets matching the Swift `refresh()` exactly.
    pub async fn refresh_lists(&self) -> GhResult<Arc<RefreshSnapshot>> {
        // Identify the current user first so classification can run.
        let current_user = match self.inner.gh.whoami().await {
            Ok(u) => Some(u),
            Err(e) => {
                warn!(error = %e, "whoami failed during refresh_lists");
                None
            }
        };

        let to_review_fut = self.inner.gh.search_to_review();
        let reviewed_fut = self.inner.gh.search_reviewed();
        let mine_fut = self.inner.gh.search_mine();
        let (to_review, reviewed, mine) =
            tokio::join!(to_review_fut, reviewed_fut, mine_fut);

        let to_review = match to_review {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "search_to_review failed");
                Vec::<PullRequest>::new()
            }
        };
        let reviewed = match reviewed {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "search_reviewed failed");
                Vec::<PullRequest>::new()
            }
        };
        let mine = mine?;

        let (enriched_to_review, enriched_reviewed, enriched_mine) = tokio::join!(
            self.inner.gh.enrich(to_review),
            self.inner.gh.enrich(reviewed),
            self.inner.gh.enrich(mine),
        );
        let enriched_to_review = enriched_to_review.unwrap_or_default();
        let enriched_reviewed = enriched_reviewed.unwrap_or_default();
        let enriched_mine = enriched_mine?;

        let user = current_user.as_deref();
        let (to_review_bucket, done_bucket) =
            classify_review_buckets(&enriched_to_review, &enriched_reviewed, user);

        let snapshot = RefreshSnapshot {
            current_user,
            to_review: to_review_bucket,
            reviewed: done_bucket,
            mine: enriched_mine,
            fetched_at_ms: chrono::Utc::now().timestamp_millis(),
        };
        let arc = Arc::new(snapshot);
        self.inner.snapshot.store(Some(arc.clone()));
        *self.inner.refresh_lock.lock() = Some(Instant::now());
        Ok(arc)
    }

    /// Refresh if the last snapshot is older than [`REFRESH_TTL`], else
    /// return the cache. Drives every "show me bucket X" code path so the
    /// Mine / Review / Done tabs share one fetch when opened in
    /// quick succession.
    pub async fn refresh_lists_if_stale(&self) -> GhResult<Arc<RefreshSnapshot>> {
        let cached = self.inner.snapshot.load_full();
        let last = *self.inner.refresh_lock.lock();
        let fresh = match (cached.as_ref(), last) {
            (Some(_), Some(t)) => t.elapsed() < REFRESH_TTL,
            _ => false,
        };
        if let (true, Some(snap)) = (fresh, cached) {
            return Ok(snap);
        }
        self.refresh_lists().await
    }

    /// Snapshot of the current cached refresh (or `None` if never refreshed).
    pub fn last_snapshot(&self) -> Option<Arc<RefreshSnapshot>> {
        self.inner.snapshot.load_full()
    }

    /// "To Review" bucket — uses the cached refresh (refreshes if stale).
    pub async fn list_to_review(&self) -> GhResult<Vec<EnrichedPullRequest>> {
        Ok(self.refresh_lists_if_stale().await?.to_review.clone())
    }

    /// "Done" / Reviewed bucket.
    pub async fn list_reviewed(&self) -> GhResult<Vec<EnrichedPullRequest>> {
        Ok(self.refresh_lists_if_stale().await?.reviewed.clone())
    }

    /// "Mine" bucket — your own open PRs.
    pub async fn list_mine(&self) -> GhResult<Vec<EnrichedPullRequest>> {
        Ok(self.refresh_lists_if_stale().await?.mine.clone())
    }

    /// Conversation groups — unresolved review threads + @mentions on PRs
    /// the user is involved in. Always re-fetches (no TTL) since
    /// conversation activity is more bursty than the PR list itself.
    pub async fn list_conversations(&self) -> GhResult<Vec<ConversationGroup>> {
        let user = match self.inner.gh.whoami().await {
            Ok(u) if !u.is_empty() => u,
            _ => return Ok(Vec::new()),
        };
        self.inner.gh.fetch_conversations(&user).await
    }

    // ─── Actions ─────────────────────────────────────────────────────────

    /// Submit an APPROVE review.
    pub async fn approve(&self, pr: &PrRef) -> GhResult<()> {
        let res = self
            .inner
            .gh
            .submit_review(pr, ReviewEvent::Approve, None)
            .await;
        self.invalidate_cache();
        res
    }

    /// Submit a REQUEST_CHANGES review with the given body.
    pub async fn request_changes(&self, pr: &PrRef, body: &str) -> GhResult<()> {
        let res = self
            .inner
            .gh
            .submit_review(pr, ReviewEvent::RequestChanges, Some(body))
            .await;
        self.invalidate_cache();
        res
    }

    /// Add the current user (or any login) as a requested reviewer.
    pub async fn add_reviewer(&self, pr: &PrRef, login: &str) -> GhResult<()> {
        let res = self.inner.gh.add_reviewer(pr, login).await;
        self.invalidate_cache();
        res
    }

    /// Drop the cached refresh — the next `list_*` call will refetch.
    /// Called after every action that mutates server state so the UI
    /// reflects the change on its next read.
    fn invalidate_cache(&self) {
        *self.inner.refresh_lock.lock() = None;
    }
}

impl Default for PrMasterEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Apply PRMaster's client-side reclassification to the union of the
/// `--review-requested @me` and `--reviewed-by @me` searches.
///
/// **Returns** `(to_review_bucket, reviewed_bucket)`.
///
/// Rules (mirror `Sources/PRMaster/ViewModels/PRListViewModel.swift:165–197`):
///
///   * skip PRs the user authored (those belong in **Mine**);
///   * a PR with **no** `APPROVED` / `CHANGES_REQUESTED` review by the user
///     goes to **To Review** (a comment-only review keeps it here);
///   * a PR with at least one `APPROVED` / `CHANGES_REQUESTED` review by
///     the user goes to **Done**.
///
/// Dedups by stable PR id so a PR present in both `gh` searches doesn't
/// appear twice.
fn classify_review_buckets(
    to_review: &[EnrichedPullRequest],
    reviewed: &[EnrichedPullRequest],
    current_user: Option<&str>,
) -> (Vec<EnrichedPullRequest>, Vec<EnrichedPullRequest>) {
    let mut to_review_out = Vec::with_capacity(to_review.len() + reviewed.len());
    let mut done_out = Vec::with_capacity(to_review.len() + reviewed.len());
    let mut seen_to_review = ahash::AHashSet::new();
    let mut seen_done = ahash::AHashSet::new();

    let mut classify = |pr: &EnrichedPullRequest| {
        // Skip my own PRs (those go in the Mine bucket).
        if let Some(user) = current_user {
            if pr.pr.author.as_ref().map(|a| a.login.as_str()) == Some(user) {
                return;
            }
        }
        let id = pr.id();
        let has_submitted = match current_user {
            Some(user) => pr.reviews.iter().any(|r| {
                r.author.as_ref().map(|a| a.login.as_str()) == Some(user)
                    && matches!(r.state, ReviewState::Approved | ReviewState::ChangesRequested)
            }),
            None => false,
        };

        if has_submitted {
            if seen_done.insert(id) {
                done_out.push(pr.clone());
            }
        } else if seen_to_review.insert(id) {
            to_review_out.push(pr.clone());
        }
    };

    for pr in to_review {
        classify(pr);
    }
    for pr in reviewed {
        classify(pr);
    }

    (to_review_out, done_out)
}

/// Apply per-filter notification action precedence to a candidate review
/// notification. Returns `None` when the most-restrictive matching filter
/// mutes the PR; otherwise returns a [`PendingNotification`] reflecting
/// the strongest applicable action across matching filters (for example,
/// any matching `Mute` overrides a `SoundBanner`).
fn build_review_notification(
    pr: &EnrichedPullRequest,
    reason: ReviewNotificationReason,
    filters: &[NotificationFilter],
    settings: &PrMasterSettings,
) -> Option<PendingNotification> {
    let file_paths: Vec<String> = pr
        .detail
        .as_ref()
        .and_then(|d| d.files.as_ref())
        .map(|f| f.nodes.iter().map(|n| n.path.clone()).collect())
        .unwrap_or_default();

    // Find the strongest matching filter (Mute > BadgeOnly > SilentBanner > SoundBanner).
    let mut chosen: Option<NotificationAction> = None;
    let mut matched_any = false;
    for f in filters {
        if !f.matches(&pr.pr, &file_paths) {
            continue;
        }
        matched_any = true;
        let upgrade = match (chosen, f.action) {
            (None, a) => Some(a),
            (Some(NotificationAction::Mute), _) => Some(NotificationAction::Mute),
            (_, NotificationAction::Mute) => Some(NotificationAction::Mute),
            (Some(NotificationAction::BadgeOnly), _) => Some(NotificationAction::BadgeOnly),
            (_, NotificationAction::BadgeOnly) => Some(NotificationAction::BadgeOnly),
            (Some(NotificationAction::SilentBanner), _) => Some(NotificationAction::SilentBanner),
            (_, NotificationAction::SilentBanner) => Some(NotificationAction::SilentBanner),
            _ => Some(NotificationAction::SoundBanner),
        };
        chosen = upgrade;
    }

    // When `only_filter_notifications` is on, suppress unmatched PRs.
    if settings.only_filter_notifications && !matched_any {
        return None;
    }

    let action = chosen.unwrap_or(NotificationAction::SoundBanner);
    let (silent, badge_only, muted) = match action {
        NotificationAction::SoundBanner => (false, false, false),
        NotificationAction::SilentBanner => (true, false, false),
        NotificationAction::BadgeOnly => (true, true, false),
        NotificationAction::Mute => (true, true, true),
    };
    if muted {
        return None;
    }

    let title = match reason {
        ReviewNotificationReason::NewPr => "New PR to Review".to_string(),
        ReviewNotificationReason::NewCommits => "PR Updated".to_string(),
    };
    let author = pr.pr.author.as_ref().map(|a| a.login.as_str()).unwrap_or("");
    let body = format!(
        "{}/{}#{} — {}{}",
        pr.pr.repository.split().0,
        pr.pr.repository.short_name(),
        pr.pr.number,
        if author.is_empty() {
            String::new()
        } else {
            format!("@{author} · ")
        },
        pr.pr.title,
    );
    Some(PendingNotification {
        id: format!("{}:{:?}", pr.id(), reason),
        title,
        body,
        url: pr.pr.url.clone(),
        silent,
        badge_only,
        muted: false,
    })
}

fn build_my_pr_notification(
    pr: &EnrichedPullRequest,
    reason: &MyPrNotificationReason,
    _settings: &PrMasterSettings,
) -> Option<PendingNotification> {
    let (title, body) = match reason {
        MyPrNotificationReason::NewReview(login) => (
            "New review on your PR".to_string(),
            format!(
                "@{login} reviewed {}#{}",
                pr.pr.repository.short_name(),
                pr.pr.number
            ),
        ),
        MyPrNotificationReason::NewComment => (
            "New comment on your PR".to_string(),
            format!(
                "{}#{} — {}",
                pr.pr.repository.short_name(),
                pr.pr.number,
                pr.pr.title
            ),
        ),
    };
    Some(PendingNotification {
        id: format!("{}:my:{}", pr.id(), match reason {
            MyPrNotificationReason::NewReview(_) => "review",
            MyPrNotificationReason::NewComment => "comment",
        }),
        title,
        body,
        url: pr.pr.url.clone(),
        silent: false,
        badge_only: false,
        muted: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use zen_github::{Author, PullRequest, Repository, Review, ReviewAuthor, ReviewState};

    fn make_pr(id: u64, author: &str) -> PullRequest {
        PullRequest {
            number: id,
            title: format!("PR {id}"),
            url: format!("https://example/pr/{id}"),
            state: "OPEN".into(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            is_draft: false,
            author: Some(Author {
                login: author.into(),
                ..Default::default()
            }),
            repository: Repository {
                name: "repo".into(),
                name_with_owner: "octo/repo".into(),
            },
        }
    }

    fn enriched(pr: PullRequest, reviewer: Option<(&str, ReviewState)>) -> EnrichedPullRequest {
        EnrichedPullRequest {
            pr,
            review_decision: None,
            reviews: reviewer
                .map(|(login, state)| {
                    vec![Review {
                        author: Some(ReviewAuthor {
                            login: login.into(),
                        }),
                        state,
                    }]
                })
                .unwrap_or_default(),
            requested_reviewers: vec![],
            merged_by: None,
            merged_at: None,
            detail: None,
        }
    }

    #[test]
    fn classifies_no_review_as_to_review() {
        let pr = enriched(make_pr(1, "alice"), None);
        let (to_review, done) = classify_review_buckets(&[pr], &[], Some("me"));
        assert_eq!(to_review.len(), 1);
        assert_eq!(done.len(), 0);
    }

    #[test]
    fn classifies_approved_as_done() {
        let pr = enriched(make_pr(2, "alice"), Some(("me", ReviewState::Approved)));
        let (to_review, done) = classify_review_buckets(&[pr], &[], Some("me"));
        assert_eq!(to_review.len(), 0);
        assert_eq!(done.len(), 1);
    }

    #[test]
    fn comment_only_keeps_in_to_review() {
        let pr = enriched(make_pr(3, "alice"), Some(("me", ReviewState::Commented)));
        let (to_review, done) = classify_review_buckets(&[], &[pr], Some("me"));
        assert_eq!(to_review.len(), 1);
        assert_eq!(done.len(), 0);
    }

    #[test]
    fn skips_my_own_prs() {
        let pr = enriched(make_pr(4, "me"), None);
        let (to_review, done) = classify_review_buckets(&[pr.clone()], &[pr], Some("me"));
        assert!(to_review.is_empty());
        assert!(done.is_empty());
    }

    #[test]
    fn dedupes_pr_present_in_both_searches() {
        let pr = enriched(make_pr(5, "alice"), Some(("me", ReviewState::Approved)));
        let (to_review, done) =
            classify_review_buckets(&[pr.clone()], &[pr], Some("me"));
        assert_eq!(to_review.len(), 0);
        assert_eq!(done.len(), 1);
    }
}
