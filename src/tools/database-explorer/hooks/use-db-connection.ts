/**
 * Connect / disconnect actions wired to the store.
 */

import { useCallback } from "react";
import { dbTauri } from "../lib/tauri";
import { formatError } from "../lib/format-error";
import { useDbExplorerStore } from "../store/db-explorer-store";

export function useDbConnection() {
  const { dispatch } = useDbExplorerStore();

  const connect = useCallback(
    async (id: string) => {
      dispatch({ type: "set-status", id, status: "connecting", error: null });
      try {
        await dbTauri.connect(id);
        dispatch({ type: "set-status", id, status: "connected" });
      } catch (err) {
        dispatch({
          type: "set-status",
          id,
          status: "error",
          error: formatError(err),
        });
      }
    },
    [dispatch],
  );

  const disconnect = useCallback(
    async (id: string) => {
      try {
        await dbTauri.disconnect(id);
      } finally {
        dispatch({ type: "set-status", id, status: "disconnected" });
      }
    },
    [dispatch],
  );

  return { connect, disconnect };
}
