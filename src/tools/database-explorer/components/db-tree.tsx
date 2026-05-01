/**
 * Collapsible tree of databases > schemas > tables for the active
 * connection. Children are fetched lazily on first expansion.
 *
 * Each table row carries a small dot indicating schema-cache freshness
 * (green: fresh, amber: stale, dim: not cached). Right-clicking a
 * table row triggers an explicit reindex (Opt+Enter is the editor-side
 * equivalent for tables referenced in the SQL buffer).
 */

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Database, FolderOpen, Table } from "lucide-react";
import { useDbExplorerStore } from "../store/db-explorer-store";
import { useDbTree } from "../hooks/use-db-tree";
import { dbTauri } from "../lib/tauri";
import {
  forceReindex,
  subscribe as subscribeSchemaCache,
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
        chevron={open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
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
  const { state, dispatch } = useDbExplorerStore();
  const { fetchTables } = useDbTree();
  const [open, setOpen] = useState(false);
  const key = `${database}/${schema}`;
  const tables = state.trees[connectionId]?.tablesBySchema[key];

  /**
   * Hydrate `schemaIndexedAt` for this schema's tables when the user
   * opens it. Cheap (one SQLite read), so we re-pull on every open in
   * case other tabs/sessions invalidated rows.
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
    if (!open) fetchTables(connectionId, database, schema);
    setOpen(!open);
  }

  return (
    <div>
      <Row
        depth={1}
        onClick={toggle}
        icon={<FolderOpen className="h-3 w-3 text-muted-foreground" />}
        chevron={open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        label={schema}
      />
      {open && (
        <div>
          {tables === undefined ? (
            <Row depth={2} muted label="Loading…" />
          ) : tables.length === 0 ? (
            <Row depth={2} muted label="(no tables)" />
          ) : (
            tables.map((t) => (
              <TableLeaf
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

function TableLeaf({
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
  const indexedAt =
    state.schemaIndexedAt[`${connectionId}/${database}/${schema}/${table}`];

  const onContextMenu = (ev: React.MouseEvent) => {
    ev.preventDefault();
    void forceReindex(connectionId, database, schema, [table]);
  };

  return (
    <Row
      depth={2}
      icon={<Table className="h-3 w-3 text-muted-foreground" />}
      label={table}
      adornment={<FreshnessDot indexedAt={indexedAt} />}
      title={
        indexedAt
          ? `Cached ${formatRelative(indexedAt)} · right-click to reindex`
          : "Not cached yet · right-click to index"
      }
      onContextMenu={onContextMenu}
    />
  );
}

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

function Row({
  depth,
  icon,
  chevron,
  label,
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
      {adornment}
    </Tag>
  );
}
