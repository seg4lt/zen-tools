//! Shared SQLite primitives for the zen-tools workspace.
//!
//! Two things lived here:
//!
//! * [`SharedConnection`] / [`open_at`]: open a `rusqlite::Connection`
//!   with the **same** durability and concurrency pragmas every
//!   consumer should use (`journal_mode = WAL`, `synchronous = NORMAL`),
//!   wrapped in `Arc<parking_lot::Mutex<_>>` for cheap clone-and-share
//!   across threads. Three independent stores in the codebase used to
//!   open `Connection` themselves with subtly different pragmas (or
//!   none at all) — this primitive fixes that drift.
//!
//! * [`KvStore`]: a tiny key/value JSON store. Originally
//!   `src-tauri/src/user_config.rs`; promoted here so the Tauri layer
//!   becomes a 5-line wrapper that knows where on disk the file lives.
//!
//! The crate has no async dep, no Tauri dep, and no `dirs` /
//! `app-handle` knowledge — those concerns live in the consumers.

#![warn(missing_docs)]

use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Serialize;
use thiserror::Error;

/// Cheap-to-clone, thread-safe handle around an open SQLite connection.
/// `parking_lot::Mutex` because rusqlite's `Connection` is `!Sync` and
/// the operations we run on it are short, disk-bound, and don't benefit
/// from the std mutex's poisoning behaviour.
pub type SharedConnection = Arc<Mutex<Connection>>;

/// Error type for storage operations. Wraps both rusqlite errors and
/// the JSON serialisation errors raised by [`KvStore`].
#[derive(Debug, Error)]
pub enum StorageError {
    /// Underlying SQLite operation failed.
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// JSON serialisation / deserialisation failed.
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    /// I/O error (e.g. creating the parent directory).
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Convenience alias.
pub type StorageResult<T> = std::result::Result<T, StorageError>;

/// Open (or create) a SQLite database at `path`, applying the standard
/// zen-tools pragmas (`journal_mode = WAL`, `synchronous = NORMAL`),
/// and wrap it in a [`SharedConnection`].
///
/// Pass `":memory:"` to get an in-memory connection (handy for tests).
/// The caller is responsible for creating the parent directory if `path`
/// is on disk and the parent doesn't exist yet.
pub fn open_at(path: impl AsRef<Path>) -> StorageResult<SharedConnection> {
    let conn = Connection::open(path.as_ref())?;
    apply_default_pragmas(&conn)?;
    Ok(Arc::new(Mutex::new(conn)))
}

/// Apply the standard zen-tools durability + concurrency pragmas to an
/// already-open `Connection`. Useful when a consumer needs to open the
/// connection itself (e.g. with non-default open flags) but still wants
/// the standard pragmas.
pub fn apply_default_pragmas(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; \
         PRAGMA synchronous = NORMAL;",
    )
}

// ────────────────────────────────────────────────────────────────────────
// Key/value JSON store
// ────────────────────────────────────────────────────────────────────────

/// Tiny JSON-blob key/value store backed by a single SQLite table.
///
/// Schema:
///
/// ```sql
/// CREATE TABLE config (
///   key   TEXT PRIMARY KEY,
///   value TEXT NOT NULL  -- arbitrary JSON
/// );
/// ```
///
/// One key per logical section is the intended pattern (`preferences`,
/// `editor.layout`, `runs.history`, …) so different concerns can grow
/// independently without schema migrations. Atomic per-key writes
/// avoid the half-written-document corruption risk of one big JSON file.
#[derive(Clone)]
pub struct KvStore {
    inner: SharedConnection,
}

impl KvStore {
    /// Open (or create) the store at `path`. The `config` table is
    /// created on-demand. WAL + NORMAL sync pragmas applied.
    pub fn open(path: impl AsRef<Path>) -> StorageResult<Self> {
        let conn = open_at(path)?;
        conn.lock().execute_batch(
            "CREATE TABLE IF NOT EXISTS config ( \
               key   TEXT PRIMARY KEY, \
               value TEXT NOT NULL \
             );",
        )?;
        Ok(Self { inner: conn })
    }

    /// Wrap an already-open [`SharedConnection`]. Useful when several
    /// stores want to share one connection (rare; usually each store
    /// owns its own DB file).
    pub fn from_connection(conn: SharedConnection) -> StorageResult<Self> {
        conn.lock().execute_batch(
            "CREATE TABLE IF NOT EXISTS config ( \
               key   TEXT PRIMARY KEY, \
               value TEXT NOT NULL \
             );",
        )?;
        Ok(Self { inner: conn })
    }

    /// Read the raw JSON string stored under `key`, or `None` on miss.
    pub fn get_raw(&self, key: &str) -> StorageResult<Option<String>> {
        let conn = self.inner.lock();
        conn.query_row(
            "SELECT value FROM config WHERE key = ?1",
            params![key],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(Into::into)
    }

    /// Write a raw JSON string under `key`. Replaces any existing row.
    pub fn set_raw(&self, key: &str, value: &str) -> StorageResult<()> {
        let conn = self.inner.lock();
        conn.execute(
            "INSERT INTO config (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Typed read. Returns `None` on a cache miss; `Err` if the stored
    /// JSON no longer matches `T` (e.g. an enum variant was renamed
    /// without a migration).
    pub fn get<T: DeserializeOwned>(&self, key: &str) -> StorageResult<Option<T>> {
        let Some(raw) = self.get_raw(key)? else {
            return Ok(None);
        };
        let value: T = serde_json::from_str(&raw)?;
        Ok(Some(value))
    }

    /// Typed write — round-trips through `serde_json`.
    pub fn set<T: Serialize>(&self, key: &str, value: &T) -> StorageResult<()> {
        let raw = serde_json::to_string(value)?;
        self.set_raw(key, &raw)
    }

    /// Delete a row. No-op if the key is absent.
    pub fn delete(&self, key: &str) -> StorageResult<()> {
        let conn = self.inner.lock();
        conn.execute("DELETE FROM config WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// Borrow the underlying [`SharedConnection`] (e.g. so you can
    /// open a second store on the same DB file or run a one-off query).
    pub fn connection(&self) -> &SharedConnection {
        &self.inner
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_at_applies_pragmas() {
        let conn = open_at(":memory:").unwrap();
        let mode: String = conn
            .lock()
            .query_row("PRAGMA journal_mode;", [], |r| r.get(0))
            .unwrap();
        // WAL is silently downgraded to "memory" for `:memory:`
        // databases, so accept either result. The point of the test is
        // that the PRAGMA was issued without error.
        assert!(mode == "wal" || mode == "memory", "unexpected mode {mode}");
    }

    #[test]
    fn kv_set_then_get_roundtrips_json() {
        let kv = KvStore::open(":memory:").unwrap();
        kv.set("foo", &serde_json::json!({"a": 1, "b": [2, 3]}))
            .unwrap();
        let got: serde_json::Value = kv.get("foo").unwrap().unwrap();
        assert_eq!(got["a"], 1);
        assert_eq!(got["b"][1], 3);
    }

    #[test]
    fn kv_get_missing_returns_none() {
        let kv = KvStore::open(":memory:").unwrap();
        let got: Option<serde_json::Value> = kv.get("missing").unwrap();
        assert!(got.is_none());
    }

    #[test]
    fn kv_set_replaces_existing() {
        let kv = KvStore::open(":memory:").unwrap();
        kv.set_raw("k", "1").unwrap();
        kv.set_raw("k", "2").unwrap();
        assert_eq!(kv.get_raw("k").unwrap(), Some("2".to_string()));
    }

    #[test]
    fn kv_delete_is_idempotent() {
        let kv = KvStore::open(":memory:").unwrap();
        kv.delete("never-set").unwrap();
        kv.set_raw("k", "1").unwrap();
        kv.delete("k").unwrap();
        assert_eq!(kv.get_raw("k").unwrap(), None);
    }
}
