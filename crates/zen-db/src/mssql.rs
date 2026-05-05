//! MSSQL driver backed by tiberius + a `bb8` connection pool.
//!
//! tiberius doesn't ship a pool itself; we layer `bb8-tiberius`
//! around it so we get the same fault-tolerance + sleep/wake
//! survival behaviour as the Postgres `sqlx::PgPool`. The pool
//! transparently:
//!
//!   - **Replaces dead connections** between checkouts —
//!     `bb8::Builder::test_on_check_out(true)` makes
//!     `pool.get()` ping `SELECT 1` first; if the ping fails, bb8
//!     drops the entry and creates a fresh one. No more
//!     "connection closed" errors after macOS wake.
//!   - **Keeps one warm connection** via `min_idle(Some(1))` so
//!     the first query after the user comes back from another
//!     app doesn't pay the full TCP+TLS+auth handshake.
//!   - **Caps concurrency at 4** to match the Postgres setup —
//!     the registry's per-id mutex still serialises user-visible
//!     queries today, but having a pool ready means the lock
//!     sampler and any future concurrent paths don't fight for a
//!     single TCP socket.
//!
//! Per-batch session pinning is preserved: `execute_batch_with_options`
//! checks out **one** connection from the pool up-front and runs every
//! statement (including the leading `USE [db]` and the `@@SPID`
//! capture for lock telemetry) on that one connection — same reason
//! Postgres pins a `PgPool` connection: `USE` and other session-state
//! sets don't carry across the pool boundary.

use std::time::{Duration, Instant};

use async_trait::async_trait;
use bb8::Pool;
use bb8_tiberius::ConnectionManager;
use tiberius::numeric::Numeric;
use tiberius::{AuthMethod, Client, ColumnData, Config, EncryptionLevel, QueryItem};
use tokio::net::TcpStream;
use tokio_util::compat::Compat;

use crate::driver::{DbConnection, DbError, DbResult};
use crate::locks::{MsSqlLockSampler, DEFAULT_SAMPLE_INTERVAL_MS};
use crate::types::{
    Cell, CheckDescription, Column, ColumnDescription, ConnectionConfig, ExecuteOptions,
    ExplainFormat, ExplainResult, ForeignKeyDescription, IndexDescription, KeyDescription,
    LockSummary, QueryResult, RoutineDescription, RoutineKind, TableDescription, TableKind,
    TableSummary, TriggerDescription,
};

/// Concrete tiberius client type our pool yields. Matches what
/// `bb8_tiberius::rt::Client` resolves to with the `with-tokio`
/// feature: `Client<Compat<TcpStream>>`.
type MsClient = Client<Compat<TcpStream>>;

/// Convenience alias for our `bb8` pool of tiberius clients.
type MsPool = Pool<ConnectionManager>;

pub struct MsSqlConnection {
    pool: MsPool,
    /// Stored so the lock sampler can spin up its own sidecar
    /// `tiberius::Client` against the same server. The sampler
    /// intentionally does NOT use the user pool — sampling is a
    /// sidecar by design and shouldn't compete with user queries
    /// for pool slots.
    cfg: ConnectionConfig,
}

impl MsSqlConnection {
    pub async fn connect(cfg: ConnectionConfig) -> DbResult<Self> {
        // ── Sanitize the host string ────────────────────────────────
        // The Azure portal's "Server name" field copies as
        // `myserver.database.windows.net,1433` (comma-port suffix —
        // ADO.NET / SSMS parse this, tiberius does NOT). If the user
        // pastes that form whole, DNS lookup fails on the literal
        // string. Strip the suffix here; if a port was embedded and
        // the form-side `port` is still the default, adopt the
        // embedded port too.
        //
        // We also strip an explicit `tcp:` prefix (another
        // Microsoft-style protocol marker users sometimes copy).
        let (host, port) = parse_host_port(&cfg.host, cfg.port);

        let mut tib_cfg = Config::new();
        tib_cfg.host(&host);
        tib_cfg.port(port);
        if !cfg.database.is_empty() {
            tib_cfg.database(&cfg.database);
        }
        tib_cfg.authentication(AuthMethod::sql_server(&cfg.username, &cfg.password));
        // Dev/CI containers ship with self-signed certs.
        if cfg.trust_server_certificate {
            tib_cfg.trust_cert();
        }
        // Azure SQL Edge / mssql-server containers default to TLS-on;
        // keep encryption negotiated.
        tib_cfg.encryption(EncryptionLevel::Required);

        // bb8-tiberius default sets `tcp.set_nodelay(true)` for us
        // (see ConnectionManager::new in the upstream source). No
        // extra `with_modify_tcp_stream` hook needed.
        let mgr = ConnectionManager::new(tib_cfg);

        // Pool sizing — mirrors the Postgres tuning rationale in
        // `postgres.rs::PostgresConnection::connect`:
        //
        //   - `max_size(4)`           — small ceiling matches the
        //                                per-id registry mutex; we
        //                                only run one user query at a
        //                                time per connection, the
        //                                extra slots are headroom for
        //                                catalog/sampler side-channels.
        //   - `min_idle(Some(1))`     — keep one warm connection so
        //                                the first query after macOS
        //                                wake doesn't pay a full
        //                                handshake.
        //   - `connection_timeout(30s)`— Azure SQL needs the headroom.
        //                                A cold first connect on Azure
        //                                does TLS + PRELOGIN + LOGIN7
        //                                + a routing-token redirect to
        //                                the actual node + a SECOND
        //                                full handshake. 5–15s is
        //                                normal; 8s (the original
        //                                value, kept for parity with
        //                                Postgres) timed out before the
        //                                routing redirect could land.
        //                                Local mssql containers still
        //                                connect well under 30s, so
        //                                this is purely additive
        //                                headroom.
        //   - `idle_timeout(10 min)`  — recycle long-idle pool conns
        //                                proactively so we don't hold
        //                                a fleet of server-side
        //                                sleeping sessions.
        //   - `test_on_check_out(true)`— PING `SELECT 1` before each
        //                                handout; bb8-tiberius's
        //                                `is_valid` impl does this.
        //                                **Load-bearing for sleep/wake
        //                                survival**: if the server
        //                                killed our backend while we
        //                                slept, the test fails and bb8
        //                                replaces the entry silently.
        let pool = Pool::builder()
            .max_size(4)
            .min_idle(Some(1))
            .connection_timeout(Duration::from_secs(30))
            .idle_timeout(Some(Duration::from_secs(10 * 60)))
            .test_on_check_out(true)
            .build(mgr)
            .await
            .map_err(|e| {
                // bb8's `RunError` wraps the underlying tiberius error;
                // its `Display` impl flattens the chain to just the
                // outer "pool error" string and drops the actual cause
                // ("certificate verification failed", "Login failed
                // for user", "tcp connect: connection refused", etc.).
                // Walk the cause chain manually so the user sees the
                // root reason — that's the difference between a
                // useless "connect failed" toast and an actionable
                // "your username needs the @servername suffix on
                // Azure SQL" message.
                let chain = format_error_chain(&e);
                tracing::warn!(error = %chain, host = %host, port = port, "mssql connect failed");
                DbError::Connect(chain)
            })?;

        Ok(Self {
            pool,
            cfg: ConnectionConfig {
                host: host.clone(),
                port,
                ..cfg
            },
        })
    }

    /// Pull one tiberius client out of the pool. The returned
    /// `PooledConnection` derefs to `&mut Client<...>`; pass
    /// `&mut conn` to helpers that want `&mut MsClient`. Drop
    /// returns it to the pool automatically.
    async fn acquire(&self) -> DbResult<bb8::PooledConnection<'_, ConnectionManager>> {
        self.pool
            .get()
            .await
            .map_err(|e| DbError::Query(format!("pool: {e}")))
    }
}


#[async_trait]
impl DbConnection for MsSqlConnection {
    async fn ping(&self) -> DbResult<()> {
        // Just acquiring from the pool runs `is_valid` (= `SELECT 1`)
        // because we set `test_on_check_out(true)`. That is the
        // ping. If the cached connection was stale, bb8 swaps it
        // out before handing us a fresh one — so the user clicking
        // Test never sees a "session timed out" failure for an
        // idle connection.
        let _conn = self.acquire().await?;
        Ok(())
    }

    async fn list_databases(&self) -> DbResult<Vec<String>> {
        // The pool's `test_on_check_out(true)` setting makes every
        // `acquire()` ping the connection first; if our cached
        // session died (typical after macOS sleep) bb8 swaps it
        // out silently. So we no longer need a manual
        // ensure-alive probe — `acquire` IS the probe.
        let mut conn = self.acquire().await?;
        run_string_column(
            &mut conn,
            "SELECT name FROM sys.databases ORDER BY name",
            "name",
        )
        .await
    }

    async fn list_schemas(&self, database: &str) -> DbResult<Vec<String>> {
        let mut conn = self.acquire().await?;
        // `USE [db]` only affects the connection it runs on, so we
        // pin one connection across both statements. If we let the
        // pool hand out a fresh one between calls, the SELECT below
        // would land in whatever database that other connection
        // happened to be in.
        let use_stmt = format!("USE [{}]", escape_ident(database));
        conn.simple_query(use_stmt)
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;
        run_string_column(
            &mut conn,
            "SELECT name FROM sys.schemas \
             WHERE name NOT IN ('sys','INFORMATION_SCHEMA','db_owner','db_accessadmin', \
                                'db_securityadmin','db_ddladmin','db_backupoperator', \
                                'db_datareader','db_datawriter','db_denydatareader','db_denydatawriter') \
             ORDER BY name",
            "name",
        )
        .await
    }

    async fn list_tables(&self, database: &str, schema: &str) -> DbResult<Vec<String>> {
        let mut conn = self.acquire().await?;
        let use_stmt = format!("USE [{}]", escape_ident(database));
        conn.simple_query(use_stmt)
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;

        let q = format!(
            "SELECT t.name AS name FROM sys.tables t \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             WHERE s.name = '{}' \
             UNION ALL \
             SELECT v.name FROM sys.views v \
             JOIN sys.schemas s ON s.schema_id = v.schema_id \
             WHERE s.name = '{}' \
             ORDER BY name",
            schema.replace('\'', "''"),
            schema.replace('\'', "''"),
        );
        run_string_column(&mut conn, &q, "name").await
    }

    async fn list_all_tables(&self, database: &str) -> DbResult<Vec<TableSummary>> {
        // Pin one pool connection so `USE` + the catalog query run
        // on the same logical session.
        let mut conn = self.acquire().await?;
        let use_stmt = format!("USE [{}]", escape_ident(database));
        conn.simple_query(use_stmt)
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;

        let q = "SELECT s.name AS schema_name, t.name AS table_name, 'TABLE' AS table_type \
                 FROM sys.tables t \
                 JOIN sys.schemas s ON s.schema_id = t.schema_id \
                 WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA','db_owner','db_accessadmin', \
                                      'db_securityadmin','db_ddladmin','db_backupoperator', \
                                      'db_datareader','db_datawriter','db_denydatareader','db_denydatawriter') \
                 UNION ALL \
                 SELECT s.name, v.name, 'VIEW' \
                 FROM sys.views v \
                 JOIN sys.schemas s ON s.schema_id = v.schema_id \
                 WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA','db_owner','db_accessadmin', \
                                      'db_securityadmin','db_ddladmin','db_backupoperator', \
                                      'db_datareader','db_datawriter','db_denydatareader','db_denydatawriter') \
                 ORDER BY schema_name, table_name";

        let mut out: Vec<TableSummary> = Vec::new();
        let mut stream = conn
            .simple_query(q.to_string())
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;
        while let Some(item) = stream
            .try_next()
            .await
            .map_err(|e| DbError::Query(e.to_string()))?
        {
            if let QueryItem::Row(row) = item {
                let schema = row
                    .try_get::<&str, _>("schema_name")
                    .ok()
                    .flatten()
                    .unwrap_or_default()
                    .to_string();
                let name = row
                    .try_get::<&str, _>("table_name")
                    .ok()
                    .flatten()
                    .unwrap_or_default()
                    .to_string();
                let kind_raw = row
                    .try_get::<&str, _>("table_type")
                    .ok()
                    .flatten()
                    .unwrap_or("TABLE");
                let kind = if kind_raw.eq_ignore_ascii_case("VIEW") {
                    TableKind::View
                } else {
                    TableKind::Table
                };
                if !name.is_empty() && !schema.is_empty() {
                    out.push(TableSummary { schema, name, kind });
                }
            }
        }
        Ok(out)
    }

    async fn describe_table(
        &self,
        database: &str,
        schema: &str,
        table: &str,
    ) -> DbResult<TableDescription> {
        // Pin one pool connection for the whole describe — `USE [db]`
        // sets the database context per-connection, and the eight
        // catalog queries below all assume that context.
        let mut conn = self.acquire().await?;
        let use_stmt = format!("USE [{}]", escape_ident(database));
        conn.simple_query(use_stmt)
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;

        // Detect view vs base table up-front. Empty result = not found.
        let kind_q = format!(
            "SELECT TOP 1 TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_SCHEMA = '{}' AND TABLE_NAME = '{}'",
            schema.replace('\'', "''"),
            table.replace('\'', "''"),
        );
        let mut kind = TableKind::Table;
        let mut found = false;
        {
            let mut stream = conn
                .simple_query(kind_q)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    found = true;
                    if let Some(t) = row.try_get::<&str, _>("TABLE_TYPE").ok().flatten() {
                        if t.eq_ignore_ascii_case("VIEW") {
                            kind = TableKind::View;
                        }
                    }
                }
            }
        }
        if !found {
            return Err(DbError::Query(format!(
                "table not found: {schema}.{table}"
            )));
        }

        // Column rundown — ordinal, type with length, null-ability,
        // default, plus a left-join against KEY_COLUMN_USAGE filtered to
        // PRIMARY KEY constraints to flag PK columns.
        let q = format!(
            "SELECT \
                c.COLUMN_NAME AS column_name, \
                c.DATA_TYPE AS data_type, \
                c.CHARACTER_MAXIMUM_LENGTH AS char_max, \
                c.NUMERIC_PRECISION AS num_prec, \
                c.NUMERIC_SCALE AS num_scale, \
                c.IS_NULLABLE AS is_nullable, \
                c.COLUMN_DEFAULT AS column_default, \
                c.ORDINAL_POSITION AS ordinal_position, \
                CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS is_pk \
             FROM INFORMATION_SCHEMA.COLUMNS c \
             LEFT JOIN ( \
               SELECT k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME \
               FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t \
               JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k \
                 ON k.CONSTRAINT_NAME = t.CONSTRAINT_NAME \
                AND k.TABLE_SCHEMA  = t.TABLE_SCHEMA \
                AND k.TABLE_NAME    = t.TABLE_NAME \
               WHERE t.CONSTRAINT_TYPE = 'PRIMARY KEY' \
             ) pk \
               ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA \
              AND pk.TABLE_NAME   = c.TABLE_NAME \
              AND pk.COLUMN_NAME  = c.COLUMN_NAME \
             WHERE c.TABLE_SCHEMA = '{}' AND c.TABLE_NAME = '{}' \
             ORDER BY c.ORDINAL_POSITION",
            schema.replace('\'', "''"),
            table.replace('\'', "''"),
        );

        let mut columns: Vec<ColumnDescription> = Vec::new();
        // Wrap the columns stream in a block so it's dropped before
        // the next `simple_query` borrows `self.client` mutably again.
        // tiberius's `Client` is `!Sync` and the stream holds a
        // `&mut Client` for its whole lifetime; sequential queries
        // need scoped streams.
        {
            let mut stream = conn
                .simple_query(q)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let name: String = row
                        .try_get::<&str, _>("column_name")
                        .ok()
                        .flatten()
                        .unwrap_or_default()
                        .to_string();
                    let base_type: String = row
                        .try_get::<&str, _>("data_type")
                        .ok()
                        .flatten()
                        .unwrap_or_default()
                        .to_string();
                    let char_max: Option<i32> = row.try_get::<i32, _>("char_max").ok().flatten();
                    let num_prec: Option<u8> = row.try_get::<u8, _>("num_prec").ok().flatten();
                    let num_scale: Option<i32> = row.try_get::<i32, _>("num_scale").ok().flatten();
                    let is_nullable: String = row
                        .try_get::<&str, _>("is_nullable")
                        .ok()
                        .flatten()
                        .unwrap_or("YES")
                        .to_string();
                    let default: Option<String> = row
                        .try_get::<&str, _>("column_default")
                        .ok()
                        .flatten()
                        .map(|s| s.to_string());
                    let ordinal: i32 =
                        row.try_get::<i32, _>("ordinal_position").ok().flatten().unwrap_or(0);
                    let is_pk_raw: i32 = row.try_get::<i32, _>("is_pk").ok().flatten().unwrap_or(0);

                    let data_type = format_mssql_type(&base_type, char_max, num_prec, num_scale);

                    columns.push(ColumnDescription {
                        name,
                        data_type,
                        nullable: is_nullable.eq_ignore_ascii_case("YES"),
                        default,
                        ordinal,
                        is_primary_key: is_pk_raw != 0,
                    });
                }
            }
        }

        // ── Keys (PRIMARY KEY + UNIQUE) ──────────────────────────────
        // `sys.key_constraints` stores the PK/UQ catalogue; the
        // associated `sys.indexes` row gives us the column ordering
        // via `sys.index_columns`. One row per (constraint, column)
        // pair — collapsed into the `KeyDescription` Vec in Rust.
        let q_keys = format!(
            "SELECT \
                kc.name AS name, \
                kc.type AS kc_type, \
                COL_NAME(ic.object_id, ic.column_id) AS col_name, \
                ic.key_ordinal AS key_ordinal \
             FROM sys.key_constraints kc \
             JOIN sys.indexes i \
               ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id \
             JOIN sys.index_columns ic \
               ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             WHERE kc.parent_object_id = OBJECT_ID('{}.{}') \
               AND ic.is_included_column = 0 \
             ORDER BY kc.name, ic.key_ordinal",
            schema.replace('\'', "''"),
            table.replace('\'', "''"),
        );
        let mut keys_acc: Vec<(String, String, String, i32)> = Vec::new();
        {
            let mut stream = conn
                .simple_query(q_keys)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let n = row
                        .try_get::<&str, _>("name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let t = row
                        .try_get::<&str, _>("kc_type")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let c = row
                        .try_get::<&str, _>("col_name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let o = row.try_get::<i32, _>("key_ordinal").ok().flatten().unwrap_or(0);
                    keys_acc.push((n, t, c, o));
                }
            }
        }
        let keys = collapse_keys(keys_acc);

        // ── Foreign keys ─────────────────────────────────────────────
        let q_fks = format!(
            "SELECT \
                fk.name AS name, \
                COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS col, \
                rs.name AS ref_schema, \
                rt.name AS ref_table, \
                COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS ref_col, \
                fkc.constraint_column_id AS col_ord \
             FROM sys.foreign_keys fk \
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
             JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id \
             JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
             WHERE fk.parent_object_id = OBJECT_ID('{}.{}') \
             ORDER BY fk.name, fkc.constraint_column_id",
            schema.replace('\'', "''"),
            table.replace('\'', "''"),
        );
        let mut fk_acc: Vec<(String, String, String, String, String, i32)> = Vec::new();
        {
            let mut stream = conn
                .simple_query(q_fks)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let n = row
                        .try_get::<&str, _>("name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let c = row
                        .try_get::<&str, _>("col")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let rs = row
                        .try_get::<&str, _>("ref_schema")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let rt = row
                        .try_get::<&str, _>("ref_table")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let rc = row
                        .try_get::<&str, _>("ref_col")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let o = row.try_get::<i32, _>("col_ord").ok().flatten().unwrap_or(0);
                    fk_acc.push((n, c, rs, rt, rc, o));
                }
            }
        }
        let foreign_keys = collapse_foreign_keys(fk_acc);

        // ── Checks ───────────────────────────────────────────────────
        let q_checks = format!(
            "SELECT cc.name AS name, cc.definition AS definition \
             FROM sys.check_constraints cc \
             WHERE cc.parent_object_id = OBJECT_ID('{}.{}') \
             ORDER BY cc.name",
            schema.replace('\'', "''"),
            table.replace('\'', "''"),
        );
        let mut checks: Vec<CheckDescription> = Vec::new();
        {
            let mut stream = conn
                .simple_query(q_checks)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let name = row
                        .try_get::<&str, _>("name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let expr = row
                        .try_get::<&str, _>("definition")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    checks.push(CheckDescription {
                        name,
                        expression: expr,
                    });
                }
            }
        }

        // ── Indexes (excluding PK/UQ — those live under Keys) ───────
        let q_indexes = format!(
            "SELECT \
                i.name AS name, \
                CAST(i.is_unique AS int) AS is_unique, \
                COL_NAME(ic.object_id, ic.column_id) AS col, \
                ic.key_ordinal AS key_ordinal \
             FROM sys.indexes i \
             JOIN sys.index_columns ic \
               ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             WHERE i.object_id = OBJECT_ID('{}.{}') \
               AND i.is_primary_key = 0 \
               AND i.is_unique_constraint = 0 \
               AND ic.is_included_column = 0 \
               AND i.name IS NOT NULL \
             ORDER BY i.name, ic.key_ordinal",
            schema.replace('\'', "''"),
            table.replace('\'', "''"),
        );
        let mut idx_acc: Vec<(String, bool, String, i32)> = Vec::new();
        {
            let mut stream = conn
                .simple_query(q_indexes)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let n = row
                        .try_get::<&str, _>("name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let u = row.try_get::<i32, _>("is_unique").ok().flatten().unwrap_or(0) != 0;
                    let c = row
                        .try_get::<&str, _>("col")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let o = row.try_get::<i32, _>("key_ordinal").ok().flatten().unwrap_or(0);
                    idx_acc.push((n, u, c, o));
                }
            }
        }
        let indexes = collapse_indexes(idx_acc);

        // ── Triggers ─────────────────────────────────────────────────
        let q_triggers = format!(
            "SELECT \
                t.name AS name, \
                CAST(OBJECTPROPERTY(t.object_id, 'ExecIsInsteadOfTrigger') AS int) AS instead_of, \
                CAST(OBJECTPROPERTY(t.object_id, 'ExecIsInsertTrigger') AS int) AS on_insert, \
                CAST(OBJECTPROPERTY(t.object_id, 'ExecIsUpdateTrigger') AS int) AS on_update, \
                CAST(OBJECTPROPERTY(t.object_id, 'ExecIsDeleteTrigger') AS int) AS on_delete, \
                OBJECT_DEFINITION(t.object_id) AS definition \
             FROM sys.triggers t \
             WHERE t.parent_id = OBJECT_ID('{}.{}') \
             ORDER BY t.name",
            schema.replace('\'', "''"),
            table.replace('\'', "''"),
        );
        let mut triggers: Vec<TriggerDescription> = Vec::new();
        {
            let mut stream = conn
                .simple_query(q_triggers)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let name = row
                        .try_get::<&str, _>("name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let instead = row.try_get::<i32, _>("instead_of").ok().flatten().unwrap_or(0) != 0;
                    let on_ins = row.try_get::<i32, _>("on_insert").ok().flatten().unwrap_or(0) != 0;
                    let on_upd = row.try_get::<i32, _>("on_update").ok().flatten().unwrap_or(0) != 0;
                    let on_del = row.try_get::<i32, _>("on_delete").ok().flatten().unwrap_or(0) != 0;
                    let definition = row
                        .try_get::<&str, _>("definition")
                        .ok()
                        .flatten()
                        .map(|s| s.to_string());
                    let timing = if instead { "INSTEAD OF" } else { "AFTER" }.to_string();
                    let mut events = Vec::new();
                    if on_ins {
                        events.push("INSERT".to_string());
                    }
                    if on_upd {
                        events.push("UPDATE".to_string());
                    }
                    if on_del {
                        events.push("DELETE".to_string());
                    }
                    triggers.push(TriggerDescription {
                        name,
                        timing,
                        events,
                        definition,
                    });
                }
            }
        }

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
        &self,
        database: &str,
        schema: &str,
    ) -> DbResult<Vec<RoutineDescription>> {
        // Pin one pool connection — `USE [db]` is per-connection so
        // both queries below need to share the same session.
        let mut conn = self.acquire().await?;
        let use_stmt = format!("USE [{}]", escape_ident(database));
        conn.simple_query(use_stmt)
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;

        // Object types: 'P' = stored procedure, 'PC' = CLR procedure,
        // 'FN' = scalar function, 'IF' = inline TVF, 'TF' = TVF,
        // 'AF' = aggregate function. We surface all of them.
        // Return type: only relevant for FN; for TVFs we report
        // "TABLE", and for procedures/aggregates we leave it None.
        let q_objs = format!(
            "SELECT \
                o.object_id AS object_id, \
                o.name AS name, \
                RTRIM(o.type) AS obj_type, \
                CASE \
                  WHEN o.type = 'FN' THEN TYPE_NAME(p_ret.user_type_id) \
                  WHEN o.type IN ('IF', 'TF') THEN 'TABLE' \
                  ELSE NULL END AS return_type \
             FROM sys.objects o \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             LEFT JOIN sys.parameters p_ret \
               ON p_ret.object_id = o.object_id AND p_ret.parameter_id = 0 \
             WHERE s.name = '{}' \
               AND o.type IN ('P','PC','FN','IF','TF','AF') \
             ORDER BY o.name",
            schema.replace('\'', "''"),
        );

        // (object_id, name, kind, return_type)
        let mut objs: Vec<(i32, String, String, Option<String>)> = Vec::new();
        {
            let mut stream = conn
                .simple_query(q_objs)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let id = row.try_get::<i32, _>("object_id").ok().flatten().unwrap_or(0);
                    let name = row
                        .try_get::<&str, _>("name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let kind_raw = row
                        .try_get::<&str, _>("obj_type")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let ret = row
                        .try_get::<&str, _>("return_type")
                        .ok()
                        .flatten()
                        .map(|s| s.to_string());
                    objs.push((id, name, kind_raw, ret));
                }
            }
        }

        // Argument types per object_id, excluding the return-type
        // pseudo-parameter (parameter_id = 0).
        let q_args = format!(
            "SELECT \
                p.object_id AS object_id, \
                p.parameter_id AS parameter_id, \
                TYPE_NAME(p.user_type_id) AS type_name \
             FROM sys.parameters p \
             JOIN sys.objects o ON o.object_id = p.object_id \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = '{}' \
               AND o.type IN ('P','PC','FN','IF','TF','AF') \
               AND p.parameter_id > 0 \
             ORDER BY p.object_id, p.parameter_id",
            schema.replace('\'', "''"),
        );
        let mut args: std::collections::HashMap<i32, Vec<String>> = std::collections::HashMap::new();
        {
            let mut stream = conn
                .simple_query(q_args)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let id = row.try_get::<i32, _>("object_id").ok().flatten().unwrap_or(0);
                    let ty = row
                        .try_get::<&str, _>("type_name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    args.entry(id).or_default().push(ty);
                }
            }
        }

        Ok(objs
            .into_iter()
            .map(|(id, name, kind_raw, ret)| {
                let kind = match kind_raw.as_str() {
                    "P" | "PC" => RoutineKind::Procedure,
                    _ => RoutineKind::Function,
                };
                RoutineDescription {
                    schema: schema.to_string(),
                    name,
                    kind,
                    language: Some("sql".to_string()),
                    return_type: ret,
                    argument_types: args.remove(&id).unwrap_or_default(),
                }
            })
            .collect())
    }

    async fn explain_query(
        &self,
        database: Option<&str>,
        _schema: Option<&str>,
        sql: &str,
        analyze: bool,
    ) -> DbResult<ExplainResult> {
        // Pin one pool connection for the duration of the explain
        // round-trip — `USE [db]`, the `SET STATISTICS / SHOWPLAN`
        // toggle, and the user query all need to share one logical
        // session.
        let mut conn = self.acquire().await?;
        if let Some(db) = database {
            let stmt = format!("USE [{}]", escape_ident(db));
            conn.simple_query(stmt)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
        }

        // Two flavours, very different result shapes:
        //
        // - `analyze = true`  →  `SET STATISTICS XML ON` + run the
        //   query + `SET STATISTICS XML OFF`. Each SELECT yields
        //   (data_set, plan_xml_set). We capture both — the data
        //   surfaces as `ExplainResult.data`, the plan as `raw`.
        //
        // - `analyze = false` →  `SET SHOWPLAN_XML ON` then run the
        //   query. SHOWPLAN_XML *replaces* execution: the only
        //   thing returned is the estimated plan XML, no data.
        //   Per MS docs, SHOWPLAN_XML must be the only statement in
        //   its batch — so we send it as a separate `simple_query`
        //   first, then run the user SQL on the same session.
        //   `data` is `None` because nothing executed.
        //
        // Statistics we *don't* enable today, why, and the path:
        //   - `SET STATISTICS IO ON` — emits per-table "logical reads N,
        //     physical reads N" InfoMessage rows. ShowPlanXML already
        //     embeds `ActualLogicalReads` / `ActualPhysicalReads` /
        //     `ActualReadAheads` per <RelOp>, so this is mostly
        //     duplicate; capturing it would require subscribing to
        //     tiberius's `Token::Info` stream alongside the QueryStream.
        //   - `SET STATISTICS TIME ON` — emits "SQL Server parse and
        //     compile time… Execution Time…" InfoMessage rows. We
        //     approximate via `ExplainResult.duration_ms` (round-trip
        //     wall-clock). Capturing per-statement parse/compile/exec
        //     splits would also need the InfoMessage stream.
        //   - `SET STATISTICS PROFILE ON` — text-form per-row plan,
        //     superseded by STATISTICS XML.
        // If a future user wants the InfoMessage timings split out,
        // the right shape is a `tiberius_messages: Vec<String>` field
        // on `ExplainResult` populated by capturing `Token::Info` in
        // `run_capturing_all_sets`.
        let trimmed = sql.trim_end_matches(&[' ', '\t', '\n', '\r', ';'][..]);

        let start = Instant::now();
        let (sets, expect_data) = if analyze {
            let wrapped = format!(
                "SET STATISTICS XML ON; {trimmed}; SET STATISTICS XML OFF;"
            );
            (run_capturing_all_sets(&mut conn, &wrapped).await?, true)
        } else {
            // Toggle SHOWPLAN_XML in its own batch; tiberius's
            // `simple_query` is one batch per call.
            conn.simple_query("SET SHOWPLAN_XML ON")
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            // The query batch is now redirected — output is the
            // estimated plan XML, not row data.
            let plan_sets = run_capturing_all_sets(&mut conn, trimmed).await;
            // Always turn it back off, even on error, so the session
            // doesn't stay wedged in plan-emit mode for follow-up
            // queries on this connection.
            let _ = conn.simple_query("SET SHOWPLAN_XML OFF").await;
            (plan_sets?, false)
        };
        let duration_ms = start.elapsed().as_millis() as u64;

        // Pull the *last* plan + the *last* data set: matches what
        // the user clicked Run on if they batched several
        // statements.
        let mut plan: Option<String> = None;
        let mut data: Option<QueryResult> = None;
        for set in sets.into_iter() {
            if is_showplan_set(&set) {
                if let Some(Cell::Text(s)) = set.rows.first().and_then(|r| r.first()) {
                    plan = Some(s.clone());
                }
            } else if expect_data && !set.columns.is_empty() {
                data = Some(set);
            }
        }

        let raw = plan.ok_or_else(|| {
            DbError::Query(if analyze {
                "STATISTICS XML did not return a Showplan result set".to_string()
            } else {
                "SHOWPLAN_XML did not return a plan result set".to_string()
            })
        })?;

        Ok(ExplainResult {
            format: ExplainFormat::Xml,
            raw,
            statement: sql.to_string(),
            duration_ms,
            data,
        })
    }

    async fn execute_batch(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        statements: &[&str],
    ) -> DbResult<Vec<QueryResult>> {
        self.execute_batch_with_options(database, schema, statements, &ExecuteOptions::default())
            .await
    }

    async fn execute_batch_with_options(
        &self,
        database: Option<&str>,
        _schema: Option<&str>,
        statements: &[&str],
        options: &ExecuteOptions,
    ) -> DbResult<Vec<QueryResult>> {
        // Pin one pool connection for the whole batch. This is
        // load-bearing for transaction semantics: `BEGIN TRAN; …;
        // COMMIT;` only works if every statement lands on the
        // same TDS session. Calling `self.execute(sql)` per
        // statement would let bb8 hand out different connections
        // and silently break user transactions.
        //
        // The pool's `test_on_check_out(true)` setting (see
        // `connect`) doubles as the sleep/wake guard — `acquire`
        // pings before handing us the connection, and bb8 swaps
        // out a stale entry transparently. So no manual
        // ensure-alive probe is needed any more.
        let mut conn = self.acquire().await?;

        if let Some(db) = database {
            let stmt = format!("USE [{}]", escape_ident(db));
            conn.simple_query(stmt)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
        }

        // For lock telemetry: capture @@SPID on the pinned
        // connection. The SPID belongs to this specific TDS
        // session — every statement in the batch runs on this
        // same session, so the sampler can filter
        // `sys.dm_tran_locks WHERE request_session_id = <spid>`
        // and reliably observe locks held by this batch.
        let spid: Option<i32> = if options.capture_locks {
            match capture_spid(&mut conn).await {
                Ok(s) => Some(s),
                Err(e) => {
                    tracing::warn!(?e, "lock-sampler: @@SPID capture failed");
                    None
                }
            }
        } else {
            None
        };
        let interval_ms = options
            .lock_sample_interval_ms
            .unwrap_or(DEFAULT_SAMPLE_INTERVAL_MS);

        // **Batch-wide sampler** (was: one sampler per statement).
        //
        // Why one sampler for the whole batch? Multi-statement
        // transactions like
        //   `BEGIN TRAN; UPDATE …; WAITFOR DELAY 0.4; ROLLBACK;`
        // hold the UPDATE's row lock from the moment UPDATE runs
        // until ROLLBACK. With per-statement sampling, that lock
        // showed up on the WAITFOR tab (because that's the
        // statement that lasted long enough for the sampler to
        // tick) — leaving the UPDATE tab "empty" and forcing the
        // user to click around to find their locks.
        //
        // Running ONE sampler across the entire batch produces a
        // single timeline that covers BEGIN → UPDATE → WAITFOR →
        // ROLLBACK end-to-end. We attach the resulting summary to
        // the FIRST result tab, which the UI auto-selects on Run.
        // So: drag-select a transaction block, hit Run with locks,
        // land on tab 0, see the entire batch's lock timeline. No
        // tab-juggling, no `sp_executesql` hack.
        let sampler = spid.map(|s| {
            MsSqlLockSampler::start(self.cfg.clone(), s, interval_ms)
        });

        let mut out = Vec::with_capacity(statements.len());
        for sql in statements {
            // `execute_on` runs the statement on the pinned
            // connection — NOT on a fresh pool checkout —
            // preserving session state (transactions, USE, SET).
            let result = execute_on(&mut conn, sql).await?;
            out.push(result);
        }

        // Stop the sampler now that every statement has run, and
        // attach the aggregated summary to results[0]. Other
        // result tabs leave `locks = None` so the LocksView
        // sub-tab only renders on tab 0.
        if let Some(s) = sampler {
            let summary = s.stop().await;
            if let Some(first) = out.first_mut() {
                first.locks = Some(summary);
            }
        } else if options.capture_locks {
            if let Some(first) = out.first_mut() {
                first.locks = Some(LockSummary::unavailable(
                    interval_ms,
                    "could not capture @@SPID",
                ));
            }
        }

        Ok(out)
    }

    async fn execute(&self, sql: &str) -> DbResult<QueryResult> {
        // Standalone single-statement path — fresh pool checkout,
        // no session state to preserve. `execute_batch_with_options`
        // is what user-visible Run goes through; this method is
        // only used for ad-hoc one-shots (registry::execute and
        // similar test paths).
        let mut conn = self.acquire().await?;
        execute_on(&mut conn, sql).await
    }
}

/// Run one tiberius statement on the given client, materialise
/// the result into a `QueryResult`. Pulled out of the trait
/// `execute` impl so `execute_batch_with_options` can call it on
/// the **pinned** pool connection rather than `self.execute()`,
/// which would acquire a fresh checkout each call and lose
/// transaction state.
async fn execute_on(client: &mut MsClient, sql: &str) -> DbResult<QueryResult> {
        let start = Instant::now();
        let mut stream = client
            .simple_query(sql.to_string())
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;

        let mut columns: Vec<Column> = Vec::new();
        let mut rows: Vec<Vec<Cell>> = Vec::new();

        while let Some(item) = stream
            .try_next()
            .await
            .map_err(|e| DbError::Query(e.to_string()))?
        {
            match item {
                QueryItem::Metadata(meta) => {
                    if columns.is_empty() {
                        columns = meta
                            .columns()
                            .iter()
                            .map(|c| Column {
                                name: c.name().to_string(),
                                type_name: format!("{:?}", c.column_type()),
                            })
                            .collect();
                    }
                }
                QueryItem::Row(row) => {
                    let mut cells = Vec::with_capacity(row.len());
                    for col_data in row.into_iter() {
                        cells.push(decode_cell(&col_data));
                    }
                    rows.push(cells);
                }
            }
        }

        // tiberius's `simple_query` does not surface a unified
        // `rows_affected` count across all batches in v0.12; for v1 we
        // report None for mutations and let the UI badge "OK" when a
        // statement returns no rows. v2 will switch to `query` for
        // mutations to capture the count.
        Ok(QueryResult {
            statement: sql.to_string(),
            columns,
            rows,
            rows_affected: None,
            duration_ms: start.elapsed().as_millis() as u64,
            locks: None,
        })
}

/// Pull `@@SPID` off the user session. Used by the lock sampler so
/// the sidecar observer connection can scope `sys.dm_tran_locks`
/// down to the session running the user statement.
async fn capture_spid(client: &mut MsClient) -> DbResult<i32> {
    let mut stream = client
        .simple_query("SELECT @@SPID AS spid".to_string())
        .await
        .map_err(|e| DbError::Query(e.to_string()))?;
    while let Some(item) = stream
        .try_next()
        .await
        .map_err(|e| DbError::Query(e.to_string()))?
    {
        if let QueryItem::Row(row) = item {
            // @@SPID is a `smallint` in T-SQL; tiberius ships it as i16.
            if let Some(v) = row.try_get::<i16, _>(0).ok().flatten() {
                return Ok(v as i32);
            }
        }
    }
    Err(DbError::Query("@@SPID returned no row".into()))
}

async fn run_string_column(
    client: &mut MsClient,
    sql: &str,
    col: &str,
) -> DbResult<Vec<String>> {
    let mut stream = client
        .simple_query(sql.to_string())
        .await
        .map_err(|e| DbError::Query(e.to_string()))?;
    let mut out = Vec::new();
    while let Some(item) = stream
        .try_next()
        .await
        .map_err(|e| DbError::Query(e.to_string()))?
    {
        if let QueryItem::Row(row) = item {
            if let Some(v) = row.try_get::<&str, _>(col).ok().flatten() {
                out.push(v.to_string());
            }
        }
    }
    Ok(out)
}

fn escape_ident(s: &str) -> String {
    s.replace(']', "]]")
}

/// Render an MSSQL `INFORMATION_SCHEMA.COLUMNS` row into a tooltip-ready
/// type string, e.g. `varchar(64)`, `decimal(10,2)`. Width is appended
/// only for types that actually carry one.
fn format_mssql_type(
    base: &str,
    char_max: Option<i32>,
    num_prec: Option<u8>,
    num_scale: Option<i32>,
) -> String {
    let lower = base.to_ascii_lowercase();
    match lower.as_str() {
        "char" | "varchar" | "nchar" | "nvarchar" | "binary" | "varbinary" => match char_max {
            Some(n) if n < 0 => format!("{base}(max)"),
            Some(n) => format!("{base}({n})"),
            None => base.to_string(),
        },
        "decimal" | "numeric" => match (num_prec, num_scale) {
            (Some(p), Some(s)) => format!("{base}({p},{s})"),
            (Some(p), None) => format!("{base}({p})"),
            _ => base.to_string(),
        },
        _ => base.to_string(),
    }
}

fn decode_cell(col: &ColumnData<'_>) -> Cell {
    match col {
        ColumnData::Bit(Some(v)) => Cell::Bool(*v),
        ColumnData::U8(Some(v)) => Cell::Integer(*v as i64),
        ColumnData::I16(Some(v)) => Cell::Integer(*v as i64),
        ColumnData::I32(Some(v)) => Cell::Integer(*v as i64),
        ColumnData::I64(Some(v)) => Cell::Integer(*v),
        ColumnData::F32(Some(v)) => Cell::Float(*v as f64),
        ColumnData::F64(Some(v)) => Cell::Float(*v),
        ColumnData::String(Some(v)) => Cell::Text(v.to_string()),
        ColumnData::Guid(Some(v)) => Cell::Text(v.to_string()),
        ColumnData::Numeric(Some(v)) => Cell::Text(format_numeric(v)),
        ColumnData::Binary(Some(v)) => Cell::Text(format!("0x{}", short_hex(v))),
        ColumnData::DateTime(v) => match v {
            Some(d) => Cell::Text(format!("{:?}", d)),
            None => Cell::Null,
        },
        ColumnData::SmallDateTime(v) => match v {
            Some(d) => Cell::Text(format!("{:?}", d)),
            None => Cell::Null,
        },
        ColumnData::Time(v) => match v {
            Some(d) => Cell::Text(format!("{:?}", d)),
            None => Cell::Null,
        },
        ColumnData::Date(v) => match v {
            Some(d) => Cell::Text(format!("{:?}", d)),
            None => Cell::Null,
        },
        ColumnData::DateTime2(v) => match v {
            Some(d) => Cell::Text(format!("{:?}", d)),
            None => Cell::Null,
        },
        ColumnData::DateTimeOffset(v) => match v {
            Some(d) => Cell::Text(format!("{:?}", d)),
            None => Cell::Null,
        },
        ColumnData::Xml(Some(v)) => Cell::Text(v.to_string()),
        // Any None variant is SQL NULL.
        ColumnData::U8(None)
        | ColumnData::I16(None)
        | ColumnData::I32(None)
        | ColumnData::I64(None)
        | ColumnData::F32(None)
        | ColumnData::F64(None)
        | ColumnData::Bit(None)
        | ColumnData::String(None)
        | ColumnData::Guid(None)
        | ColumnData::Numeric(None)
        | ColumnData::Binary(None)
        | ColumnData::Xml(None) => Cell::Null,
    }
}

fn format_numeric(n: &Numeric) -> String {
    // Numeric Display gives a decimal string.
    n.to_string()
}

fn short_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    const MAX: usize = 64;
    let take = bytes.len().min(MAX);
    let mut s = String::with_capacity(take * 2 + 4);
    for b in &bytes[..take] {
        let _ = write!(s, "{:02x}", b);
    }
    if bytes.len() > MAX {
        s.push_str("...");
    }
    s
}

// tiberius's QueryStream doesn't implement futures::TryStreamExt directly
// in the public re-exports; pull it in via the futures crate.
use futures::TryStreamExt;

/// Group a flat `(name, kc_type, column, ordinal)` row stream into
/// `KeyDescription`s. `kc_type` is the trimmed `sys.key_constraints.type`
/// — `"PK"` for primary keys, `"UQ"` for unique constraints. Within a
/// group, ordinal is monotonic so ordering is preserved.
fn collapse_keys(rows: Vec<(String, String, String, i32)>) -> Vec<KeyDescription> {
    let mut out: Vec<KeyDescription> = Vec::new();
    for (name, kc_type, col, _ord) in rows {
        if let Some(last) = out.last_mut() {
            if last.name == name {
                last.columns.push(col);
                continue;
            }
        }
        out.push(KeyDescription {
            name,
            columns: vec![col],
            is_primary: kc_type.trim().eq_ignore_ascii_case("PK"),
        });
    }
    out
}

/// Group a flat FK row stream
/// `(name, col, ref_schema, ref_table, ref_col, ord)` into
/// `ForeignKeyDescription`s. Multi-column FKs naturally consolidate
/// because the query orders by `(name, ord)`.
fn collapse_foreign_keys(
    rows: Vec<(String, String, String, String, String, i32)>,
) -> Vec<ForeignKeyDescription> {
    let mut out: Vec<ForeignKeyDescription> = Vec::new();
    for (name, col, ref_schema, ref_table, ref_col, _ord) in rows {
        if let Some(last) = out.last_mut() {
            if last.name == name {
                last.columns.push(col);
                last.referenced_columns.push(ref_col);
                continue;
            }
        }
        out.push(ForeignKeyDescription {
            name,
            columns: vec![col],
            referenced_schema: ref_schema,
            referenced_table: ref_table,
            referenced_columns: vec![ref_col],
        });
    }
    out
}

/// Run a multi-result-set batch and capture every result set into a
/// `Vec<QueryResult>`. Used by `explain_query` to receive the
/// `STATISTICS XML` ShowPlan row as a separate set after the actual
/// data. The base `execute()` path collapses everything into one
/// columns/rows pair, which is fine for normal queries but loses
/// ShowPlan information.
async fn run_capturing_all_sets(
    client: &mut MsClient,
    sql: &str,
) -> DbResult<Vec<QueryResult>> {
    let mut stream = client
        .simple_query(sql.to_string())
        .await
        .map_err(|e| DbError::Query(e.to_string()))?;

    let mut sets: Vec<QueryResult> = Vec::new();
    let mut cur_columns: Vec<Column> = Vec::new();
    let mut cur_rows: Vec<Vec<Cell>> = Vec::new();
    let mut have_set = false;

    let flush = |sets: &mut Vec<QueryResult>,
                 columns: &mut Vec<Column>,
                 rows: &mut Vec<Vec<Cell>>| {
        sets.push(QueryResult {
            statement: String::new(),
            columns: std::mem::take(columns),
            rows: std::mem::take(rows),
            rows_affected: None,
            duration_ms: 0,
            locks: None,
        });
    };

    while let Some(item) = stream
        .try_next()
        .await
        .map_err(|e| DbError::Query(e.to_string()))?
    {
        match item {
            QueryItem::Metadata(meta) => {
                if have_set {
                    flush(&mut sets, &mut cur_columns, &mut cur_rows);
                }
                cur_columns = meta
                    .columns()
                    .iter()
                    .map(|c| Column {
                        name: c.name().to_string(),
                        type_name: format!("{:?}", c.column_type()),
                    })
                    .collect();
                cur_rows = Vec::new();
                have_set = true;
            }
            QueryItem::Row(row) => {
                let mut cells = Vec::with_capacity(row.len());
                for col_data in row.into_iter() {
                    cells.push(decode_cell(&col_data));
                }
                cur_rows.push(cells);
            }
        }
    }

    if have_set {
        flush(&mut sets, &mut cur_columns, &mut cur_rows);
    }

    Ok(sets)
}

/// Whether a `QueryResult` looks like the single-cell ShowPlan row
/// that `SET STATISTICS XML ON` injects after each SELECT. tiberius
/// reports the column name as
/// `"Microsoft SQL Server * XML Showplan"`; we match on the trailing
/// "Showplan" substring so future SQL Server versions don't break
/// the detection.
fn is_showplan_set(set: &QueryResult) -> bool {
    set.columns.len() == 1
        && set
            .columns
            .first()
            .map(|c| c.name.contains("Showplan"))
            .unwrap_or(false)
}

/// Group a flat index row stream `(name, is_unique, column, ordinal)`
/// into `IndexDescription`s.
fn collapse_indexes(rows: Vec<(String, bool, String, i32)>) -> Vec<IndexDescription> {
    let mut out: Vec<IndexDescription> = Vec::new();
    for (name, is_unique, col, _ord) in rows {
        if let Some(last) = out.last_mut() {
            if last.name == name {
                last.columns.push(col);
                continue;
            }
        }
        out.push(IndexDescription {
            name,
            columns: vec![col],
            is_unique,
            is_primary: false,
        });
    }
    out
}

/// Strip Microsoft-style protocol prefix / port suffix from a host
/// string and return `(host, port)`. Handles the two flavours users
/// most commonly paste from the Azure portal / SSMS:
///
///   * `myserver.database.windows.net,1433`  →  `("myserver…", 1433)`
///   * `tcp:myserver.database.windows.net,1433` →  same
///   * plain `myserver.database.windows.net` (no comma) →
///     `("myserver…", default_port)`
///
/// `default_port` is the form-side port the user already typed (or 1433
/// from the UI default); we only override when an embedded port is
/// present AND the form-side port is still the default — that way users
/// who explicitly typed a different port in the port field don't get
/// overridden by a stale comma in the host field.
fn parse_host_port(raw: &str, default_port: u16) -> (String, u16) {
    let mut s = raw.trim();
    // Strip `tcp:` (case-insensitive) — Microsoft's protocol marker.
    if s.len() >= 4 && s[..4].eq_ignore_ascii_case("tcp:") {
        s = &s[4..];
    }
    if let Some((host, port_str)) = s.split_once(',') {
        // A comma is not legal in a DNS hostname, so whatever follows
        // it is unambiguously a port-attempt regardless of whether it
        // parses. We always strip it before handing the host to
        // tiberius — passing `myserver,garbage` straight through would
        // just give a confusing DNS lookup failure.
        let host = host.trim().to_string();
        if let Ok(p) = port_str.trim().parse::<u16>() {
            // Adopt the embedded port only if the UI form is still on
            // the default (1433). Anything else is an explicit user
            // choice we mustn't override.
            let port = if default_port == 1433 { p } else { default_port };
            return (host, port);
        }
        return (host, default_port);
    }
    (s.to_string(), default_port)
}

/// Render a chained error (e.g. `bb8::RunError` wrapping a
/// `tiberius::Error`) as a human-readable string that includes every
/// cause level. `bb8::RunError`'s own `Display` impl truncates to just
/// the outer message — useless for diagnosing Azure SQL failures
/// where the actual reason ("Login failed for user 'foo'",
/// "certificate verification failed: invalid issuer", "tcp connect:
/// timed out") only shows up two or three levels deep in the chain.
fn format_error_chain<E: std::error::Error>(err: &E) -> String {
    let mut out = err.to_string();
    let mut src: Option<&dyn std::error::Error> = err.source();
    while let Some(s) = src {
        let msg = s.to_string();
        // Avoid duplicating the same string when bb8 / tiberius wrap
        // an error whose Display matches the outer.
        if !out.contains(&msg) {
            out.push_str(": ");
            out.push_str(&msg);
        }
        src = s.source();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::parse_host_port;

    #[test]
    fn plain_host_keeps_default_port() {
        assert_eq!(
            parse_host_port("myserver.database.windows.net", 1433),
            ("myserver.database.windows.net".to_string(), 1433),
        );
    }

    #[test]
    fn comma_port_suffix_is_extracted() {
        assert_eq!(
            parse_host_port("myserver.database.windows.net,1433", 1433),
            ("myserver.database.windows.net".to_string(), 1433),
        );
    }

    #[test]
    fn tcp_prefix_is_stripped() {
        assert_eq!(
            parse_host_port("tcp:myserver.database.windows.net,1433", 1433),
            ("myserver.database.windows.net".to_string(), 1433),
        );
    }

    #[test]
    fn explicit_form_port_wins_over_embedded() {
        // User typed 1500 in the port field — don't override with the
        // 1433 they pasted into the host field.
        assert_eq!(
            parse_host_port("myserver.example.com,1433", 1500),
            ("myserver.example.com".to_string(), 1500),
        );
    }

    #[test]
    fn embedded_port_overrides_default_only() {
        // Form-side port is the default (1433), embedded is non-default.
        assert_eq!(
            parse_host_port("myserver.example.com,2433", 1433),
            ("myserver.example.com".to_string(), 2433),
        );
    }

    #[test]
    fn malformed_port_falls_back_to_default() {
        assert_eq!(
            parse_host_port("myserver,not-a-number", 1433),
            ("myserver".to_string(), 1433),
        );
    }

    #[test]
    fn whitespace_is_trimmed() {
        assert_eq!(
            parse_host_port("  myserver.example.com , 1433 ", 1433),
            ("myserver.example.com".to_string(), 1433),
        );
    }
}
