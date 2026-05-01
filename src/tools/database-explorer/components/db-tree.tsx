/**
 * DataGrip-style tree of databases > schemas > {tables, routines}.
 * Tables expand into six metadata sub-folders (Columns / Keys /
 * Foreign keys / Indexes / Checks / Triggers); routines are leaf
 * rows showing function/procedure signatures.
 *
 * All children are fetched lazily on first expansion. Per-table
 * metadata rides through the existing `schema_cache.db` (extended in
 * this revision to carry keys/checks/triggers); per-schema routines
 * use a session-only cache in `schema-cache.ts`.
 *
 * Each table row carries a small dot indicating schema-cache freshness
 * (green: fresh, amber: stale, dim: not cached). Right-clicking a
 * table row triggers an explicit reindex (Opt+Enter is the editor-side
 * equivalent for tables referenced in the SQL buffer).
 */

import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Cog,
  Database,
  FolderOpen,
  Folder,
  KeyRound,
  Link2,
  ListTree,
  ShieldCheck,
  Sigma,
  Table,
  Type,
  Zap,
} from "lucide-react";
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

  // Auto-load databases on first connect.
  useEffect(() => {
    if (id && status === "connected" && !tree?.databases) {
      fetchDatabases(id);
    }
  }, [id, status, tree?.databases, fetchDatabases]);

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
  if (!tree?.databases) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">Loading…</div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 px-1 py-2">
      <span className="px-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        Databases
      </span>
      {tree.databases.map((db) => (
        <DatabaseNode key={db} connectionId={id} database={db} />
      ))}
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
  const [open, setOpen] = useState(false);
  const schemas = state.trees[connectionId]?.schemasByDb[database];

  function toggle() {
    if (!open) fetchSchemas(connectionId, database);
    setOpen(!open);
  }

  return (
    <div>
      <Row
        depth={0}
        onClick={toggle}
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
  const [open, setOpen] = useState(false);

  return (
    <div>
      <Row
        depth={1}
        onClick={() => setOpen(!open)}
        icon={<FolderOpen className="h-3 w-3 text-muted-foreground" />}
        chevron={
          open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )
        }
        label={schema}
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
  const [open, setOpen] = useState(true); // tables open by default — matches DataGrip
  const key = `${database}/${schema}`;
  const tables = state.trees[connectionId]?.tablesBySchema[key];

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
    // Subscribe to live updates so newly-indexed rows light up.
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

  function toggle() {
    if (!open && tables === undefined) {
      fetchTables(connectionId, database, schema);
    }
    setOpen(!open);
  }

  return (
    <div>
      <Row
        depth={2}
        onClick={toggle}
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
          {tables === undefined ? (
            <Row depth={3} muted label="Loading…" />
          ) : tables.length === 0 ? (
            <Row depth={3} muted label="(none)" />
          ) : (
            tables.map((t) => (
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
  const [open, setOpen] = useState(false);
  const key = `${database}/${schema}`;
  const routines = state.trees[connectionId]?.routinesBySchema[key];

  // First open kicks the backend; subsequent opens read from the
  // session cache. The schema-cache façade subscribes to its own
  // event stream — we mirror updates back into the store so the
  // tree re-renders consistently with `tablesBySchema`.
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
        // Surface as empty rather than wedging the folder in a
        // perpetual "Loading…" — error toasts come through the
        // existing run-toolbar surface.
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

  return (
    <div>
      <Row
        depth={2}
        onClick={() => setOpen(!open)}
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
      />
      {open && (
        <div>
          {routines === undefined ? (
            <Row depth={3} muted label="Loading…" />
          ) : routines.length === 0 ? (
            <Row depth={3} muted label="(none)" />
          ) : (
            routines.map((r) => (
              <RoutineLeaf key={`${r.kind}:${r.name}`} routine={r} />
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
  const [open, setOpen] = useState(false);
  const indexedAt =
    state.schemaIndexedAt[`${connectionId}/${database}/${schema}/${table}`];

  // The mirror entry is the source of truth for this table's
  // sub-folders. `readCached` returns whatever's currently in the
  // mirror; `ensureTables` fills it on first expand.
  const cached = readCached(connectionId, database, schema, [table])[0];

  // `subscribeSchemaCache` already pushes `schemaIndexedAt` updates
  // via the parent `TablesFolder` effect; we don't need a second
  // subscription here. Local re-render comes from the parent
  // re-rendering when the store ticks — which it does on every
  // `set-schema-indexed-at`.

  useEffect(() => {
    if (!open || cached) return;
    void ensureTables(connectionId, database, schema, [table]).catch(() => {
      // Backend describe failure is non-fatal; sub-folders render
      // their empty/loading state.
    });
  }, [open, cached, connectionId, database, schema, table]);

  const onContextMenu = (ev: React.MouseEvent) => {
    ev.preventDefault();
    void forceReindex(connectionId, database, schema, [table]);
  };

  return (
    <div>
      <Row
        depth={3}
        onClick={() => setOpen(!open)}
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
        <TableDetails depth={4} desc={cached} />
      )}
    </div>
  );
}

function TableDetails({
  depth,
  desc,
}: {
  depth: number;
  desc: DbTableDescription | undefined;
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
      >
        {desc.columns.map((c) => (
          <ColumnRow key={c.name} depth={depth + 1} col={c} />
        ))}
      </SubFolder>
      <SubFolder
        depth={depth}
        label="Keys"
        icon={<KeyRound className="h-3 w-3 text-muted-foreground" />}
        count={desc.keys.length}
      >
        {desc.keys.map((k) => (
          <KeyRow key={k.name} depth={depth + 1} k={k} />
        ))}
      </SubFolder>
      <SubFolder
        depth={depth}
        label="Foreign keys"
        icon={<Link2 className="h-3 w-3 text-muted-foreground" />}
        count={desc.foreignKeys.length}
      >
        {desc.foreignKeys.map((fk) => (
          <FkRow key={fk.name} depth={depth + 1} fk={fk} />
        ))}
      </SubFolder>
      <SubFolder
        depth={depth}
        label="Indexes"
        icon={<ListTree className="h-3 w-3 text-muted-foreground" />}
        count={desc.indexes.length}
      >
        {desc.indexes.map((idx) => (
          <IndexRow key={idx.name} depth={depth + 1} idx={idx} />
        ))}
      </SubFolder>
      <SubFolder
        depth={depth}
        label="Checks"
        icon={<ShieldCheck className="h-3 w-3 text-muted-foreground" />}
        count={desc.checks.length}
      >
        {desc.checks.map((c) => (
          <CheckRow key={c.name} depth={depth + 1} c={c} />
        ))}
      </SubFolder>
      <SubFolder
        depth={depth}
        label="Triggers"
        icon={<Zap className="h-3 w-3 text-muted-foreground" />}
        count={desc.triggers.length}
      >
        {desc.triggers.map((t) => (
          <TriggerRow key={t.name} depth={depth + 1} t={t} />
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
  children,
}: {
  depth: number;
  label: string;
  icon: React.ReactNode;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <Row
        depth={depth}
        onClick={() => setOpen(!open)}
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

function ColumnRow({ depth, col }: { depth: number; col: DbColumnDescription }) {
  const flags = [
    col.isPrimaryKey ? "PK" : null,
    !col.nullable ? "NOT NULL" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const detail = col.default ? `${col.dataType} · DEFAULT ${col.default}` : col.dataType;
  return (
    <Row
      depth={depth}
      icon={<Type className="h-3 w-3 text-muted-foreground/70" />}
      label={col.name}
      detail={detail}
      title={
        flags ? `${col.name} ${col.dataType} · ${flags}` : `${col.name} ${col.dataType}`
      }
    />
  );
}

function KeyRow({ depth, k }: { depth: number; k: DbKeyDescription }) {
  const tag = k.isPrimary ? "PRIMARY" : "UNIQUE";
  const detail = `${tag} (${k.columns.join(", ")})`;
  return (
    <Row
      depth={depth}
      icon={<KeyRound className="h-3 w-3 text-muted-foreground/70" />}
      label={k.name}
      detail={detail}
      title={`${k.name} ${detail}`}
    />
  );
}

function FkRow({ depth, fk }: { depth: number; fk: DbForeignKeyDescription }) {
  const detail = `(${fk.columns.join(", ")}) → ${fk.referencedSchema}.${fk.referencedTable}(${fk.referencedColumns.join(", ")})`;
  return (
    <Row
      depth={depth}
      icon={<Link2 className="h-3 w-3 text-muted-foreground/70" />}
      label={fk.name}
      detail={detail}
      title={`${fk.name} ${detail}`}
    />
  );
}

function IndexRow({ depth, idx }: { depth: number; idx: DbIndexDescription }) {
  const detail = `(${idx.columns.join(", ")})${idx.isUnique ? " · UNIQUE" : ""}`;
  return (
    <Row
      depth={depth}
      icon={<ListTree className="h-3 w-3 text-muted-foreground/70" />}
      label={idx.name}
      detail={detail}
      title={`${idx.name} ${detail}`}
    />
  );
}

function CheckRow({ depth, c }: { depth: number; c: DbCheckDescription }) {
  return (
    <Row
      depth={depth}
      icon={<ShieldCheck className="h-3 w-3 text-muted-foreground/70" />}
      label={c.name}
      detail={c.expression}
      title={`${c.name}: ${c.expression}`}
    />
  );
}

function TriggerRow({ depth, t }: { depth: number; t: DbTriggerDescription }) {
  const detail = `${t.timing} ${t.events.join(" / ")}`;
  return (
    <Row
      depth={depth}
      icon={<Zap className="h-3 w-3 text-muted-foreground/70" />}
      label={t.name}
      detail={detail}
      title={t.definition ?? `${t.name} ${detail}`}
    />
  );
}

function RoutineLeaf({ routine }: { routine: DbRoutineDescription }) {
  const sig = `(${routine.argumentTypes.join(", ")})`;
  const ret = routine.returnType ? ` → ${routine.returnType}` : "";
  const Icon = routine.kind === "procedure" ? Cog : Sigma;
  return (
    <Row
      depth={3}
      icon={<Icon className="h-3 w-3 text-muted-foreground/70" />}
      label={routine.name}
      detail={`${sig}${ret}`}
      title={`${routine.kind} ${routine.schema}.${routine.name}${sig}${ret}`}
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
  /** Primary text — left-aligned. */
  label: string;
  /**
   * Right-aligned secondary text. Used by metadata rows to surface a
   * one-line summary (`integer · NOT NULL`, `(col1, col2)`, …) without
   * forcing a tooltip-only fallback.
   */
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
