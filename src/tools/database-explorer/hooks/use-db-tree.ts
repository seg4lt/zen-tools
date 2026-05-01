/**
 * Lazy fetchers for connection-tree data. Each helper stores results
 * back in the store; concurrent calls for the same key are de-duped via
 * a per-key "in-flight" cache.
 */

import { useCallback } from "react";
import { dbTauri } from "../lib/tauri";
import { useDbExplorerStore } from "../store/db-explorer-store";

const inflight = new Map<string, Promise<unknown>>();

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

export function useDbTree() {
  const { dispatch } = useDbExplorerStore();

  const fetchDatabases = useCallback(
    async (id: string) => {
      try {
        const databases = await dedupe(`db:${id}`, () => dbTauri.listDatabases(id));
        dispatch({ type: "set-databases", id, databases });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("listDatabases failed", err);
      }
    },
    [dispatch],
  );

  const fetchSchemas = useCallback(
    async (id: string, database: string) => {
      try {
        const schemas = await dedupe(`schemas:${id}:${database}`, () =>
          dbTauri.listSchemas(id, database),
        );
        dispatch({ type: "set-schemas", id, database, schemas });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("listSchemas failed", err);
      }
    },
    [dispatch],
  );

  const fetchTables = useCallback(
    async (id: string, database: string, schema: string) => {
      try {
        const tables = await dedupe(`tables:${id}:${database}:${schema}`, () =>
          dbTauri.listTables(id, database, schema),
        );
        dispatch({ type: "set-tables", id, database, schema, tables });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("listTables failed", err);
      }
    },
    [dispatch],
  );

  return { fetchDatabases, fetchSchemas, fetchTables };
}
