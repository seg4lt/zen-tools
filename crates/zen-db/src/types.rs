//! Wire types shared with the front-end.

use serde::{Deserialize, Serialize};

/// Which driver to use for a connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbDriver {
    Postgres,
    #[serde(alias = "mssql", alias = "sqlserver")]
    MsSql,
}

impl DbDriver {
    pub fn as_str(self) -> &'static str {
        match self {
            DbDriver::Postgres => "postgres",
            DbDriver::MsSql => "mssql",
        }
    }
}

/// Connection settings sent from the UI. `password` is transient; it is
/// loaded from the OS keychain on connect and is **never** persisted in
/// `preferences.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub driver: DbDriver,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// Disable TLS verification (mainly useful for the bundled MSSQL
    /// developer image which uses a self-signed cert).
    #[serde(default)]
    pub trust_server_certificate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    pub type_name: String,
}

/// A single result cell. Numeric / text / bool / null is enough for v1;
/// dates and bytes are stringified upstream so the front-end never has to
/// reason about driver-specific types.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "lowercase")]
pub enum Cell {
    Null,
    Text(String),
    Integer(i64),
    Float(f64),
    Bool(bool),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    /// SQL statement that produced this result (so the UI can correlate
    /// when multiple statements were submitted in one run).
    pub statement: String,
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Cell>>,
    pub rows_affected: Option<u64>,
    pub duration_ms: u64,
}
