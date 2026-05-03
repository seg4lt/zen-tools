//! Per-table schema cache backed by a local SQLite file.
//!
//! Auto-completion in the SQL editor needs cheap, repeated access to a
//! table's column list. Re-querying `information_schema` on every key
//! stroke is unacceptable on big databases, so we persist
//! [`crate::TableDescription`] payloads here and only refresh them when
//! either:
//!
//! * the cache row is missing, or
//! * the cache row is older than [`DEFAULT_TTL_MS`] (1 day), or
//! * the user explicitly forces a reindex via the Opt+Enter actions.
//!
//! Storage shape (single file at the path the host chooses; the host
//! also picks the on-disk location — typically `app_data_dir()/schema_cache.db`):
//!
//! ```sql
//! CREATE TABLE table_schema (
//!   connection_id TEXT NOT NULL,
//!   database      TEXT NOT NULL,
//!   schema        TEXT NOT NULL,
//!   table_name    TEXT NOT NULL,
//!   indexed_at    INTEGER NOT NULL, -- unix ms
//!   payload       TEXT NOT NULL,    -- TableDescription as JSON
//!   PRIMARY KEY (connection_id, database, schema, table_name)
//! );
//! ```
//!
//! All operations are synchronous (rusqlite). Tauri commands wrap calls
//! in `tokio::task::spawn_blocking` so the runtime isn't stalled on
//! local disk I/O.

use std::path::Path;

use rusqlite::{params, params_from_iter, OptionalExtension};
use serde::Serialize;
use zen_storage::{open_at, SharedConnection};

use crate::driver::{DbError, DbResult};
use crate::types::TableDescription;

/// Default time-to-live for a cached table description before we treat
/// the row as stale and trigger a background refresh. The cached value
/// is still served to callers immediately; the refresh just brings the
/// row back to "fresh" for next time.
pub const DEFAULT_TTL_MS: i64 = 24 * 60 * 60 * 1_000;

/// Wire shape for a cached row. Mirrors the JSON the front-end reads.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedTable {
    /// The cached `TableDescription` payload (columns and, in future,
    /// indexes/FKs).
    pub description: TableDescription,
    /// Unix milliseconds at which the row was last upserted.
    pub indexed_at: i64,
}

/// Lightweight metadata for the "list cached tables under this schema"
/// query — used by the DB-explorer freshness badge without re-decoding
/// the full payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedTableMeta {
    /// Table name (no schema qualifier).
    pub name: String,
    /// Unix milliseconds at which the row was last upserted.
    pub indexed_at: i64,
}

/// Thread-safe handle around the open SQLite connection.
#[derive(Clone)]
pub struct SchemaCache {
    inner: SharedConnection,
}

impl SchemaCache {
    /// Open (or create) the cache at the given path. Caller is
    /// responsible for ensuring the parent directory exists. Pass
    /// `":memory:"` for tests.
    pub fn open_at(path: impl AsRef<Path>) -> DbResult<Self> {
        let conn = open_at(path)?;
        conn.lock()
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS table_schema ( \
                   connection_id TEXT NOT NULL, \
                   database      TEXT NOT NULL, \
                   schema        TEXT NOT NULL, \
                   table_name    TEXT NOT NULL, \
                   indexed_at    INTEGER NOT NULL, \
                   payload       TEXT NOT NULL, \
                   PRIMARY KEY (connection_id, database, schema, table_name) \
                 ); \
                 CREATE INDEX IF NOT EXISTS idx_table_schema_lookup \
                   ON table_schema(connection_id, database, schema);",
            )
            .map_err(|e| DbError::SchemaCache(format!("init: {e}")))?;
        Ok(Self { inner: conn })
    }

    /// Single-row read. Returns `None` on a cache miss.
    pub fn get(
        &self,
        connection_id: &str,
        database: &str,
        schema: &str,
        table: &str,
    ) -> DbResult<Option<CachedTable>> {
        let conn = self.inner.lock();
        let row = conn
            .query_row(
                "SELECT payload, indexed_at FROM table_schema \
                 WHERE connection_id = ?1 AND database = ?2 AND schema = ?3 AND table_name = ?4",
                params![connection_id, database, schema, table],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(|e| DbError::SchemaCache(format!("get: {e}")))?;
        match row {
            None => Ok(None),
            Some((payload, indexed_at)) => {
                let description: TableDescription = serde_json::from_str(&payload)?;
                Ok(Some(CachedTable {
                    description,
                    indexed_at,
                }))
            }
        }
    }

    /// Bulk read for autocomplete: returns whatever is cached now (any
    /// age). The caller is responsible for kicking off background
    /// refreshes for stale or missing rows.
    pub fn get_many(
        &self,
        connection_id: &str,
        database: &str,
        schema: &str,
        tables: &[&str],
    ) -> DbResult<Vec<CachedTable>> {
        if tables.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders: Vec<String> = (0..tables.len()).map(|i| format!("?{}", i + 4)).collect();
        let sql = format!(
            "SELECT payload, indexed_at FROM table_schema \
             WHERE connection_id = ?1 AND database = ?2 AND schema = ?3 \
               AND table_name IN ({})",
            placeholders.join(",")
        );
        let conn = self.inner.lock();
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| DbError::SchemaCache(format!("get_many prepare: {e}")))?;

        // params! macro doesn't extend cleanly across a runtime-sized
        // slice, so we collect into a Vec<&dyn ToSql> manually.
        let mut binds: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(3 + tables.len());
        binds.push(&connection_id);
        binds.push(&database);
        binds.push(&schema);
        for t in tables {
            binds.push(t);
        }

        let rows = stmt
            .query_map(params_from_iter(binds.iter().copied()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(|e| DbError::SchemaCache(format!("get_many query: {e}")))?;

        let mut out = Vec::new();
        for row in rows {
            let (payload, indexed_at) =
                row.map_err(|e| DbError::SchemaCache(format!("get_many row: {e}")))?;
            let description: TableDescription = serde_json::from_str(&payload)?;
            out.push(CachedTable {
                description,
                indexed_at,
            });
        }
        Ok(out)
    }

    /// Replace (or insert) a single row. Bumps `indexed_at`.
    pub fn upsert(
        &self,
        connection_id: &str,
        description: &TableDescription,
        indexed_at: i64,
    ) -> DbResult<()> {
        let payload = serde_json::to_string(description)?;
        let conn = self.inner.lock();
        conn.execute(
            "INSERT INTO table_schema \
               (connection_id, database, schema, table_name, indexed_at, payload) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(connection_id, database, schema, table_name) DO UPDATE SET \
               indexed_at = excluded.indexed_at, \
               payload    = excluded.payload",
            params![
                connection_id,
                description.database,
                description.schema,
                description.name,
                indexed_at,
                payload,
            ],
        )
        .map_err(|e| DbError::SchemaCache(format!("upsert: {e}")))?;
        Ok(())
    }

    /// Delete specific rows. An empty `tables` slice deletes **all**
    /// rows for `(connection_id, database, schema)` — used by the
    /// "Reindex everything cached for this connection" action.
    pub fn invalidate(
        &self,
        connection_id: &str,
        database: &str,
        schema: &str,
        tables: &[&str],
    ) -> DbResult<()> {
        let conn = self.inner.lock();
        if tables.is_empty() {
            conn.execute(
                "DELETE FROM table_schema \
                 WHERE connection_id = ?1 AND database = ?2 AND schema = ?3",
                params![connection_id, database, schema],
            )
            .map_err(|e| DbError::SchemaCache(format!("invalidate-all: {e}")))?;
            return Ok(());
        }
        let placeholders: Vec<String> = (0..tables.len()).map(|i| format!("?{}", i + 4)).collect();
        let sql = format!(
            "DELETE FROM table_schema \
             WHERE connection_id = ?1 AND database = ?2 AND schema = ?3 \
               AND table_name IN ({})",
            placeholders.join(",")
        );
        let mut binds: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(3 + tables.len());
        binds.push(&connection_id);
        binds.push(&database);
        binds.push(&schema);
        for t in tables {
            binds.push(t);
        }
        conn.execute(&sql, params_from_iter(binds.iter().copied()))
            .map_err(|e| DbError::SchemaCache(format!("invalidate: {e}")))?;
        Ok(())
    }

    /// Drop every row for a connection — called from
    /// `db_delete_connection` so a removed connection doesn't leave
    /// orphan cache rows behind.
    pub fn invalidate_connection(&self, connection_id: &str) -> DbResult<()> {
        let conn = self.inner.lock();
        conn.execute(
            "DELETE FROM table_schema WHERE connection_id = ?1",
            params![connection_id],
        )
        .map_err(|e| DbError::SchemaCache(format!("invalidate_connection: {e}")))?;
        Ok(())
    }

    /// Lightweight listing for the DB-explorer freshness badges.
    pub fn list_cached(
        &self,
        connection_id: &str,
        database: &str,
        schema: &str,
    ) -> DbResult<Vec<CachedTableMeta>> {
        let conn = self.inner.lock();
        let mut stmt = conn
            .prepare(
                "SELECT table_name, indexed_at FROM table_schema \
                 WHERE connection_id = ?1 AND database = ?2 AND schema = ?3 \
                 ORDER BY table_name",
            )
            .map_err(|e| DbError::SchemaCache(format!("list prepare: {e}")))?;
        let rows = stmt
            .query_map(params![connection_id, database, schema], |r| {
                Ok(CachedTableMeta {
                    name: r.get::<_, String>(0)?,
                    indexed_at: r.get::<_, i64>(1)?,
                })
            })
            .map_err(|e| DbError::SchemaCache(format!("list query: {e}")))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| DbError::SchemaCache(format!("list row: {e}")))?);
        }
        Ok(out)
    }
}

/// Current unix-millisecond timestamp. Centralised so tests can stub it
/// later if we ever need deterministic TTL math.
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ColumnDescription, TableKind};

    fn sample_desc(name: &str) -> TableDescription {
        TableDescription {
            database: "db".into(),
            schema: "public".into(),
            name: name.into(),
            kind: TableKind::Table,
            columns: vec![ColumnDescription {
                name: "id".into(),
                data_type: "integer".into(),
                nullable: false,
                default: None,
                ordinal: 1,
                is_primary_key: true,
            }],
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            keys: Vec::new(),
            checks: Vec::new(),
            triggers: Vec::new(),
        }
    }

    #[test]
    fn upsert_then_get_returns_payload() {
        let cache = SchemaCache::open_at(":memory:").unwrap();
        cache.upsert("c1", &sample_desc("users"), 1_000).unwrap();
        let row = cache.get("c1", "db", "public", "users").unwrap().unwrap();
        assert_eq!(row.indexed_at, 1_000);
        assert_eq!(row.description.columns[0].name, "id");
    }

    #[test]
    fn upsert_replaces_existing_row() {
        let cache = SchemaCache::open_at(":memory:").unwrap();
        cache.upsert("c1", &sample_desc("users"), 1).unwrap();
        cache.upsert("c1", &sample_desc("users"), 2).unwrap();
        let row = cache.get("c1", "db", "public", "users").unwrap().unwrap();
        assert_eq!(row.indexed_at, 2);
    }

    #[test]
    fn get_many_returns_only_present_rows() {
        let cache = SchemaCache::open_at(":memory:").unwrap();
        cache.upsert("c1", &sample_desc("users"), 1).unwrap();
        cache.upsert("c1", &sample_desc("orders"), 1).unwrap();
        let rows = cache
            .get_many("c1", "db", "public", &["users", "missing", "orders"])
            .unwrap();
        let mut names: Vec<_> = rows.iter().map(|r| r.description.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["orders".to_string(), "users".to_string()]);
    }

    #[test]
    fn invalidate_targets_only_named_rows() {
        let cache = SchemaCache::open_at(":memory:").unwrap();
        cache.upsert("c1", &sample_desc("users"), 1).unwrap();
        cache.upsert("c1", &sample_desc("orders"), 1).unwrap();
        cache
            .invalidate("c1", "db", "public", &["users"])
            .unwrap();
        assert!(cache.get("c1", "db", "public", "users").unwrap().is_none());
        assert!(cache
            .get("c1", "db", "public", "orders")
            .unwrap()
            .is_some());
    }

    #[test]
    fn invalidate_empty_drops_whole_schema() {
        let cache = SchemaCache::open_at(":memory:").unwrap();
        cache.upsert("c1", &sample_desc("users"), 1).unwrap();
        cache.upsert("c1", &sample_desc("orders"), 1).unwrap();
        cache.invalidate("c1", "db", "public", &[]).unwrap();
        let listed = cache.list_cached("c1", "db", "public").unwrap();
        assert!(listed.is_empty());
    }

    #[test]
    fn legacy_payload_without_new_fields_still_decodes() {
        // Simulates a `schema_cache.db` row written by an older build
        // where `TableDescription` only had columns/indexes/FKs. New
        // fields must default to `Vec::new()` so we don't blow up.
        let cache = SchemaCache::open_at(":memory:").unwrap();
        let legacy_payload = serde_json::json!({
            "database": "db",
            "schema": "public",
            "name": "users",
            "kind": "table",
            "columns": [{
                "name": "id",
                "dataType": "integer",
                "nullable": false,
                "default": null,
                "ordinal": 1,
                "isPrimaryKey": true,
            }],
            // intentionally omit `keys`, `checks`, `triggers`
        });
        // Insert directly via raw upsert path; the cache layer
        // treats the payload as opaque JSON, so this models exactly
        // what an older binary would have written.
        let conn = cache.inner.lock();
        conn.execute(
            "INSERT INTO table_schema (connection_id, database, schema, table_name, indexed_at, payload) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                "c1",
                "db",
                "public",
                "users",
                1_000_i64,
                legacy_payload.to_string()
            ],
        )
        .unwrap();
        drop(conn);

        let row = cache.get("c1", "db", "public", "users").unwrap().unwrap();
        assert_eq!(row.description.columns.len(), 1);
        assert!(row.description.keys.is_empty());
        assert!(row.description.checks.is_empty());
        assert!(row.description.triggers.is_empty());
    }

    #[test]
    fn invalidate_connection_drops_all_rows_for_connection() {
        let cache = SchemaCache::open_at(":memory:").unwrap();
        cache.upsert("c1", &sample_desc("users"), 1).unwrap();
        cache.upsert("c2", &sample_desc("users"), 1).unwrap();
        cache.invalidate_connection("c1").unwrap();
        assert!(cache.get("c1", "db", "public", "users").unwrap().is_none());
        assert!(cache.get("c2", "db", "public", "users").unwrap().is_some());
    }
}
