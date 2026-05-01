/**
 * Left-rail list of saved connections. Click to make active; double-click
 * (or Connect button) opens a live connection.
 */

import {
  Database,
  Plus,
  Pencil,
  Trash2,
  Plug,
  Unplug,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDbExplorerStore } from "../store/db-explorer-store";
import { useDbConnection } from "../hooks/use-db-connection";
import { useDbTree } from "../hooks/use-db-tree";
import { dbTauri, type DbConnectionPrefs } from "../lib/tauri";

export function ConnectionList() {
  const { state, dispatch } = useDbExplorerStore();
  const { connect, disconnect } = useDbConnection();
  const { fetchDatabases } = useDbTree();

  async function handleConnect(c: DbConnectionPrefs) {
    dispatch({ type: "set-active-connection", id: c.id });
    await connect(c.id);
    fetchDatabases(c.id);
  }

  async function handleDelete(c: DbConnectionPrefs) {
    if (!confirm(`Delete connection "${c.name}"?`)) return;
    try {
      await dbTauri.deleteConnection(c.id);
      const rows = await dbTauri.listSavedConnections();
      dispatch({ type: "set-connections", connections: rows });
      if (state.activeConnectionId === c.id) {
        dispatch({ type: "set-active-connection", id: null });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("delete connection failed", err);
    }
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Connections
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          onClick={() => dispatch({ type: "open-form", mode: "new" })}
          title="Add connection"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {state.connections.length === 0 && (
        <div className="px-2 py-4 text-center text-xs text-muted-foreground">
          No connections yet. Click + to add one.
        </div>
      )}

      <ul className="flex flex-col gap-1">
        {state.connections.map((c) => {
          const status = state.status[c.id] ?? "disconnected";
          const isActive = state.activeConnectionId === c.id;
          return (
            <li
              key={c.id}
              className={
                "group rounded px-2 py-1.5 transition " +
                (isActive ? "bg-muted" : "hover:bg-muted/50")
              }
            >
              <button
                type="button"
                className="flex w-full items-center gap-2 text-left"
                onClick={() =>
                  dispatch({ type: "set-active-connection", id: c.id })
                }
                onDoubleClick={() => handleConnect(c)}
              >
                <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate text-sm">{c.name}</span>
                <StatusBadge status={status} />
              </button>

              <div className="mt-1 flex gap-1 opacity-0 transition group-hover:opacity-100">
                {status === "connected" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => disconnect(c.id)}
                  >
                    <Unplug className="mr-1 h-3 w-3" />
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => handleConnect(c)}
                  >
                    <Plug className="mr-1 h-3 w-3" />
                    Connect
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0"
                  onClick={() =>
                    dispatch({ type: "open-form", mode: { editId: c.id } })
                  }
                  title="Edit"
                >
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0"
                  onClick={() => handleDelete(c)}
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>

              {state.errors[c.id] && (
                <div className="mt-1 truncate text-[11px] text-red-500" title={state.errors[c.id] ?? ""}>
                  {state.errors[c.id]}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "connecting":
      return <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />;
    case "connected":
      return <CheckCircle2 className="h-3 w-3 text-green-500" />;
    case "error":
      return <AlertCircle className="h-3 w-3 text-red-500" />;
    default:
      return <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />;
  }
}
