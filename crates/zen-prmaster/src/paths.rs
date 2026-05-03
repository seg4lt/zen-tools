//! Single source of truth for the on-disk locations PRMaster persists
//! state to.
//!
//! `dirs::data_dir()` returns `~/Library/Application Support` on macOS,
//! `%APPDATA%` on Windows, `$XDG_DATA_HOME` (or `~/.local/share`) on
//! Linux. Falling back to `dirs::home_dir()` and finally `.` keeps test
//! environments and headless boxes from panicking.

use std::path::PathBuf;

/// Bundle identifier the Tauri app uses for its data directory.
/// Mirrors `tauri.conf.json`'s `identifier`.
const APP_BUNDLE: &str = "com.zen-tools.app";

/// Subfolder inside the app data dir for everything PRMaster owns
/// (notification state, AI summary cache, filter DB, …).
const PRMASTER_SUBDIR: &str = "prmaster";

/// `<app_data_dir>/<bundle>/prmaster`. Used by the notification store,
/// the AI summary cache, and the filter store.
pub fn data_dir() -> PathBuf {
    dirs::data_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_BUNDLE)
        .join(PRMASTER_SUBDIR)
}
