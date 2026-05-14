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
    /// Tool ids the user has explicitly disabled. Disabled tools
    /// vanish from the title-bar pills, their routes redirect away,
    /// their frontend providers don't mount, and their backend
    /// lifecycle hooks (currently only PRMaster's tray, polling,
    /// hotkey, and broadcast bridge) are torn down. Toggling back on
    /// re-arms everything live without an app restart.
    #[serde(default)]
    pub disabled_tools: Vec<String>,
    /// Terminal-only workspace + pane session snapshot. Used to
    /// restore the embedded Ghostty session on app relaunch.
    #[serde(default)]
    pub terminal_session: Option<TerminalSessionPreferences>,
}

/// Persisted terminal-only session snapshot used to restore the
/// embedded Ghostty surface across launches.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionPreferences {
    /// Restorable workspace grouping metadata in user-defined order.
    #[serde(default)]
    pub workspaces: Vec<TerminalSessionWorkspacePreferences>,
    /// Persisted pane metadata keyed by stable persistent id.
    #[serde(default)]
    pub panes: Vec<TerminalSessionPanePreferences>,
    /// Workspace selected when the session snapshot was saved.
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    /// Ordered persistent pane ids pinned by the user.
    #[serde(default)]
    pub pinned_pane_ids: Vec<String>,
}

/// One persisted terminal workspace grouping.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionWorkspacePreferences {
    /// Stable workspace id minted in the frontend.
    pub id: String,
    /// User-facing workspace name.
    pub name: String,
    /// Ordered persistent pane ids currently assigned to the workspace.
    #[serde(default)]
    pub pane_ids: Vec<String>,
    /// The last active pane within this workspace, when known.
    #[serde(default)]
    pub last_active_pane_id: Option<String>,
}

/// One persisted terminal pane snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionPanePreferences {
    /// Stable pane id minted in the frontend and remapped on restore.
    pub id: String,
    /// Last-known Ghostty title, used for deferred pin labels.
    #[serde(default)]
    pub ghostty_title: Option<String>,
    /// User-specified pane title override, if any.
    #[serde(default)]
    pub title_override: Option<String>,
    /// Last known live cwd reported by the shell.
    #[serde(default)]
    pub cwd_absolute_path: Option<String>,
    /// Launch directory used to recreate the pane on restore.
    #[serde(default)]
    pub launch_directory: Option<String>,
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
            disabled_tools: Vec::new(),
            terminal_session: None,
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
    cfg.set(PREFERENCES_KEY, prefs)?;
    Ok(())
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

/// Toggle a single tool on or off. Routes through the backend (rather
/// than the front-end calling `save_preferences` directly) so any
/// tool-specific lifecycle hook fires atomically with the preference
/// write — today only PRMaster has one (tray, polling, hotkey,
/// broadcast bridge), but the dispatch shape lets new tools opt in
/// without changing the front-end contract.
#[tauri::command]
pub async fn set_tool_disabled(
    tool_id: String,
    disabled: bool,
    app: AppHandle,
) -> AppResult<()> {
    let mut prefs = load_preferences(&app)?;
    let already_disabled = prefs.disabled_tools.iter().any(|id| id == &tool_id);
    if disabled == already_disabled {
        return Ok(()); // no-op; preserves the lifecycle invariants
    }
    if disabled {
        prefs.disabled_tools.push(tool_id.clone());
    } else {
        prefs.disabled_tools.retain(|id| id != &tool_id);
    }
    write_preferences(&app, &prefs)?;

    // Tool-specific live lifecycle dispatch. Other tools have no
    // always-on machinery to gate, so they fall through.
    match tool_id.as_str() {
        "prmaster" => {
            if disabled {
                crate::prmaster_lifecycle::stop(&app);
            } else {
                crate::prmaster_lifecycle::start(&app);
            }
        }
        // Local Whisper dictation. When disabled this drops the
        // CGEventTap (so right-⌘ stops being intercepted), hides
        // the mic tray, and abandons any in-flight recording.
        // See `crate::dictation::lifecycle` for the teardown order.
        id if id == crate::dictation::TOOL_ID => {
            if disabled {
                crate::dictation::lifecycle::stop(&app);
            } else {
                crate::dictation::lifecycle::start(&app);
            }
        }
        _ => {}
    }

    Ok(())
}
