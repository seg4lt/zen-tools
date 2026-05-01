/**
 * Front-end schema-cache façade.
 *
 * The Rust side already persists every `TableDescription` we've ever
 * fetched, but reaching back across the IPC boundary on every
 * keystroke would still be wasteful. This module:
 *
 *   1. Mirrors the cached payloads in a JS `Map`, keyed by
 *      `connId/db/schema/table`.
 *   2. Lets callers `ensureTables(...)` for a list of references — we
 *      hand back the rows that are already in the mirror, and call
 *      `db_describe_tables_bulk` for any that aren't (the backend does
 *      its own cache lookup + background refresh, so the second call
 *      with the same args is essentially free).
 *   3. Subscribes to the `schema-cache-updated` Tauri event and
 *      re-pulls affected rows so anyone listening (the editor's
 *      autocomplete plugin, the explorer freshness badges) sees fresh
 *      data without polling.
 *
 * Module-scope singleton — autocomplete needs a stable shared cache
 * across editor mounts, and there's no per-connection state we
 * couldn't key into a single map.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  dbTauri,
  SCHEMA_CACHE_EVENT,
  type DbRoutineDescription,
  type DbTableDescription,
  type DbTableSummary,
  type SchemaCacheUpdatedEvent,
} from "./tauri";
import { awaitProgressSubscribed } from "./schema-progress";
import {
  extractAliasMap,
  extractTableReferences,
  type TableReference,
} from "./sql-references";

type Key = string;

function makeKey(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
): Key {
  // `/` separator avoids prefix collisions between adjacent fields
  // (e.g. a UUID ending in characters that match the start of a
  // database name). Cheap insurance.
  return `${connectionId}/${database}/${schema}/${table}`;
}

/**
 * Count of tables whose `TableDescription` is currently in the
 * in-memory mirror for `(connectionId, database)`. Used by the
 * cache-status badge to render "X/Y tables indexed" without doing a
 * Tauri round-trip on every render.
 */
export function countCachedTables(
  connectionId: string,
  database: string,
): number {
  const prefix = `${connectionId}/${database}/`;
  let count = 0;
  for (const key of mirror.keys()) {
    if (key.startsWith(prefix)) count += 1;
  }
  return count;
}

/**
 * Every `TableDescription` currently in the mirror for
 * `(connectionId, database)` — across all schemas. Used by the alias
 * completion source to resolve a bare `<table>` reference without
 * caring which schema it lives in.
 *
 * Returns an empty array if the mirror has nothing for this
 * connection. Cheap O(N) scan over the in-memory map; N is bounded by
 * the prefetch limit (and typically <100).
 */
export function readCachedForDatabase(
  connectionId: string,
  database: string,
): DbTableDescription[] {
  const prefix = `${connectionId}/${database}/`;
  const out: DbTableDescription[] = [];
  for (const [key, desc] of mirror) {
    if (key.startsWith(prefix)) out.push(desc);
  }
  return out;
}

/** A subscriber callback. Receives the list of `(db, schema, table)` keys
 * whose payloads just changed (added or refreshed). The connection id
 * is fixed per scope, so the listener is registered with `connectionId`
 * baked in. */
export type SchemaCacheListener = (event: {
  connectionId: string;
  database: string;
  schema: string;
  tables: string[];
}) => void;

const mirror: Map<Key, DbTableDescription> = new Map();
const listeners: Set<SchemaCacheListener> = new Set();

/**
 * Cold catalog: every relation the connection exposes, fetched in one
 * round-trip per `(connectionId, database)`. Keyed by
 * `${connectionId}/${database}` so switching DBs (MSSQL `USE`) doesn't
 * mix catalogs.
 *
 * The catalog is what makes `zen_**` complete to `zen_db` and
 * `zen_db.metri**` complete to `zen_db.metrics` *before* any column
 * fetch has happened — column-level completions still come from the
 * `mirror` once `ensureTables` (or a force-reindex) has populated it.
 */
const catalogs: Map<string, DbTableSummary[]> = new Map();
const catalogInflight: Map<string, Promise<DbTableSummary[]>> = new Map();
const catalogListeners: Set<CatalogListener> = new Set();

function catalogKey(connectionId: string, database: string): string {
  return `${connectionId}/${database}`;
}

/** Catalog listener — fires whenever a `(conn, db)` catalog changes. */
export type CatalogListener = (event: {
  connectionId: string;
  database: string;
  tables: DbTableSummary[];
}) => void;

let unlistenPromise: Promise<UnlistenFn> | null = null;

/**
 * Make sure the global Tauri-event subscription is alive. Lazily
 * initialised on first use so headless tests don't need `__TAURI__`.
 */
function ensureSubscribed(): void {
  if (unlistenPromise) return;
  unlistenPromise = listen<SchemaCacheUpdatedEvent>(
    SCHEMA_CACHE_EVENT,
    async (msg) => {
      const { connectionId, database, schema, tables } = msg.payload;
      if (!tables.length) return;
      // Re-pull the affected rows from the backend cache (which is
      // the canonical source of truth). This second call hits the
      // SQLite cache, not the live database.
      try {
        const refreshed = await dbTauri.describeTablesBulk(
          connectionId,
          database,
          schema,
          tables,
          false,
        );
        for (const desc of refreshed) {
          mirror.set(
            makeKey(connectionId, database, schema, desc.name),
            desc,
          );
        }
      } catch {
        // If the backend can't service the read (e.g. cache file lock
        // contention), fall through and just notify subscribers with
        // whatever we already had. They can re-call `ensureTables`.
      }
      for (const fn of listeners) {
        fn({ connectionId, database, schema, tables });
      }
    },
  );
}

/**
 * Read every currently-known description for `tables` under
 * `(connectionId, database, schema)`. Synchronous — only consults the
 * in-memory mirror.
 */
export function readCached(
  connectionId: string,
  database: string,
  schema: string,
  tables: string[],
): DbTableDescription[] {
  const out: DbTableDescription[] = [];
  for (const t of tables) {
    const desc = mirror.get(makeKey(connectionId, database, schema, t));
    if (desc) out.push(desc);
  }
  return out;
}

/**
 * Make sure the in-memory mirror has whatever the backend can supply
 * for `tables`. Returns the merged set of descriptions known after the
 * call. Missing/stale rows trigger a backend background refresh; those
 * land later via the `schema-cache-updated` event.
 *
 * Safe to call on every keystroke — the backend bulk command is cheap
 * (single SQLite read + at most one async refresh batch per call).
 */
export async function ensureTables(
  connectionId: string,
  database: string,
  schema: string,
  tables: string[],
): Promise<DbTableDescription[]> {
  ensureSubscribed();
  if (!tables.length) return [];

  // Filter to tables we don't already mirror — the bulk call still
  // works with already-cached names, but skipping the round-trip
  // entirely is cheaper for typing latency.
  const missing = tables.filter(
    (t) => !mirror.has(makeKey(connectionId, database, schema, t)),
  );

  if (missing.length) {
    try {
      // Pre-warm the progress listener so the backend's `started`
      // event isn't lost on fast cache-hit-but-stale paths (the
      // server schedules a background refresh and emits progress
      // immediately; without the listener the chip wouldn't show).
      await awaitProgressSubscribed();
      const fetched = await dbTauri.describeTablesBulk(
        connectionId,
        database,
        schema,
        missing,
        false,
      );
      for (const desc of fetched) {
        mirror.set(
          makeKey(connectionId, database, schema, desc.name),
          desc,
        );
      }
    } catch {
      // Swallow: a missing table or a transient driver error
      // shouldn't block typing. Subsequent calls will retry.
    }
  }

  return readCached(connectionId, database, schema, tables);
}

/**
 * Force a fresh fetch + cache upsert for the named tables, bypassing
 * both the in-memory mirror and the backend's TTL check. Used by the
 * Opt+Enter actions and the DB-explorer "Index table" right-click.
 */
export async function forceReindex(
  connectionId: string,
  database: string,
  schema: string,
  tables: string[],
): Promise<DbTableDescription[]> {
  ensureSubscribed();
  if (!tables.length) return [];
  // Same pre-warm as `ensureTables`: the backend emits the first
  // progress event before the foreground reindex loop starts, and we
  // want it to land in the chip even on tiny single-table refreshes.
  await awaitProgressSubscribed();
  const fetched = await dbTauri.describeTablesBulk(
    connectionId,
    database,
    schema,
    tables,
    true,
  );
  for (const desc of fetched) {
    mirror.set(makeKey(connectionId, database, schema, desc.name), desc);
  }
  // Notify listeners ourselves — the backend already emitted, but the
  // listener re-fetches and overwrites the same rows, which is a
  // harmless no-op.
  for (const fn of listeners) {
    fn({ connectionId, database, schema, tables: fetched.map((d) => d.name) });
  }
  return fetched;
}

/**
 * Clear cache rows. `tables.length === 0` means "everything under this
 * (connection, database, schema)". The next `ensureTables` call will
 * re-fetch.
 */
export async function invalidate(
  connectionId: string,
  database: string,
  schema: string,
  tables: string[],
): Promise<void> {
  await dbTauri.invalidateSchemaCache(connectionId, database, schema, tables);
  if (tables.length) {
    for (const t of tables) {
      mirror.delete(makeKey(connectionId, database, schema, t));
    }
  } else {
    const prefix = `${connectionId}/${database}/${schema}/`;
    for (const key of [...mirror.keys()]) {
      if (key.startsWith(prefix)) mirror.delete(key);
    }
  }
}

/** Subscribe to mirror updates. Returns an unsubscribe function. */
export function subscribe(listener: SchemaCacheListener): () => void {
  ensureSubscribed();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ─── Catalog (cold-start completions) ────────────────────────────────

/**
 * Read the currently-known catalog for `(connectionId, database)`.
 * Returns an empty array if `ensureCatalog` hasn't run (or is still in
 * flight). Synchronous — for use in render paths.
 */
export function readCatalog(
  connectionId: string,
  database: string,
): DbTableSummary[] {
  return catalogs.get(catalogKey(connectionId, database)) ?? [];
}

/**
 * Make sure the catalog for `(connectionId, database)` is loaded.
 * The first call kicks off the backend round-trip; subsequent calls
 * (until `forceRefreshCatalog`) reuse the cached array. Concurrent
 * callers share a single in-flight promise.
 *
 * Catalogs are deliberately session-scoped — they live in module
 * memory so they don't survive app restart. The backend round-trip
 * is ~1 query, so the cost on next launch is negligible.
 */
export async function ensureCatalog(
  connectionId: string,
  database: string,
): Promise<DbTableSummary[]> {
  const key = catalogKey(connectionId, database);
  const existing = catalogs.get(key);
  if (existing) return existing;
  const inflight = catalogInflight.get(key);
  if (inflight) return inflight;

  // Make sure the progress listener is wired BEFORE we fire the
  // backend command. The catalog query can complete in tens of ms on
  // a small DB — well inside the time `listen()` takes to register —
  // and a missed `started`/`done` pair would mean the progress chip
  // never appears.
  const promise = awaitProgressSubscribed()
    .then(() => dbTauri.listAllTables(connectionId, database))
    .then((rows) => {
      catalogs.set(key, rows);
      catalogInflight.delete(key);
      for (const fn of catalogListeners) {
        fn({ connectionId, database, tables: rows });
      }
      return rows;
    })
    .catch((err) => {
      catalogInflight.delete(key);
      throw err;
    });
  catalogInflight.set(key, promise);
  return promise;
}

/** Force a refresh of the catalog (e.g. after the user creates a new
 * table externally and wants the new name in autocomplete). */
export async function forceRefreshCatalog(
  connectionId: string,
  database: string,
): Promise<DbTableSummary[]> {
  catalogs.delete(catalogKey(connectionId, database));
  catalogInflight.delete(catalogKey(connectionId, database));
  return ensureCatalog(connectionId, database);
}

/** Subscribe to catalog changes. */
export function subscribeCatalog(listener: CatalogListener): () => void {
  catalogListeners.add(listener);
  return () => catalogListeners.delete(listener);
}

/** Diagnostic: dump every mirrored row (mainly for tests). */
export function _debugSnapshot(): DbTableDescription[] {
  return [...mirror.values()];
}

// ─── Run-triggered indexing ─────────────────────────────────────────

/**
 * Ensure-tables for every reference in a SQL string, bucketed by
 * schema. Used by both the editor's typing-debounce flush and the
 * Run-button / Mod-Enter path so that executing a query also seeds
 * the cache for its tables (if not already present). Fire-and-forget;
 * the caller doesn't need to await.
 *
 * `defaultSchema` is the schema that bare table refs (`FROM users`)
 * are assumed to belong to. Cross-schema refs (`FROM other.users`)
 * are dispatched in their own bucket.
 */
export function ensureTablesForSql(
  connectionId: string,
  database: string,
  defaultSchema: string,
  sqlText: string,
): void {
  const refs = extractTableReferences(sqlText);
  if (refs.length === 0) return;

  // Drop "qualified" refs whose schema part is actually a table
  // alias declared in the same buffer. Without this filter, the
  // QUALIFIED_RE pass in `extractTableReferences` treats `e.happ`
  // (an `<alias>.<column>` reference) as a `<schema>.<table>` and
  // makes us fire an `ensureTables(..., "e", ["happ"])` that the
  // backend can't fulfil — wasting a round-trip and lighting up the
  // progress chip with a phantom "indexing happ" entry on every run.
  // The chip is then a lie: nothing is actually being indexed.
  const aliases = extractAliasMap(sqlText);
  const filtered: TableReference[] = refs.filter(
    (r) => !(r.schema !== null && r.schema in aliases),
  );
  if (filtered.length === 0) return;

  // Catalog tells us which schema(s) each bare table actually lives in.
  // Without this, a `FROM events e` whose table happens to be in
  // `app` (not `public`) would never fetch — we'd ask the backend for
  // `public.events`, which doesn't exist, and the alias would never
  // resolve to columns. Since the catalog is loaded eagerly on
  // connect, it's nearly always already in memory by the time the
  // user starts typing.
  const catalog = readCatalog(connectionId, database);

  const buckets = new Map<string, Set<string>>();
  const pushTo = (schema: string, table: string) => {
    const set = buckets.get(schema) ?? new Set();
    set.add(table);
    buckets.set(schema, set);
  };

  for (const r of filtered) {
    if (r.schema) {
      // Qualified — caller already named the schema, trust them.
      pushTo(r.schema, r.table);
      continue;
    }
    // Bare ref. Find every catalog entry matching the table name and
    // ensure it for each owning schema. If the catalog doesn't know
    // about it (yet/at all), fall back to the editor's default schema
    // — backend will return an error and we'll just skip the cache
    // upsert.
    const matches = catalog.filter((t) => t.name === r.table);
    if (matches.length === 0) {
      pushTo(defaultSchema, r.table);
    } else {
      for (const m of matches) pushTo(m.schema, m.name);
    }
  }

  // Final mirror filter: only keep schema buckets that actually have
  // at least one table NOT yet in the in-memory mirror. If every
  // table in the SQL is already cached, this short-circuits without
  // touching the backend at all — exactly matching the
  // "only-fetch-if-stale-or-missing" contract for query-run-driven
  // ensures. (The backend would also short-circuit, but skipping the
  // RPC entirely keeps the chip silent and the wire idle.)
  for (const [schema, names] of buckets) {
    const namesArr = [...names];
    const needsFetch = namesArr.some(
      (t) => !mirror.has(makeKey(connectionId, database, schema, t)),
    );
    if (!needsFetch) continue;
    void ensureTables(connectionId, database, schema, namesArr).catch(() => {});
  }
}

// ─── Routines (per-schema, session-only) ────────────────────────────

/**
 * Routines (stored procedures + functions) live under the per-schema
 * "Routines" folder of the DB tree. Unlike `TableDescription`, they
 * are **session-only** — no `schema_cache.db` persistence:
 *
 *   - One backend round-trip per `(conn, db, schema)`, cheap.
 *   - Routine churn often aligns with active schema migrations the
 *     user is iterating on; stale persisted entries would cause more
 *     confusion than they save typing latency.
 *
 * The cache lives in module scope, mirrors the catalog's pattern,
 * and de-dupes concurrent callers via `inflight`.
 */
type RoutineKey = string;

function routineKey(
  connectionId: string,
  database: string,
  schema: string,
): RoutineKey {
  return `${connectionId}/${database}/${schema}`;
}

const routineCache: Map<RoutineKey, DbRoutineDescription[]> = new Map();
const routineInflight: Map<RoutineKey, Promise<DbRoutineDescription[]>> =
  new Map();
/**
 * Per-`(conn, db, schema)` unix-ms timestamp of the most recent
 * routine fetch. The DB-tree exposes it as a "Cached X ago" tooltip
 * on each routine leaf — same affordance the table rows carry.
 */
const routineFetchedAt: Map<RoutineKey, number> = new Map();

/** Routine subscribers fire when a `(conn, db, schema)` bucket
 * changes (loaded for the first time, or refreshed). */
export type RoutineListener = (event: {
  connectionId: string;
  database: string;
  schema: string;
  routines: DbRoutineDescription[];
}) => void;

const routineListeners: Set<RoutineListener> = new Set();

/** Synchronous read for the currently-known routines under a
 * schema. Returns `[]` until `ensureRoutines` resolves. */
export function readRoutines(
  connectionId: string,
  database: string,
  schema: string,
): DbRoutineDescription[] {
  return routineCache.get(routineKey(connectionId, database, schema)) ?? [];
}

/**
 * Make sure the routine list for `(conn, db, schema)` is loaded.
 * Concurrent callers share one in-flight promise. Re-call after
 * `refreshRoutines` to re-fetch.
 */
export async function ensureRoutines(
  connectionId: string,
  database: string,
  schema: string,
): Promise<DbRoutineDescription[]> {
  const key = routineKey(connectionId, database, schema);
  const existing = routineCache.get(key);
  if (existing) return existing;
  const inflight = routineInflight.get(key);
  if (inflight) return inflight;

  const promise = dbTauri
    .listRoutines(connectionId, database, schema)
    .then((rows) => {
      routineCache.set(key, rows);
      routineFetchedAt.set(key, Date.now());
      routineInflight.delete(key);
      for (const fn of routineListeners) {
        fn({ connectionId, database, schema, routines: rows });
      }
      return rows;
    })
    .catch((err) => {
      routineInflight.delete(key);
      throw err;
    });
  routineInflight.set(key, promise);
  return promise;
}

/** Unix-ms timestamp of the last routine fetch for `(conn, db,
 * schema)`, or `undefined` if never fetched. Used by the DB-tree
 * tooltip — same "Cached X ago" affordance the table rows carry. */
export function readRoutinesFetchedAt(
  connectionId: string,
  database: string,
  schema: string,
): number | undefined {
  return routineFetchedAt.get(routineKey(connectionId, database, schema));
}

/** Force-refresh after the user (or external migration) might have
 * created new routines. Drops the cached list, then re-ensures. */
export async function refreshRoutines(
  connectionId: string,
  database: string,
  schema: string,
): Promise<DbRoutineDescription[]> {
  const key = routineKey(connectionId, database, schema);
  routineCache.delete(key);
  routineInflight.delete(key);
  routineFetchedAt.delete(key);
  return ensureRoutines(connectionId, database, schema);
}

/** Subscribe to routine-cache updates. */
export function subscribeRoutines(listener: RoutineListener): () => void {
  routineListeners.add(listener);
  return () => routineListeners.delete(listener);
}
