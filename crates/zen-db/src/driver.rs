//! Driver trait + error type.

use async_trait::async_trait;
use thiserror::Error;

use crate::types::{
    ExecuteOptions, ExplainResult, QueryResult, RoutineDescription, TableDescription, TableSummary,
};

#[derive(Debug, Error)]
pub enum DbError {
    #[error("connect: {0}")]
    Connect(String),

    #[error("query: {0}")]
    Query(String),

    #[error("driver not supported: {0}")]
    Unsupported(String),

    #[error("connection not found: {0}")]
    NotFound(String),

    #[error("keyring: {0}")]
    Keyring(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("schema cache: {0}")]
    SchemaCache(String),

    #[error("storage: {0}")]
    Storage(#[from] zen_storage::StorageError),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

pub type DbResult<T> = Result<T, DbError>;

/// One open connection to a database. Implementations are expected to be
/// `Send + Sync` and to be wrapped in a per-entry mutex inside the
/// [`crate::ConnectionRegistry`].
#[async_trait]
pub trait DbConnection: Send + Sync {
    /// Cheap round-trip — used by the "Test connection" button.
    async fn ping(&mut self) -> DbResult<()>;

    /// Top-level catalogues / databases visible to this connection.
    async fn list_databases(&mut self) -> DbResult<Vec<String>>;

    /// Schemas in the given database. Postgres respects the current
    /// database (cross-database queries are rare); MSSQL switches `USE`.
    async fn list_schemas(&mut self, database: &str) -> DbResult<Vec<String>>;

    /// Tables (and views) in `database.schema`.
    async fn list_tables(&mut self, database: &str, schema: &str) -> DbResult<Vec<String>>;

    /// Every relation (table or view) visible in `database`, grouped by
    /// schema. Single round-trip — used by the SQL editor's autocomplete
    /// to seed schema + qualified-table completions cold, without one
    /// `list_tables` call per schema.
    async fn list_all_tables(&mut self, database: &str) -> DbResult<Vec<TableSummary>>;

    /// Describe a single table: columns + keys + foreign keys +
    /// indexes + checks + triggers. Drivers fill what they cheaply can;
    /// the shape is stable so the cache payload survives later
    /// upgrades.
    async fn describe_table(
        &mut self,
        database: &str,
        schema: &str,
        table: &str,
    ) -> DbResult<TableDescription>;

    /// List stored procedures + functions in `database.schema`. Used
    /// by the DB-tree's per-schema "Routines" folder. Session-only on
    /// the front-end (not persisted in `schema_cache.db`) since the
    /// query is one round-trip and the results churn alongside
    /// migrations.
    async fn list_routines(
        &mut self,
        database: &str,
        schema: &str,
    ) -> DbResult<Vec<RoutineDescription>>;

    /// Execute a single SQL statement and materialise the result.
    async fn execute(&mut self, sql: &str) -> DbResult<QueryResult>;

    /// Run the user query through the dialect-appropriate
    /// "execute + explain" path and return the captured plan.
    ///
    /// `analyze`:
    /// - `true`  — actually execute the query and capture per-node
    ///   actual rows + timing + buffer counts (Postgres
    ///   `EXPLAIN (… ANALYZE, BUFFERS, TIMING …)`, MSSQL
    ///   `SET STATISTICS XML ON`). **Side effects happen** — DML
    ///   statements modify data unless wrapped in a transaction.
    /// - `false` — plan-only mode. Postgres `EXPLAIN (FORMAT JSON,
    ///   VERBOSE)`; MSSQL `SET SHOWPLAN_XML ON`. No execution, no
    ///   actual rows, no timing — just the planner's estimates.
    ///   Safe for destructive statements.
    ///
    /// Used by the `db_explain_query` Tauri command for the
    /// performance-visualizer "Run with plan" path.
    async fn explain_query(
        &mut self,
        database: Option<&str>,
        schema: Option<&str>,
        sql: &str,
        analyze: bool,
    ) -> DbResult<ExplainResult>;

    /// Execute a sequence of statements with optional session context.
    ///
    /// Implementations **must** keep every statement (and the context
    /// set-up) on a single physical connection, otherwise session state
    /// like Postgres' `search_path` doesn't survive between calls.
    ///
    /// - Postgres: `schema` becomes the head of `search_path`. `database`
    ///   is ignored (sqlx connections are bound to one DB).
    /// - MSSQL: `database` triggers `USE [db]`. `schema` is ignored —
    ///   T-SQL doesn't have a session-level schema, callers qualify.
    async fn execute_batch(
        &mut self,
        database: Option<&str>,
        schema: Option<&str>,
        statements: &[&str],
    ) -> DbResult<Vec<QueryResult>>;

    /// Like [`Self::execute_batch`], plus optional sidecar lock
    /// telemetry. With [`ExecuteOptions::capture_locks`] off, this
    /// is identical to `execute_batch` (zero overhead). With it
    /// on, the driver opens a fresh observer connection against
    /// the same database, captures the executing session's
    /// PID/SPID, polls the engine's lock catalogue for the
    /// duration of each statement, and attaches an aggregated
    /// [`crate::LockSummary`] to the matching `QueryResult`.
    ///
    /// Default impl ignores the options and forwards to
    /// `execute_batch`, so drivers without lock support are fine
    /// not to override this method.
    async fn execute_batch_with_options(
        &mut self,
        database: Option<&str>,
        schema: Option<&str>,
        statements: &[&str],
        options: &ExecuteOptions,
    ) -> DbResult<Vec<QueryResult>> {
        let _ = options;
        self.execute_batch(database, schema, statements).await
    }
}
