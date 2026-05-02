//! Wire types shared with the front-end.

use std::collections::HashMap;

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
    /// Per-statement lock telemetry, populated only when the caller
    /// passes [`ExecuteOptions::capture_locks = true`]. `None` (the
    /// default) means lock sampling was off or unavailable on this
    /// driver. See [`LockSummary`] for the shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locks: Option<LockSummary>,
}

/// Knobs that influence how a single statement (or batch) executes
/// beyond the SQL itself. Defaults are zero-cost and match the
/// historic [`crate::DbConnection::execute`] / `execute_batch`
/// behaviour exactly — pass `ExecuteOptions::default()` to keep the
/// old semantics.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteOptions {
    /// When `true`, the driver opens a sidecar observer connection
    /// against the same database, captures the executing
    /// session/PID, and polls the engine's lock catalogue
    /// (`pg_locks` / `sys.dm_tran_locks`) every
    /// [`Self::lock_sample_interval_ms`] for the duration of the
    /// statement. The aggregated [`LockSummary`] is attached to the
    /// matching [`QueryResult`].
    ///
    /// Off by default: opening a second connection has cost, and
    /// the polling itself adds load to the server. UI surfaces this
    /// behind an explicit "Run with locks" button.
    #[serde(default)]
    pub capture_locks: bool,

    /// Sampling cadence for the lock observer, in milliseconds.
    /// Smaller = more chance of catching short-held locks, more
    /// load. `None` lets the driver pick its default (currently 25
    /// ms — fine for sub-second to multi-second queries; bump for
    /// queries you expect to run for minutes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_sample_interval_ms: Option<u64>,
}

/// What kind of resource a lock was held on, mapped to a small
/// engine-agnostic vocabulary so the UI can render row vs page vs
/// table the same way for Postgres and MSSQL. The driver-native
/// type stays available in [`LockSample::raw_kind`] for users
/// chasing dialect-specific edge cases.
///
/// - `Row`      — Postgres `tuple` / MSSQL `KEY` or `RID`.
/// - `Page`     — Postgres `page` / MSSQL `PAGE`.
/// - `Table`    — Postgres `relation` / MSSQL `OBJECT`.
/// - `Database` — Postgres `database` / MSSQL `DATABASE`.
/// - `Transaction` — Postgres `transactionid`/`virtualxid` /
///   MSSQL `XACT`.
/// - `Advisory` — Postgres `advisory` (no MSSQL equivalent).
/// - `Metadata` — anything catalog/schema-modification related
///   (MSSQL `METADATA`, `SCHEMA`, `HOBT`, `ALLOCATION_UNIT`,
///   `EXTENT`, `APPLICATION`, …).
/// - `Other`    — fallback when the engine returns something we
///   don't classify; check `raw_kind` for the original string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LockGranularity {
    Row,
    Page,
    Table,
    Database,
    Transaction,
    Advisory,
    Metadata,
    Other,
}

impl LockGranularity {
    pub fn as_str(self) -> &'static str {
        match self {
            LockGranularity::Row => "row",
            LockGranularity::Page => "page",
            LockGranularity::Table => "table",
            LockGranularity::Database => "database",
            LockGranularity::Transaction => "transaction",
            LockGranularity::Advisory => "advisory",
            LockGranularity::Metadata => "metadata",
            LockGranularity::Other => "other",
        }
    }
}

/// One observation of a held (or waiting) lock at a single instant
/// during the user query. Several samples per "lock" are normal —
/// the same lock is observed once per polling tick while it's
/// alive — so consumers should aggregate by `(granularity, mode,
/// object)` rather than treating every sample as a unique lock.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockSample {
    /// Milliseconds since the user statement started.
    pub at_ms: u64,
    pub granularity: LockGranularity,
    /// Driver-native resource type string. PG: `relation`,
    /// `tuple`, `page`, `transactionid`, `virtualxid`, `object`,
    /// `userlock`, `advisory`, … MSSQL: `KEY`, `RID`, `PAGE`,
    /// `OBJECT`, `METADATA`, `HOBT`, …
    pub raw_kind: String,
    /// Lock mode as reported by the engine. PG: `AccessShareLock`,
    /// `RowExclusiveLock`, `ShareUpdateExclusiveLock`, …
    /// MSSQL: `S`, `X`, `IX`, `SIX`, `Sch-M`, …
    pub mode: String,
    /// `true` for held locks, `false` for the request rows where
    /// the session is *waiting* to acquire the lock.
    pub granted: bool,
    /// Best-effort human label for the locked object. Postgres
    /// fills this with `schema.relation` for relation/tuple/page
    /// locks; MSSQL with `OBJECT_NAME(...)` when available.
    /// `None` for transaction / advisory / virtualxid locks where
    /// there is no underlying object name.
    pub object: Option<String>,
    /// PID/SPID of the session that currently blocks ours, when
    /// our session was waiting at sample time. `None` when we
    /// weren't waiting, or when the engine couldn't identify a
    /// blocker.
    pub blocker_pid: Option<i64>,
}

/// One row of the per-object rollup the UI surfaces in the Locks
/// panel: "what objects did this query touch, and how heavily?"
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectLockRow {
    pub object: String,
    /// Set of granularities ever observed against this object
    /// during the query (e.g. `["row", "table"]` if both a tuple
    /// and a relation lock fired).
    pub granularities: Vec<LockGranularity>,
    /// Set of distinct modes observed (e.g. `["AccessShareLock"]`).
    pub modes: Vec<String>,
    /// Peak number of distinct lock rows observed in a single
    /// sample for this object (so a query that locked 3 separate
    /// rows of one table reports 3, not 1).
    pub peak_locks: u32,
    /// `true` if any sample for this object showed `granted = false`
    /// (i.e. we were ever waiting on this object).
    pub waited: bool,
}

/// Brief description of who blocked us at some point during the
/// query. Multiple entries appear when blocking ownership shifted
/// (e.g. blocker A released, blocker B took over).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockerInfo {
    pub pid: i64,
    /// Engine-reported reason: PG's `wait_event_type/wait_event`
    /// (`Lock/transactionid`, `Lock/relation`, …), MSSQL's
    /// `wait_type` (`LCK_M_X`, `LCK_M_SCH_S`, …).
    pub reason: Option<String>,
    /// Cumulative wait time we observed across samples, in ms.
    pub wait_ms: u64,
}

/// Aggregated lock telemetry for one statement. Built by the
/// driver's lock sampler; attached to the matching
/// [`QueryResult`] when [`ExecuteOptions::capture_locks`] is on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockSummary {
    /// Sampling interval the observer used, in ms. Surfaced in
    /// the UI header so the user can judge how reliable the
    /// granularity counts are: a 5 ms query against a 25 ms
    /// sampler may have escaped observation entirely.
    pub sample_interval_ms: u64,
    /// Total samples taken (mostly diagnostic — empty samples
    /// also count, so a long idle query can have many samples
    /// with no rows).
    pub sample_count: u32,
    /// Total wall-clock time, in ms, that this session spent
    /// waiting for a lock (i.e. samples where `granted = false`).
    /// Approximated as `(blocked_samples × interval)` — exact
    /// only at the sampling resolution.
    pub blocked_ms: u64,
    /// Peak per-granularity counts across all samples — the
    /// "row: 142, page: 3, table: 1" you see in the UI bar.
    pub peak_by_granularity: HashMap<LockGranularity, u32>,
    /// Peak per-mode counts.
    pub peak_by_mode: HashMap<String, u32>,
    /// Per-object rollup, sorted by `peak_locks` desc upstream.
    pub objects: Vec<ObjectLockRow>,
    /// Sessions that blocked us at some point.
    pub blockers: Vec<BlockerInfo>,
    /// Raw samples, capped client-side. The UI uses these for
    /// the timeline sparkline.
    pub samples: Vec<LockSample>,
    /// Set when the sampler couldn't run (permission denied,
    /// sidecar connect failure, sampling disabled by config).
    /// All other fields will be empty / zero in that case.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl LockSummary {
    /// Build an "I tried to sample but couldn't" summary. Surfaced
    /// in the UI as a disabled-with-reason state instead of an
    /// errored query.
    pub fn unavailable(interval_ms: u64, reason: impl Into<String>) -> Self {
        Self {
            sample_interval_ms: interval_ms,
            sample_count: 0,
            blocked_ms: 0,
            peak_by_granularity: HashMap::new(),
            peak_by_mode: HashMap::new(),
            objects: Vec::new(),
            blockers: Vec::new(),
            samples: Vec::new(),
            error: Some(reason.into()),
        }
    }
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
