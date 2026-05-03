/**
 * DataGrip-style tree of databases > schemas > {tables, routines}.
 * Tables expand into six metadata sub-folders (Columns / Keys /
 * Foreign keys / Indexes / Checks / Triggers); routines are leaf
 * rows showing function/procedure signatures.
 *
 * Top of the rail carries a search box that filters the whole tree
 * by name, with optional `kind > name` syntax to scope to one
 * metadata kind. See `lib/db-tree-search.ts` for the DSL details.
 *
 * All children are fetched lazily on first expansion. Per-table
 * metadata rides through the existing `schema_cache.db` (extended in
 * this revision to carry keys/checks/triggers); per-schema routines
 * use a session-only cache in `schema-cache.ts`.
 *
 * Each table row carries a small dot indicating schema-cache
 * freshness. Right-clicking a table triggers an explicit reindex.
 * Hovering a schema row reveals a "Refresh cache" action that
 * `forceReindex`'es every cached table in the schema + refetches
 * the routine list.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cog,
  Database,
  FolderOpen,
  Folder,
  KeyRound,
  Link2,
  ListTree,
  RefreshCw,
  Search,
  ShieldCheck,
  Sigma,
  Table,
  Type,
  X,
  Zap,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@zen-tools/ui";
import { useDbExplorerStore } from "../store/db-explorer-store";
import { useDbTree } from "../hooks/use-db-tree";
import {
  dbTauri,
  type DbCheckDescription,
  type DbColumnDescription,
  type DbForeignKeyDescription,
  type DbIndexDescription,
  type DbKeyDescription,
  type DbRoutineDescription,
  type DbTableDescription,
  type DbTriggerDescription,
} from "../lib/tauri";
import {
  ensureRoutines,
  ensureTables,
  forceReindex,
  readCached,
  readCachedForDatabase,
  readRoutinesFetchedAt,
  refreshRoutines,
  subscribe as subscribeSchemaCache,
  subscribeRoutines,
} from "../lib/schema-cache";
import {
  emptyResult,
  evaluateQuery,
  parseQuery,
  type SearchResult,
  type TableSubfolder,
} from "../lib/db-tree-search";

/**
 * Cache rows older than this are flagged "stale" by the freshness
 * badge. Mirrors the backend's `DEFAULT_TTL_MS` so the dot lights up
 * just before the next typing pass would auto-refresh.
 */
const FRESHNESS_TTL_MS = 24 * 60 * 60 * 1000;

const SearchContext = createContext<SearchResult>(emptyResult());

function useSearch(): SearchResult {
  return useContext(SearchContext);
}

export function DbTree() {
  const { state, dispatch } = useDbExplorerStore();
  const { fetchDatabases, fetchSchemas, fetchTables } = useDbTree();
  const id = state.activeConnectionId;
  const status = id ? state.status[id] : undefined;
  const tree = id ? state.trees[id] : undefined;
  const databases = tree?.databases;
  const schemasByDb = tree?.schemasByDb;
  const tablesBySchema = tree?.tablesBySchema;
  const routinesBySchema = tree?.routinesBySchema;

  const [query, setQuery] = useState("");
  const parsed = useMemo(() => parseQuery(query), [query]);

  // Snapshot the current tree state + the in-memory mirror for the
  // search evaluator. `cachedTables` covers every table this session
  // has described so far; columns/fks/etc. of un-described tables
  // are silently skipped (the user can right-click → Index table to
  // pull more in).
  const searchResult = useMemo(() => {
    if (!parsed || !id) return emptyResult();
    const conn = tree;
    if (!conn) return emptyResult();
    return evaluateQuery(parsed, {
      schemasByDb: conn.schemasByDb,
      tablesBySchema: conn.tablesBySchema,
      routinesBySchema: conn.routinesBySchema,
      cachedTables: id ? readCachedForDatabase(id, currentDatabase(state, id) ?? "") : [],
    });
  }, [parsed, id, tree, state]);

  // Auto-load databases on first connect.
  useEffect(() => {
    if (id && status === "connected" && !databases) {
      fetchDatabases(id);
    }
  }, [id, status, databases, fetchDatabases]);

  // Eagerly fetch schemas for every database so the search box has a
  // complete catalogue to filter against. Without this, typing a
  // pattern before the user has expanded any database returns "no
  // matches in loaded data" — even when the schemas would obviously
  // match. The `useDbTree` hook dedupes in-flight calls per
  // (connection, database), so re-running this effect is safe.
  useEffect(() => {
    if (!id || status !== "connected" || !databases || !schemasByDb) return;
    for (const db of databases) {
      if (schemasByDb[db] === undefined) {
        fetchSchemas(id, db);
      }
    }
  }, [id, status, databases, schemasByDb, fetchSchemas]);

  // Same for tables — once a schema is known, pre-fetch its table
  // list. Cheap (single SQL roundtrip per schema, no column data),
  // and means search finds tables across schemas the user hasn't
  // expanded yet.
  useEffect(() => {
    if (!id || status !== "connected" || !schemasByDb || !tablesBySchema)
      return;
    for (const [db, schemas] of Object.entries(schemasByDb)) {
      for (const schema of schemas) {
        const key = `${db}/${schema}`;
        if (tablesBySchema[key] === undefined) {
          fetchTables(id, db, schema);
        }
      }
    }
  }, [id, status, schemasByDb, tablesBySchema, fetchTables]);

  // And routines — `proc > *`, `fn > *`, `routine > *` searches need
  // the routine list loaded just like schemas/tables. One RPC per
  // schema; the session-only mirror in `schema-cache.ts` dedupes.
  // Once fetched, routines never auto-refresh — the user explicitly
  // refreshes via the per-schema cache-refresh hover button.
  useEffect(() => {
    if (!id || status !== "connected" || !schemasByDb || !routinesBySchema)
      return;
    for (const [db, schemas] of Object.entries(schemasByDb)) {
      for (const schema of schemas) {
        const key = `${db}/${schema}`;
        if (routinesBySchema[key] !== undefined) continue;
        void ensureRoutines(id, db, schema)
          .then((rows) =>
            dispatch({
              type: "set-routines",
              id,
              database: db,
              schema,
              routines: rows,
            }),
          )
          // Soft-fail: on backend error, store an empty list so the
          // UI doesn't get stuck in a "loading…" loop on the
          // Routines folder.
          .catch(() =>
            dispatch({
              type: "set-routines",
              id,
              database: db,
              schema,
              routines: [],
            }),
          );
      }
    }
  }, [id, status, schemasByDb, routinesBySchema, dispatch]);

  if (!id) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        Select a connection to browse its databases.
      </div>
    );
  }
  if (status !== "connected") {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        Connect to view databases.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 px-1 py-2">
      {/* `sticky` pins the search box at the top of the tree's
          scroll viewport — the outer `<aside>` in
          DatabaseExplorerView already has `overflow-auto`, so this
          input never scrolls out of reach no matter how deep the
          tree gets. The wrapper carries a solid bg so rows behind
          it don't bleed through. */}
      <div className="sticky top-0 z-10 -mx-1 -mt-2 bg-background px-1 pb-1 pt-2">
        <SearchBox value={query} onChange={setQuery} result={searchResult} />
      </div>
      {!tree?.databases ? (
        <div className="px-3 py-4 text-xs text-muted-foreground">Loading…</div>
      ) : (
        <SearchContext.Provider value={searchResult}>
          <span className="px-2 pt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            Databases
          </span>
          {tree.databases.map((db) => (
            <DatabaseNode key={db} connectionId={id} database={db} />
          ))}
        </SearchContext.Provider>
      )}
    </div>
  );
}

/** Pulls the active database for this connection out of the store —
 * the editor stores it as a per-connection value. Falls back to the
 * connection's default DB if the user hasn't picked one. */
function currentDatabase(
  state: ReturnType<typeof useDbExplorerStore>["state"],
  id: string,
): string | null {
  const explicit = state.activeDbByConnection[id];
  if (explicit) return explicit;
  const conn = state.connections.find((c) => c.id === id);
  return conn?.database ?? null;
}

// ─── Search box ─────────────────────────────────────────────────────

/**
 * One row in the syntax-help popover. `prefix` is what the click
 * inserts (with a trailing space — user types the rest); `example`
 * is the rendered hint text.
 */
const SEARCH_KIND_HINTS: Array<{
  prefix: string;
  example: string;
  hint: string;
}> = [
  { prefix: "table > ", example: "table > orders*", hint: "tables only" },
  { prefix: "column > ", example: "column > email", hint: "column names only" },
  { prefix: "fk > ", example: "fk > orders_*", hint: "foreign keys" },
  { prefix: "key > ", example: "key > pk_*", hint: "PRIMARY + UNIQUE keys" },
  { prefix: "index > ", example: "index > *_idx", hint: "indexes" },
  { prefix: "check > ", example: "check > *_age_*", hint: "CHECK constraints" },
  { prefix: "trigger > ", example: "trigger > *_audit", hint: "triggers" },
  { prefix: "proc > ", example: "proc > archive_*", hint: "stored procedures" },
  { prefix: "fn > ", example: "fn > format_*", hint: "functions" },
  { prefix: "routine > ", example: "routine > *", hint: "fns + procs" },
  { prefix: "schema > ", example: "schema > metric*", hint: "schemas (full subtree)" },
];

function SearchBox({
  value,
  onChange,
  result,
}: {
  value: string;
  onChange: (v: string) => void;
  result: SearchResult;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div>
      <div className="flex items-center gap-1 rounded border border-border/60 bg-background px-2 py-1 focus-within:border-primary">
        <Search className="size-3 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Filter · name, name*, kind > name"
          className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
        {value ? (
          <button
            type="button"
            onClick={() => onChange("")}
            className="text-muted-foreground hover:text-foreground"
            title="Clear filter"
          >
            <X className="size-3" />
          </button>
        ) : null}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              title="Filter syntax"
              aria-label="Filter syntax help"
            >
              <CircleHelp className="size-3" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="end"
            className="w-80 p-0 text-xs"
            // Don't yank focus away from the input — letting the user
            // pick a kind chip and keep typing is the whole point.
            onOpenAutoFocus={(ev) => ev.preventDefault()}
          >
            <div className="border-b border-border/60 px-3 py-2">
              <div className="font-medium">Filter syntax</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Plain <code>name</code> = substring match.{" "}
                <code>name*</code>, <code>*name</code>, or{" "}
                <code>head*tail</code> = glob (anchored).
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                <code>kind &gt; pattern</code> restricts to one node
                kind. Tap a chip below to insert.
              </div>
            </div>
            <div className="grid max-h-64 grid-cols-1 gap-0 overflow-auto p-1">
              {SEARCH_KIND_HINTS.map((h) => (
                <button
                  key={h.prefix}
                  type="button"
                  onClick={() => {
                    onChange(h.prefix);
                    // Restore focus to the input so the user can
                    // type immediately after the prefix.
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                  className="flex items-center justify-between gap-2 rounded px-2 py-1 text-left hover:bg-muted/60"
                  title={h.hint}
                >
                  <span className="font-mono text-[11px] text-foreground">
                    {h.example}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {h.hint}
                  </span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {result.active ? (
        <div className="px-2 pt-1 text-[10px] tabular-nums text-muted-foreground/70">
          {result.totalMatches > 0
            ? `${result.totalMatches} match${result.totalMatches === 1 ? "" : "es"}`
            : "no matches in loaded data"}
        </div>
      ) : null}
    </div>
  );
}

// ─── Database / Schema ───────────────────────────────────────────────

function DatabaseNode({
  connectionId,
  database,
}: {
  connectionId: string;
  database: string;
}) {
  const { state } = useDbExplorerStore();
  const { fetchSchemas } = useDbTree();
  const search = useSearch();
  const [localOpen, setLocalOpen] = useState(false);
  const schemas = state.trees[connectionId]?.schemasByDb[database];

  const visible = !search.active || search.visibleDatabases.has(database);
  const forceOpen = search.active && search.visibleDatabases.has(database);
  const open = forceOpen || localOpen;

  // Fetch schemas the moment we go open — covers both manual toggle
  // and search-driven force-open.
  useEffect(() => {
    if (open && schemas === undefined) {
      fetchSchemas(connectionId, database);
    }
  }, [open, schemas, connectionId, database, fetchSchemas]);

  if (!visible) return null;

  return (
    <div>
      <Row
        depth={0}
        onClick={() => setLocalOpen(!localOpen)}
        icon={<Database className="h-3 w-3 text-muted-foreground" />}
        chevron={
          open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )
        }
        label={database}
      />
      {open && (
        <div>
          {schemas === undefined ? (
            <Row depth={1} muted label="Loading…" />
          ) : schemas.length === 0 ? (
            <Row depth={1} muted label="(no schemas)" />
          ) : (
            schemas.map((s) => (
              <SchemaNode
                key={s}
                connectionId={connectionId}
                database={database}
                schema={s}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SchemaNode({
  connectionId,
  database,
  schema,
}: {
  connectionId: string;
  database: string;
  schema: string;
}) {
  const { state } = useDbExplorerStore();
  const search = useSearch();
  const [localOpen, setLocalOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const schemaId = `${database}/${schema}`;
  const visible = !search.active || search.visibleSchemas.has(schemaId);
  const forceOpen = search.active && search.visibleSchemas.has(schemaId);
  const open = forceOpen || localOpen;

  // Hover action — explicit user-driven cache refresh for everything
  // under this schema. Forces re-describe of every cached table here
  // and re-fetches routines. Uncached tables stay uncached (consistent
  // with the no-auto-update contract); the user can right-click a
  // specific table to pull it in for the first time.
  const refreshSchema = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const cached = state.trees[connectionId]?.tablesBySchema[schemaId] ?? [];
      // Filter to tables that already have something in the
      // session mirror; reindexing tables we've never described is
      // unnecessary work and would distort the freshness chart.
      const allCached = readCachedForDatabase(connectionId, database);
      const cachedNames = new Set(
        allCached.filter((d) => d.schema === schema).map((d) => d.name),
      );
      const targets = cached.filter((t) => cachedNames.has(t));
      if (targets.length > 0) {
        await forceReindex(connectionId, database, schema, targets);
      }
      await refreshRoutines(connectionId, database, schema);
    } finally {
      setRefreshing(false);
    }
  };

  if (!visible) return null;

  return (
    <div className="group">
      <Row
        depth={1}
        onClick={() => setLocalOpen(!localOpen)}
        icon={<FolderOpen className="h-3 w-3 text-muted-foreground" />}
        chevron={
          open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )
        }
        label={schema}
        adornment={
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation();
              void refreshSchema();
            }}
            disabled={refreshing}
            title="Refresh cache for every cached table + routines in this schema"
            className={
              "ml-auto opacity-0 transition group-hover:opacity-100 hover:text-foreground " +
              (refreshing ? "opacity-100 text-primary" : "text-muted-foreground")
            }
          >
            <RefreshCw
              className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`}
            />
          </button>
        }
      />
      {open && (
        <>
          <TablesFolder
            connectionId={connectionId}
            database={database}
            schema={schema}
          />
          <RoutinesFolder
            connectionId={connectionId}
            database={database}
            schema={schema}
          />
        </>
      )}
    </div>
  );
}

// ─── Per-schema folders ──────────────────────────────────────────────

function TablesFolder({
  connectionId,
  database,
  schema,
}: {
  connectionId: string;
  database: string;
  schema: string;
}) {
  const { state, dispatch } = useDbExplorerStore();
  const { fetchTables } = useDbTree();
  const search = useSearch();
  const [localOpen, setLocalOpen] = useState(true); // open by default — DataGrip parity
  const key = `${database}/${schema}`;
  const tables = state.trees[connectionId]?.tablesBySchema[key];

  // When search is active, open the folder iff any of its tables is
  // in the visible set. Otherwise honour the local toggle.
  const hasMatchingTable =
    search.active &&
    !!tables?.some((t) => search.visibleTables.has(`${key}/${t}`));
  const open = (search.active ? hasMatchingTable : localOpen) || localOpen;

  // Fetch tables when the folder goes open — handles both manual
  // toggle and the search-active force-open.
  useEffect(() => {
    if (open && tables === undefined) {
      fetchTables(connectionId, database, schema);
    }
  }, [open, tables, connectionId, database, schema, fetchTables]);

  /**
   * Hydrate `schemaIndexedAt` for this schema's tables when the user
   * opens the folder. Cheap (one SQLite read), so we re-pull on every
   * open in case another tab/session invalidated rows.
   */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await dbTauri.listCachedTables(
          connectionId,
          database,
          schema,
        );
        if (cancelled) return;
        dispatch({
          type: "set-schema-indexed-at",
          entries: rows.map((r) => ({
            id: connectionId,
            database,
            schema,
            table: r.name,
            indexedAt: r.indexedAt,
          })),
        });
      } catch {
        // Cache file inaccessible — leave dots in their "unknown" state.
      }
    })();
    const unsub = subscribeSchemaCache((event) => {
      if (
        event.connectionId !== connectionId ||
        event.database !== database ||
        event.schema !== schema
      )
        return;
      const now = Date.now();
      dispatch({
        type: "set-schema-indexed-at",
        entries: event.tables.map((t) => ({
          id: connectionId,
          database,
          schema,
          table: t,
          indexedAt: now,
        })),
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [open, connectionId, database, schema, dispatch]);

  // Filter: when search is active, hide tables that aren't in the
  // visible set.
  const visibleTables = useMemo(() => {
    if (!tables) return undefined;
    if (!search.active) return tables;
    return tables.filter((t) => search.visibleTables.has(`${key}/${t}`));
  }, [tables, search.active, search.visibleTables, key]);

  // Hide the entire folder when search is active and there's nothing
  // matching inside it.
  if (search.active && visibleTables && visibleTables.length === 0) {
    return null;
  }

  return (
    <div>
      <Row
        depth={2}
        onClick={() => setLocalOpen(!localOpen)}
        icon={<Folder className="h-3 w-3 text-muted-foreground" />}
        chevron={
          open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )
        }
        label="Tables"
        adornment={
          tables ? (
            <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/60">
              {search.active && visibleTables
                ? `${visibleTables.length}/${tables.length}`
                : tables.length}
            </span>
          ) : null
        }
      />
      {open && (
        <div>
          {visibleTables === undefined ? (
            <Row depth={3} muted label="Loading…" />
          ) : visibleTables.length === 0 ? (
            <Row depth={3} muted label="(none)" />
          ) : (
            visibleTables.map((t) => (
              <TableNode
                key={t}
                connectionId={connectionId}
                database={database}
                schema={schema}
                table={t}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function RoutinesFolder({
  connectionId,
  database,
  schema,
}: {
  connectionId: string;
  database: string;
  schema: string;
}) {
  const { state, dispatch } = useDbExplorerStore();
  const search = useSearch();
  const [localOpen, setLocalOpen] = useState(false);
  const key = `${database}/${schema}`;
  const routines = state.trees[connectionId]?.routinesBySchema[key];

  // Force-open iff at least one routine is visible.
  const hasMatchingRoutine =
    search.active &&
    !!routines?.some((r) => search.visibleRoutines.has(`${key}/${r.name}`));
  const open = hasMatchingRoutine || localOpen;

  // First open kicks the backend; subsequent opens read from the
  // session cache.
  useEffect(() => {
    if (!open) return;
    if (routines !== undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await ensureRoutines(connectionId, database, schema);
        if (cancelled) return;
        dispatch({
          type: "set-routines",
          id: connectionId,
          database,
          schema,
          routines: rows,
        });
      } catch {
        if (cancelled) return;
        dispatch({
          type: "set-routines",
          id: connectionId,
          database,
          schema,
          routines: [],
        });
      }
    })();
    const unsub = subscribeRoutines((event) => {
      if (
        event.connectionId !== connectionId ||
        event.database !== database ||
        event.schema !== schema
      )
        return;
      dispatch({
        type: "set-routines",
        id: connectionId,
        database,
        schema,
        routines: event.routines,
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [open, routines, connectionId, database, schema, dispatch]);

  const visibleRoutines = useMemo(() => {
    if (!routines) return undefined;
    if (!search.active) return routines;
    return routines.filter((r) => search.visibleRoutines.has(`${key}/${r.name}`));
  }, [routines, search.active, search.visibleRoutines, key]);

  if (search.active && visibleRoutines && visibleRoutines.length === 0) {
    return null;
  }

  // Recompute the routine fetched-at on every render — `routines`
  // updating in the store guarantees we re-render whenever the cache
  // ticks, and `Date.now()` inside `cachedSuffix` keeps the tooltip
  // age fresh.
  const routinesIndexedAt = readRoutinesFetchedAt(connectionId, database, schema);

  return (
    <div>
      <Row
        depth={2}
        onClick={() => setLocalOpen(!localOpen)}
        icon={<Sigma className="h-3 w-3 text-muted-foreground" />}
        chevron={
          open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )
        }
        label="Routines"
        adornment={
          routines ? (
            <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/60">
              {search.active && visibleRoutines
                ? `${visibleRoutines.length}/${routines.length}`
                : routines.length}
            </span>
          ) : null
        }
        title={`Routines (${routines?.length ?? 0})${cachedSuffix(routinesIndexedAt)}`}
      />
      {open && (
        <div>
          {visibleRoutines === undefined ? (
            <Row depth={3} muted label="Loading…" />
          ) : visibleRoutines.length === 0 ? (
            <Row depth={3} muted label="(none)" />
          ) : (
            visibleRoutines.map((r) => (
              <RoutineLeaf
                key={`${r.kind}:${r.name}`}
                routine={r}
                indexedAt={routinesIndexedAt}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Table expansion (six metadata sub-folders) ──────────────────────

function TableNode({
  connectionId,
  database,
  schema,
  table,
}: {
  connectionId: string;
  database: string;
  schema: string;
  table: string;
}) {
  const { state } = useDbExplorerStore();
  const search = useSearch();
  const [localOpen, setLocalOpen] = useState(false);
  const tableId = `${database}/${schema}/${table}`;
  const indexedAt =
    state.schemaIndexedAt[`${connectionId}/${database}/${schema}/${table}`];

  const visible = !search.active || search.visibleTables.has(tableId);
  const forceOpen = search.active && search.visibleTables.has(tableId);
  const open = forceOpen || localOpen;

  const cached = readCached(connectionId, database, schema, [table])[0];

  useEffect(() => {
    if (!open || cached) return;
    void ensureTables(connectionId, database, schema, [table]).catch(() => {});
  }, [open, cached, connectionId, database, schema, table]);

  const onContextMenu = (ev: React.MouseEvent) => {
    ev.preventDefault();
    void forceReindex(connectionId, database, schema, [table]);
  };

  if (!visible) return null;

  return (
    <div>
      <Row
        depth={3}
        onClick={() => setLocalOpen(!localOpen)}
        icon={<Table className="h-3 w-3 text-muted-foreground" />}
        chevron={
          open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )
        }
        label={table}
        adornment={<FreshnessDot indexedAt={indexedAt} />}
        title={
          indexedAt
            ? `Cached ${formatRelative(indexedAt)} · right-click to reindex`
            : "Not cached yet · right-click to index"
        }
        onContextMenu={onContextMenu}
      />
      {open && (
        <TableDetails
          depth={4}
          desc={cached}
          tableId={tableId}
          indexedAt={indexedAt}
        />
      )}
    </div>
  );
}

function TableDetails({
  depth,
  desc,
  tableId,
  indexedAt,
}: {
  depth: number;
  desc: DbTableDescription | undefined;
  tableId: string;
  /** When the parent `TableNode`'s description was last cached. Threaded
   * down so every leaf can render a "cached X ago" suffix in its
   * tooltip — same source, same age across all children. */
  indexedAt: number | undefined;
}) {
  const search = useSearch();
  if (!desc) {
    return <Row depth={depth} muted label="Loading…" />;
  }

  const fullExpand = search.active && search.fullExpandTables.has(tableId);
  const subfolderHits = search.tableSubfolderVisible.get(tableId);

  // When search is active, a subfolder renders if (a) the table
  // fullExpand'd (table itself matched), or (b) the subfolder has at
  // least one matching leaf.
  const subVisible = (s: TableSubfolder): boolean => {
    if (!search.active) return true;
    if (fullExpand) return true;
    return !!subfolderHits?.has(s);
  };

  return (
    <>
      {subVisible("columns") && (
        <SubFolder
          depth={depth}
          tableId={tableId}
          subfolder="columns"
          label="Columns"
          icon={<Type className="h-3 w-3 text-muted-foreground" />}
          count={desc.columns.length}
          defaultOpen
          indexedAt={indexedAt}
        >
          {desc.columns
            .filter((c) =>
              !search.active || fullExpand
                ? true
                : search.visibleColumns.has(`${tableId}/${c.name}`),
            )
            .map((c) => (
              <ColumnRow
                key={c.name}
                depth={depth + 1}
                col={c}
                indexedAt={indexedAt}
              />
            ))}
        </SubFolder>
      )}
      {subVisible("keys") && (
        <SubFolder
          depth={depth}
          tableId={tableId}
          subfolder="keys"
          label="Keys"
          icon={<KeyRound className="h-3 w-3 text-muted-foreground" />}
          count={desc.keys.length}
          indexedAt={indexedAt}
        >
          {desc.keys
            .filter((k) =>
              !search.active || fullExpand
                ? true
                : search.visibleKeys.has(`${tableId}/${k.name}`),
            )
            .map((k) => (
              <KeyRow
                key={k.name}
                depth={depth + 1}
                k={k}
                indexedAt={indexedAt}
              />
            ))}
        </SubFolder>
      )}
      {subVisible("fks") && (
        <SubFolder
          depth={depth}
          tableId={tableId}
          subfolder="fks"
          label="Foreign keys"
          icon={<Link2 className="h-3 w-3 text-muted-foreground" />}
          count={desc.foreignKeys.length}
          indexedAt={indexedAt}
        >
          {desc.foreignKeys
            .filter((fk) =>
              !search.active || fullExpand
                ? true
                : search.visibleFks.has(`${tableId}/${fk.name}`),
            )
            .map((fk) => (
              <FkRow
                key={fk.name}
                depth={depth + 1}
                fk={fk}
                indexedAt={indexedAt}
              />
            ))}
        </SubFolder>
      )}
      {subVisible("indexes") && (
        <SubFolder
          depth={depth}
          tableId={tableId}
          subfolder="indexes"
          label="Indexes"
          icon={<ListTree className="h-3 w-3 text-muted-foreground" />}
          count={desc.indexes.length}
          indexedAt={indexedAt}
        >
          {desc.indexes
            .filter((idx) =>
              !search.active || fullExpand
                ? true
                : search.visibleIndexes.has(`${tableId}/${idx.name}`),
            )
            .map((idx) => (
              <IndexRow
                key={idx.name}
                depth={depth + 1}
                idx={idx}
                indexedAt={indexedAt}
              />
            ))}
        </SubFolder>
      )}
      {subVisible("checks") && (
        <SubFolder
          depth={depth}
          tableId={tableId}
          subfolder="checks"
          label="Checks"
          icon={<ShieldCheck className="h-3 w-3 text-muted-foreground" />}
          count={desc.checks.length}
          indexedAt={indexedAt}
        >
          {desc.checks
            .filter((c) =>
              !search.active || fullExpand
                ? true
                : search.visibleChecks.has(`${tableId}/${c.name}`),
            )
            .map((c) => (
              <CheckRow
                key={c.name}
                depth={depth + 1}
                c={c}
                indexedAt={indexedAt}
              />
            ))}
        </SubFolder>
      )}
      {subVisible("triggers") && (
        <SubFolder
          depth={depth}
          tableId={tableId}
          subfolder="triggers"
          label="Triggers"
          icon={<Zap className="h-3 w-3 text-muted-foreground" />}
          count={desc.triggers.length}
          indexedAt={indexedAt}
        >
          {desc.triggers
            .filter((t) =>
              !search.active || fullExpand
                ? true
                : search.visibleTriggers.has(`${tableId}/${t.name}`),
            )
            .map((t) => (
              <TriggerRow
                key={t.name}
                depth={depth + 1}
                t={t}
                indexedAt={indexedAt}
              />
            ))}
        </SubFolder>
      )}
    </>
  );
}

function SubFolder({
  depth,
  tableId,
  subfolder,
  label,
  icon,
  count,
  defaultOpen = false,
  indexedAt,
  children,
}: {
  depth: number;
  tableId: string;
  subfolder: TableSubfolder;
  label: string;
  icon: React.ReactNode;
  count: number;
  defaultOpen?: boolean;
  /** Inherited from the parent table — the "Cached X ago" line on
   * this folder's tooltip. */
  indexedAt: number | undefined;
  children: React.ReactNode;
}) {
  const search = useSearch();
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const fullExpand = search.active && search.fullExpandTables.has(tableId);
  const hasHits = search.tableSubfolderVisible.get(tableId)?.has(subfolder);
  const open = (search.active ? fullExpand || hasHits : localOpen) || localOpen;

  return (
    <div>
      <Row
        depth={depth}
        onClick={() => setLocalOpen(!localOpen)}
        icon={icon}
        chevron={
          open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )
        }
        label={label}
        adornment={
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/60">
            {count}
          </span>
        }
        title={`${label} (${count})${cachedSuffix(indexedAt)}`}
      />
      {open && (
        <div>
          {count === 0 ? (
            <Row depth={depth + 1} muted label="(none)" />
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}

// ─── Leaf rows for each metadata type ────────────────────────────────

function ColumnRow({
  depth,
  col,
  indexedAt,
}: {
  depth: number;
  col: DbColumnDescription;
  indexedAt: number | undefined;
}) {
  const flags = [
    col.isPrimaryKey ? "PK" : null,
    !col.nullable ? "NOT NULL" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const detail = col.default ? `${col.dataType} · DEFAULT ${col.default}` : col.dataType;
  const head = flags
    ? `${col.name} ${col.dataType} · ${flags}`
    : `${col.name} ${col.dataType}`;
  return (
    <Row
      depth={depth}
      icon={<Type className="h-3 w-3 text-muted-foreground/70" />}
      label={col.name}
      detail={detail}
      title={`${head}${cachedSuffix(indexedAt)}`}
    />
  );
}

function KeyRow({
  depth,
  k,
  indexedAt,
}: {
  depth: number;
  k: DbKeyDescription;
  indexedAt: number | undefined;
}) {
  const tag = k.isPrimary ? "PRIMARY" : "UNIQUE";
  const detail = `${tag} (${k.columns.join(", ")})`;
  return (
    <Row
      depth={depth}
      icon={<KeyRound className="h-3 w-3 text-muted-foreground/70" />}
      label={k.name}
      detail={detail}
      title={`${k.name} ${detail}${cachedSuffix(indexedAt)}`}
    />
  );
}

function FkRow({
  depth,
  fk,
  indexedAt,
}: {
  depth: number;
  fk: DbForeignKeyDescription;
  indexedAt: number | undefined;
}) {
  const detail = `(${fk.columns.join(", ")}) → ${fk.referencedSchema}.${fk.referencedTable}(${fk.referencedColumns.join(", ")})`;
  return (
    <Row
      depth={depth}
      icon={<Link2 className="h-3 w-3 text-muted-foreground/70" />}
      label={fk.name}
      detail={detail}
      title={`${fk.name} ${detail}${cachedSuffix(indexedAt)}`}
    />
  );
}

function IndexRow({
  depth,
  idx,
  indexedAt,
}: {
  depth: number;
  idx: DbIndexDescription;
  indexedAt: number | undefined;
}) {
  const detail = `(${idx.columns.join(", ")})${idx.isUnique ? " · UNIQUE" : ""}`;
  return (
    <Row
      depth={depth}
      icon={<ListTree className="h-3 w-3 text-muted-foreground/70" />}
      label={idx.name}
      detail={detail}
      title={`${idx.name} ${detail}${cachedSuffix(indexedAt)}`}
    />
  );
}

function CheckRow({
  depth,
  c,
  indexedAt,
}: {
  depth: number;
  c: DbCheckDescription;
  indexedAt: number | undefined;
}) {
  return (
    <Row
      depth={depth}
      icon={<ShieldCheck className="h-3 w-3 text-muted-foreground/70" />}
      label={c.name}
      detail={c.expression}
      title={`${c.name}: ${c.expression}${cachedSuffix(indexedAt)}`}
    />
  );
}

function TriggerRow({
  depth,
  t,
  indexedAt,
}: {
  depth: number;
  t: DbTriggerDescription;
  indexedAt: number | undefined;
}) {
  const detail = `${t.timing} ${t.events.join(" / ")}`;
  // `definition` (when present) is the most useful tooltip; we
  // append the cached-at marker on its own line so it stays
  // readable with a multi-line trigger body.
  const head = t.definition ?? `${t.name} ${detail}`;
  return (
    <Row
      depth={depth}
      icon={<Zap className="h-3 w-3 text-muted-foreground/70" />}
      label={t.name}
      detail={detail}
      title={`${head}${cachedSuffix(indexedAt)}`}
    />
  );
}

function RoutineLeaf({
  routine,
  indexedAt,
}: {
  routine: DbRoutineDescription;
  /** Routines are session-cached separately from tables; this is the
   * timestamp from `readRoutinesFetchedAt`. */
  indexedAt: number | undefined;
}) {
  const sig = `(${routine.argumentTypes.join(", ")})`;
  const ret = routine.returnType ? ` → ${routine.returnType}` : "";
  const Icon = routine.kind === "procedure" ? Cog : Sigma;
  return (
    <Row
      depth={3}
      icon={<Icon className="h-3 w-3 text-muted-foreground/70" />}
      label={routine.name}
      detail={`${sig}${ret}`}
      title={`${routine.kind} ${routine.schema}.${routine.name}${sig}${ret}${cachedSuffix(indexedAt)}`}
    />
  );
}

// ─── Freshness dot (table-level only) ────────────────────────────────

function FreshnessDot({ indexedAt }: { indexedAt: number | undefined }) {
  let cls = "bg-muted-foreground/40";
  if (indexedAt) {
    const age = Date.now() - indexedAt;
    cls = age > FRESHNESS_TTL_MS ? "bg-amber-500/80" : "bg-emerald-500/80";
  }
  return (
    <span
      aria-hidden
      className={`ml-auto inline-block h-1.5 w-1.5 shrink-0 rounded-full ${cls}`}
    />
  );
}

function formatRelative(ts: number): string {
  const delta = Date.now() - ts;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (delta < min) return "just now";
  if (delta < hr) return `${Math.floor(delta / min)}m ago`;
  if (delta < day) return `${Math.floor(delta / hr)}h ago`;
  return `${Math.floor(delta / day)}d ago`;
}

/** Tooltip suffix appended to every cache-derived row. Empty string
 * when nothing has been cached yet — keeps the tooltip text terse
 * for "fresh-from-the-DB" cases. */
function cachedSuffix(indexedAt: number | undefined): string {
  return indexedAt ? ` · cached ${formatRelative(indexedAt)}` : "";
}

// ─── Generic Row ─────────────────────────────────────────────────────

function Row({
  depth,
  icon,
  chevron,
  label,
  detail,
  onClick,
  onContextMenu,
  muted,
  adornment,
  title,
}: {
  depth: number;
  icon?: React.ReactNode;
  chevron?: React.ReactNode;
  label: string;
  detail?: string;
  onClick?: () => void;
  onContextMenu?: (ev: React.MouseEvent) => void;
  muted?: boolean;
  adornment?: React.ReactNode;
  title?: string;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
      className={
        "flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-sm transition " +
        (onClick ? "hover:bg-muted/50 " : "") +
        (muted ? "text-muted-foreground" : "")
      }
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      <span className="w-3">{chevron ?? ""}</span>
      {icon}
      <span className="truncate">{label}</span>
      {detail ? (
        <span className="ml-2 truncate text-[11px] text-muted-foreground/70">
          {detail}
        </span>
      ) : null}
      {adornment}
    </Tag>
  );
}
