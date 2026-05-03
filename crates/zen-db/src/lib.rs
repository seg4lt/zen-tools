//! zen-db — driver-agnostic database abstraction used by the Database
//! Explorer tool.
//!
//! Two drivers are supported in v1: Postgres (via `sqlx`) and MSSQL (via
//! `tiberius`). Each implements the [`DbConnection`] trait. A
//! [`ConnectionRegistry`] keeps live connections keyed by a UUID minted by
//! the front-end. Passwords never live in user-readable preferences — they
//! are stored in the OS keychain via the [`secrets`] module.

pub mod driver;
pub mod locks;
pub mod mssql;
pub mod postgres;
pub mod registry;
pub mod schema_cache;
pub mod secrets;
pub mod sql;
pub mod types;

pub use driver::{DbConnection, DbError, DbResult};
pub use registry::ConnectionRegistry;
pub use schema_cache::{now_ms, CachedTable, CachedTableMeta, SchemaCache, DEFAULT_TTL_MS};
pub use sql::split_statements;
pub use types::{
    BlockerInfo, Cell, CheckDescription, Column, ColumnDescription, ConnectionConfig, DbDriver,
    ExecuteOptions, ExplainFormat, ExplainResult, ForeignKeyDescription, IndexDescription,
    KeyDescription, LockGranularity, LockSample, LockSummary, ObjectLockRow, QueryResult,
    RoutineDescription, RoutineKind, TableDescription, TableKind, TableSummary, TriggerDescription,
};
