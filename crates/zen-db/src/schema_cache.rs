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

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, OptionalExtension};
use serde::Serialize;
use zen_storage::{open_at, SharedConnection};

use crate::driver::{DbError, DbResult};
use crate::types::{RoutineDescription, RoutineKind, TableDescription, TableKind, TableSummary};

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

/// One bounded database-catalog search hit. This intentionally contains
/// names and ancestry only; detailed table metadata remains lazy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSearchHit {
    /// Database/catalogue containing the object.
    pub database: String,
    /// Schema/owner containing the object.
    pub schema: String,
    /// Parent table for column/constraint/index hits.
    pub table: Option<String>,
    /// Stable lowercase kind (`table`, `view`, `column`, ...).
    pub kind: String,
    /// Object name.
    pub name: String,
}

/// Bounded catalog-search response. `truncated` tells the UI to ask the
/// user for a narrower query instead of rendering an unbounded tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSearchResult {
    /// Matching objects, capped by the caller-provided limit.
    pub items: Vec<CatalogSearchHit>,
    /// Whether at least one additional match exists.
    pub truncated: bool,
    /// The backend rejected an unbounded/too-short pattern before scanning.
    pub query_too_broad: bool,
    /// Unix milliseconds at which the lightweight relation catalog was built.
    pub indexed_at: Option<i64>,
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
        let path = path.as_ref();
        let run_backfill_inline = cfg!(test) || path == Path::new(":memory:");
        let conn = open_at(path)?;
        {
            let sqlite = conn.lock();
            sqlite
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
                   ON table_schema(connection_id, database, schema); \
                 CREATE TABLE IF NOT EXISTS catalog_nodes ( \
                   id              INTEGER PRIMARY KEY AUTOINCREMENT, \
                   connection_id   TEXT NOT NULL, \
                   database_name   TEXT NOT NULL, \
                   schema_name     TEXT NOT NULL, \
                   table_name      TEXT NOT NULL DEFAULT '', \
                   kind            TEXT NOT NULL, \
                   name            TEXT NOT NULL, \
                   normalized_name TEXT NOT NULL, \
                   UNIQUE(connection_id, database_name, schema_name, table_name, kind, name) \
                 ); \
                 CREATE INDEX IF NOT EXISTS idx_catalog_scope_kind_name \
                   ON catalog_nodes(connection_id, database_name, kind, normalized_name); \
                 CREATE INDEX IF NOT EXISTS idx_catalog_hierarchy_kind_name \
                   ON catalog_nodes(connection_id, database_name, schema_name, table_name, kind, normalized_name); \
                 CREATE TABLE IF NOT EXISTS catalog_status ( \
                   connection_id TEXT NOT NULL, \
                   database_name TEXT NOT NULL, \
                   indexed_at    INTEGER NOT NULL, \
                   PRIMARY KEY(connection_id, database_name) \
                 ); \
                 CREATE TABLE IF NOT EXISTS catalog_meta ( \
                   key   TEXT PRIMARY KEY, \
                   value TEXT NOT NULL \
                 ); \
                 CREATE VIRTUAL TABLE IF NOT EXISTS catalog_nodes_fts USING fts5( \
                   normalized_name, \
                   content='catalog_nodes', \
                   content_rowid='id', \
                   tokenize='trigram' \
                 ); \
                 CREATE TRIGGER IF NOT EXISTS catalog_nodes_ai AFTER INSERT ON catalog_nodes BEGIN \
                   INSERT INTO catalog_nodes_fts(rowid, normalized_name) \
                   VALUES (new.id, new.normalized_name); \
                 END; \
                 CREATE TRIGGER IF NOT EXISTS catalog_nodes_ad AFTER DELETE ON catalog_nodes BEGIN \
                   INSERT INTO catalog_nodes_fts(catalog_nodes_fts, rowid, normalized_name) \
                   VALUES ('delete', old.id, old.normalized_name); \
                 END; \
                 CREATE TRIGGER IF NOT EXISTS catalog_nodes_au AFTER UPDATE ON catalog_nodes BEGIN \
                   INSERT INTO catalog_nodes_fts(catalog_nodes_fts, rowid, normalized_name) \
                   VALUES ('delete', old.id, old.normalized_name); \
                   INSERT INTO catalog_nodes_fts(rowid, normalized_name) \
                   VALUES (new.id, new.normalized_name); \
                 END;",
                )
                .map_err(|e| DbError::SchemaCache(format!("init: {e}")))?;
        }
        let cache = Self { inner: conn };
        if run_backfill_inline {
            loop {
                if backfill_catalog_nodes_batch(&mut cache.inner.lock())? {
                    break;
                }
            }
        } else {
            let background = cache.clone();
            std::thread::spawn(move || loop {
                let result = backfill_catalog_nodes_batch(&mut background.inner.lock());
                match result {
                    Ok(true) => break,
                    Ok(false) => std::thread::yield_now(),
                    Err(e) => {
                        tracing::warn!(?e, "legacy catalog backfill stopped");
                        break;
                    }
                }
            });
        }
        Ok(cache)
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
        let mut conn = self.inner.lock();
        let tx = conn
            .transaction()
            .map_err(|e| DbError::SchemaCache(format!("upsert transaction: {e}")))?;
        tx.execute(
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
        upsert_description_nodes(&tx, connection_id, description)?;
        tx.commit()
            .map_err(|e| DbError::SchemaCache(format!("upsert commit: {e}")))?;
        Ok(())
    }

    /// Atomically replace the lightweight relation catalog for one database.
    /// Detailed child nodes learned through [`Self::upsert`] are preserved.
    pub fn replace_relations(
        &self,
        connection_id: &str,
        database: &str,
        schemas: &[String],
        schemas_complete: bool,
        relations: &[TableSummary],
        indexed_at: i64,
    ) -> DbResult<()> {
        let mut conn = self.inner.lock();
        let tx = conn
            .transaction()
            .map_err(|e| DbError::SchemaCache(format!("catalog transaction: {e}")))?;
        tx.execute(
            "DELETE FROM catalog_nodes WHERE connection_id = ?1 AND database_name = ?2 \
             AND kind IN ('schema', 'table', 'view')",
            params![connection_id, database],
        )
        .map_err(|e| DbError::SchemaCache(format!("catalog clear: {e}")))?;

        let mut inserted_schemas = std::collections::HashSet::new();
        for schema in schemas
            .iter()
            .chain(relations.iter().map(|relation| &relation.schema))
        {
            if !inserted_schemas.insert(schema.as_str()) {
                continue;
            }
            insert_catalog_node(&tx, connection_id, database, schema, "", "schema", schema)?;
        }
        for relation in relations {
            insert_catalog_node(
                &tx,
                connection_id,
                database,
                &relation.schema,
                &relation.name,
                match relation.kind {
                    TableKind::Table => "table",
                    TableKind::View => "view",
                },
                &relation.name,
            )?;
        }
        if schemas_complete {
            tx.execute(
                "DELETE FROM catalog_nodes AS routine \
             WHERE routine.connection_id = ?1 AND routine.database_name = ?2 \
               AND routine.kind IN ('function', 'procedure') \
               AND NOT EXISTS ( \
                 SELECT 1 FROM catalog_nodes AS schema_node \
                 WHERE schema_node.connection_id = routine.connection_id \
                   AND schema_node.database_name = routine.database_name \
                   AND schema_node.schema_name = routine.schema_name \
                   AND schema_node.kind = 'schema' \
               )",
                params![connection_id, database],
            )
            .map_err(|e| DbError::SchemaCache(format!("catalog routine cleanup: {e}")))?;
        }
        tx.execute(
            "DELETE FROM catalog_nodes AS child \
             WHERE child.connection_id = ?1 AND child.database_name = ?2 \
               AND child.kind IN ('column', 'key', 'fk', 'index', 'check', 'trigger') \
               AND NOT EXISTS ( \
                 SELECT 1 FROM catalog_nodes AS relation \
                 WHERE relation.connection_id = child.connection_id \
                   AND relation.database_name = child.database_name \
                   AND relation.schema_name = child.schema_name \
                   AND relation.table_name = child.table_name \
                   AND relation.kind IN ('table', 'view') \
               )",
            params![connection_id, database],
        )
        .map_err(|e| DbError::SchemaCache(format!("catalog orphan cleanup: {e}")))?;
        tx.execute(
            "INSERT INTO catalog_status(connection_id, database_name, indexed_at) \
             VALUES (?1, ?2, ?3) \
             ON CONFLICT(connection_id, database_name) DO UPDATE SET indexed_at = excluded.indexed_at",
            params![connection_id, database, indexed_at],
        )
        .map_err(|e| DbError::SchemaCache(format!("catalog status: {e}")))?;
        tx.commit()
            .map_err(|e| DbError::SchemaCache(format!("catalog commit: {e}")))?;
        Ok(())
    }

    /// Replace the connection-level database/catalog names. Database nodes
    /// live under a reserved empty database scope so they can be searched
    /// across the whole connection without opening every database.
    pub fn replace_databases(
        &self,
        connection_id: &str,
        databases: &[String],
        indexed_at: i64,
    ) -> DbResult<()> {
        let mut conn = self.inner.lock();
        let tx = conn
            .transaction()
            .map_err(|e| DbError::SchemaCache(format!("database catalog transaction: {e}")))?;
        tx.execute(
            "DELETE FROM catalog_nodes WHERE connection_id = ?1 AND kind = 'database'",
            params![connection_id],
        )
        .map_err(|e| DbError::SchemaCache(format!("database catalog clear: {e}")))?;
        for database in databases {
            insert_catalog_node(&tx, connection_id, "", "", "", "database", database)?;
        }
        tx.execute(
            "INSERT INTO catalog_status(connection_id, database_name, indexed_at) \
             VALUES (?1, '', ?2) \
             ON CONFLICT(connection_id, database_name) DO UPDATE SET indexed_at = excluded.indexed_at",
            params![connection_id, indexed_at],
        )
        .map_err(|e| DbError::SchemaCache(format!("database catalog status: {e}")))?;
        tx.commit()
            .map_err(|e| DbError::SchemaCache(format!("database catalog commit: {e}")))?;
        Ok(())
    }

    /// Resolve the database whose relation catalog a query needs. `None`
    /// means the query targets connection-level database nodes themselves.
    pub fn query_database_scope(query: &str, default_database: &str) -> Option<String> {
        let parsed = ParsedCatalogQuery::parse(query)?;
        if matches!(parsed.kind, CatalogQueryKind::Database) {
            None
        } else {
            Some(
                parsed
                    .database
                    .unwrap_or_else(|| default_database.to_owned()),
            )
        }
    }

    /// Add or replace routine names learned through the normal lazy tree API.
    pub fn upsert_routines(
        &self,
        connection_id: &str,
        database: &str,
        schema: &str,
        routines: &[RoutineDescription],
    ) -> DbResult<()> {
        let mut conn = self.inner.lock();
        let tx = conn
            .transaction()
            .map_err(|e| DbError::SchemaCache(format!("routine transaction: {e}")))?;
        tx.execute(
            "DELETE FROM catalog_nodes WHERE connection_id = ?1 AND database_name = ?2 \
             AND schema_name = ?3 AND kind IN ('function', 'procedure')",
            params![connection_id, database, schema],
        )
        .map_err(|e| DbError::SchemaCache(format!("routine clear: {e}")))?;
        for routine in routines {
            insert_catalog_node(
                &tx,
                connection_id,
                database,
                schema,
                "",
                match routine.kind {
                    RoutineKind::Function => "function",
                    RoutineKind::Procedure => "procedure",
                },
                &routine.name,
            )?;
        }
        tx.commit()
            .map_err(|e| DbError::SchemaCache(format!("routine commit: {e}")))?;
        Ok(())
    }

    /// Timestamp of the latest successful lightweight relation index.
    pub fn catalog_indexed_at(&self, connection_id: &str, database: &str) -> DbResult<Option<i64>> {
        self.inner
            .lock()
            .query_row(
                "SELECT indexed_at FROM catalog_status \
                 WHERE connection_id = ?1 AND database_name = ?2",
                params![connection_id, database],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| DbError::SchemaCache(format!("catalog status read: {e}")))
    }

    /// Search the persistent catalog entirely inside SQLite. The backend owns
    /// parsing, matching, kind filtering, and bounds; callers only render.
    pub fn search_catalog(
        &self,
        connection_id: &str,
        database: &str,
        query: &str,
        limit: usize,
    ) -> DbResult<CatalogSearchResult> {
        let parsed = ParsedCatalogQuery::parse(query);
        let Some(parsed) = parsed else {
            return Ok(CatalogSearchResult {
                items: Vec::new(),
                truncated: false,
                query_too_broad: !query.trim().is_empty(),
                indexed_at: self.catalog_indexed_at(connection_id, database)?,
            });
        };
        if parsed.is_too_broad() {
            return Ok(CatalogSearchResult {
                items: Vec::new(),
                truncated: false,
                query_too_broad: true,
                indexed_at: self.catalog_indexed_at(connection_id, database)?,
            });
        }
        let search_database = if matches!(parsed.kind, CatalogQueryKind::Database) {
            ""
        } else {
            parsed.database.as_deref().unwrap_or(database)
        };
        let limit = limit.clamp(1, 200);
        let fetch_limit = limit + 1;
        let kinds = parsed.kind_sql_list();
        let conn = self.inner.lock();
        let mut items = Vec::with_capacity(fetch_limit);

        if parsed.is_scoped_match_all() {
            let mut binds = vec![
                Value::Text(connection_id.to_owned()),
                Value::Text(search_database.to_owned()),
            ];
            let hierarchy = parsed.hierarchy_sql("", &mut binds);
            let limit_param = binds.len() + 1;
            binds.push(Value::Integer(fetch_limit as i64));
            let sql = format!(
                "SELECT database_name, schema_name, table_name, kind, name \
                 FROM catalog_nodes \
                 WHERE connection_id = ?1 AND database_name = ?2 \
                   AND kind IN ({kinds}) \
                   {hierarchy} \
                 ORDER BY normalized_name, schema_name \
                 LIMIT ?{limit_param}"
            );
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| DbError::SchemaCache(format!("catalog search prepare: {e}")))?;
            let rows = stmt
                .query_map(params_from_iter(binds.iter()), catalog_hit_from_row)
                .map_err(|e| DbError::SchemaCache(format!("catalog search query: {e}")))?;
            for row in rows {
                items.push(row.map_err(|e| DbError::SchemaCache(format!("catalog row: {e}")))?);
            }
        } else if let Some(candidate) = parsed.fts_candidate() {
            let mut binds = vec![
                Value::Text(ParsedCatalogQuery::fts_query(&candidate)),
                Value::Text(connection_id.to_owned()),
                Value::Text(search_database.to_owned()),
            ];
            let hierarchy = parsed.hierarchy_sql("n.", &mut binds);
            let like_param = binds.len() + 1;
            binds.push(Value::Text(parsed.like_pattern()));
            let limit_param = binds.len() + 1;
            binds.push(Value::Integer(fetch_limit as i64));
            let sql = format!(
                "SELECT n.database_name, n.schema_name, n.table_name, n.kind, n.name \
                 FROM catalog_nodes_fts f \
                 JOIN catalog_nodes n ON n.id = f.rowid \
                 WHERE f.normalized_name MATCH ?1 \
                   AND n.connection_id = ?2 AND n.database_name = ?3 \
                   AND n.kind IN ({kinds}) \
                   {hierarchy} \
                   AND n.normalized_name LIKE ?{like_param} ESCAPE '\\' \
                 ORDER BY n.name COLLATE NOCASE, n.schema_name COLLATE NOCASE \
                 LIMIT ?{limit_param}"
            );
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| DbError::SchemaCache(format!("catalog search prepare: {e}")))?;
            let rows = stmt
                .query_map(params_from_iter(binds.iter()), catalog_hit_from_row)
                .map_err(|e| DbError::SchemaCache(format!("catalog search query: {e}")))?;
            for row in rows {
                items.push(row.map_err(|e| DbError::SchemaCache(format!("catalog row: {e}")))?);
            }
        } else {
            let sql = format!(
                "SELECT database_name, schema_name, table_name, kind, name \
                 FROM catalog_nodes \
                 WHERE connection_id = ?1 AND database_name = ?2 \
                   AND kind IN ({kinds}) AND normalized_name LIKE ?3 ESCAPE '\\' \
                 ORDER BY name COLLATE NOCASE, schema_name COLLATE NOCASE \
                 LIMIT ?4"
            );
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| DbError::SchemaCache(format!("catalog search prepare: {e}")))?;
            let rows = stmt
                .query_map(
                    params![
                        connection_id,
                        search_database,
                        parsed.like_pattern(),
                        fetch_limit as i64
                    ],
                    catalog_hit_from_row,
                )
                .map_err(|e| DbError::SchemaCache(format!("catalog search query: {e}")))?;
            for row in rows {
                items.push(row.map_err(|e| DbError::SchemaCache(format!("catalog row: {e}")))?);
            }
        }
        let truncated = items.len() > limit;
        items.truncate(limit);
        let indexed_at = conn
            .query_row(
                "SELECT indexed_at FROM catalog_status \
                 WHERE connection_id = ?1 AND database_name = ?2",
                params![connection_id, search_database],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| DbError::SchemaCache(format!("catalog status read: {e}")))?;
        Ok(CatalogSearchResult {
            items,
            truncated,
            query_too_broad: false,
            indexed_at,
        })
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
        let mut conn = self.inner.lock();
        let tx = conn
            .transaction()
            .map_err(|e| DbError::SchemaCache(format!("invalidate transaction: {e}")))?;
        if tables.is_empty() {
            tx.execute(
                "DELETE FROM table_schema \
                 WHERE connection_id = ?1 AND database = ?2 AND schema = ?3",
                params![connection_id, database, schema],
            )
            .map_err(|e| DbError::SchemaCache(format!("invalidate-all: {e}")))?;
            tx.execute(
                "DELETE FROM catalog_nodes \
                 WHERE connection_id = ?1 AND database_name = ?2 AND schema_name = ?3 \
                   AND kind IN ('column', 'key', 'fk', 'index', 'check', 'trigger')",
                params![connection_id, database, schema],
            )
            .map_err(|e| DbError::SchemaCache(format!("invalidate catalog children: {e}")))?;
            tx.commit()
                .map_err(|e| DbError::SchemaCache(format!("invalidate commit: {e}")))?;
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
        tx.execute(&sql, params_from_iter(binds.iter().copied()))
            .map_err(|e| DbError::SchemaCache(format!("invalidate: {e}")))?;
        let child_sql = format!(
            "DELETE FROM catalog_nodes \
             WHERE connection_id = ?1 AND database_name = ?2 AND schema_name = ?3 \
               AND table_name IN ({}) \
               AND kind IN ('column', 'key', 'fk', 'index', 'check', 'trigger')",
            placeholders.join(",")
        );
        tx.execute(&child_sql, params_from_iter(binds.iter().copied()))
            .map_err(|e| DbError::SchemaCache(format!("invalidate catalog children: {e}")))?;
        tx.commit()
            .map_err(|e| DbError::SchemaCache(format!("invalidate commit: {e}")))?;
        Ok(())
    }

    /// Drop every row for a connection — called from
    /// `db_delete_connection` so a removed connection doesn't leave
    /// orphan cache rows behind.
    pub fn invalidate_connection(&self, connection_id: &str) -> DbResult<()> {
        let mut conn = self.inner.lock();
        let tx = conn
            .transaction()
            .map_err(|e| DbError::SchemaCache(format!("invalidate connection transaction: {e}")))?;
        tx.execute(
            "DELETE FROM table_schema WHERE connection_id = ?1",
            params![connection_id],
        )
        .map_err(|e| DbError::SchemaCache(format!("invalidate_connection: {e}")))?;
        tx.execute(
            "DELETE FROM catalog_nodes WHERE connection_id = ?1",
            params![connection_id],
        )
        .map_err(|e| DbError::SchemaCache(format!("invalidate catalog: {e}")))?;
        tx.execute(
            "DELETE FROM catalog_status WHERE connection_id = ?1",
            params![connection_id],
        )
        .map_err(|e| DbError::SchemaCache(format!("invalidate catalog status: {e}")))?;
        tx.commit()
            .map_err(|e| DbError::SchemaCache(format!("invalidate connection commit: {e}")))?;
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

/// Process at most one resumable legacy-cache migration batch. File-backed
/// caches call this on a background thread so a large old cache cannot delay
/// window creation; tests and in-memory caches drain it synchronously.
fn backfill_catalog_nodes_batch(conn: &mut rusqlite::Connection) -> DbResult<bool> {
    let already_done: Option<String> = conn
        .query_row(
            "SELECT value FROM catalog_meta WHERE key = 'table-schema-backfill-v1'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| DbError::SchemaCache(format!("catalog backfill marker: {e}")))?;
    if already_done.is_some() {
        return Ok(true);
    }

    let last_rowid = conn
        .query_row(
            "SELECT value FROM catalog_meta WHERE key = 'table-schema-backfill-v1-cursor'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| DbError::SchemaCache(format!("catalog backfill cursor: {e}")))?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let batch = {
        let mut stmt = conn
            .prepare(
                "SELECT rowid, connection_id, payload FROM table_schema \
                 WHERE rowid > ?1 ORDER BY rowid LIMIT 100",
            )
            .map_err(|e| DbError::SchemaCache(format!("catalog backfill prepare: {e}")))?;
        let rows = stmt
            .query_map(params![last_rowid], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| DbError::SchemaCache(format!("catalog backfill query: {e}")))?;
        let mut batch = Vec::new();
        for row in rows {
            batch
                .push(row.map_err(|e| DbError::SchemaCache(format!("catalog backfill row: {e}")))?);
        }
        batch
    };

    let tx = conn
        .transaction()
        .map_err(|e| DbError::SchemaCache(format!("catalog backfill transaction: {e}")))?;
    if batch.is_empty() {
        tx.execute(
            "INSERT INTO catalog_meta(key, value) VALUES ('table-schema-backfill-v1', 'done')",
            [],
        )
        .map_err(|e| DbError::SchemaCache(format!("catalog backfill marker write: {e}")))?;
        tx.execute(
            "DELETE FROM catalog_meta WHERE key = 'table-schema-backfill-v1-cursor'",
            [],
        )
        .map_err(|e| DbError::SchemaCache(format!("catalog backfill cursor clear: {e}")))?;
        tx.commit()
            .map_err(|e| DbError::SchemaCache(format!("catalog backfill commit: {e}")))?;
        return Ok(true);
    }

    let next_rowid = batch.last().map(|row| row.0).unwrap_or(last_rowid);
    for (_, connection_id, payload) in batch {
        match serde_json::from_str::<TableDescription>(&payload) {
            Ok(description) => upsert_description_nodes(&tx, &connection_id, &description)?,
            Err(e) => tracing::warn!(?e, "skipping invalid legacy schema-cache payload"),
        }
    }
    tx.execute(
        "INSERT INTO catalog_meta(key, value) \
         VALUES ('table-schema-backfill-v1-cursor', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![next_rowid.to_string()],
    )
    .map_err(|e| DbError::SchemaCache(format!("catalog backfill cursor write: {e}")))?;
    tx.commit()
        .map_err(|e| DbError::SchemaCache(format!("catalog backfill commit: {e}")))?;
    Ok(false)
}

fn insert_catalog_node(
    conn: &rusqlite::Connection,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    kind: &str,
    name: &str,
) -> DbResult<()> {
    conn.execute(
        "INSERT INTO catalog_nodes( \
           connection_id, database_name, schema_name, table_name, kind, name, normalized_name \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(connection_id, database_name, schema_name, table_name, kind, name) \
         DO UPDATE SET normalized_name = excluded.normalized_name",
        params![
            connection_id,
            database,
            schema,
            table,
            kind,
            name,
            name.to_lowercase(),
        ],
    )
    .map_err(|e| DbError::SchemaCache(format!("catalog upsert: {e}")))?;
    Ok(())
}

fn upsert_description_nodes(
    conn: &rusqlite::Connection,
    connection_id: &str,
    description: &TableDescription,
) -> DbResult<()> {
    let database = &description.database;
    let schema = &description.schema;
    let table = &description.name;
    insert_catalog_node(conn, connection_id, database, schema, "", "schema", schema)?;
    insert_catalog_node(
        conn,
        connection_id,
        database,
        schema,
        table,
        match description.kind {
            TableKind::Table => "table",
            TableKind::View => "view",
        },
        table,
    )?;

    // Replace detailed children as one snapshot so renamed/dropped objects do
    // not survive indefinitely in search results.
    conn.execute(
        "DELETE FROM catalog_nodes WHERE connection_id = ?1 AND database_name = ?2 \
         AND schema_name = ?3 AND table_name = ?4 \
         AND kind IN ('column', 'key', 'fk', 'index', 'check', 'trigger')",
        params![connection_id, database, schema, table],
    )
    .map_err(|e| DbError::SchemaCache(format!("catalog child clear: {e}")))?;

    for column in &description.columns {
        insert_catalog_node(
            conn,
            connection_id,
            database,
            schema,
            table,
            "column",
            &column.name,
        )?;
    }
    for key in &description.keys {
        insert_catalog_node(
            conn,
            connection_id,
            database,
            schema,
            table,
            "key",
            &key.name,
        )?;
    }
    for fk in &description.foreign_keys {
        insert_catalog_node(conn, connection_id, database, schema, table, "fk", &fk.name)?;
    }
    for index in &description.indexes {
        insert_catalog_node(
            conn,
            connection_id,
            database,
            schema,
            table,
            "index",
            &index.name,
        )?;
    }
    for check in &description.checks {
        insert_catalog_node(
            conn,
            connection_id,
            database,
            schema,
            table,
            "check",
            &check.name,
        )?;
    }
    for trigger in &description.triggers {
        insert_catalog_node(
            conn,
            connection_id,
            database,
            schema,
            table,
            "trigger",
            &trigger.name,
        )?;
    }
    Ok(())
}

fn catalog_hit_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CatalogSearchHit> {
    let mut database: String = row.get(0)?;
    let table: String = row.get(2)?;
    let kind: String = row.get(3)?;
    let name: String = row.get(4)?;
    if kind == "database" && database.is_empty() {
        database.clone_from(&name);
    }
    Ok(CatalogSearchHit {
        database,
        schema: row.get(1)?,
        table: if table.is_empty() { None } else { Some(table) },
        kind,
        name,
    })
}

struct ParsedCatalogQuery {
    kind: CatalogQueryKind,
    pattern: String,
    database: Option<String>,
    schema: Option<String>,
    table: Option<String>,
}

#[derive(Clone, Copy)]
enum CatalogQueryKind {
    Any,
    Database,
    Schema,
    Table,
    Column,
    Key,
    ForeignKey,
    Index,
    Check,
    Trigger,
    Function,
    Procedure,
    Routine,
}

impl ParsedCatalogQuery {
    fn parse(raw: &str) -> Option<Self> {
        let mut rest = raw.trim();
        if rest.is_empty() {
            return None;
        }
        let mut qualifiers = Vec::new();
        while let Some((qualifier, value, remaining)) = Self::take_qualifier(rest) {
            qualifiers.push((qualifier, value));
            rest = remaining.trim_start();
        }

        let mut database = None;
        let mut schema = None;
        let mut table = None;
        let (kind, pattern, scopes) = if rest.is_empty() {
            let (target_kind, target_value) = qualifiers.pop()?;
            (target_kind, target_value, qualifiers)
        } else {
            (CatalogQueryKind::Any, rest.to_owned(), qualifiers)
        };

        for (scope, value) in scopes {
            match scope {
                CatalogQueryKind::Database => database = Some(value),
                CatalogQueryKind::Schema => schema = Some(value),
                CatalogQueryKind::Table => table = Some(value),
                _ => return None,
            }
        }
        if pattern.is_empty() {
            return None;
        }
        Some(Self {
            kind,
            pattern: pattern.to_lowercase(),
            database,
            schema,
            table,
        })
    }

    /// Consume one leading `type:value` qualifier. Values may be bare,
    /// single-quoted, double-quoted, or bracketed so database object names
    /// containing spaces remain unambiguous.
    fn take_qualifier(raw: &str) -> Option<(CatalogQueryKind, String, &str)> {
        let colon = raw.find(':')?;
        let name = &raw[..colon];
        if name.is_empty() || name.chars().any(char::is_whitespace) {
            return None;
        }
        let kind = CatalogQueryKind::parse(name)?;
        let value_and_rest = &raw[colon + 1..];
        let first = value_and_rest.chars().next()?;
        let (value, consumed) = match first {
            '\'' | '"' => {
                let body = &value_and_rest[first.len_utf8()..];
                let end = body.find(first)?;
                (&body[..end], first.len_utf8() + end + first.len_utf8())
            }
            '[' => {
                let body = &value_and_rest[1..];
                let end = body.find(']')?;
                (&body[..end], end + 2)
            }
            _ => {
                let end = value_and_rest
                    .find(char::is_whitespace)
                    .unwrap_or(value_and_rest.len());
                (&value_and_rest[..end], end)
            }
        };
        if value.is_empty() {
            return None;
        }
        Some((kind, value.to_owned(), &value_and_rest[consumed..]))
    }

    fn fts_candidate(&self) -> Option<String> {
        self.pattern
            .split('*')
            .filter(|part| part.chars().count() >= 3)
            .max_by_key(|part| part.chars().count())
            .map(str::to_owned)
    }

    fn is_scoped_match_all(&self) -> bool {
        self.pattern == "*"
            && (!matches!(self.kind, CatalogQueryKind::Any)
                || self.database.is_some()
                || self.schema.is_some()
                || self.table.is_some())
    }

    fn is_too_broad(&self) -> bool {
        !self.is_scoped_match_all() && self.fts_candidate().is_none()
    }

    fn fts_query(candidate: &str) -> String {
        format!("\"{}\"", candidate.replace('"', "\"\""))
    }

    fn like_pattern(&self) -> String {
        let mut escaped = String::with_capacity(self.pattern.len() + 2);
        for ch in self.pattern.chars() {
            match ch {
                '\\' | '%' | '_' => {
                    escaped.push('\\');
                    escaped.push(ch);
                }
                '*' => escaped.push('%'),
                _ => escaped.push(ch),
            }
        }
        if self.pattern.contains('*') {
            escaped
        } else {
            format!("%{escaped}%")
        }
    }

    fn hierarchy_sql(&self, alias: &str, binds: &mut Vec<Value>) -> String {
        let mut clauses = Vec::with_capacity(2);
        if let Some(schema) = &self.schema {
            binds.push(Value::Text(schema.clone()));
            clauses.push(format!(
                "AND {alias}schema_name = ?{} COLLATE NOCASE",
                binds.len()
            ));
        }
        if let Some(table) = &self.table {
            binds.push(Value::Text(table.clone()));
            clauses.push(format!(
                "AND {alias}table_name = ?{} COLLATE NOCASE",
                binds.len()
            ));
        }
        clauses.join(" ")
    }

    fn kind_sql_list(&self) -> &'static str {
        match self.kind {
            CatalogQueryKind::Any => {
                "'database','schema','table','view','column','key','fk','index','check','trigger','function','procedure'"
            }
            CatalogQueryKind::Database => "'database'",
            CatalogQueryKind::Schema => "'schema'",
            CatalogQueryKind::Table => "'table','view'",
            CatalogQueryKind::Column => "'column'",
            CatalogQueryKind::Key => "'key'",
            CatalogQueryKind::ForeignKey => "'fk'",
            CatalogQueryKind::Index => "'index'",
            CatalogQueryKind::Check => "'check'",
            CatalogQueryKind::Trigger => "'trigger'",
            CatalogQueryKind::Function => "'function'",
            CatalogQueryKind::Procedure => "'procedure'",
            CatalogQueryKind::Routine => "'function','procedure'",
        }
    }
}

impl CatalogQueryKind {
    fn parse(raw: &str) -> Option<Self> {
        match raw.to_lowercase().as_str() {
            "db" | "database" | "databases" => Some(Self::Database),
            "schema" | "schemas" => Some(Self::Schema),
            "table" | "tables" | "tbl" => Some(Self::Table),
            "column" | "columns" | "col" | "cols" => Some(Self::Column),
            "key" | "keys" | "pk" | "uk" => Some(Self::Key),
            "fk" | "fks" | "foreign key" | "foreign keys" => Some(Self::ForeignKey),
            "index" | "indexes" | "indices" | "idx" => Some(Self::Index),
            "check" | "checks" => Some(Self::Check),
            "trigger" | "triggers" | "trg" => Some(Self::Trigger),
            "fn" | "func" | "function" | "functions" => Some(Self::Function),
            "proc" | "procs" | "procedure" | "procedures" | "sp" => Some(Self::Procedure),
            "routine" | "routines" => Some(Self::Routine),
            _ => None,
        }
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
        cache.invalidate("c1", "db", "public", &["users"]).unwrap();
        assert!(cache.get("c1", "db", "public", "users").unwrap().is_none());
        assert!(cache.get("c1", "db", "public", "orders").unwrap().is_some());
        let removed_children = cache.search_catalog("c1", "db", "column:*", 20).unwrap();
        assert!(removed_children
            .items
            .iter()
            .all(|hit| hit.table.as_deref() != Some("users")));
        let relation = cache.search_catalog("c1", "db", "users", 20).unwrap();
        assert_eq!(relation.items.len(), 1);
        assert_eq!(relation.items[0].kind, "table");
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

    #[test]
    fn catalog_search_is_bounded_and_reports_truncation() {
        let cache = SchemaCache::open_at(":memory:").unwrap();
        let relations: Vec<TableSummary> = (0..5)
            .map(|n| TableSummary {
                schema: "public".into(),
                name: format!("customer_{n}"),
                kind: TableKind::Table,
            })
            .collect();
        cache
            .replace_relations("c1", "db", &[], true, &relations, 123)
            .unwrap();

        let result = cache.search_catalog("c1", "db", "customer", 3).unwrap();
        assert_eq!(result.items.len(), 3);
        assert!(result.truncated);
        assert_eq!(result.indexed_at, Some(123));
    }

    #[test]
    fn catalog_search_parses_kind_scope_in_backend() {
        let cache = SchemaCache::open_at(":memory:").unwrap();
        cache
            .replace_relations(
                "c1",
                "db",
                &[],
                true,
                &[
                    TableSummary {
                        schema: "metrics".into(),
                        name: "daily_metrics".into(),
                        kind: TableKind::Table,
                    },
                    TableSummary {
                        schema: "metrics".into(),
                        name: "metrics_view".into(),
                        kind: TableKind::View,
                    },
                ],
                1,
            )
            .unwrap();

        let schemas = cache
            .search_catalog("c1", "db", "schema:metric", 20)
            .unwrap();
        assert_eq!(schemas.items.len(), 1);
        assert_eq!(schemas.items[0].kind, "schema");

        let tables = cache
            .search_catalog("c1", "db", "table:metric", 20)
            .unwrap();
        assert_eq!(tables.items.len(), 2);
        assert!(tables
            .items
            .iter()
            .all(|hit| hit.kind == "table" || hit.kind == "view"));
    }

    #[test]
    fn catalog_search_rejects_short_scans_but_allows_scoped_match_all() {
        let cache = SchemaCache::open_at(":memory:").unwrap();
        cache
            .replace_relations(
                "c1",
                "db",
                &["public".into()],
                true,
                &[TableSummary {
                    schema: "public".into(),
                    name: "users".into(),
                    kind: TableKind::Table,
                }],
                1,
            )
            .unwrap();

        let short = cache.search_catalog("c1", "db", "us", 20).unwrap();
        assert!(short.query_too_broad);
        assert!(short.items.is_empty());
        assert!(
            cache
                .search_catalog("c1", "db", "ab*cd", 20)
                .unwrap()
                .query_too_broad
        );

        let scoped = cache.search_catalog("c1", "db", "table:*", 20).unwrap();
        assert!(!scoped.query_too_broad);
        assert_eq!(scoped.items.len(), 1);
    }

    #[test]
    fn catalog_search_escapes_like_metacharacters() {
        let cache = SchemaCache::open_at(":memory:").unwrap();
        cache
            .replace_relations(
                "c1",
                "db",
                &[],
                true,
                &[
                    TableSummary {
                        schema: "public".into(),
                        name: "sales_100%".into(),
                        kind: TableKind::Table,
                    },
                    TableSummary {
                        schema: "public".into(),
                        name: "salesX100Y".into(),
                        kind: TableKind::Table,
                    },
                ],
                1,
            )
            .unwrap();

        let result = cache
            .search_catalog("c1", "db", "table:sales_*%", 20)
            .unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].name, "sales_100%");
    }

    #[test]
    fn catalog_search_isolated_by_connection_and_database() {
        let cache = SchemaCache::open_at(":memory:").unwrap();
        let relation = [TableSummary {
            schema: "public".into(),
            name: "customers".into(),
            kind: TableKind::Table,
        }];
        cache
            .replace_relations("c1", "db1", &[], true, &relation, 1)
            .unwrap();
        cache
            .replace_relations("c2", "db1", &[], true, &relation, 1)
            .unwrap();
        cache
            .replace_relations("c1", "db2", &[], true, &relation, 1)
            .unwrap();

        assert_eq!(
            cache
                .search_catalog("c1", "db1", "customers", 20)
                .unwrap()
                .items
                .len(),
            1
        );
        assert_eq!(
            cache
                .search_catalog("c2", "db1", "customers", 20)
                .unwrap()
                .items
                .len(),
            1
        );
        assert_eq!(
            cache
                .search_catalog("c1", "db2", "customers", 20)
                .unwrap()
                .items
                .len(),
            1
        );
        assert!(cache
            .search_catalog("missing", "db1", "customers", 20)
            .unwrap()
            .items
            .is_empty());
    }

    #[test]
    fn catalog_search_scopes_database_schema_and_parent_table() {
        let cache = SchemaCache::open_at(":memory:").unwrap();
        cache
            .replace_databases("c1", &["Sales".into(), "Data Warehouse".into()], 1)
            .unwrap();
        cache
            .replace_relations(
                "c1",
                "Data Warehouse",
                &["dbo".into(), "audit".into()],
                true,
                &[
                    TableSummary {
                        schema: "dbo".into(),
                        name: "orders".into(),
                        kind: TableKind::Table,
                    },
                    TableSummary {
                        schema: "audit".into(),
                        name: "orders_history".into(),
                        kind: TableKind::Table,
                    },
                ],
                1,
            )
            .unwrap();
        let mut description = sample_desc("orders");
        description.database = "Data Warehouse".into();
        description.schema = "dbo".into();
        cache.upsert("c1", &description, 1).unwrap();

        let databases = cache.search_catalog("c1", "", "database:ware", 20).unwrap();
        assert_eq!(databases.items.len(), 1);
        assert_eq!(databases.items[0].name, "Data Warehouse");

        let single_quoted_database = cache
            .search_catalog("c1", "", "database:'Data Warehouse'", 20)
            .unwrap();
        assert_eq!(single_quoted_database.items.len(), 1);
        assert_eq!(single_quoted_database.items[0].name, "Data Warehouse");

        let tables = cache
            .search_catalog(
                "c1",
                "Sales",
                "database:'Data Warehouse' schema:dbo table:*",
                20,
            )
            .unwrap();
        assert_eq!(tables.items.len(), 1);
        assert_eq!(tables.items[0].name, "orders");

        let columns = cache
            .search_catalog(
                "c1",
                "Sales",
                "database:[Data Warehouse] schema:dbo table:orders column:*",
                20,
            )
            .unwrap();
        assert_eq!(columns.items.len(), 1);
        assert_eq!(columns.items[0].kind, "column");
        assert_eq!(
            SchemaCache::query_database_scope(
                "database:\"Data Warehouse\" schema:dbo table:orders",
                "Sales"
            )
            .as_deref(),
            Some("Data Warehouse")
        );
        assert!(SchemaCache::query_database_scope("database:ware", "Sales").is_none());
    }

    #[test]
    fn routine_snapshots_replace_stale_names() {
        let cache = SchemaCache::open_at(":memory:").unwrap();
        let routine = |name: &str| RoutineDescription {
            schema: "public".into(),
            name: name.into(),
            kind: RoutineKind::Function,
            language: None,
            return_type: None,
            argument_types: Vec::new(),
        };
        cache
            .upsert_routines("c1", "db", "public", &[routine("old_function")])
            .unwrap();
        cache
            .upsert_routines("c1", "db", "public", &[routine("new_function")])
            .unwrap();

        assert!(cache
            .search_catalog("c1", "db", "old_function", 20)
            .unwrap()
            .items
            .is_empty());
        assert_eq!(
            cache
                .search_catalog("c1", "db", "new_function", 20)
                .unwrap()
                .items
                .len(),
            1
        );

        cache
            .replace_relations("c1", "db", &[], false, &[], 2)
            .unwrap();
        assert_eq!(
            cache
                .search_catalog("c1", "db", "new_function", 20)
                .unwrap()
                .items
                .len(),
            1
        );

        cache
            .replace_relations("c1", "db", &["public".into()], true, &[], 3)
            .unwrap();
        assert_eq!(
            cache
                .search_catalog("c1", "db", "new_function", 20)
                .unwrap()
                .items
                .len(),
            1
        );

        cache
            .replace_relations("c1", "db", &[], true, &[], 4)
            .unwrap();
        assert!(cache
            .search_catalog("c1", "db", "new_function", 20)
            .unwrap()
            .items
            .is_empty());
    }

    #[test]
    fn described_children_join_the_catalog_without_search_fetches() {
        let cache = SchemaCache::open_at(":memory:").unwrap();
        cache.upsert("c1", &sample_desc("users"), 1).unwrap();

        let result = cache.search_catalog("c1", "db", "column:*", 20).unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].kind, "column");
        assert_eq!(result.items[0].table.as_deref(), Some("users"));
    }

    #[test]
    fn replacing_relations_removes_stale_relation_names() {
        let cache = SchemaCache::open_at(":memory:").unwrap();
        cache.upsert("c1", &sample_desc("old_orders"), 1).unwrap();
        cache
            .replace_relations(
                "c1",
                "db",
                &[],
                true,
                &[TableSummary {
                    schema: "public".into(),
                    name: "old_orders".into(),
                    kind: TableKind::Table,
                }],
                1,
            )
            .unwrap();
        cache
            .replace_relations("c1", "db", &[], true, &[], 2)
            .unwrap();

        let result = cache.search_catalog("c1", "db", "old_orders", 20).unwrap();
        assert!(result.items.is_empty());
        let child = cache.search_catalog("c1", "db", "column:*", 20).unwrap();
        assert!(child.items.is_empty());
        assert_eq!(result.indexed_at, Some(2));
    }

    #[test]
    fn opening_existing_cache_backfills_detailed_catalog_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("schema-cache.db");
        let description = sample_desc("legacy_users");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE table_schema ( \
                   connection_id TEXT NOT NULL, database TEXT NOT NULL, schema TEXT NOT NULL, \
                   table_name TEXT NOT NULL, indexed_at INTEGER NOT NULL, payload TEXT NOT NULL, \
                   PRIMARY KEY (connection_id, database, schema, table_name) \
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO table_schema \
                 (connection_id, database, schema, table_name, indexed_at, payload) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    "c1",
                    "db",
                    "public",
                    "legacy_users",
                    1,
                    serde_json::to_string(&description).unwrap(),
                ],
            )
            .unwrap();
        }

        let cache = SchemaCache::open_at(&path).unwrap();
        let result = cache.search_catalog("c1", "db", "column:*", 20).unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].table.as_deref(), Some("legacy_users"));
    }
}
