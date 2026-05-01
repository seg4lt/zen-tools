/**
 * Database Explorer store.
 *
 * Holds the saved connection list (mirror of preferences), the currently
 * active connection id, the editor buffer for that connection, and the
 * latest query result + status. Connection-tree data
 * (databases/schemas/tables) is fetched on demand from the backend and
 * cached here per-connection.
 */

import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import {
  dbTauri,
  type DbConnectionPrefs,
  type DbQueryResult,
} from "../lib/tauri";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface ConnectionTreeData {
  /** Databases visible to this connection. */
  databases?: string[];
  /** `database` → schemas. */
  schemasByDb: Record<string, string[]>;
  /** `database/schema` → tables. */
  tablesBySchema: Record<string, string[]>;
}

export interface DbExplorerState {
  connections: DbConnectionPrefs[];
  activeConnectionId: string | null;
  /** Editor buffer per-connection (so switching connections doesn't lose work). */
  sqlByConnection: Record<string, string>;
  /** Latest run results per-connection. */
  resultsByConnection: Record<string, DbQueryResult[] | null>;
  /** Index of the active result tab per-connection. */
  activeResultIndexByConnection: Record<string, number>;
  /** Connection status per-connection. */
  status: Record<string, ConnectionStatus>;
  /** Last error message per-connection. */
  errors: Record<string, string | null>;
  /** Whether a query is currently running for this connection. */
  running: Record<string, boolean>;
  /** Cached tree data keyed by connection id. */
  trees: Record<string, ConnectionTreeData>;
  /**
   * Active "current database" per connection (MSSQL). For Postgres the
   * connection is bound to one DB so this is informational only.
   */
  activeDbByConnection: Record<string, string>;
  /**
   * Active "current schema" per connection (Postgres `search_path`).
   * For MSSQL this is unused — T-SQL convention is qualified table refs.
   */
  activeSchemaByConnection: Record<string, string>;
  /** Whether the connection-form modal is open. If a string, edit mode. */
  formOpen: false | "new" | { editId: string };
  /** Currently-open SQL file (absolute path) — drives the editor. */
  selectedFilePath: string | null;
  /** Buffer per file path. Survives file-tree navigation. */
  bufferByPath: Record<string, string>;
  /** Per-file "buffer differs from disk" flag. */
  dirtyByPath: Record<string, boolean>;
  /**
   * Inline-edit state. `null` when no row is being renamed and no
   * placeholder is being typed into.
   */
  editing: EditingState | null;
  /**
   * Append-only-ish query log shared across connections. Capped at
   * `LOG_MAX` entries — oldest dropped first.
   */
  logs: QueryLogEntry[];
}

/** Cap to keep the log panel responsive and bound memory use. */
export const LOG_MAX = 500;

/** Discriminated union for the inline-edit state machine. */
export type EditingState =
  | { kind: "rename"; path: string; seed: string }
  | { kind: "create"; parentDir: string; childKind: "file" | "folder" };

/** One entry in the persistent query log (append-only ring). */
export interface QueryLogEntry {
  id: string;
  /** Wall-clock ms — `Date.now()` at run dispatch. */
  ts: number;
  connectionId: string;
  connectionName: string;
  driver: string;
  /** The SQL that was sent. Long statements get truncated for display. */
  sql: string;
  status: "ok" | "error";
  /** Number of rowsful + rowsless statements in the result. */
  statementCount: number;
  /** Total wall-clock ms across all statements. `null` on error. */
  durationMs: number | null;
  /** Error message; only set when `status === "error"`. */
  message: string | null;
}

type Action =
  | { type: "set-connections"; connections: DbConnectionPrefs[] }
  | { type: "set-active-connection"; id: string | null }
  | { type: "set-sql"; id: string; sql: string }
  | { type: "set-status"; id: string; status: ConnectionStatus; error?: string | null }
  | { type: "set-running"; id: string; running: boolean }
  | { type: "set-results"; id: string; results: DbQueryResult[] | null }
  | { type: "set-active-result-index"; id: string; index: number }
  | { type: "close-result-tab"; id: string; index: number }
  | { type: "set-error"; id: string; error: string | null }
  | { type: "set-databases"; id: string; databases: string[] }
  | { type: "set-schemas"; id: string; database: string; schemas: string[] }
  | { type: "set-tables"; id: string; database: string; schema: string; tables: string[] }
  | { type: "set-active-database"; id: string; database: string }
  | { type: "set-active-schema"; id: string; schema: string }
  | { type: "open-form"; mode: "new" | { editId: string } }
  | { type: "close-form" }
  | { type: "select-file"; path: string | null }
  | { type: "set-buffer"; path: string; content: string; dirty: boolean }
  | { type: "mark-clean"; path: string }
  | { type: "drop-buffer"; path: string }
  | { type: "start-rename"; path: string; seed: string }
  | {
      type: "start-create";
      parentDir: string;
      childKind: "file" | "folder";
    }
  | { type: "cancel-editing" }
  | { type: "append-log"; entry: QueryLogEntry }
  | { type: "clear-logs" };

const initial: DbExplorerState = {
  connections: [],
  activeConnectionId: null,
  sqlByConnection: {},
  resultsByConnection: {},
  status: {},
  errors: {},
  running: {},
  trees: {},
  activeResultIndexByConnection: {},
  activeDbByConnection: {},
  activeSchemaByConnection: {},
  formOpen: false,
  selectedFilePath: null,
  bufferByPath: {},
  dirtyByPath: {},
  editing: null,
  logs: [],
};

function reducer(state: DbExplorerState, action: Action): DbExplorerState {
  switch (action.type) {
    case "set-connections":
      return { ...state, connections: action.connections };

    case "set-active-connection":
      return { ...state, activeConnectionId: action.id };

    case "set-sql":
      return {
        ...state,
        sqlByConnection: { ...state.sqlByConnection, [action.id]: action.sql },
      };

    case "set-status": {
      const errors = { ...state.errors };
      if (action.error !== undefined) errors[action.id] = action.error;
      return {
        ...state,
        status: { ...state.status, [action.id]: action.status },
        errors,
      };
    }

    case "set-running":
      return {
        ...state,
        running: { ...state.running, [action.id]: action.running },
      };

    case "set-results":
      return {
        ...state,
        resultsByConnection: {
          ...state.resultsByConnection,
          [action.id]: action.results,
        },
        // New result set always opens on tab 0.
        activeResultIndexByConnection: {
          ...state.activeResultIndexByConnection,
          [action.id]: 0,
        },
      };

    case "set-active-result-index":
      return {
        ...state,
        activeResultIndexByConnection: {
          ...state.activeResultIndexByConnection,
          [action.id]: action.index,
        },
      };

    case "close-result-tab": {
      const current = state.resultsByConnection[action.id] ?? null;
      if (!current) return state;
      const next = current.filter((_, idx) => idx !== action.index);
      const prevActive = state.activeResultIndexByConnection[action.id] ?? 0;
      // Keep the same tab where possible; if we closed it, fall back
      // to the one before. Clamp to 0 when nothing's left.
      let nextActive = prevActive;
      if (action.index < prevActive) nextActive = prevActive - 1;
      if (nextActive >= next.length) nextActive = Math.max(0, next.length - 1);
      return {
        ...state,
        resultsByConnection: {
          ...state.resultsByConnection,
          [action.id]: next.length === 0 ? null : next,
        },
        activeResultIndexByConnection: {
          ...state.activeResultIndexByConnection,
          [action.id]: nextActive,
        },
      };
    }

    case "set-error":
      return {
        ...state,
        errors: { ...state.errors, [action.id]: action.error },
      };

    case "set-databases": {
      const tree = state.trees[action.id] ?? {
        schemasByDb: {},
        tablesBySchema: {},
      };
      return {
        ...state,
        trees: {
          ...state.trees,
          [action.id]: { ...tree, databases: action.databases },
        },
      };
    }

    case "set-schemas": {
      const tree = state.trees[action.id] ?? {
        schemasByDb: {},
        tablesBySchema: {},
      };
      return {
        ...state,
        trees: {
          ...state.trees,
          [action.id]: {
            ...tree,
            schemasByDb: {
              ...tree.schemasByDb,
              [action.database]: action.schemas,
            },
          },
        },
      };
    }

    case "set-tables": {
      const tree = state.trees[action.id] ?? {
        schemasByDb: {},
        tablesBySchema: {},
      };
      const key = `${action.database}/${action.schema}`;
      return {
        ...state,
        trees: {
          ...state.trees,
          [action.id]: {
            ...tree,
            tablesBySchema: {
              ...tree.tablesBySchema,
              [key]: action.tables,
            },
          },
        },
      };
    }

    case "set-active-database":
      return {
        ...state,
        activeDbByConnection: {
          ...state.activeDbByConnection,
          [action.id]: action.database,
        },
        // Clear schema when DB changes — schemas are scoped to a DB.
        activeSchemaByConnection: {
          ...state.activeSchemaByConnection,
          [action.id]: "",
        },
      };

    case "set-active-schema":
      return {
        ...state,
        activeSchemaByConnection: {
          ...state.activeSchemaByConnection,
          [action.id]: action.schema,
        },
      };

    case "open-form":
      return { ...state, formOpen: action.mode };

    case "close-form":
      return { ...state, formOpen: false };

    case "select-file":
      return { ...state, selectedFilePath: action.path };

    case "set-buffer":
      return {
        ...state,
        bufferByPath: { ...state.bufferByPath, [action.path]: action.content },
        dirtyByPath: { ...state.dirtyByPath, [action.path]: action.dirty },
      };

    case "mark-clean":
      return {
        ...state,
        dirtyByPath: { ...state.dirtyByPath, [action.path]: false },
      };

    case "drop-buffer": {
      const { [action.path]: _drop, ...buffers } = state.bufferByPath;
      const { [action.path]: _drop2, ...dirty } = state.dirtyByPath;
      return {
        ...state,
        bufferByPath: buffers,
        dirtyByPath: dirty,
        selectedFilePath:
          state.selectedFilePath === action.path
            ? null
            : state.selectedFilePath,
      };
    }

    case "start-rename":
      return {
        ...state,
        editing: { kind: "rename", path: action.path, seed: action.seed },
      };

    case "start-create":
      return {
        ...state,
        editing: {
          kind: "create",
          parentDir: action.parentDir,
          childKind: action.childKind,
        },
      };

    case "cancel-editing":
      return { ...state, editing: null };

    case "append-log": {
      // Newest-first so the log panel reads top-down.
      const next = [action.entry, ...state.logs];
      if (next.length > LOG_MAX) next.length = LOG_MAX;
      return { ...state, logs: next };
    }

    case "clear-logs":
      return { ...state, logs: [] };
  }
}

interface ContextValue {
  state: DbExplorerState;
  dispatch: Dispatch<Action>;
}

const DbExplorerContext = createContext<ContextValue | null>(null);

export function DbExplorerStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);

  // Load saved connections on mount.
  useEffect(() => {
    let cancelled = false;
    dbTauri.listSavedConnections().then(
      (rows) => {
        if (!cancelled) dispatch({ type: "set-connections", connections: rows });
      },
      (err) => {
        // Non-fatal; the user just sees an empty list.
        // eslint-disable-next-line no-console
        console.error("listSavedConnections failed", err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <DbExplorerContext.Provider value={{ state, dispatch }}>
      {children}
    </DbExplorerContext.Provider>
  );
}

export function useDbExplorerStore(): ContextValue {
  const ctx = useContext(DbExplorerContext);
  if (!ctx) {
    throw new Error("useDbExplorerStore must be used inside DbExplorerStoreProvider");
  }
  return ctx;
}
