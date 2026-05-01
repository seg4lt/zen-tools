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

  // ── Query ─────────────────────────────────────────────────────────────

  query: (
    id: string,
    sql: string,
    opts?: { database?: string | null; schema?: string | null },
  ) =>
    invoke<DbQueryResult[]>("db_query", {
      id,
      sql,
      database: opts?.database ?? null,
      schema: opts?.schema ?? null,
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
