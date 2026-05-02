//! Postgres driver backed by sqlx.

use std::time::Instant;

use async_trait::async_trait;
use sqlx::pool::PoolConnection;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow};
use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use sqlx::types::Uuid;
use sqlx::{Column as _, Postgres, Row, TypeInfo, ValueRef};

use crate::driver::{DbConnection, DbError, DbResult};
use crate::types::{
    Cell, CheckDescription, Column, ColumnDescription, ConnectionConfig, ExplainFormat,
    ExplainResult, ForeignKeyDescription, IndexDescription, KeyDescription, QueryResult,
    RoutineDescription, RoutineKind, TableDescription, TableKind, TableSummary, TriggerDescription,
};

pub struct PostgresConnection {
    pool: PgPool,
}

impl PostgresConnection {
    pub async fn connect(cfg: ConnectionConfig) -> DbResult<Self> {
        let opts = PgConnectOptions::new()
            .host(&cfg.host)
            .port(cfg.port)
            .username(&cfg.username)
            .password(&cfg.password)
            .database(&cfg.database);

        let pool = PgPoolOptions::new()
            .max_connections(4)
            .acquire_timeout(std::time::Duration::from_secs(8))
            .connect_with(opts)
            .await
            .map_err(|e| DbError::Connect(e.to_string()))?;

        Ok(Self { pool })
    }
}

#[async_trait]
impl DbConnection for PostgresConnection {
    async fn ping(&mut self) -> DbResult<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;
        Ok(())
    }

    async fn list_databases(&mut self) -> DbResult<Vec<String>> {
        // sqlx pools are bound to a single Postgres database — querying
        // a different one requires a fresh connection. Listing every
        // database in the cluster would be misleading because expanding
        // them in the UI would still show this DB's schemas. Instead,
        // surface only the DB this connection is actually bound to.
        // To browse a different DB, edit the connection.
        let current: (String,) = sqlx::query_as("SELECT current_database()")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;
        Ok(vec![current.0])
    }

    async fn list_schemas(&mut self, _database: &str) -> DbResult<Vec<String>> {
        // sqlx connection is bound to one database; cross-DB switching is
        // not supported in v1. The UI passes the database it's connected
        // to, so we ignore the argument here.
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT IN ('pg_catalog', 'information_schema') \
             AND schema_name NOT LIKE 'pg_toast%' \
             AND schema_name NOT LIKE 'pg_temp%' \
             ORDER BY schema_name",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DbError::Query(e.to_string()))?;
        Ok(rows)
    }

    async fn list_tables(&mut self, _database: &str, schema: &str) -> DbResult<Vec<String>> {
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT table_name FROM information_schema.tables \
             WHERE table_schema = $1 \
             ORDER BY table_name",
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DbError::Query(e.to_string()))?;
        Ok(rows)
    }

    async fn list_all_tables(&mut self, _database: &str) -> DbResult<Vec<TableSummary>> {
        // sqlx is bound to the connection's database; cross-DB browsing
        // isn't supported in v1 (mirrors `list_schemas` / `list_tables`).
        // The query excludes system schemas and toast tables — same
        // exclusions as `list_schemas`.
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT n.nspname::text AS schema_name, \
                    c.relname::text AS table_name, \
                    c.relkind::text AS relkind \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f') \
               AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
               AND n.nspname NOT LIKE 'pg_toast%' \
               AND n.nspname NOT LIKE 'pg_temp%' \
             ORDER BY n.nspname, c.relname",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DbError::Query(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|(schema, name, relkind)| TableSummary {
                schema,
                name,
                kind: match relkind.as_str() {
                    "v" | "m" => TableKind::View,
                    _ => TableKind::Table,
                },
            })
            .collect())
    }

    async fn describe_table(
        &mut self,
        database: &str,
        schema: &str,
        table: &str,
    ) -> DbResult<TableDescription> {
        // Pull `format_type` for a render-friendly type string (e.g.
        // `varchar(64)`, `numeric(10,2)`) instead of the raw oid name.
        // PK flag comes from `pg_index.indisprimary` joined on the
        // attribute number — cheap, single round-trip.
        let column_rows: Vec<(
            String,         // column_name
            String,         // formatted type
            bool,           // nullable (is_nullable = 'YES')
            Option<String>, // default
            i32,            // ordinal_position
            bool,           // is_primary_key
            String,         // relkind ('r','v','m','p','f',...)
        )> = sqlx::query_as(
            "SELECT \
                a.attname::text AS column_name, \
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, \
                NOT a.attnotnull AS nullable, \
                pg_get_expr(d.adbin, d.adrelid) AS default_expr, \
                a.attnum::int4 AS ordinal_position, \
                COALESCE(pk.is_pk, false) AS is_primary_key, \
                c.relkind::text AS relkind \
             FROM pg_attribute a \
             JOIN pg_class c ON c.oid = a.attrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             LEFT JOIN ( \
               SELECT i.indrelid, x.attnum, true AS is_pk \
               FROM pg_index i \
               JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true \
               JOIN pg_attribute x ON x.attrelid = i.indrelid AND x.attnum = k.attnum \
               WHERE i.indisprimary \
             ) pk ON pk.indrelid = a.attrelid AND pk.attnum = a.attnum \
             WHERE n.nspname = $1 AND c.relname = $2 \
               AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DbError::Query(e.to_string()))?;

        if column_rows.is_empty() {
            return Err(DbError::Query(format!(
                "table not found: {schema}.{table}"
            )));
        }

        let kind = match column_rows[0].6.as_str() {
            "v" | "m" => TableKind::View,
            _ => TableKind::Table,
        };

        let columns = column_rows
            .into_iter()
            .map(
                |(name, data_type, nullable, default, ordinal, is_pk, _relkind)| {
                    ColumnDescription {
                        name,
                        data_type,
                        nullable,
                        default,
                        ordinal,
                        is_primary_key: is_pk,
                    }
                },
            )
            .collect();

        // ── Keys (PRIMARY KEY + UNIQUE) ──────────────────────────────
        // `pg_constraint.contype` = 'p' (primary) or 'u' (unique).
        // `unnest(conkey) WITH ORDINALITY` preserves declaration order
        // so multi-column keys round-trip cleanly.
        let key_rows: Vec<(String, bool, Vec<String>)> = sqlx::query_as(
            "SELECT \
                co.conname::text AS name, \
                (co.contype = 'p') AS is_primary, \
                ARRAY( \
                  SELECT a.attname::text \
                  FROM unnest(co.conkey) WITH ORDINALITY AS k(attnum, ord) \
                  JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = k.attnum \
                  ORDER BY k.ord \
                ) AS columns \
             FROM pg_constraint co \
             JOIN pg_class c ON c.oid = co.conrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2 \
               AND co.contype IN ('p', 'u') \
             ORDER BY (co.contype = 'p') DESC, co.conname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DbError::Query(e.to_string()))?;

        let keys = key_rows
            .into_iter()
            .map(|(name, is_primary, columns)| KeyDescription {
                name,
                columns,
                is_primary,
            })
            .collect();

        // ── Foreign keys ─────────────────────────────────────────────
        // Outgoing FKs only (the table's own `contype = 'f'`); the
        // tree's "Foreign keys" folder is per-table, so showing
        // who-points-at-us would just confuse the row meaning.
        let fk_rows: Vec<(String, Vec<String>, String, String, Vec<String>)> = sqlx::query_as(
            "SELECT \
                co.conname::text AS name, \
                ARRAY( \
                  SELECT a.attname::text \
                  FROM unnest(co.conkey) WITH ORDINALITY AS k(attnum, ord) \
                  JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = k.attnum \
                  ORDER BY k.ord \
                ) AS columns, \
                refn.nspname::text AS ref_schema, \
                refc.relname::text AS ref_table, \
                ARRAY( \
                  SELECT a.attname::text \
                  FROM unnest(co.confkey) WITH ORDINALITY AS k(attnum, ord) \
                  JOIN pg_attribute a ON a.attrelid = co.confrelid AND a.attnum = k.attnum \
                  ORDER BY k.ord \
                ) AS ref_columns \
             FROM pg_constraint co \
             JOIN pg_class c ON c.oid = co.conrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             JOIN pg_class refc ON refc.oid = co.confrelid \
             JOIN pg_namespace refn ON refn.oid = refc.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2 AND co.contype = 'f' \
             ORDER BY co.conname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DbError::Query(e.to_string()))?;

        let foreign_keys = fk_rows
            .into_iter()
            .map(
                |(name, columns, referenced_schema, referenced_table, referenced_columns)| {
                    ForeignKeyDescription {
                        name,
                        columns,
                        referenced_schema,
                        referenced_table,
                        referenced_columns,
                    }
                },
            )
            .collect();

        // ── Checks ───────────────────────────────────────────────────
        let check_rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT \
                co.conname::text AS name, \
                pg_get_constraintdef(co.oid, true) AS expression \
             FROM pg_constraint co \
             JOIN pg_class c ON c.oid = co.conrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2 AND co.contype = 'c' \
             ORDER BY co.conname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DbError::Query(e.to_string()))?;

        let checks = check_rows
            .into_iter()
            .map(|(name, expression)| CheckDescription { name, expression })
            .collect();

        // ── Indexes (excluding PK indexes — those live under Keys) ──
        let index_rows: Vec<(String, Vec<String>, bool, bool)> = sqlx::query_as(
            "SELECT \
                ic.relname::text AS name, \
                ARRAY( \
                  SELECT a.attname::text \
                  FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) \
                  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum \
                  ORDER BY k.ord \
                ) AS columns, \
                i.indisunique AS is_unique, \
                i.indisprimary AS is_primary \
             FROM pg_index i \
             JOIN pg_class c ON c.oid = i.indrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             JOIN pg_class ic ON ic.oid = i.indexrelid \
             WHERE n.nspname = $1 AND c.relname = $2 \
               AND NOT i.indisprimary \
             ORDER BY ic.relname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DbError::Query(e.to_string()))?;

        let indexes = index_rows
            .into_iter()
            .map(|(name, columns, is_unique, is_primary)| IndexDescription {
                name,
                columns,
                is_unique,
                is_primary,
            })
            .collect();

        // ── Triggers ─────────────────────────────────────────────────
        // `tgtype` is a bitmask:
        //   0x02 = BEFORE, 0x40 = INSTEAD OF (else AFTER)
        //   0x04 = INSERT, 0x08 = DELETE, 0x10 = UPDATE, 0x20 = TRUNCATE
        // We decode it here so the catalog stays driver-agnostic.
        let trigger_rows: Vec<(String, i16, Option<String>)> = sqlx::query_as(
            "SELECT \
                t.tgname::text AS name, \
                t.tgtype::int2 AS tgtype, \
                pg_get_triggerdef(t.oid, true) AS definition \
             FROM pg_trigger t \
             JOIN pg_class c ON c.oid = t.tgrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2 \
               AND NOT t.tgisinternal \
             ORDER BY t.tgname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DbError::Query(e.to_string()))?;

        let triggers = trigger_rows
            .into_iter()
            .map(|(name, tgtype, definition)| {
                let timing = if tgtype & 0x40 != 0 {
                    "INSTEAD OF"
                } else if tgtype & 0x02 != 0 {
                    "BEFORE"
                } else {
                    "AFTER"
                }
                .to_string();
                let mut events = Vec::new();
                if tgtype & 0x04 != 0 {
                    events.push("INSERT".to_string());
                }
                if tgtype & 0x08 != 0 {
                    events.push("DELETE".to_string());
                }
                if tgtype & 0x10 != 0 {
                    events.push("UPDATE".to_string());
                }
                if tgtype & 0x20 != 0 {
                    events.push("TRUNCATE".to_string());
                }
                TriggerDescription {
                    name,
                    timing,
                    events,
                    definition,
                }
            })
            .collect();

        Ok(TableDescription {
            database: database.to_string(),
            schema: schema.to_string(),
            name: table.to_string(),
            kind,
            columns,
            indexes,
            foreign_keys,
            keys,
            checks,
            triggers,
        })
    }

    async fn list_routines(
        &mut self,
        _database: &str,
        schema: &str,
    ) -> DbResult<Vec<RoutineDescription>> {
        // `prokind`: 'f' = function, 'p' = procedure, 'a' = aggregate,
        // 'w' = window. We surface the first two only — aggregates and
        // window functions clutter the tree without much value.
        // `pg_get_function_arguments` returns the formatted argument
        // list ("a integer, b text"); we split on commas to fit the
        // `argument_types` Vec.
        let rows: Vec<(String, String, String, Option<String>, String)> = sqlx::query_as(
            "SELECT \
                p.proname::text AS name, \
                p.prokind::text AS prokind, \
                pg_get_function_arguments(p.oid) AS arguments, \
                CASE WHEN p.prokind = 'p' THEN NULL \
                     ELSE pg_get_function_result(p.oid) END AS return_type, \
                l.lanname::text AS language \
             FROM pg_proc p \
             JOIN pg_namespace n ON n.oid = p.pronamespace \
             JOIN pg_language l ON l.oid = p.prolang \
             WHERE n.nspname = $1 \
               AND p.prokind IN ('f', 'p') \
             ORDER BY p.proname",
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DbError::Query(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|(name, prokind, arguments, return_type, language)| {
                let kind = if prokind == "p" {
                    RoutineKind::Procedure
                } else {
                    RoutineKind::Function
                };
                let argument_types = if arguments.trim().is_empty() {
                    Vec::new()
                } else {
                    arguments
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                };
                RoutineDescription {
                    schema: schema.to_string(),
                    name,
                    kind,
                    language: Some(language),
                    return_type,
                    argument_types,
                }
            })
            .collect())
    }

    async fn execute(&mut self, sql: &str) -> DbResult<QueryResult> {
        // No context — single statement on whichever pool conn is free.
        // Used by `ping`-equivalent paths and the simple `db_query`
        // fallback. For batches (which need a stable session) callers
        // go through `execute_batch`.
        let mut conn = self
            .pool
            .acquire()
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;
        run_one(&mut conn, sql).await
    }

    async fn explain_query(
        &mut self,
        _database: Option<&str>,
        schema: Option<&str>,
        sql: &str,
        analyze: bool,
    ) -> DbResult<ExplainResult> {
        // Always wrap the user's body with the canonical option set —
        // `FORMAT JSON` is non-negotiable since the visualizer expects
        // JSON it can parse. Whatever EXPLAIN the user typed is stripped
        // before wrapping; otherwise we'd get
        // `EXPLAIN (FORMAT JSON, …) EXPLAIN SELECT …` (Postgres rejects
        // nested EXPLAIN), or — worse — we'd accept their bare
        // `EXPLAIN SELECT …` and try to decode plain-text output as
        // JSON.
        //
        // `analyze` toggles between two flavours:
        //   - `true`  → execute + collect actual rows / timing /
        //               buffers. Side effects happen.
        //   - `false` → planner estimates only. No execution; safe
        //               for destructive statements.
        // ANALYZE / BUFFERS / TIMING are all execution-bound options
        // — Postgres rejects them when the query isn't being run —
        // so we drop them in the estimate-only path.
        let body = strip_explain_prefix(sql);
        let body = body.trim().trim_end_matches(';').trim();
        if body.is_empty() {
            return Err(DbError::Query("explain: empty SQL after wrapping".into()));
        }
        let opts = if analyze {
            "FORMAT JSON, ANALYZE, BUFFERS, VERBOSE, TIMING"
        } else {
            "FORMAT JSON, VERBOSE"
        };
        let wrapped = format!("EXPLAIN ({opts}) {body}");

        // Pin a single physical connection so `SET search_path`
        // applies to the wrapped query — same reason `execute_batch`
        // does it.
        let mut conn = self
            .pool
            .acquire()
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;
        if let Some(s) = schema {
            let safe = s.replace('"', "\"\"");
            let stmt = format!("SET search_path TO \"{}\", public", safe);
            sqlx::query(&stmt)
                .execute(&mut *conn)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
        }

        let start = Instant::now();
        // EXPLAIN-JSON returns one row, one column whose type info
        // says `json`. We decode through `serde_json::Value` so we
        // can re-serialise pretty-printed for the Raw view.
        let row: (serde_json::Value,) = sqlx::query_as(&wrapped)
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;
        let duration_ms = start.elapsed().as_millis() as u64;

        let raw = serde_json::to_string_pretty(&row.0)
            .map_err(|e| DbError::Query(format!("explain serialise: {e}")))?;

        Ok(ExplainResult {
            format: ExplainFormat::Json,
            raw,
            statement: sql.to_string(),
            duration_ms,
            data: None,
        })
    }

    async fn execute_batch(
        &mut self,
        _database: Option<&str>,
        schema: Option<&str>,
        statements: &[&str],
    ) -> DbResult<Vec<QueryResult>> {
        // Acquire **one** physical connection up-front so `SET
        // search_path` and every user statement share the same session.
        // sqlx's PgPool would otherwise hand out a different conn for
        // each call and the SET would be silently lost.
        let mut conn = self
            .pool
            .acquire()
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;

        if let Some(s) = schema {
            let safe = s.replace('"', "\"\"");
            let stmt = format!("SET search_path TO \"{}\", public", safe);
            sqlx::query(&stmt)
                .execute(&mut *conn)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
        }

        let mut out = Vec::with_capacity(statements.len());
        for sql in statements {
            out.push(run_one(&mut conn, sql).await?);
        }
        Ok(out)
    }
}

/// Run a single statement on the given pooled connection. Used by both
/// `execute` and `execute_batch` so the row/cell decoding lives in one
/// place.
async fn run_one(conn: &mut PoolConnection<Postgres>, sql: &str) -> DbResult<QueryResult> {
    let start = Instant::now();

    let rows: Vec<PgRow> = sqlx::query(sql)
        .fetch_all(&mut **conn)
        .await
        .map_err(|e| DbError::Query(e.to_string()))?;

    let columns: Vec<Column> = if let Some(first) = rows.first() {
        first
            .columns()
            .iter()
            .map(|c| Column {
                name: c.name().to_string(),
                type_name: c.type_info().name().to_string(),
            })
            .collect()
    } else {
        Vec::new()
    };

    let mut out_rows: Vec<Vec<Cell>> = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut cells = Vec::with_capacity(row.columns().len());
        for (i, _col) in row.columns().iter().enumerate() {
            cells.push(decode_cell(row, i));
        }
        out_rows.push(cells);
    }

    Ok(QueryResult {
        statement: sql.to_string(),
        columns,
        rows: out_rows,
        rows_affected: None,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

/// Best-effort cell decoder. Tries the common Postgres scalar types in
/// order; falls back to the raw text representation. Anything we don't
/// recognise becomes `Cell::Text("<type>")` so the UI still gets _something_.
fn decode_cell(row: &PgRow, idx: usize) -> Cell {
    // NULL check first.
    let raw = match row.try_get_raw(idx) {
        Ok(r) => r,
        Err(_) => return Cell::Null,
    };
    if raw.is_null() {
        return Cell::Null;
    }
    let type_name = raw.type_info().name().to_string();

    // Try strict types in priority order.
    if let Ok(v) = row.try_get::<bool, _>(idx) {
        return Cell::Bool(v);
    }
    if let Ok(v) = row.try_get::<i64, _>(idx) {
        return Cell::Integer(v);
    }
    if let Ok(v) = row.try_get::<i32, _>(idx) {
        return Cell::Integer(v as i64);
    }
    if let Ok(v) = row.try_get::<i16, _>(idx) {
        return Cell::Integer(v as i64);
    }
    if let Ok(v) = row.try_get::<f64, _>(idx) {
        return Cell::Float(v);
    }
    if let Ok(v) = row.try_get::<f32, _>(idx) {
        return Cell::Float(v as f64);
    }
    if let Ok(v) = row.try_get::<String, _>(idx) {
        return Cell::Text(v);
    }
    if let Ok(v) = row.try_get::<Uuid, _>(idx) {
        return Cell::Text(v.to_string());
    }
    if let Ok(v) = row.try_get::<DateTime<Utc>, _>(idx) {
        return Cell::Text(v.to_rfc3339());
    }
    if let Ok(v) = row.try_get::<NaiveDateTime, _>(idx) {
        return Cell::Text(v.format("%Y-%m-%d %H:%M:%S%.f").to_string());
    }
    if let Ok(v) = row.try_get::<NaiveDate, _>(idx) {
        return Cell::Text(v.format("%Y-%m-%d").to_string());
    }
    if let Ok(v) = row.try_get::<NaiveTime, _>(idx) {
        return Cell::Text(v.format("%H:%M:%S%.f").to_string());
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
        return Cell::Text(format!("\\x{}", hex_short(&v)));
    }
    if let Ok(v) = row.try_get::<serde_json::Value, _>(idx) {
        return Cell::Text(v.to_string());
    }

    Cell::Text(format!("<{}>", type_name))
}

fn hex_short(bytes: &[u8]) -> String {
    const MAX: usize = 64;
    let take = bytes.len().min(MAX);
    let mut s = String::with_capacity(take * 2 + 4);
    for b in &bytes[..take] {
        use std::fmt::Write as _;
        let _ = write!(s, "{:02x}", b);
    }
    if bytes.len() > MAX {
        s.push_str("...");
    }
    s
}

/// Strip a leading `EXPLAIN [(opts…)] [ANALYZE|VERBOSE]*` prefix so
/// the caller can re-wrap with a canonical option set. Returns the
/// inner SQL body when an EXPLAIN was found, or the trimmed input
/// when not.
///
/// Why we strip rather than respect: the visualizer parses
/// `FORMAT JSON` output specifically. A user-typed `EXPLAIN SELECT …`
/// (no options, defaults to text) would round-trip through the JSON
/// decoder and panic. A user-typed `EXPLAIN ANALYZE …` similarly
/// returns text. Always normalising means the user can paste any
/// flavour of EXPLAIN and the perf view still works.
fn strip_explain_prefix(sql: &str) -> &str {
    // Trim leading whitespace + `;` (copy-paste artefacts).
    let mut s = sql.trim_start_matches(&[' ', '\t', '\n', '\r', ';'][..]);

    // Detect `EXPLAIN` token (case-insensitive). Whole-word check —
    // we don't want to chew off the `EXPLAIN` of e.g.
    // `SELECT 'EXPLAIN ME' …` (defensive, since SQL keywords
    // shouldn't appear at the start of a literal).
    if s.len() < 7
        || !s[..7].eq_ignore_ascii_case("EXPLAIN")
        || s.as_bytes()
            .get(7)
            .map(|b| (*b as char).is_ascii_alphanumeric() || *b == b'_')
            .unwrap_or(false)
    {
        return s;
    }
    s = &s[7..];
    s = s.trim_start_matches(&[' ', '\t', '\n', '\r'][..]);

    // Optional `(option, option, …)` block. Postgres EXPLAIN options
    // are simple identifiers + values, no nested parens / strings,
    // so the first `)` ends the block.
    if s.starts_with('(') {
        if let Some(close) = s.find(')') {
            s = &s[close + 1..];
            s = s.trim_start_matches(&[' ', '\t', '\n', '\r'][..]);
        } else {
            // Unbalanced — give up and pass through as-is.
            return s;
        }
    }

    // Optional bare `ANALYZE` / `ANALYSE` / `VERBOSE` keywords (the
    // legacy non-parenthesised form).
    loop {
        let next_word_end = s
            .as_bytes()
            .iter()
            .position(|b| !((*b as char).is_ascii_alphabetic()))
            .unwrap_or(s.len());
        if next_word_end == 0 {
            break;
        }
        let word = &s[..next_word_end];
        match word.to_ascii_uppercase().as_str() {
            "ANALYZE" | "ANALYSE" | "VERBOSE" => {
                s = &s[next_word_end..];
                s = s.trim_start_matches(&[' ', '\t', '\n', '\r'][..]);
            }
            _ => break,
        }
    }

    s
}

#[cfg(test)]
mod tests {
    use super::strip_explain_prefix;

    #[test]
    fn passes_through_when_no_explain() {
        assert_eq!(strip_explain_prefix("SELECT 1"), "SELECT 1");
    }

    #[test]
    fn strips_bare_explain() {
        assert_eq!(strip_explain_prefix("EXPLAIN SELECT 1"), "SELECT 1");
    }

    #[test]
    fn strips_explain_with_parens() {
        assert_eq!(
            strip_explain_prefix("EXPLAIN (FORMAT JSON, ANALYZE) SELECT 1"),
            "SELECT 1",
        );
    }

    #[test]
    fn strips_explain_analyze_legacy_form() {
        assert_eq!(
            strip_explain_prefix("EXPLAIN ANALYZE VERBOSE SELECT 1"),
            "SELECT 1",
        );
    }

    #[test]
    fn case_insensitive() {
        assert_eq!(strip_explain_prefix("explain select 1"), "select 1");
    }

    #[test]
    fn ignores_explain_inside_word() {
        // `EXPLAINER` is a column name, not the keyword.
        assert_eq!(
            strip_explain_prefix("EXPLAINER SELECT 1"),
            "EXPLAINER SELECT 1",
        );
    }

    #[test]
    fn trims_leading_whitespace_and_semis() {
        assert_eq!(
            strip_explain_prefix("  ;\n EXPLAIN  SELECT 1"),
            "SELECT 1",
        );
    }
}
