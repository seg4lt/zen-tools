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
}

type Action =
  | { type: "set-connections"; connections: DbConnectionPrefs[] }
  | { type: "set-active-connection"; id: string | null }
  | { type: "set-sql"; id: string; sql: string }
  | { type: "set-status"; id: string; status: ConnectionStatus; error?: string | null }
  | { type: "set-running"; id: string; running: boolean }
  | { type: "set-results"; id: string; results: DbQueryResult[] | null }
  | { type: "set-error"; id: string; error: string | null }
  | { type: "set-databases"; id: string; databases: string[] }
  | { type: "set-schemas"; id: string; database: string; schemas: string[] }
  | { type: "set-tables"; id: string; database: string; schema: string; tables: string[] }
  | { type: "set-active-database"; id: string; database: string }
  | { type: "set-active-schema"; id: string; schema: string }
  | { type: "open-form"; mode: "new" | { editId: string } }
  | { type: "close-form" };

const initial: DbExplorerState = {
  connections: [],
  activeConnectionId: null,
  sqlByConnection: {},
  resultsByConnection: {},
  status: {},
  errors: {},
  running: {},
  trees: {},
  activeDbByConnection: {},
  activeSchemaByConnection: {},
  formOpen: false,
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
      };

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
