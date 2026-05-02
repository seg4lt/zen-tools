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

/// PRIMARY KEY or UNIQUE constraint surfaced under the table's "Keys"
/// folder. `is_primary` distinguishes the two so the UI can show
/// `🔑 PRIMARY` vs `UNIQUE` consistently.
///
/// The column-level `ColumnDescription::is_primary_key` flag remains
/// the cheap-to-render answer to "is this column a PK"; this struct
/// is the catalogue-level view the tree uses.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyDescription {
    /// Constraint name (driver-native).
    pub name: String,
    /// Columns that participate in the key, ordered.
    pub columns: Vec<String>,
    /// `true` for the table's PRIMARY KEY; `false` for UNIQUE keys.
    #[serde(default)]
    pub is_primary: bool,
}

/// CHECK constraint. The expression is the driver-native source —
/// `pg_get_constraintdef(oid)` on Postgres, the `definition` column
/// on MSSQL.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckDescription {
    pub name: String,
    pub expression: String,
}

/// Trigger metadata. `timing` ("BEFORE", "AFTER", "INSTEAD OF") and
/// `events` (any combination of "INSERT", "UPDATE", "DELETE",
/// "TRUNCATE") come straight from the catalogue; `definition` is the
/// `CREATE TRIGGER` body when the driver exposes it cheaply.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerDescription {
    pub name: String,
    pub timing: String,
    pub events: Vec<String>,
    pub definition: Option<String>,
}

/// Whether a routine is a function or a stored procedure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoutineKind {
    Function,
    Procedure,
}

/// Stored procedure or function. Schema-scoped, returned by
/// [`crate::DbConnection::list_routines`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineDescription {
    /// Schema (Postgres) / owner (MSSQL) the routine belongs to.
    pub schema: String,
    /// Routine name.
    pub name: String,
    pub kind: RoutineKind,
    /// Postgres: `plpgsql`, `sql`, `c`, … MSSQL: `Some("sql")` for all
    /// T-SQL routines, `None` for CLR.
    pub language: Option<String>,
    /// Formatted return type for functions; `None` for procedures.
    pub return_type: Option<String>,
    /// Formatted argument types in declaration order. Empty for
    /// zero-argument routines.
    pub argument_types: Vec<String>,
}

/// Full description of a single table. Drivers fill in what they
/// cheaply can; everything else stays empty. Backwards-compatible
/// fields (`indexes`, `foreign_keys`, `keys`, `checks`, `triggers`)
/// use `#[serde(default)]` so old `schema_cache.db` payloads
/// deserialise cleanly into the current shape — they re-fill on the
/// next describe.
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
    /// PRIMARY KEY + UNIQUE constraints.
    #[serde(default)]
    pub keys: Vec<KeyDescription>,
    /// CHECK constraints.
    #[serde(default)]
    pub checks: Vec<CheckDescription>,
    /// Trigger metadata.
    #[serde(default)]
    pub triggers: Vec<TriggerDescription>,
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

/// Wire format for the explain payload. Each dialect carries one
/// canonical shape:
///
/// - `Json` — Postgres `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS, …)`,
///   a single-element array of objects with a `Plan` tree.
/// - `Xml` — MSSQL `SET STATISTICS XML ON; <query>;`, a
///   `<ShowPlanXML>` document with nested `<RelOp>` nodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExplainFormat {
    Json,
    Xml,
}

/// Result of `db_explain_query`. Drivers shape the user SQL into the
/// dialect-appropriate plan-emitting wrapper, run it, and ship the
/// payload + bookkeeping back. The frontend parses `raw` into the
/// unified `PlanRoot` model used by the visualizer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainResult {
    pub format: ExplainFormat,
    /// The full plan payload — Postgres EXPLAIN-JSON, or MSSQL
    /// ShowPlanXML.
    pub raw: String,
    /// Original SQL the user submitted, before the driver-specific
    /// EXPLAIN/STATISTICS wrapping.
    pub statement: String,
    /// Wall-clock time for the whole "explain" round-trip
    /// (includes any session-state SQL the wrapper added).
    pub duration_ms: u64,
    /// MSSQL only — the actual data the wrapped query returned.
    /// `None` for Postgres, since `EXPLAIN ANALYZE` doesn't ship the
    /// inner query's rows. Surfaced so the front-end can show data
    /// alongside the plan in a single round-trip when running
    /// against MSSQL.
    pub data: Option<QueryResult>,
}
