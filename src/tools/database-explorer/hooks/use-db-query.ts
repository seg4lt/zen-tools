/**
 * Run a SQL string against the active connection and append a per-run
 * result tab into the store. Each call mints a unique `queryId` (also
 * the tab id) so:
 *
 *   • Multiple runs can be in flight at the same time on one
 *     connection — schema indexing won't block them, and they don't
 *     block each other (the registry now uses `&self` access through
 *     the driver's pool, no global per-connection mutex).
 *   • Each tab carries a Stop button while the query is `running`;
 *     clicking it routes through `dbTauri.cancelQuery(tabId)`. The
 *     backend signals the in-flight token; the awaited `dbTauri.query`
 *     resolves with `db: query cancelled`, which we translate into a
 *     `cancelled` tab.
 */

import { useCallback } from "react";
import { dbTauri } from "../lib/tauri";
import { formatError } from "../lib/format-error";
import {
  useDbExplorerStore,
  type QueryLogEntry,
  type ResultTab,
} from "../store/db-explorer-store";

export function makeQueryId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Short, single-line preview of the SQL — used as the tab label
 * fallback and the title-tooltip on running tabs. */
function previewSql(sql: string): string {
  const collapsed = sql.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 120)}…` : collapsed;
}

/** Detect the `db: query cancelled` error shape (produced when the
 * backend's cancellation token fires). The backend wraps DbErrors in
 * AppError with kind:"db" and the message ends in "query cancelled". */
function isCancellationError(err: unknown): boolean {
  const msg = formatError(err).toLowerCase();
  return msg.includes("query cancelled") || msg.includes("cancelled");
}

export function useDbQuery() {
  const { state, dispatch } = useDbExplorerStore();

  const runQuery = useCallback(
    async (
      connectionId: string,
      sql: string,
      opts?: {
        database?: string | null;
        schema?: string | null;
        /** Pass `true` from the "Run with locks" button to attach a
         * `DbLockSummary` to every result tab. */
        captureLocks?: boolean;
        lockSampleIntervalMs?: number;
        /**
         * Optional caller-supplied id. The "Run with…" combo path
         * uses this so the data tab and the EXPLAIN piggyback can
         * agree on one tab strip identity (the EXPLAIN appends its
         * own tab via `captureExplain`; the data run is keyed
         * here). When omitted we mint one.
         */
        queryId?: string;
      },
    ): Promise<{ queryId: string; status: ResultTab["status"] }> => {
      const trimmed = sql.trim();
      if (!trimmed) {
        return { queryId: "", status: "ok" };
      }

      const queryId = opts?.queryId ?? makeQueryId();
      const startedAt = Date.now();
      const sqlPreview = previewSql(trimmed);

      const meta = state.connections.find((c) => c.id === connectionId);
      const logBase: Pick<
        QueryLogEntry,
        "id" | "ts" | "connectionId" | "connectionName" | "driver" | "sql"
      > = {
        id: queryId,
        ts: startedAt,
        connectionId,
        connectionName: meta?.name ?? "(unknown)",
        driver: meta?.driver ?? "?",
        sql: trimmed,
      };

      // Open a `running` tab synchronously so the user sees Stop
      // immediately, even on slow first-byte queries.
      dispatch({
        type: "append-result",
        id: connectionId,
        tab: {
          id: queryId,
          startedAt,
          status: "running",
          sqlPreview,
          kind: "running",
          mode: "data",
        },
        activate: true,
      });
      // Clear the global error one-liner — per-tab errors live on
      // the tab itself now.
      dispatch({ type: "set-error", id: connectionId, error: null });

      try {
        const results = await dbTauri.query(connectionId, trimmed, {
          ...opts,
          queryId,
        });
        // The original behaviour was to fan one Run into N tabs (one
        // per `;`-separated statement). With per-run tabs we keep
        // the strip flat: re-use the running tab for the FIRST
        // statement's result, append additional sibling tabs for any
        // extra statements. They all share the same SQL preview but
        // each carries its own row count + duration.
        if (results.length === 0) {
          dispatch({
            type: "replace-result",
            id: connectionId,
            tabId: queryId,
            tab: {
              id: queryId,
              startedAt,
              status: "ok",
              sqlPreview,
              kind: "data",
              data: {
                statement: trimmed,
                columns: [],
                rows: [],
                rowsAffected: 0,
                durationMs: Date.now() - startedAt,
              },
            },
          });
        } else {
          dispatch({
            type: "replace-result",
            id: connectionId,
            tabId: queryId,
            tab: {
              id: queryId,
              startedAt,
              status: "ok",
              sqlPreview,
              kind: "data",
              data: results[0],
            },
          });
          for (let i = 1; i < results.length; i += 1) {
            dispatch({
              type: "append-result",
              id: connectionId,
              tab: {
                id: `${queryId}#${i}`,
                startedAt,
                status: "ok",
                sqlPreview,
                kind: "data",
                data: results[i],
              },
            });
          }
        }
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
        return { queryId, status: "ok" };
      } catch (err) {
        const message = formatError(err);
        const cancelled = isCancellationError(err);
        dispatch({
          type: "replace-result",
          id: connectionId,
          tabId: queryId,
          tab: cancelled
            ? {
                id: queryId,
                startedAt,
                status: "cancelled",
                sqlPreview,
                kind: "cancelled",
              }
            : {
                id: queryId,
                startedAt,
                status: "error",
                sqlPreview,
                kind: "error",
                error: message,
              },
        });
        dispatch({
          type: "append-log",
          entry: {
            ...logBase,
            status: "error",
            statementCount: 0,
            durationMs: null,
            message: cancelled ? "cancelled" : message,
          },
        });
        return { queryId, status: cancelled ? "cancelled" : "error" };
      }
    },
    [dispatch, state.connections],
  );

  /** Stop a running query by its tab id. Idempotent: stopping a
   * finished tab is a no-op on the backend. */
  const stopQuery = useCallback(async (queryId: string) => {
    try {
      await dbTauri.cancelQuery(queryId);
    } catch {
      // Soft-fail — if the backend can't find the token (already
      // finished, never registered) the running future will resolve
      // on its own; nothing for us to fix up.
    }
  }, []);

  return { runQuery, stopQuery };
}
