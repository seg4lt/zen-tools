//! Tauri-managed state for the dictation feature.
//!
//! Held inside Tauri's `tauri::State` map under its own type-id key,
//! separate from the existing `Mutex<AppState>` mega-struct. The
//! `state.rs` comment in the parent crate explicitly notes that the
//! app-state should be split per-tool; following that direction here
//! keeps dictation self-contained.

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use zen_dictation::DictationManager;

/// Wrapper held by Tauri's managed state. Cheap to clone (one `Arc`
/// for the manager + one for the cached path strings).
#[derive(Clone)]
pub struct DictationTauriState {
    /// Owns the live whisper context, mic capture, and hotkey handle.
    pub manager: DictationManager,
    /// `<app_data_dir>/models/`.
    pub models_dir: PathBuf,
    /// `<app_data_dir>/logs/`.
    pub logs_dir: PathBuf,
    /// `<app_data_dir>/`.
    pub app_data_dir: PathBuf,
    /// In-flight downloads keyed by wire model id. Used by the
    /// `dictation_download_model` command to avoid spawning duplicate
    /// downloads for the same model when the user clicks twice.
    pub in_flight: Arc<Mutex<ahash::HashSet<String>>>,
}

impl DictationTauriState {
    /// Build a fresh state from the resolved paths. Caller is
    /// responsible for `create_dir_all` on each.
    pub fn new(app_data_dir: PathBuf, models_dir: PathBuf, logs_dir: PathBuf) -> Self {
        Self {
            manager: DictationManager::new(),
            models_dir,
            logs_dir,
            app_data_dir,
            in_flight: Arc::new(Mutex::new(ahash::HashSet::default())),
        }
    }
}
