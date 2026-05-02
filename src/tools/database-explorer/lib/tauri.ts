/**
 * Typed wrappers around the database-explorer Tauri commands.
 * Hand-mirrored from `crates/zen-db` + `src-tauri/src/commands/database.rs`.
 */

import { invoke } from "@tauri-apps/api/core";

export type DbDriverId = "postgres" | "mssql";

/**
 * Connection metadata. The password is only ever set on `db_save_connection`
 * / `db_test_connection`; reads from the backend (`db_list_saved_connections`)
 * never include it (it lives in the OS keychain).
 */
export interface DbConnectionInput {
  id: string;
  name: string;
  driver: DbDriverId;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  trustServerCertificate?: boolean;
}

/** Saved connection as returned from `db_list_saved_connections`. */
export interface DbConnectionPrefs {
  id: string;
  name: string;
  driver: DbDriverId;
  host: string;
  port: number;
  database: string;
  username: string;
  trustServerCertificate?: boolean;
}

export interface DbColumn {
  name: string;
  typeName: string;
}

/** Mirrors `zen_db::TableKind`. Drives the leaf icon in the explorer. */
export type DbTableKind = "table" | "view";

/** Mirrors `zen_db::ColumnDescription`. */
export interface DbColumnDescription {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  ordinal: number;
  isPrimaryKey: boolean;
}

/**
 * Stub fields populated by a future revision of the driver. We carry
 * the shapes now so the cache payload doesn't need a migration when the
 * details pane lands.
 */
export interface DbIndexDescription {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
}

export interface DbForeignKeyDescription {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
}

/** PRIMARY KEY or UNIQUE constraint surfaced under a table's "Keys"
 * folder. Mirrors `zen_db::KeyDescription`. */
export interface DbKeyDescription {
  name: string;
  columns: string[];
  isPrimary: boolean;
}

/** CHECK constraint. Mirrors `zen_db::CheckDescription`. */
export interface DbCheckDescription {
  name: string;
  expression: string;
}

/** Trigger metadata. Mirrors `zen_db::TriggerDescription`. */
export interface DbTriggerDescription {
  name: string;
  /** "BEFORE" | "AFTER" | "INSTEAD OF". */
  timing: string;
  /** Any combination of "INSERT" / "UPDATE" / "DELETE" / "TRUNCATE". */
  events: string[];
  /** `CREATE TRIGGER` body when the driver exposes it cheaply. */
  definition: string | null;
}

/** Whether a routine is a function or a stored procedure. */
export type DbRoutineKind = "function" | "procedure";

/** Stored procedure / function. Schema-scoped. Mirrors
 * `zen_db::RoutineDescription`. */
export interface DbRoutineDescription {
  schema: string;
  name: string;
  kind: DbRoutineKind;
  language: string | null;
  returnType: string | null;
  argumentTypes: string[];
}

/**
 * Mirrors `zen_db::TableSummary`. Lightweight — used to seed the SQL
 * editor's autocomplete catalog (schemas + qualified tables) cold,
 * before any column descriptions have been fetched.
 */
export interface DbTableSummary {
  schema: string;
  name: string;
  kind: DbTableKind;
}

/** Mirrors `zen_db::TableDescription`. */
export interface DbTableDescription {
  database: string;
  schema: string;
  name: string;
  kind: DbTableKind;
  columns: DbColumnDescription[];
  indexes: DbIndexDescription[];
  foreignKeys: DbForeignKeyDescription[];
  /** PRIMARY KEY + UNIQUE constraints. */
  keys: DbKeyDescription[];
  /** CHECK constraints. */
  checks: DbCheckDescription[];
  /** Trigger metadata. */
  triggers: DbTriggerDescription[];
}

/** Lightweight cache-listing row — used for freshness badges. */
export interface DbCachedTableMeta {
  name: string;
  /** Unix-ms timestamp of the last cache upsert. */
  indexedAt: number;
}

/**
 * Payload of the `schema-cache-updated` Tauri event. Emitted whenever
 * a background refresh upserts at least one row for `(connection, db,
 * schema)`. The editor's autocomplete plugin listens for this and
 * re-pulls the affected rows from the cache.
 */
export interface SchemaCacheUpdatedEvent {
  connectionId: string;
  database: string;
  schema: string;
  tables: string[];
}

/** Tauri event channel name. Centralised so the frontend can't drift. */
export const SCHEMA_CACHE_EVENT = "schema-cache-updated";

/**
 * Lifecycle marker for an in-flight cache job. Mirrors the backend
 * `ProgressState` enum exactly.
 */
export type SchemaCacheProgressState =
  | "started"
  | "progress"
  | "done"
  | "error";

/**
 * Which kind of cache work is happening — drives both the icon and
 * the prominence of the indicator chip:
 *
 *   - `catalog` — listing every relation in the database (single
 *     query). Quick.
 *   - `describe` — user-triggered per-table description fetch
 *     (Opt+Enter reindex, right-click "Index table"). Show prominently.
 *   - `background` — typing-triggered or stale auto-refresh. Subtle.
 */
export type SchemaCacheProgressKind = "catalog" | "describe" | "background";

/**
 * Streaming progress message from the backend. One `started` per job,
 * any number of `progress`, exactly one terminator (`done` or `error`).
 */
export interface SchemaCacheProgressEvent {
  jobId: string;
  kind: SchemaCacheProgressKind;
  state: SchemaCacheProgressState;
  connectionId: string;
  database: string;
  /** Absent for `catalog` (which spans every schema). */
  schema: string | null;
  current: number;
  total: number;
  /** Table currently being processed, when applicable. */
  currentItem: string | null;
  /** Free-text status. Carries the error message on `state=error`. */
  message: string | null;
}

/** Tauri channel name for the streaming progress event. */
export const SCHEMA_CACHE_PROGRESS_EVENT = "schema-cache-progress";

/** Wire format of the explain payload. Mirrors `zen_db::ExplainFormat`. */
export type DbExplainFormat = "json" | "xml";

/**
 * Result of `db_explain_query`. The frontend parses `raw` into a
 * unified `PlanRoot` model (see `lib/explain-plan.ts`) and renders
 * Raw / Plan / Flame views in the result tab.
 */
export interface DbExplainResult {
  format: DbExplainFormat;
  /** Full plan payload — Postgres EXPLAIN-JSON, or MSSQL ShowPlanXML. */
  raw: string;
  /** Original SQL the user submitted (without the EXPLAIN/STATISTICS
   * wrapping) so the UI can show what was profiled. */
  statement: string;
  /** Wall-clock for the whole explain round-trip. */
  durationMs: number;
  /**
   * MSSQL only — the actual data the wrapped query returned.
   * `null` for Postgres (EXPLAIN ANALYZE doesn't ship the inner
   * rows). Surfaced so a single round-trip can serve both data and
   * plan when running against MSSQL.
   */
  data: DbQueryResult | null;
}

/** Tagged-union cell — see `zen_db::types::Cell`. */
export type DbCell =
  | { kind: "null" }
  | { kind: "text"; value: string }
  | { kind: "integer"; value: number }
  | { kind: "float"; value: number }
  | { kind: "bool"; value: boolean };

export interface DbQueryResult {
  statement: string;
  columns: DbColumn[];
  rows: DbCell[][];
  rowsAffected: number | null;
  durationMs: number;
  /**
   * Per-statement lock telemetry. Only present when the caller
   * passed `captureLocks: true` (the "Run with locks" button) —
   * otherwise the field is absent. See {@link DbLockSummary}.
   */
  locks?: DbLockSummary;
}

/**
 * Engine-agnostic lock granularity vocabulary. See
 * `zen_db::LockGranularity`. Drives the row/page/table chips in
 * the Locks panel: the same row reads as `row` whether it came
 * from a Postgres `tuple` or an MSSQL `KEY`/`RID`.
 */
export type DbLockGranularity =
  | "row"
  | "page"
  | "table"
  | "database"
  | "transaction"
  | "advisory"
  | "metadata"
  | "other";

/** Mirrors `zen_db::LockSample`. */
export interface DbLockSample {
  /** Milliseconds since the user statement started. */
  atMs: number;
  granularity: DbLockGranularity;
  /** Driver-native resource type ("relation", "tuple", "KEY", …). */
  rawKind: string;
  /** Engine mode ("AccessShareLock", "X", "IX", …). */
  mode: string;
  /** `false` means the session was waiting for this lock at sample
   * time; `true` means it was held. */
  granted: boolean;
  /** Best-effort `schema.table` (or `[schema].[table]` for MSSQL). */
  object: string | null;
  blockerPid: number | null;
}

/** Mirrors `zen_db::ObjectLockRow`. */
export interface DbObjectLockRow {
  object: string;
  granularities: DbLockGranularity[];
  modes: string[];
  /** Peak number of distinct lock rows observed for this object
   * within a single sample window. */
  peakLocks: number;
  /** `true` if any sample showed us waiting on this object. */
  waited: boolean;
}

/** Mirrors `zen_db::BlockerInfo`. */
export interface DbBlockerInfo {
  pid: number;
  /** Engine wait-event reason ("Lock/transactionid", "LCK_M_X", …). */
  reason: string | null;
  /** Approximate wait time = blocked_samples * sample_interval_ms. */
  waitMs: number;
}

/**
 * Aggregated lock telemetry for one statement. Mirrors
 * `zen_db::LockSummary`. When `error` is set, the sampler couldn't
 * run — render the panel as "Lock capture unavailable: {error}"
 * rather than as no-locks-found.
 */
export interface DbLockSummary {
  sampleIntervalMs: number;
  sampleCount: number;
  blockedMs: number;
  /** Object form: `{ row: 142, table: 1 }`. Engine-agnostic keys. */
  peakByGranularity: Partial<Record<DbLockGranularity, number>>;
  /** Engine-native mode → peak count map. */
  peakByMode: Record<string, number>;
  objects: DbObjectLockRow[];
  blockers: DbBlockerInfo[];
  /** Raw timeline samples — capped server-side. */
  samples: DbLockSample[];
  /** Set when sampling was unavailable (permission denied,
   * sidecar connect failed, …). */
  error?: string;
}

// ── Connections ─────────────────────────────────────────────────────────

export const dbTauri = {
  testConnection: (input: DbConnectionInput) =>
    invoke<void>("db_test_connection", { input }),

  saveConnection: (input: DbConnectionInput) =>
    invoke<void>("db_save_connection", { input }),

  deleteConnection: (id: string) =>
    invoke<void>("db_delete_connection", { id }),

  listSavedConnections: () =>
    invoke<DbConnectionPrefs[]>("db_list_saved_connections"),

  connect: (id: string) => invoke<void>("db_connect", { id }),

  disconnect: (id: string) => invoke<void>("db_disconnect", { id }),

  // ── Tree ──────────────────────────────────────────────────────────────

  listDatabases: (id: string) =>
    invoke<string[]>("db_list_databases", { id }),

  listSchemas: (id: string, database: string) =>
    invoke<string[]>("db_list_schemas", { id, database }),

  listTables: (id: string, database: string, schema: string) =>
    invoke<string[]>("db_list_tables", { id, database, schema }),

  /**
   * Single round-trip catalog dump for the SQL editor's autocomplete.
   * Returns every relation visible in `database`. Cheap on the wire —
   * one query, names + schema + kind only (no columns).
   */
  listAllTables: (id: string, database: string) =>
    invoke<DbTableSummary[]>("db_list_all_tables", { id, database }),

  /**
   * Stored procedures + functions in `database.schema`. Drives the
   * per-schema "Routines" folder in the DB tree. Front-end caches
   * results for the session — no SQLite persistence, since the
   * query is one round-trip and routine churn often aligns with
   * migrations the user is actively iterating on.
   */
  listRoutines: (id: string, database: string, schema: string) =>
    invoke<DbRoutineDescription[]>("db_list_routines", {
      id,
      database,
      schema,
    }),

  // ── Query ─────────────────────────────────────────────────────────────

  query: (
    id: string,
    sql: string,
    opts?: {
      database?: string | null;
      schema?: string | null;
      /**
       * When `true`, the backend opens a sidecar observer
       * connection and polls `pg_locks` / `sys.dm_tran_locks`
       * for the duration of every statement, attaching a
       * {@link DbLockSummary} to each `DbQueryResult.locks`.
       * Drives the "Run with locks" UI button.
       *
       * Off by default: opens a second connection + adds
       * polling load on the server.
       */
      captureLocks?: boolean;
      /**
       * Polling interval in ms. Defaults server-side to 25 ms.
       * Bump for queries you expect to run for many seconds; the
       * trade-off is sub-interval lock acquisitions can escape
       * observation.
       */
      lockSampleIntervalMs?: number;
    },
  ) =>
    invoke<DbQueryResult[]>("db_query", {
      id,
      sql,
      database: opts?.database ?? null,
      schema: opts?.schema ?? null,
      captureLocks: opts?.captureLocks ?? false,
      lockSampleIntervalMs: opts?.lockSampleIntervalMs ?? null,
    }),

  /**
   * Run the user SQL through the dialect's "execute + explain"
   * path and return the captured plan payload. Drives the perf
   * visualizer's "Run with plan" toolbar button + the auto-EXPLAIN
   * piggyback on a regular Run.
   */
  explainQuery: (
    id: string,
    sql: string,
    opts?: {
      database?: string | null;
      schema?: string | null;
      /**
       * `true` (default) → execute the query and capture actual rows
       * / timing / buffers (Postgres `ANALYZE`, MSSQL
       * `STATISTICS XML`). Side effects happen — DML statements
       * modify data unless wrapped in a transaction.
       *
       * `false` → planner-estimate only. No execution; no actual
       * rows, no timing, no buffers. Safe for destructive
       * statements.
       */
      analyze?: boolean;
    },
  ) =>
    invoke<DbExplainResult>("db_explain_query", {
      id,
      sql,
      database: opts?.database ?? null,
      schema: opts?.schema ?? null,
      analyze: opts?.analyze ?? true,
    }),

  // ── Schema cache (autocomplete) ──────────────────────────────────────

  /**
   * Single-table description. `force: true` bypasses the cache.
   *
   * `force: false` returns the cached row when present (any age) and
   * schedules a background refresh if it's older than the TTL — the
   * front-end will see the refreshed version via the
   * `schema-cache-updated` event. A cache miss falls through to a
   * synchronous fetch.
   */
  describeTable: (
    id: string,
    database: string,
    schema: string,
    table: string,
    force = false,
  ) =>
    invoke<DbTableDescription>("db_describe_table", {
      id,
      database,
      schema,
      table,
      force,
    }),

  /**
   * Bulk variant. Returns whatever is currently cached for the named
   * tables (any age) and queues background refreshes for missing or
   * stale rows. With `force: true` every requested table is re-fetched
   * synchronously and the event is emitted with the full set.
   */
  describeTablesBulk: (
    id: string,
    database: string,
    schema: string,
    tables: string[],
    force = false,
  ) =>
    invoke<DbTableDescription[]>("db_describe_tables_bulk", {
      id,
      database,
      schema,
      tables,
      force,
    }),

  /** List names + indexedAt for everything currently cached for a schema. */
  listCachedTables: (id: string, database: string, schema: string) =>
    invoke<DbCachedTableMeta[]>("db_list_cached_tables", {
      id,
      database,
      schema,
    }),

  /**
   * Drop cache rows. Empty `tables` clears every row under
   * `(id, database, schema)`. The next describe call refetches.
   */
  invalidateSchemaCache: (
    id: string,
    database: string,
    schema: string,
    tables: string[],
  ) =>
    invoke<void>("db_invalidate_schema_cache", {
      id,
      database,
      schema,
      tables,
    }),
};

// ── SQL workspace (project files) ──────────────────────────────────────

export type SqlFileType = "sqlFile" | "directory";

export interface SqlFileTreeItem {
  name: string;
  path: string;
  isDir: boolean;
  depth: number;
  expanded: boolean;
  fileType: SqlFileType;
}

export interface DiscoveredSqlProject {
  root: string;
  name: string;
  items: SqlFileTreeItem[];
}

export const sqlWorkspaceTauri = {
  list: () => invoke<string[]>("sql_workspace_list"),
  add: (path: string) => invoke<string[]>("sql_workspace_add", { path }),
  remove: (path: string) => invoke<string[]>("sql_workspace_remove", { path }),
  discover: () => invoke<DiscoveredSqlProject[]>("sql_workspace_discover"),
  createFile: (parentDir: string, name: string) =>
    invoke<string>("sql_workspace_create_file", { parentDir, name }),
  createDir: (parentDir: string, name: string) =>
    invoke<string>("sql_workspace_create_dir", { parentDir, name }),
  rename: (oldPath: string, newName: string) =>
    invoke<string>("sql_workspace_rename", { oldPath, newName }),
  deleteToTrash: (path: string) =>
    invoke<void>("sql_workspace_delete_to_trash", { path }),
  /** Native folder picker — reuses the http-runner command. */
  pickDirectory: () => invoke<string | null>("pick_directory"),
  readFile: (path: string) =>
    invoke<string>("read_file_content", { path }),
  writeFile: (path: string, content: string) =>
    invoke<void>("write_file_content", { path, content }),
};

/** Render a `DbCell` to a human-friendly string. */
export function cellToString(cell: DbCell): string {
  switch (cell.kind) {
    case "null":
      return "NULL";
    case "text":
      return cell.value;
    case "integer":
    case "float":
      return String(cell.value);
    case "bool":
      return cell.value ? "true" : "false";
  }
}
