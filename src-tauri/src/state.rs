//! Mutable application state held inside `tauri::State<Mutex<AppState>>`.

use ahash::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use zen_cleaner::Tree as CleanerTree;
use zen_db::ConnectionRegistry;
use zen_http::{FileRegistry, HttpExecutor};
use zen_parser::PerfConfig;
use zen_perf::{MetricsSnapshot, RequestSample, StopHandle};
use zen_process_monitor::{Sample as PmSample, SamplerHandle, SamplerState, SharedState as PmSharedState};
use zen_git::GitEngine;
use zen_pr_review::ReviewEngine;
use zen_prmaster::PrMasterEngine;
use zen_types::prelude::*;

/// Per-tool state for the Cleaner. Held inside [`AppState::cleaner`].
///
/// `folders` is the persisted scan-folder list (mirrors the prefs JSON);
/// `trees` keeps each folder's freshly built [`CleanerTree`] so the
/// background size-estimation worker can mutate it under a lock as
/// estimates settle.  `globals` carries the pre-discovered global cache
/// section.
#[derive(Default)]
pub struct CleanerState {
    /// Persisted scan-folder list (absolute paths in user-defined order).
    pub folders: Vec<String>,
    /// Live tree per folder. Key is the absolute folder path.
    pub trees: HashMap<String, CleanerTree>,
    /// Global cache section (computed once at startup, refreshed on `R`).
    pub globals: Option<CleanerTree>,
}

/// Snapshot of everything the Tauri layer manages on behalf of the front-end.
///
/// Wrapped in [`tokio::sync::Mutex`] for per-command access. Critical
/// sections are kept short — long-running work (HTTP execution, perf
/// loops) drops the lock first.
///
/// **Future direction:** this megastruct should be split into per-tool
/// sub-structs (`HttpRunnerState`, `PerfState`, `PmState`,
/// `CleanerState`, `MarkdownState`, `DbState`, `PrMasterState`) each
/// registered as its own `tauri::State` entry, so commands take only
/// the slice they touch. The current pattern (every command clones a
/// sub-field then drops the outer lock) is consistent but makes
/// cross-tool coupling invisible at the function signature. Doing the
/// split is mechanical but invasive (~17 command files) and is left
/// for a dedicated PR.
pub struct AppState {
    /// Open project roots. Each entry is a folder the user has added via
    /// the "+" button on the file tree. Empty until the user adds at
    /// least one (no `$HOME` default — scanning the entire home dir is
    /// expensive and almost never what the user wants).
    pub working_dirs: Vec<PathBuf>,
    /// Workspace-level env file (if any).
    pub global_env_file: Option<EnvironmentFile>,
    /// File-local env override (loaded when an http file is opened).
    pub local_env_file: Option<EnvironmentFile>,
    /// Active environment name within the env file.
    pub selected_env: Option<EnvName>,

    /// Variables extracted from successful responses, keyed by env.
    pub extracted_vars: HashMap<EnvName, HashMap<String, String>>,
    /// Cookies received per env.
    pub cookies: HashMap<EnvName, Vec<(String, String)>>,
    /// Last result per request id.
    pub last_results: HashMap<RequestId, RequestResult>,

    /// Shared HTTP-file parse cache.
    pub file_registry: Arc<FileRegistry>,
    /// Cheap-to-clone HTTP executor.
    pub executor: HttpExecutor,

    /// Loaded perf config (if any).
    pub perf_config: Option<PerfConfig>,
    /// Source path of the loaded perf config.
    pub perf_config_path: Option<PathBuf>,
    /// Latest perf metrics snapshot.
    pub perf_metrics: Option<MetricsSnapshot>,
    /// Raw samples from the last perf run (CSV export).
    pub perf_samples: Vec<RequestSample>,
    /// Wall-clock start time of the most recent perf run.
    pub perf_started_at: Option<std::time::Instant>,
    /// `true` while a perf test is in flight.
    pub perf_running: bool,
    /// Stop handle for the current perf run; `None` when idle.
    pub perf_stop: Option<StopHandle>,

    // ──── Process Monitor ────
    /// Shared sampler state (target PIDs, history ring, prev-sample deltas).
    /// Held inside the sampler crate's own [`parking_lot::Mutex`] so the
    /// blocking sampler thread can lock without contending with the Tokio
    /// runtime.
    pub pm_state: PmSharedState,
    /// Handle for subscribing to the live sample broadcast (Tauri event
    /// bridge holds one subscriber; future consumers can subscribe too).
    pub pm_handle: SamplerHandle,

    // ──── macOS menu-bar trays ────
    /// Active unified tray icon (perf, process-monitor, dictation).
    /// Built once at startup by `crate::tray::init`; held here so the
    /// `NSStatusItem` is pinned alongside the rest of the per-app
    /// state.
    pub tray: Option<tauri::tray::TrayIcon>,
    /// PRMaster's dedicated tray. Built / torn down by
    /// `crate::prmaster_tray::init` / `tear_down`, which run in step
    /// with PRMaster's lifecycle (enable / disable in settings).
    /// `None` while PRMaster is disabled.
    pub prmaster_tray: Option<tauri::tray::TrayIcon>,

    // ──── Cleaner ────
    /// Disk-cleaner per-tool state (folders, trees, globals).
    ///
    /// Wrapped in `Arc<parking_lot::Mutex<...>>` rather than a tokio mutex
    /// so the std::thread workers spawned by `cleaner_scan_folder` can
    /// lock without needing a Tokio runtime context.  The outer
    /// `Mutex<AppState>` is held only briefly to clone this `Arc` out;
    /// every subsequent access goes through the parking_lot mutex.
    pub cleaner: Arc<parking_lot::Mutex<CleanerState>>,

    // ──── Markdown ────
    /// Cancellation flags for in-flight content-search invocations,
    /// keyed by the frontend-minted token. Mirrors flowstate's fff
    /// pattern: every `markdown_search_contents` call registers an
    /// `AtomicBool`; `markdown_stop_content_search(token)` flips it
    /// and the worker drops out at the next per-file checkpoint.
    pub markdown_search_tokens:
        Arc<parking_lot::Mutex<HashMap<u64, Arc<std::sync::atomic::AtomicBool>>>>,

    // ──── Database Explorer ────
    /// Live database connections for the Database Explorer tool.
    /// `Arc` so a slow query holds only the per-connection lock inside
    /// the registry, never the outer `Mutex<AppState>`.
    pub db: Arc<ConnectionRegistry>,
    /// Open project roots for the Database Explorer's SQL-file
    /// workspace. Separate from `working_dirs` (which is the http-runner
    /// project list) so the two tools don't bleed into each other.
    pub sql_workspace_dirs: Vec<PathBuf>,

    // ──── PRMaster ────
    /// Domain controller for the PRMaster tool. Wraps a `gh`-CLI-backed
    /// GitHub client; cheap to clone (`Arc`-backed). Constructed once at
    /// startup so the polling loop and command handlers share the same
    /// rolling call log + cache. The 5-minute background refresh
    /// `JoinHandle` is currently spawned by `lib.rs::setup` and not
    /// retained here — the task lives for the lifetime of the process.
    pub prmaster: PrMasterEngine,

    /// Lifecycle handles for the PRMaster background workers (broadcast
    /// → Tauri-event bridge and 5-minute refresh loop). Held so the
    /// `set_tool_disabled` command can abort them when the user toggles
    /// PRMaster off; populated by `prmaster_lifecycle::start`.
    pub prmaster_lifecycle: PrMasterLifecycle,

    // ──── PRMaster — AI code review ────
    /// Domain controller for the AI review tab on the PR Master review
    /// page. Cheap to clone (`Arc`-backed); holds the in-memory run
    /// registry across command invocations so a re-mount can replay
    /// events from a still-running review.
    pub review: ReviewEngine,

    // ──── Git (merge editor + commit log) ────
    /// Domain controller for the Git tool — wraps a shell-out-based
    /// `git` CLI client + a persisted multi-repo registry. Cheap to
    /// clone (`Arc`-backed); commands clone it out from under this
    /// `Mutex<AppState>` lock and drop the lock before awaiting any
    /// git work.
    pub git: GitEngine,
}

/// Per-app lifecycle handles for PRMaster. Toggling PRMaster off
/// aborts the two background tasks, removes the tray, and unregisters
/// the global hotkey. Toggling on re-spawns everything.
#[derive(Default)]
pub struct PrMasterLifecycle {
    /// Join handle for the broadcast → Tauri-event bridge task.
    /// `abort()` on the handle is what `prmaster_lifecycle::stop` calls.
    pub bridge_task: Option<tauri::async_runtime::JoinHandle<()>>,
    /// Join handle for the 5-minute background refresh loop.
    pub bg_task: Option<tauri::async_runtime::JoinHandle<()>>,
    /// `true` once the global hotkey chord has been registered.
    pub hotkey_registered: bool,
}

impl AppState {
    /// Build a fresh, "no projects added" state.
    pub fn new() -> Self {
        // 256 buffered samples covers ~4 min at 1 Hz; subscribers that
        // fall behind get a `RecvError::Lagged` and rehydrate via
        // `pm_get_history`.
        let (tx, _) = tokio::sync::broadcast::channel::<PmSample>(256);
        Self {
            working_dirs: Vec::new(),
            global_env_file: None,
            local_env_file: None,
            selected_env: None,
            extracted_vars: HashMap::default(),
            cookies: HashMap::default(),
            last_results: HashMap::default(),
            file_registry: Arc::new(FileRegistry::new()),
            executor: HttpExecutor::new(),
            perf_config: None,
            perf_config_path: None,
            perf_metrics: None,
            perf_samples: Vec::new(),
            perf_started_at: None,
            perf_running: false,
            perf_stop: None,
            pm_state: Arc::new(parking_lot::Mutex::new(SamplerState::new())),
            pm_handle: SamplerHandle { tx },
            tray: None,
            prmaster_tray: None,
            cleaner: Arc::new(parking_lot::Mutex::new(CleanerState::default())),
            markdown_search_tokens: Arc::new(parking_lot::Mutex::new(HashMap::default())),
            db: Arc::new(ConnectionRegistry::new()),
            sql_workspace_dirs: Vec::new(),
            prmaster: PrMasterEngine::new(),
            prmaster_lifecycle: PrMasterLifecycle::default(),
            review: ReviewEngine::new(),
            git: GitEngine::new(),
        }
    }

    /// `true` while at least one process is being monitored (i.e. the
    /// sampler is producing data this tick).
    pub fn pm_is_active(&self) -> bool {
        self.pm_state.lock().is_active()
    }

    /// Lookup key for per-env data (extracted vars, cookies). Falls back to
    /// `"default"` when no environment is active.
    pub fn env_key(&self) -> EnvName {
        self.selected_env
            .clone()
            .unwrap_or_else(|| EnvName::new("default"))
    }

    /// Merge global + local env vars for the current environment into a
    /// single map suitable for [`zen_http::substitute_variables`]. The
    /// local file (if present) overrides the global one.
    pub fn current_env_vars(&self) -> HashMap<String, String> {
        let Some(env_name) = &self.selected_env else {
            return HashMap::default();
        };
        let mut merged = HashMap::default();
        if let Some(file) = &self.global_env_file {
            if let Some(env) = file.get(env_name.as_str()) {
                merged.extend(env.as_string_map());
            }
        }
        if let Some(file) = &self.local_env_file {
            if let Some(env) = file.get(env_name.as_str()) {
                merged.extend(env.as_string_map());
            }
        }
        merged
    }

    /// Extracted vars for the current env (cloned).
    pub fn current_extracted_vars(&self) -> HashMap<String, String> {
        self.extracted_vars
            .get(&self.env_key())
            .cloned()
            .unwrap_or_default()
    }

    /// Cookies for the current env (cloned).
    pub fn current_cookies(&self) -> Vec<(String, String)> {
        self.cookies
            .get(&self.env_key())
            .cloned()
            .unwrap_or_default()
    }

    /// Persist new extracted vars from a request chain.
    pub fn persist_extracted(&mut self, vars: HashMap<String, String>) {
        if vars.is_empty() {
            return;
        }
        let key = self.env_key();
        self.extracted_vars.entry(key).or_default().extend(vars);
    }

    /// Persist new cookies from a request chain.
    pub fn persist_cookies(&mut self, cookies: Vec<(String, String)>) {
        if cookies.is_empty() {
            return;
        }
        let key = self.env_key();
        self.cookies.entry(key).or_default().extend(cookies);
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
