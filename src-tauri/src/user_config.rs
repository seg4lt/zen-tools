//! Persisted user-config store — thin Tauri-aware wrapper around
//! [`zen_storage::KvStore`].
//!
//! The actual SQLite + key/value implementation lives in `zen-storage`
//! so any other tool/crate can build on the same primitive. This module
//! adds the two app-specific concerns:
//!
//! * Resolving the canonical on-disk location (`<app_data_dir>/user_config.db`).
//! * One-shot migration from the historical `preferences.json` file the
//!   first time the new store is opened.
//!
//! See **`docs/STORAGE.md`** for the full design rationale.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use zen_storage::KvStore;

use crate::error::{AppError, AppResult};

/// Storage key for the legacy `Preferences` blob. New sections should
/// pick their own key name (e.g. `"editor.layout"`, `"runs.history"`)
/// rather than piling everything back into this one row.
pub const PREFERENCES_KEY: &str = "preferences";

/// Filename inside `app_data_dir`. Kept as a constant so tests and the
/// migration code reference the same path.
const FILENAME: &str = "user_config.db";

/// Legacy filename we migrate from on first open.
const LEGACY_FILENAME: &str = "preferences.json";

/// Re-export the storage primitive so callers in this crate can keep
/// `use crate::user_config::UserConfig` working.
pub type UserConfig = KvStore;

/// Open (or create) the user-config DB at the canonical location for
/// the current app, and run the legacy `preferences.json` migration if
/// needed.
pub fn open(app: &AppHandle) -> AppResult<UserConfig> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("resolve app_data_dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(FILENAME);
    let legacy = dir.join(LEGACY_FILENAME);
    let cfg = KvStore::open(&path).map_err(|e| AppError::Other(format!("user_config open: {e}")))?;
    migrate_legacy(&cfg, &legacy)?;
    Ok(cfg)
}

/// Open the cache at an explicit path. Useful for tests
/// (`":memory:"` skips disk entirely).
pub fn open_at(path: impl AsRef<Path>) -> AppResult<UserConfig> {
    KvStore::open(path).map_err(|e| AppError::Other(format!("user_config open: {e}")))
}

/// Look up the `UserConfig` from Tauri's managed state. Errors out as
/// `NotInitialised` if `setup()` hasn't run (or failed to register the
/// store) — every command path runs after setup so this is mostly a
/// belt-and-braces guard.
pub fn require(app: &AppHandle) -> AppResult<UserConfig> {
    app.try_state::<UserConfig>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| AppError::NotInitialised("user config not initialised".into()))
}

/// Path to the file that backs this store, for diagnostics.
pub fn config_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("resolve app_data_dir: {e}")))?;
    Ok(dir.join(FILENAME))
}

/// One-shot import from the historical `preferences.json` file.
///
/// * If the legacy file is absent → no-op.
/// * If the SQLite already has a `preferences` row → no-op (we've
///   already migrated; the JSON is just a stale backup).
/// * Otherwise → read + parse the JSON, write the raw payload under
///   the `preferences` key, and rename the file to
///   `preferences.json.bak` so a future build that drops this code
///   doesn't pick it back up.
fn migrate_legacy(cfg: &UserConfig, legacy: &Path) -> AppResult<()> {
    if !legacy.exists() {
        return Ok(());
    }
    if cfg
        .get_raw(PREFERENCES_KEY)
        .map_err(|e| AppError::Other(format!("user_config get: {e}")))?
        .is_some()
    {
        // Already migrated. Leave the .json on disk untouched —
        // rotating a second time would clobber the user's backup.
        return Ok(());
    }
    let text = match std::fs::read_to_string(legacy) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(?e, path = %legacy.display(), "user_config: legacy read failed");
            return Ok(());
        }
    };
    // Validate as JSON before storing — keeps obviously-corrupt files
    // from being lifted into the DB unchecked.
    if serde_json::from_str::<serde_json::Value>(&text).is_err() {
        tracing::warn!(path = %legacy.display(), "user_config: legacy JSON invalid; skipping migration");
        return Ok(());
    }
    cfg.set_raw(PREFERENCES_KEY, &text)
        .map_err(|e| AppError::Other(format!("user_config set: {e}")))?;
    let backup = legacy.with_extension("json.bak");
    if let Err(e) = std::fs::rename(legacy, &backup) {
        // Rename failures are non-fatal (the data is already in
        // SQLite); just leave the JSON in place. We log so a surprised
        // user can find the old file.
        tracing::warn!(?e, from = %legacy.display(), to = %backup.display(), "user_config: legacy rename failed");
    } else {
        tracing::info!(from = %legacy.display(), to = %backup.display(), "user_config: legacy migrated to sqlite");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_migration_imports_and_renames() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("preferences.json");
        std::fs::write(&legacy, r#"{"vimMode":true,"appZoom":1.25}"#).unwrap();

        let db = dir.path().join("user_config.db");
        let cfg = open_at(&db).unwrap();
        migrate_legacy(&cfg, &legacy).unwrap();

        let raw = cfg.get_raw(PREFERENCES_KEY).unwrap().unwrap();
        assert!(raw.contains("\"vimMode\":true"));
        assert!(!legacy.exists(), "legacy should have been renamed");
        assert!(dir.path().join("preferences.json.bak").exists());
    }

    #[test]
    fn legacy_migration_skips_when_already_present() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("preferences.json");
        std::fs::write(&legacy, r#"{"vimMode":false}"#).unwrap();

        let db = dir.path().join("user_config.db");
        let cfg = open_at(&db).unwrap();
        cfg.set_raw(PREFERENCES_KEY, r#"{"vimMode":true}"#).unwrap();
        migrate_legacy(&cfg, &legacy).unwrap();

        let raw = cfg.get_raw(PREFERENCES_KEY).unwrap().unwrap();
        assert!(raw.contains("\"vimMode\":true"));
        assert!(legacy.exists(), "legacy should be left in place");
    }

    #[test]
    fn legacy_migration_skips_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("preferences.json");
        std::fs::write(&legacy, "not json").unwrap();

        let db = dir.path().join("user_config.db");
        let cfg = open_at(&db).unwrap();
        migrate_legacy(&cfg, &legacy).unwrap();

        assert!(cfg.get_raw(PREFERENCES_KEY).unwrap().is_none());
        assert!(legacy.exists(), "invalid file should not be moved");
    }
}
