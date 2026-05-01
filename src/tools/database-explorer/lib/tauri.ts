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
