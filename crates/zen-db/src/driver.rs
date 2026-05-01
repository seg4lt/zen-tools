//! Driver trait + error type.

use async_trait::async_trait;
use thiserror::Error;

use crate::types::QueryResult;

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

    /// Execute a single SQL statement and materialise the result.
    async fn execute(&mut self, sql: &str) -> DbResult<QueryResult>;

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
}
