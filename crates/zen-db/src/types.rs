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

/// What kind of relation a `TableDescription` represents. Drivers map
/// their native catalogues onto this small enum so the front-end has one
/// shape to render.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableKind {
    Table,
    View,
}

/// Lightweight `(schema, table)` row used to seed the SQL editor's
/// autocomplete catalog without paying the per-table-column cost up
/// front. One round-trip per connection brings back every relation
/// (table or view) the user can reference, so completions for
/// `<schema>.<table>` work the moment the editor opens — before the
/// user has typed any reference.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSummary {
    /// Schema (Postgres) / owner (MSSQL) the relation belongs to.
    pub schema: String,
    /// Table or view name.
    pub name: String,
    /// Whether this is a base table or a view.
    pub kind: TableKind,
}

/// One column on a table. `data_type` is the driver-native type string
/// (e.g. `"integer"`, `"varchar(64)"`, `"jsonb"`) — good enough for
/// autocomplete tooltips. `is_primary_key` is best-effort: drivers fill
/// it from their PK metadata where cheap, otherwise leave it `false`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDescription {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub ordinal: i32,
    #[serde(default)]
    pub is_primary_key: bool,
}

/// Index metadata stub — populated in a future revision. The shape is
/// fixed now so the cache payload doesn't need a migration when the
/// details pane lands.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDescription {
    pub name: String,
    pub columns: Vec<String>,
    #[serde(default)]
    pub is_unique: bool,
    #[serde(default)]
    pub is_primary: bool,
}

/// Foreign-key metadata stub — also populated later.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDescription {
    pub name: String,
    pub columns: Vec<String>,
    pub referenced_schema: String,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
}

/// Full description of a single table, suitable for both autocomplete
/// (columns) and a future "table details" pane (indexes, FKs). Drivers
/// fill in what they cheaply can; everything else stays empty.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDescription {
    pub database: String,
    pub schema: String,
    pub name: String,
    pub kind: TableKind,
    pub columns: Vec<ColumnDescription>,
    #[serde(default)]
    pub indexes: Vec<IndexDescription>,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyDescription>,
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
