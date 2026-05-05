//! Live connection registry.
//!
//! `DashMap` keeps per-key locking cheap. Each entry is a plain
//! `Arc<dyn DbConnection>`: the trait methods all take `&self` and the
//! drivers are internally pool-backed (sqlx + bb8-tiberius), so
//! concurrent calls multiplex over the pool's slots without contending
//! on a registry-level mutex. That's what lets schema indexing,
//! autocomplete fetches, and user queries run in parallel against the
//! same registered connection id.
//!
//! ## Cancellation
//!
//! Long-running user queries can be cancelled by the front-end via the
//! `db_cancel_query` Tauri command. The registry maintains a parallel
//! `cancellation: DashMap<query_id, CancellationToken>` map; every
//! `execute_batch_with_query_id` call registers a fresh token, races
//! the underlying driver future against `token.cancelled()`, and
//! removes the token on completion. Dropping the future also drops
//! the underlying sqlx/tiberius work — sqlx sends a `CancelRequest`
//! on the network; tiberius drops the in-flight stream so the next
//! pool checkout reaps the dead session.

use std::sync::Arc;

use dashmap::DashMap;
use tokio_util::sync::CancellationToken;

use crate::driver::{DbConnection, DbError, DbResult};
use crate::mssql::MsSqlConnection;
use crate::postgres::PostgresConnection;
use crate::types::{
    ConnectionConfig, DbDriver, ExecuteOptions, ExplainResult, QueryResult, RoutineDescription,
    TableDescription, TableSummary,
};

type Slot = Arc<dyn DbConnection>;

#[derive(Default)]
pub struct ConnectionRegistry {
    connections: DashMap<String, Slot>,
    /// Live cancellation tokens keyed by `query_id` (any opaque
    /// identifier the front-end mints when it dispatches the run).
    /// Callers are expected to register a token before awaiting the
    /// driver future and remove it on completion / cancellation.
    cancellation: DashMap<String, CancellationToken>,
}

impl ConnectionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open a fresh connection and register it under `config.id`. If an
    /// entry already exists it is replaced (the old one is dropped).
    pub async fn connect(&self, config: ConnectionConfig) -> DbResult<()> {
        let id = config.id.clone();
        let conn: Arc<dyn DbConnection> = match config.driver {
            DbDriver::Postgres => Arc::new(PostgresConnection::connect(config).await?),
            DbDriver::MsSql => Arc::new(MsSqlConnection::connect(config).await?),
        };
        self.connections.insert(id, conn);
        Ok(())
    }

    /// One-shot connectivity check. Does not register anything.
    pub async fn test(config: ConnectionConfig) -> DbResult<()> {
        match config.driver {
            DbDriver::Postgres => {
                let c = PostgresConnection::connect(config).await?;
                c.ping().await
            }
            DbDriver::MsSql => {
                let c = MsSqlConnection::connect(config).await?;
                c.ping().await
            }
        }
    }

    pub fn disconnect(&self, id: &str) {
        self.connections.remove(id);
    }

    pub fn contains(&self, id: &str) -> bool {
        self.connections.contains_key(id)
    }

    fn slot(&self, id: &str) -> DbResult<Slot> {
        self.connections
            .get(id)
            .map(|r| r.value().clone())
            .ok_or_else(|| DbError::NotFound(id.to_string()))
    }

    pub async fn list_databases(&self, id: &str) -> DbResult<Vec<String>> {
        let slot = self.slot(id)?;
        slot.list_databases().await
    }

    pub async fn list_schemas(&self, id: &str, database: &str) -> DbResult<Vec<String>> {
        let slot = self.slot(id)?;
        slot.list_schemas(database).await
    }

    pub async fn list_tables(&self, id: &str, database: &str, schema: &str) -> DbResult<Vec<String>> {
        let slot = self.slot(id)?;
        slot.list_tables(database, schema).await
    }

    /// Single round-trip catalog dump used by the SQL editor's
    /// autocomplete to seed completions cold (no per-schema fan-out).
    pub async fn list_all_tables(
        &self,
        id: &str,
        database: &str,
    ) -> DbResult<Vec<TableSummary>> {
        let slot = self.slot(id)?;
        slot.list_all_tables(database).await
    }

    /// Fetch a single `TableDescription` from the live connection. The
    /// caller is responsible for caching — the registry just dispatches.
    pub async fn describe_table(
        &self,
        id: &str,
        database: &str,
        schema: &str,
        table: &str,
    ) -> DbResult<TableDescription> {
        let slot = self.slot(id)?;
        slot.describe_table(database, schema, table).await
    }

    /// Stored procedures + functions in `database.schema`. Single
    /// round-trip; not cached at the registry level (front-end keeps
    /// a session-scoped Map).
    pub async fn list_routines(
        &self,
        id: &str,
        database: &str,
        schema: &str,
    ) -> DbResult<Vec<RoutineDescription>> {
        let slot = self.slot(id)?;
        slot.list_routines(database, schema).await
    }

    pub async fn execute(&self, id: &str, sql: &str) -> DbResult<QueryResult> {
        let slot = self.slot(id)?;
        slot.execute(sql).await
    }

    /// Run the user query through the dialect's "execute + explain"
    /// path and return the captured plan. See
    /// [`crate::DbConnection::explain_query`] for the per-driver
    /// behaviour.
    pub async fn explain_query(
        &self,
        id: &str,
        database: Option<&str>,
        schema: Option<&str>,
        sql: &str,
        analyze: bool,
    ) -> DbResult<ExplainResult> {
        let slot = self.slot(id)?;
        slot.explain_query(database, schema, sql, analyze).await
    }

    /// Run a sequence of statements with optional database/schema
    /// context. The driver is responsible for pinning everything to a
    /// single physical connection so session state (`SET search_path`,
    /// `USE [db]`) actually takes effect.
    pub async fn execute_batch(
        &self,
        id: &str,
        database: Option<&str>,
        schema: Option<&str>,
        statements: &[&str],
    ) -> DbResult<Vec<QueryResult>> {
        let slot = self.slot(id)?;
        slot.execute_batch(database, schema, statements).await
    }

    /// `execute_batch` with side-channel knobs (currently: per-query
    /// lock telemetry capture). Drives the "Run with locks" UI path.
    pub async fn execute_batch_with_options(
        &self,
        id: &str,
        database: Option<&str>,
        schema: Option<&str>,
        statements: &[&str],
        options: &ExecuteOptions,
    ) -> DbResult<Vec<QueryResult>> {
        let slot = self.slot(id)?;
        slot
            .execute_batch_with_options(database, schema, statements, options)
            .await
    }

    /// Cancellable variant of [`Self::execute_batch_with_options`].
    ///
    /// `query_id` is an opaque identifier minted by the caller (the UI
    /// generates a UUID per Run). The registry registers a fresh
    /// `CancellationToken` under that id, races the driver future
    /// against the token's `cancelled()` future, and clears the
    /// registration on completion. While the query is running, any
    /// thread can call [`Self::cancel`] with the same id to abort it.
    ///
    /// Returns `Err(DbError::Cancelled)` when the token fires before
    /// the driver completes. Otherwise returns the driver's verdict
    /// verbatim.
    pub async fn execute_batch_cancellable(
        &self,
        id: &str,
        query_id: &str,
        database: Option<&str>,
        schema: Option<&str>,
        statements: &[&str],
        options: &ExecuteOptions,
    ) -> DbResult<Vec<QueryResult>> {
        let slot = self.slot(id)?;
        let token = CancellationToken::new();
        // Replace any earlier registration under the same id so a
        // re-used query_id (front-end bug) can't leave a dangling token.
        self.cancellation
            .insert(query_id.to_string(), token.clone());

        // Defer cleanup so we always remove the registration — even
        // on panic.
        struct Cleanup<'a> {
            map: &'a DashMap<String, CancellationToken>,
            id: String,
        }
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                self.map.remove(&self.id);
            }
        }
        let _cleanup = Cleanup {
            map: &self.cancellation,
            id: query_id.to_string(),
        };

        let fut = slot.execute_batch_with_options(database, schema, statements, options);
        tokio::select! {
            biased;
            _ = token.cancelled() => Err(DbError::Cancelled),
            result = fut => result,
        }
    }

    /// Fire the cancellation token registered for `query_id`, if any.
    /// Returns `true` if a token was found and cancelled.
    ///
    /// Idempotent: cancelling a finished or never-started query is a
    /// no-op.
    pub fn cancel(&self, query_id: &str) -> bool {
        if let Some((_, token)) = self.cancellation.remove(query_id) {
            token.cancel();
            true
        } else {
            false
        }
    }
}
