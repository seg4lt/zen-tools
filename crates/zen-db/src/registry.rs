//! Live connection registry.
//!
//! `DashMap` keeps per-key locking cheap. Each entry is wrapped in a
//! `tokio::sync::Mutex` so a slow query on one connection doesn't block
//! sidebar lookups on another.

use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::Mutex;

use crate::driver::{DbConnection, DbError, DbResult};
use crate::mssql::MsSqlConnection;
use crate::postgres::PostgresConnection;
use crate::types::{
    ConnectionConfig, DbDriver, QueryResult, RoutineDescription, TableDescription, TableSummary,
};

type Slot = Arc<Mutex<Box<dyn DbConnection>>>;

#[derive(Default)]
pub struct ConnectionRegistry {
    connections: DashMap<String, Slot>,
}

impl ConnectionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open a fresh connection and register it under `config.id`. If an
    /// entry already exists it is replaced (the old one is dropped).
    pub async fn connect(&self, config: ConnectionConfig) -> DbResult<()> {
        let id = config.id.clone();
        let conn: Box<dyn DbConnection> = match config.driver {
            DbDriver::Postgres => Box::new(PostgresConnection::connect(config).await?),
            DbDriver::MsSql => Box::new(MsSqlConnection::connect(config).await?),
        };
        self.connections.insert(id, Arc::new(Mutex::new(conn)));
        Ok(())
    }

    /// One-shot connectivity check. Does not register anything.
    pub async fn test(config: ConnectionConfig) -> DbResult<()> {
        match config.driver {
            DbDriver::Postgres => {
                let mut c = PostgresConnection::connect(config).await?;
                c.ping().await
            }
            DbDriver::MsSql => {
                let mut c = MsSqlConnection::connect(config).await?;
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
        let mut conn = slot.lock().await;
        conn.list_databases().await
    }

    pub async fn list_schemas(&self, id: &str, database: &str) -> DbResult<Vec<String>> {
        let slot = self.slot(id)?;
        let mut conn = slot.lock().await;
        conn.list_schemas(database).await
    }

    pub async fn list_tables(&self, id: &str, database: &str, schema: &str) -> DbResult<Vec<String>> {
        let slot = self.slot(id)?;
        let mut conn = slot.lock().await;
        conn.list_tables(database, schema).await
    }

    /// Single round-trip catalog dump used by the SQL editor's
    /// autocomplete to seed completions cold (no per-schema fan-out).
    pub async fn list_all_tables(
        &self,
        id: &str,
        database: &str,
    ) -> DbResult<Vec<TableSummary>> {
        let slot = self.slot(id)?;
        let mut conn = slot.lock().await;
        conn.list_all_tables(database).await
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
        let mut conn = slot.lock().await;
        conn.describe_table(database, schema, table).await
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
        let mut conn = slot.lock().await;
        conn.list_routines(database, schema).await
    }

    pub async fn execute(&self, id: &str, sql: &str) -> DbResult<QueryResult> {
        let slot = self.slot(id)?;
        let mut conn = slot.lock().await;
        conn.execute(sql).await
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
        let mut conn = slot.lock().await;
        conn.execute_batch(database, schema, statements).await
    }
}
