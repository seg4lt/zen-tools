//! Persisted user-config store.
//!
//! Replaces the historical `preferences.json` file with a SQLite-backed
//! key/value store at `app_data_dir/user_config.db`. The schema is
//! deliberately tiny:
//!
//! ```sql
//! CREATE TABLE config (
//!   key   TEXT PRIMARY KEY,
//!   value TEXT NOT NULL  -- arbitrary JSON
//! );
//! ```
//!
//! See **`docs/STORAGE.md`** for the full design rationale (why
//! key/value vs. one-column-per-setting, partition strategy for
//! growing sections, recipe for adding a new section, and how this
//! relates to `schema_cache.db`).
//!
//! TL;DR:
//!
//! * One key per logical section. `preferences` holds the legacy
//!   struct today; new sections (`editor.layout`, `runs.history`, …)
//!   pick their own key without a schema migration.
//! * Atomic per-key writes — no half-written-document corruption.
//! * Reuses the `rusqlite` dep already added for the schema cache.
//! * Concurrent reads via WAL + `parking_lot::Mutex<Connection>`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Serialize;
use tauri::{AppHandle, Manager};

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

/// Thread-safe handle around the open SQLite connection. `parking_lot`
/// because rusqlite's `Connection` is `!Sync` and the operations are
/// short and disk-bound.
#[derive(Clone)]
pub struct UserConfig {
    inner: Arc<Mutex<Connection>>,
}

impl UserConfig {
    /// Open (or create) the user-config DB at the canonical location
    /// for the current app. Runs the legacy `preferences.json`
    /// migration if needed.
    pub fn open(app: &AppHandle) -> AppResult<Self> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| AppError::Other(format!("resolve app_data_dir: {e}")))?;
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(FILENAME);
        let legacy = dir.join(LEGACY_FILENAME);
        let cfg = Self::open_at(&path)?;
        cfg.migrate_legacy(&legacy)?;
        Ok(cfg)
    }

    /// Open the cache at an explicit path. Useful for tests
    /// (`":memory:"` skips disk entirely).
    pub fn open_at(path: impl AsRef<Path>) -> AppResult<Self> {
        let conn = Connection::open(path.as_ref())
            .map_err(|e| AppError::Other(format!("user_config open: {e}")))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; \
             PRAGMA synchronous = NORMAL; \
             CREATE TABLE IF NOT EXISTS config ( \
               key   TEXT PRIMARY KEY, \
               value TEXT NOT NULL \
             );",
        )
        .map_err(|e| AppError::Other(format!("user_config init: {e}")))?;
        Ok(Self {
            inner: Arc::new(Mutex::new(conn)),
        })
    }

    /// Read the raw JSON string stored under `key`, or `None` on miss.
    pub fn get_raw(&self, key: &str) -> AppResult<Option<String>> {
        let conn = self.inner.lock();
        conn.query_row(
            "SELECT value FROM config WHERE key = ?1",
            params![key],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| AppError::Other(format!("user_config get: {e}")))
    }

    /// Write a raw JSON string under `key`. Replaces any existing row.
    pub fn set_raw(&self, key: &str, value: &str) -> AppResult<()> {
        let conn = self.inner.lock();
        conn.execute(
            "INSERT INTO config (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|e| AppError::Other(format!("user_config set: {e}")))?;
        Ok(())
    }

    /// Typed read. Returns `None` on a cache miss; `Err` if the stored
    /// JSON no longer matches `T` (e.g. an enum variant was renamed
    /// without a migration).
    pub fn get<T: DeserializeOwned>(&self, key: &str) -> AppResult<Option<T>> {
        let Some(raw) = self.get_raw(key)? else {
            return Ok(None);
        };
        let value: T = serde_json::from_str(&raw)?;
        Ok(Some(value))
    }

    /// Typed write — round-trips through `serde_json`.
    pub fn set<T: Serialize>(&self, key: &str, value: &T) -> AppResult<()> {
        let raw = serde_json::to_string(value)?;
        self.set_raw(key, &raw)
    }

    /// Delete a row. No-op if the key is absent.
    pub fn delete(&self, key: &str) -> AppResult<()> {
        let conn = self.inner.lock();
        conn.execute("DELETE FROM config WHERE key = ?1", params![key])
            .map_err(|e| AppError::Other(format!("user_config delete: {e}")))?;
        Ok(())
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
    fn migrate_legacy(&self, legacy: &Path) -> AppResult<()> {
        if !legacy.exists() {
            return Ok(());
        }
        if self.get_raw(PREFERENCES_KEY)?.is_some() {
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
        // Validate as JSON before storing — keeps obviously-corrupt
        // files from being lifted into the DB unchecked.
        if serde_json::from_str::<serde_json::Value>(&text).is_err() {
            tracing::warn!(path = %legacy.display(), "user_config: legacy JSON invalid; skipping migration");
            return Ok(());
        }
        self.set_raw(PREFERENCES_KEY, &text)?;
        let backup = legacy.with_extension("json.bak");
        if let Err(e) = std::fs::rename(legacy, &backup) {
            // Rename failures are non-fatal (the data is already in
            // SQLite); just leave the JSON in place. We log so a
            // surprised user can find the old file.
            tracing::warn!(?e, from = %legacy.display(), to = %backup.display(), "user_config: legacy rename failed");
        } else {
            tracing::info!(from = %legacy.display(), to = %backup.display(), "user_config: legacy migrated to sqlite");
        }
        Ok(())
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_then_get_roundtrips_json() {
        let cfg = UserConfig::open_at(":memory:").unwrap();
        cfg.set("foo", &serde_json::json!({"a": 1, "b": [2, 3]}))
            .unwrap();
        let got: serde_json::Value = cfg.get("foo").unwrap().unwrap();
        assert_eq!(got["a"], 1);
        assert_eq!(got["b"][1], 3);
    }

    #[test]
    fn get_missing_returns_none() {
        let cfg = UserConfig::open_at(":memory:").unwrap();
        let got: Option<serde_json::Value> = cfg.get("missing").unwrap();
        assert!(got.is_none());
    }

    #[test]
    fn set_replaces_existing() {
        let cfg = UserConfig::open_at(":memory:").unwrap();
        cfg.set_raw("k", "1").unwrap();
        cfg.set_raw("k", "2").unwrap();
        assert_eq!(cfg.get_raw("k").unwrap(), Some("2".to_string()));
    }

    #[test]
    fn delete_is_idempotent() {
        let cfg = UserConfig::open_at(":memory:").unwrap();
        cfg.delete("never-set").unwrap();
        cfg.set_raw("k", "1").unwrap();
        cfg.delete("k").unwrap();
        assert_eq!(cfg.get_raw("k").unwrap(), None);
    }

    #[test]
    fn legacy_migration_imports_and_renames() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("preferences.json");
        std::fs::write(&legacy, r#"{"vimMode":true,"appZoom":1.25}"#).unwrap();

        let db = dir.path().join("user_config.db");
        let cfg = UserConfig::open_at(&db).unwrap();
        cfg.migrate_legacy(&legacy).unwrap();

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
        let cfg = UserConfig::open_at(&db).unwrap();
        // Pre-seed the SQLite with a value.
        cfg.set_raw(PREFERENCES_KEY, r#"{"vimMode":true}"#).unwrap();
        cfg.migrate_legacy(&legacy).unwrap();

        // Existing row preserved, JSON file untouched.
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
        let cfg = UserConfig::open_at(&db).unwrap();
        cfg.migrate_legacy(&legacy).unwrap();

        assert!(cfg.get_raw(PREFERENCES_KEY).unwrap().is_none());
        assert!(legacy.exists(), "invalid file should not be moved");
    }
}
