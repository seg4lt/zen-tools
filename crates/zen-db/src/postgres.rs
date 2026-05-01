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
    Cell, Column, ColumnDescription, ConnectionConfig, QueryResult, TableDescription, TableKind,
    TableSummary,
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

        Ok(TableDescription {
            database: database.to_string(),
            schema: schema.to_string(),
            name: table.to_string(),
            kind,
            columns,
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
        })
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
