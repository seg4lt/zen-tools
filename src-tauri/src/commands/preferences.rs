//! Persisted UI preferences — stored as a single JSON blob inside the
//! `user_config.db` SQLite database (key `preferences`) under the
//! OS-specific app-data directory:
//!
//! | OS      | Path (typical)                                                  |
//! |---------|-----------------------------------------------------------------|
//! | macOS   | `~/Library/Application Support/com.zen.tools/user_config.db`    |
//! | Linux   | `~/.local/share/com.zen.tools/user_config.db`                   |
//! | Windows | `%APPDATA%\com.zen.tools\user_config.db`                        |
//!
//! Older builds wrote a `preferences.json` file in the same directory;
//! `UserConfig::open` migrates it on first launch (the file becomes
//! `preferences.json.bak`). Callers continue to use the
//! `load_preferences` / `write_preferences` helpers below — only the
//! storage backend changed.
//!
//! Only includes user-facing UI state (open project list, expanded
//! folders). Anything sensitive or per-environment lives elsewhere.

use crate::error::AppResult;
use crate::user_config::{self, PREFERENCES_KEY};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Persisted UI state. New optional fields can be added without
/// breaking older preferences files thanks to `#[serde(default)]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    /// Open project roots, in user-defined order.
    #[serde(default)]
    pub working_dirs: Vec<String>,
    /// Folders the user has explicitly toggled. The string is the
    /// absolute path; if it's prefixed with `-:` the folder was
    /// explicitly *collapsed* (versus the default-expanded behaviour).
    #[serde(default)]
    pub expanded_paths: Vec<String>,
    /// Whether the editor's Vim keybindings are active. `true` (the
    /// historical default) keeps `:w`, normal/insert mode etc.; flip
    /// to `false` for plain editing.
    #[serde(default = "default_vim_mode")]
    pub vim_mode: bool,
    /// Folders the user has added to the **Cleaner** tool's scan list,
    /// in user-defined order. Persists across launches so each opened
    /// folder re-scans automatically.
    #[serde(default)]
    pub cleaner_scan_folders: Vec<String>,
    /// Cached cleaner trees, keyed by folder path (or the literal
    /// `"globals"` for the global cache section). Saved at scan
    /// completion so the UI can render instantly on app restart while
    /// a fresh scan runs in the background.
    #[serde(default)]
    pub cleaner_scan_cache: Vec<CleanerScanCacheEntry>,
    /// Vault root folders the user has opened in the **Markdown** tool,
    /// in user-defined order.  Persists so opened vaults re-mount on
    /// every launch.
    #[serde(default)]
    pub markdown_vault_dirs: Vec<String>,
    /// Bounded ring (most recent first) of `.md` files the user has
    /// opened in the Markdown tool.  Powers the quick-switcher's
    /// "Recent" group.
    #[serde(default)]
    pub markdown_recent_files: Vec<String>,
    /// Saved Database Explorer connections. Passwords are NEVER stored
    /// here — they live in the OS keychain (see `zen_db::secrets`).
    #[serde(default)]
    pub db_connections: Vec<DbConnectionPrefs>,
    /// Project roots opened in the Database Explorer's SQL-file
    /// workspace, in user-defined order. Persists across launches.
    #[serde(default)]
    pub sql_workspace_dirs: Vec<String>,
    /// Whole-app zoom level (CSS `zoom` on the root document).
    /// Default `1.0`. Bound to ⌘= / ⌘− / ⌘0 in the UI.
    #[serde(default = "default_app_zoom")]
    pub app_zoom: f64,
    /// User-defined order of tool ids (matches `Tool.id` in
    /// `src/config/tools.ts`). Empty/missing falls back to the
    /// canonical TOOLS order; ids removed from TOOLS are dropped at
    /// read time; tools missing from the saved list get appended.
    #[serde(default)]
    pub tool_order: Vec<String>,
}

/// One persisted Database Explorer connection. Mirrors
/// `zen_db::ConnectionConfig` minus the password (which is keychain-only).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectionPrefs {
    /// Stable UUID minted by the front-end.
    pub id: String,
    /// User-facing display name.
    pub name: String,
    /// `"postgres"` or `"mssql"`.
    pub driver: String,
    /// Host or IP address.
    pub host: String,
    /// TCP port (5432 / 1433 by default).
    pub port: u16,
    /// Initial database / catalogue.
    pub database: String,
    /// SQL-auth username.
    pub username: String,
    /// Trust a self-signed server cert (mainly for the bundled MSSQL
    /// developer image).
    #[serde(default)]
    pub trust_server_certificate: bool,
}

/// One entry in the persisted cleaner scan cache.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanerScanCacheEntry {
    /// Folder path (or `"globals"` for the global cache section).
    pub key: String,
    /// JSON-serialised `Vec<TreeNodeDto>` for that key. Storing the raw
    /// JSON keeps `Preferences` independent of `zen-cleaner`'s internal
    /// types, so adding/removing fields on `TreeNodeDto` doesn't risk
    /// breaking older preferences files.
    pub tree_json: String,
}

fn default_vim_mode() -> bool {
    true
}

fn default_app_zoom() -> f64 {
    1.0
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            working_dirs: Vec::new(),
            expanded_paths: Vec::new(),
            vim_mode: default_vim_mode(),
            cleaner_scan_folders: Vec::new(),
            cleaner_scan_cache: Vec::new(),
            markdown_vault_dirs: Vec::new(),
            markdown_recent_files: Vec::new(),
            db_connections: Vec::new(),
            sql_workspace_dirs: Vec::new(),
            app_zoom: default_app_zoom(),
            tool_order: Vec::new(),
        }
    }
}

/// Synchronous read used by other backend modules (e.g.
/// `commands::files` when persisting the project list). Returns
/// defaults when the row is absent or fails to deserialise — the call
/// site is expected to persist the merged result back via
/// [`write_preferences`].
pub fn load_preferences(app: &AppHandle) -> AppResult<Preferences> {
    let cfg = user_config::require(app)?;
    match cfg.get::<Preferences>(PREFERENCES_KEY) {
        Ok(Some(prefs)) => Ok(prefs),
        Ok(None) => Ok(Preferences::default()),
        Err(e) => {
            // A schema-incompatible JSON shouldn't brick the app; the
            // next save will overwrite it cleanly. Caller chains
            // already use `unwrap_or_default()` for missing files, so
            // we mirror that resilience here.
            tracing::warn!(?e, "preferences parse failed; using defaults");
            Ok(Preferences::default())
        }
    }
}

/// Synchronous write used by other backend modules. SQLite handles
/// atomicity for us — no temp-file dance required.
pub fn write_preferences(app: &AppHandle, prefs: &Preferences) -> AppResult<()> {
    let cfg = user_config::require(app)?;
    cfg.set(PREFERENCES_KEY, prefs)
}

/// Read the preferences JSON. Returns defaults when the file is
/// missing — the very first launch must not fail.
#[tauri::command]
pub async fn get_preferences(app: AppHandle) -> AppResult<Preferences> {
    load_preferences(&app)
}

/// Persist the preferences JSON atomically.
#[tauri::command]
pub async fn save_preferences(prefs: Preferences, app: AppHandle) -> AppResult<()> {
    write_preferences(&app, &prefs)
}
