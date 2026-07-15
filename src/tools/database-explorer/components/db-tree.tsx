/**
 * DataGrip-style tree of databases > schemas > {tables, routines}.
 * Tables expand into six metadata sub-folders (Columns / Keys /
 * Foreign keys / Indexes / Checks / Triggers); routines are leaf
 * rows showing function/procedure signatures.
 *
 * Top of the rail carries a backend catalog search. Rust/SQLite owns
 * indexing, matching, kind scoping, and result bounds; this component
 * only debounces the input and renders the returned page.
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
  useEffect,
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
  Loader2,
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
  type DbCatalogSearchHit,
  type DbCatalogSearchResult,
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
/**
 * Cache rows older than this are flagged "stale" by the freshness
 * badge. Mirrors the backend's `DEFAULT_TTL_MS` so the dot lights up
 * just before the next typing pass would auto-refresh.
 */
const FRESHNESS_TTL_MS = 24 * 60 * 60 * 1000;

export function DbTree() {
  const { state } = useDbExplorerStore();
  const { fetchDatabases } = useDbTree();
  const id = state.activeConnectionId;
  const status = id ? state.status[id] : undefined;
  const tree = id ? state.trees[id] : undefined;
  const databases = tree?.databases;

  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<DbCatalogSearchResult | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchRequestRef = useRef(0);
  const activeDatabase = id ? currentDatabase(state, id) : null;

  // React owns only input timing and stale-response suppression. Parsing,
  // matching, catalog refresh, and result bounds are backend responsibilities.
  useEffect(() => {
    const trimmed = query.trim();
    const requestId = ++searchRequestRef.current;
    if (!trimmed || !id) {
      setSearchResult(null);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }
    setSearchResult(null);
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      setSearchError(null);
      void dbTauri
        .searchCatalog(id, activeDatabase ?? "", trimmed)
        .then((result) => {
          if (searchRequestRef.current === requestId) setSearchResult(result);
        })
        .catch((error: unknown) => {
          if (searchRequestRef.current !== requestId) return;
          setSearchResult(null);
          setSearchError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (searchRequestRef.current === requestId) setSearchLoading(false);
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query, id, activeDatabase]);

  // Auto-load databases on first connect.
  useEffect(() => {
    if (id && status === "connected" && !databases) {
      fetchDatabases(id);
    }
  }, [id, status, databases, fetchDatabases]);

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
        <SearchBox
          value={query}
          onChange={setQuery}
          result={searchResult}
          loading={searchLoading}
          error={searchError}
        />
      </div>
      {query.trim() ? (
        <CatalogSearchResults
          connectionId={id}
          result={searchResult}
          loading={searchLoading}
          error={searchError}
        />
      ) : !tree?.databases ? (
        <div className="px-3 py-4 text-xs text-muted-foreground">Loading…</div>
      ) : (
        <>
          <span className="px-2 pt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            Databases
          </span>
          {tree.databases.map((db) => (
            <DatabaseNode key={db} connectionId={id} database={db} />
          ))}
        </>
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
  { prefix: "database:", example: "database:sales*", hint: "databases only" },
  { prefix: "database:", example: "database:Sales table:order*", hint: "inside database" },
  { prefix: "schema:", example: "schema:dbo table:order*", hint: "inside schema" },
  { prefix: "table:", example: "table:orders column:email", hint: "inside table" },
  { prefix: "table:", example: "table:orders*", hint: "tables only" },
  { prefix: "column:", example: "column:email", hint: "column names only" },
  { prefix: "fk:", example: "fk:orders_*", hint: "foreign keys" },
  { prefix: "key:", example: "key:pk_*", hint: "PRIMARY + UNIQUE keys" },
  { prefix: "index:", example: "index:*_idx", hint: "indexes" },
  { prefix: "check:", example: "check:*_age_*", hint: "CHECK constraints" },
  { prefix: "trigger:", example: "trigger:*_audit", hint: "triggers" },
  { prefix: "proc:", example: "proc:archive_*", hint: "stored procedures" },
  { prefix: "fn:", example: "fn:format_*", hint: "functions" },
  { prefix: "routine:", example: "routine:*", hint: "fns + procs" },
  { prefix: "schema:", example: "schema:metric*", hint: "schemas only" },
];

function SearchBox({
  value,
  onChange,
  result,
  loading,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  result: DbCatalogSearchResult | null;
  loading: boolean;
  error: string | null;
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
          placeholder="Filter · database:db schema:dbo table:name"
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
                <code>type:pattern</code> restricts to one node kind. Earlier
                qualifiers scope the hierarchy. Tap a chip below to insert.
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Prefix with <code>database:name</code>, <code>schema:name</code>, or{" "}
                <code>table:name</code> to filter a hierarchy. Unqualified searches use
                the active database. Quote names with spaces, for example{" "}
                <code>database:&apos;Sales DW&apos;</code>.
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
      {value.trim() ? (
        <div className="px-2 pt-1 text-[10px] tabular-nums text-muted-foreground/70">
          {loading
            ? "Searching indexed catalog…"
            : error
              ? "Catalog search failed"
              : result?.queryTooBroad
                ? "Type 3+ characters, or use type:*"
                : result?.truncated
                  ? `${result.items.length}+ matches · refine your search`
                  : result
                  ? `${result.items.length} match${result.items.length === 1 ? "" : "es"}`
                  : "Waiting to search…"}
        </div>
      ) : null}
    </div>
  );
}

function CatalogSearchResults({
  connectionId,
  result,
  loading,
  error,
}: {
  connectionId: string;
  result: DbCatalogSearchResult | null;
  loading: boolean;
  error: string | null;
}) {
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [description, setDescription] = useState<{
    key: string;
    value: DbTableDescription;
  } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const activeDescriptionRequest = useRef<string | null>(null);

  const toggleDetails = (hit: DbCatalogSearchHit, rowKey: string) => {
    if (!isExpandableCatalogHit(hit)) return;
    if (expandedRowKey === rowKey) {
      setExpandedRowKey(null);
      activeDescriptionRequest.current = null;
      return;
    }
    setExpandedRowKey(rowKey);
    if (hit.kind === "database" || hit.kind === "schema") {
      activeDescriptionRequest.current = null;
      return;
    }
    const table = hit.table ?? hit.name;
    const key = `${connectionId}/${hit.database}/${hit.schema}/${table}`;
    if (description?.key === key) {
      activeDescriptionRequest.current = null;
      return;
    }
    setDescription(null);
    setLoadingKey(key);
    activeDescriptionRequest.current = key;
    void dbTauri
      .describeTable(connectionId, hit.database, hit.schema, table)
      .then((value) => {
        if (activeDescriptionRequest.current === key) {
          setDescription({ key, value });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (activeDescriptionRequest.current === key) {
          activeDescriptionRequest.current = null;
          setLoadingKey(null);
        }
      });
  };

  if (loading && !result) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Searching catalog…
      </div>
    );
  }
  if (error) {
    return <div className="px-3 py-4 text-xs text-destructive">{error}</div>;
  }
  if (!result) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        Waiting to search…
      </div>
    );
  }
  if (result.queryTooBroad) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        Type at least 3 characters, or use a scoped match such as <code>table &gt; *</code>.
      </div>
    );
  }
  if (result.items.length === 0) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        No indexed objects match.
      </div>
    );
  }
  return (
    <div className="pt-1">
      {result.items.map((hit, index) => {
        const expandable = isExpandableCatalogHit(hit);
        const tableKey =
          hit.kind === "table" || hit.kind === "view"
            ? `${connectionId}/${hit.database}/${hit.schema}/${hit.table ?? hit.name}`
            : null;
        const rowKey = `${connectionId}/${hit.database}/${hit.schema}/${hit.table ?? ""}/${hit.kind}/${hit.name}/${index}`;
        return (
          <div key={rowKey}>
            <Row
              depth={0}
              icon={catalogHitIcon(hit)}
              chevron={
                expandable ? (
                  expandedRowKey === rowKey ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )
                ) : undefined
              }
              label={hit.name}
              detail={catalogHitPath(hit)}
              onClick={expandable ? () => toggleDetails(hit, rowKey) : undefined}
              adornment={
                <span className="ml-auto shrink-0 rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">
                  {hit.kind}
                </span>
              }
              title={`${hit.kind} · ${catalogHitPath(hit)}`}
            />
            {expandable && expandedRowKey === rowKey ? (
              hit.kind === "database" ? (
                <CatalogDatabaseContents
                  connectionId={connectionId}
                  database={hit.database}
                />
              ) : hit.kind === "schema" ? (
                <CatalogSchemaContents
                  connectionId={connectionId}
                  database={hit.database}
                  schema={hit.schema || hit.name}
                />
              ) : tableKey && loadingKey === tableKey ? (
                <div className="flex items-center gap-2 px-6 py-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> Loading table metadata…
                </div>
              ) : tableKey && description?.key === tableKey ? (
                <TableDetails depth={1} desc={description.value} indexedAt={undefined} />
              ) : (
                <div className="px-6 py-2 text-xs text-destructive">
                  Table metadata could not be loaded.
                </div>
              )
            ) : null}
          </div>
        );
      })}
      {result.truncated ? (
        <div className="px-3 py-2 text-[10px] text-muted-foreground">
          More results exist. Refine the query to narrow the catalog.
        </div>
      ) : null}
    </div>
  );
}

function isExpandableCatalogHit(hit: DbCatalogSearchHit): boolean {
  return (
    hit.kind === "database" ||
    hit.kind === "schema" ||
    hit.kind === "table" ||
    hit.kind === "view"
  );
}

function CatalogDatabaseContents({
  connectionId,
  database,
}: {
  connectionId: string;
  database: string;
}) {
  const { state } = useDbExplorerStore();
  const { fetchSchemas } = useDbTree();
  const schemas = state.trees[connectionId]?.schemasByDb[database];

  useEffect(() => {
    if (schemas === undefined) fetchSchemas(connectionId, database);
  }, [schemas, connectionId, database, fetchSchemas]);

  if (schemas === undefined) return <Row depth={1} muted label="Loading…" />;
  if (schemas.length === 0) return <Row depth={1} muted label="(no schemas)" />;
  return schemas.map((schema) => (
    <SchemaNode
      key={schema}
      connectionId={connectionId}
      database={database}
      schema={schema}
      depth={1}
    />
  ));
}

function CatalogSchemaContents({
  connectionId,
  database,
  schema,
}: {
  connectionId: string;
  database: string;
  schema: string;
}) {
  return (
    <>
      <TablesFolder
        connectionId={connectionId}
        database={database}
        schema={schema}
        depth={1}
      />
      <RoutinesFolder
        connectionId={connectionId}
        database={database}
        schema={schema}
        depth={1}
      />
    </>
  );
}

function catalogHitPath(hit: DbCatalogSearchHit): string {
  return [hit.database, hit.schema, hit.table]
    .filter((part): part is string => !!part && part !== hit.name)
    .join(" › ");
}

function catalogHitIcon(hit: DbCatalogSearchHit): React.ReactNode {
  switch (hit.kind) {
    case "database":
      return <Database className="size-3.5 text-sky-500" />;
    case "schema":
      return <FolderOpen className="size-3 text-muted-foreground" />;
    case "table":
    case "view":
      return <Table className="size-3 text-muted-foreground" />;
    case "column":
      return <Type className="size-3 text-muted-foreground" />;
    case "key":
      return <KeyRound className="size-3 text-muted-foreground" />;
    case "fk":
      return <Link2 className="size-3 text-muted-foreground" />;
    case "index":
      return <ListTree className="size-3 text-muted-foreground" />;
    case "check":
      return <ShieldCheck className="size-3 text-muted-foreground" />;
    case "trigger":
      return <Zap className="size-3 text-muted-foreground" />;
    case "function":
    case "procedure":
      return <Sigma className="size-3 text-muted-foreground" />;
  }
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
  const [localOpen, setLocalOpen] = useState(false);
  const schemas = state.trees[connectionId]?.schemasByDb[database];
  const open = localOpen;

  // Fetch schemas the moment we go open — covers both manual toggle
  // and search-driven force-open.
  useEffect(() => {
    if (open && schemas === undefined) {
      fetchSchemas(connectionId, database);
    }
  }, [open, schemas, connectionId, database, fetchSchemas]);

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
  depth = 1,
}: {
  connectionId: string;
  database: string;
  schema: string;
  depth?: number;
}) {
  const { state } = useDbExplorerStore();
  const [localOpen, setLocalOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const schemaId = `${database}/${schema}`;
  const open = localOpen;

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

  return (
    <div className="group">
      <Row
        depth={depth}
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
            depth={depth + 1}
          />
          <RoutinesFolder
            connectionId={connectionId}
            database={database}
            schema={schema}
            depth={depth + 1}
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
  depth = 2,
}: {
  connectionId: string;
  database: string;
  schema: string;
  depth?: number;
}) {
  const { state, dispatch } = useDbExplorerStore();
  const { fetchTables } = useDbTree();
  const [localOpen, setLocalOpen] = useState(true); // open by default — DataGrip parity
  const key = `${database}/${schema}`;
  const tables = state.trees[connectionId]?.tablesBySchema[key];

  const open = localOpen;

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

  const visibleTables = tables;

  return (
    <div>
      <Row
        depth={depth}
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
              {tables.length}
            </span>
          ) : null
        }
      />
      {open && (
        <div>
          {visibleTables === undefined ? (
            <Row depth={depth + 1} muted label="Loading…" />
          ) : visibleTables.length === 0 ? (
            <Row depth={depth + 1} muted label="(none)" />
          ) : (
            visibleTables.map((t) => (
              <TableNode
                key={t}
                connectionId={connectionId}
                database={database}
                schema={schema}
                table={t}
                depth={depth + 1}
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
  depth = 2,
}: {
  connectionId: string;
  database: string;
  schema: string;
  depth?: number;
}) {
  const { state, dispatch } = useDbExplorerStore();
  const [localOpen, setLocalOpen] = useState(false);
  const key = `${database}/${schema}`;
  const routines = state.trees[connectionId]?.routinesBySchema[key];

  const open = localOpen;

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

  const visibleRoutines = routines;

  // Recompute the routine fetched-at on every render — `routines`
  // updating in the store guarantees we re-render whenever the cache
  // ticks, and `Date.now()` inside `cachedSuffix` keeps the tooltip
  // age fresh.
  const routinesIndexedAt = readRoutinesFetchedAt(connectionId, database, schema);

  return (
    <div>
      <Row
        depth={depth}
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
              {routines.length}
            </span>
          ) : null
        }
        title={`Routines (${routines?.length ?? 0})${cachedSuffix(routinesIndexedAt)}`}
      />
      {open && (
        <div>
          {visibleRoutines === undefined ? (
            <Row depth={depth + 1} muted label="Loading…" />
          ) : visibleRoutines.length === 0 ? (
            <Row depth={depth + 1} muted label="(none)" />
          ) : (
            visibleRoutines.map((r) => (
              <RoutineLeaf
                key={`${r.kind}:${r.name}`}
                routine={r}
                indexedAt={routinesIndexedAt}
                depth={depth + 1}
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
  depth = 3,
}: {
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  depth?: number;
}) {
  const { state } = useDbExplorerStore();
  const [localOpen, setLocalOpen] = useState(false);
  const indexedAt =
    state.schemaIndexedAt[`${connectionId}/${database}/${schema}/${table}`];

  const open = localOpen;

  const cached = readCached(connectionId, database, schema, [table])[0];

  useEffect(() => {
    if (!open || cached) return;
    void ensureTables(connectionId, database, schema, [table]).catch(() => {});
  }, [open, cached, connectionId, database, schema, table]);

  const onContextMenu = (ev: React.MouseEvent) => {
    ev.preventDefault();
    void forceReindex(connectionId, database, schema, [table]);
  };

  return (
    <div>
      <Row
        depth={depth}
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
          depth={depth + 1}
          desc={cached}
          indexedAt={indexedAt}
        />
      )}
    </div>
  );
}

function TableDetails({
  depth,
  desc,
  indexedAt,
}: {
  depth: number;
  desc: DbTableDescription | undefined;
  /** When the parent `TableNode`'s description was last cached. Threaded
   * down so every leaf can render a "cached X ago" suffix in its
   * tooltip — same source, same age across all children. */
  indexedAt: number | undefined;
}) {
  if (!desc) {
    return <Row depth={depth} muted label="Loading…" />;
  }

  return (
    <>
      <SubFolder
        depth={depth}
        label="Columns"
        icon={<Type className="h-3 w-3 text-muted-foreground" />}
        count={desc.columns.length}
        defaultOpen
        indexedAt={indexedAt}
      >
        {desc.columns.map((c) => (
          <ColumnRow
            key={c.name}
            depth={depth + 1}
            col={c}
            indexedAt={indexedAt}
          />
        ))}
      </SubFolder>
      <SubFolder
        depth={depth}
        label="Keys"
        icon={<KeyRound className="h-3 w-3 text-muted-foreground" />}
        count={desc.keys.length}
        indexedAt={indexedAt}
      >
        {desc.keys.map((k) => (
          <KeyRow key={k.name} depth={depth + 1} k={k} indexedAt={indexedAt} />
        ))}
      </SubFolder>
      <SubFolder
        depth={depth}
        label="Foreign keys"
        icon={<Link2 className="h-3 w-3 text-muted-foreground" />}
        count={desc.foreignKeys.length}
        indexedAt={indexedAt}
      >
        {desc.foreignKeys.map((fk) => (
          <FkRow key={fk.name} depth={depth + 1} fk={fk} indexedAt={indexedAt} />
        ))}
      </SubFolder>
      <SubFolder
        depth={depth}
        label="Indexes"
        icon={<ListTree className="h-3 w-3 text-muted-foreground" />}
        count={desc.indexes.length}
        indexedAt={indexedAt}
      >
        {desc.indexes.map((idx) => (
          <IndexRow key={idx.name} depth={depth + 1} idx={idx} indexedAt={indexedAt} />
        ))}
      </SubFolder>
      <SubFolder
        depth={depth}
        label="Checks"
        icon={<ShieldCheck className="h-3 w-3 text-muted-foreground" />}
        count={desc.checks.length}
        indexedAt={indexedAt}
      >
        {desc.checks.map((c) => (
          <CheckRow key={c.name} depth={depth + 1} c={c} indexedAt={indexedAt} />
        ))}
      </SubFolder>
      <SubFolder
        depth={depth}
        label="Triggers"
        icon={<Zap className="h-3 w-3 text-muted-foreground" />}
        count={desc.triggers.length}
        indexedAt={indexedAt}
      >
        {desc.triggers.map((t) => (
          <TriggerRow key={t.name} depth={depth + 1} t={t} indexedAt={indexedAt} />
        ))}
      </SubFolder>
    </>
  );
}

function SubFolder({
  depth,
  label,
  icon,
  count,
  defaultOpen = false,
  indexedAt,
  children,
}: {
  depth: number;
  label: string;
  icon: React.ReactNode;
  count: number;
  defaultOpen?: boolean;
  /** Inherited from the parent table — the "Cached X ago" line on
   * this folder's tooltip. */
  indexedAt: number | undefined;
  children: React.ReactNode;
}) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = localOpen;

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
  depth = 3,
}: {
  routine: DbRoutineDescription;
  /** Routines are session-cached separately from tables; this is the
   * timestamp from `readRoutinesFetchedAt`. */
  indexedAt: number | undefined;
  depth?: number;
}) {
  const sig = `(${routine.argumentTypes.join(", ")})`;
  const ret = routine.returnType ? ` → ${routine.returnType}` : "";
  const Icon = routine.kind === "procedure" ? Cog : Sigma;
  return (
    <Row
      depth={depth}
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
