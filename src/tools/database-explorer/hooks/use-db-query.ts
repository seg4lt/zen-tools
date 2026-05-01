/**
 * Run a SQL string against the active connection and capture the
 * result + status into the store.
 */

import { useCallback } from "react";
import { dbTauri } from "../lib/tauri";
import { formatError } from "../lib/format-error";
import { useDbExplorerStore } from "../store/db-explorer-store";

export function useDbQuery() {
  const { dispatch } = useDbExplorerStore();

  const runQuery = useCallback(
    async (
      connectionId: string,
      sql: string,
      opts?: { database?: string | null; schema?: string | null },
    ) => {
      const trimmed = sql.trim();
      if (!trimmed) return;
      dispatch({ type: "set-running", id: connectionId, running: true });
      dispatch({ type: "set-error", id: connectionId, error: null });
      try {
        const results = await dbTauri.query(connectionId, trimmed, opts);
        dispatch({ type: "set-results", id: connectionId, results });
      } catch (err) {
        dispatch({ type: "set-error", id: connectionId, error: formatError(err) });
        dispatch({ type: "set-results", id: connectionId, results: null });
      } finally {
        dispatch({ type: "set-running", id: connectionId, running: false });
      }
    },
    [dispatch],
  );

  return { runQuery };
}
