/**
 * Collapsible tree of databases > schemas > tables for the active
 * connection. Children are fetched lazily on first expansion.
 */

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Database, FolderOpen, Table } from "lucide-react";
import { useDbExplorerStore } from "../store/db-explorer-store";
import { useDbTree } from "../hooks/use-db-tree";

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
  const { state } = useDbExplorerStore();
  const { fetchTables } = useDbTree();
  const [open, setOpen] = useState(false);
  const key = `${database}/${schema}`;
  const tables = state.trees[connectionId]?.tablesBySchema[key];

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
              <Row
                key={t}
                depth={2}
                icon={<Table className="h-3 w-3 text-muted-foreground" />}
                label={t}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  depth,
  icon,
  chevron,
  label,
  onClick,
  muted,
}: {
  depth: number;
  icon?: React.ReactNode;
  chevron?: React.ReactNode;
  label: string;
  onClick?: () => void;
  muted?: boolean;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
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
    </Tag>
  );
}
