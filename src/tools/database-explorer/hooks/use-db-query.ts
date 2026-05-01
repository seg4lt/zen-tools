/**
 * Run a SQL string against the active connection and capture the
 * result + status into the store.
 */

import { useCallback } from "react";
import { dbTauri } from "../lib/tauri";
import { formatError } from "../lib/format-error";
import {
  useDbExplorerStore,
  type QueryLogEntry,
} from "../store/db-explorer-store";

function makeLogId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useDbQuery() {
  const { state, dispatch } = useDbExplorerStore();

  const runQuery = useCallback(
    async (
      connectionId: string,
      sql: string,
      opts?: { database?: string | null; schema?: string | null },
    ) => {
      const trimmed = sql.trim();
      if (!trimmed) return;

      const meta = state.connections.find((c) => c.id === connectionId);
      const logBase: Pick<
        QueryLogEntry,
        "id" | "ts" | "connectionId" | "connectionName" | "driver" | "sql"
      > = {
        id: makeLogId(),
        ts: Date.now(),
        connectionId,
        connectionName: meta?.name ?? "(unknown)",
        driver: meta?.driver ?? "?",
        sql: trimmed,
      };

      dispatch({ type: "set-running", id: connectionId, running: true });
      dispatch({ type: "set-error", id: connectionId, error: null });
      try {
        const results = await dbTauri.query(connectionId, trimmed, opts);
        dispatch({ type: "set-results", id: connectionId, results });
        const totalMs = results.reduce(
          (acc, r) => acc + (r.durationMs ?? 0),
          0,
        );
        dispatch({
          type: "append-log",
          entry: {
            ...logBase,
            status: "ok",
            statementCount: results.length,
            durationMs: totalMs,
            message: null,
          },
        });
      } catch (err) {
        const message = formatError(err);
        dispatch({ type: "set-error", id: connectionId, error: message });
        dispatch({ type: "set-results", id: connectionId, results: null });
        dispatch({
          type: "append-log",
          entry: {
            ...logBase,
            status: "error",
            statementCount: 0,
            durationMs: null,
            message,
          },
        });
      } finally {
        dispatch({ type: "set-running", id: connectionId, running: false });
      }
    },
    [dispatch, state.connections],
  );

  return { runQuery };
}
