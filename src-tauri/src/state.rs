//! Mutable application state held inside `tauri::State<Mutex<AppState>>`.

use ahash::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use zen_http::{FileRegistry, HttpExecutor};
use zen_parser::PerfConfig;
use zen_perf::{MetricsSnapshot, RequestSample, StopHandle};
use zen_types::prelude::*;

/// Snapshot of everything the Tauri layer manages on behalf of the front-end.
///
/// Wrapped in [`tokio::sync::Mutex`] for per-command access. Critical
/// sections are kept short — long-running work (HTTP execution, perf
/// loops) drops the lock first.
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
}

impl AppState {
    /// Build a fresh, "no projects added" state.
    pub fn new() -> Self {
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
        }
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
