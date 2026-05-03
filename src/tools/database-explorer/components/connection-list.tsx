/**
 * Right-rail list of saved connections. Single-row design: name +
 * status are always visible; only Edit appears on hover.
 * Delete moved into the edit dialog. Connect / disconnect are not
 * buttons — double-click the row to toggle.
 *
 * Click row       → make active
 * Double-click    → connect (if disconnected) or disconnect (if connected)
 */

import {
  Database,
  Plus,
  Pencil,
  Loader2,
  CheckCircle2,
  AlertCircle,
  PanelRightClose,
} from "lucide-react";
import { Button } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { useDbExplorerStore } from "../store/db-explorer-store";
import { useDbConnection } from "../hooks/use-db-connection";
import { useDbTree } from "../hooks/use-db-tree";
import type { DbConnectionPrefs } from "../lib/tauri";

interface ConnectionListProps {
  /** Optional — if provided, a chevron button collapses the rail. */
  onCollapse?: () => void;
}

export function ConnectionList({ onCollapse }: ConnectionListProps = {}) {
  const { state, dispatch } = useDbExplorerStore();
  const { connect, disconnect } = useDbConnection();
  const { fetchDatabases } = useDbTree();

  async function handleConnect(c: DbConnectionPrefs) {
    dispatch({ type: "set-active-connection", id: c.id });
    await connect(c.id);
    fetchDatabases(c.id);
  }

  return (
    <div className="flex flex-col gap-1 p-2">
      <div className="flex items-center justify-between gap-1 px-1">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Connections
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0"
            onClick={() => dispatch({ type: "open-form", mode: "new" })}
            title="Add connection"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          {onCollapse && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              onClick={onCollapse}
              title="Collapse panel"
            >
              <PanelRightClose className="size-3" />
            </Button>
          )}
        </div>
      </div>

      {state.connections.length === 0 && (
        <div className="px-2 py-4 text-center text-xs text-muted-foreground">
          No connections yet. Click + to add one.
        </div>
      )}

      <ul className="flex flex-col">
        {state.connections.map((c) => {
          const status = state.status[c.id] ?? "disconnected";
          const isActive = state.activeConnectionId === c.id;
          const connected = status === "connected";
          return (
            <li
              key={c.id}
              className={cn(
                "group flex items-center gap-1 rounded px-2 py-1 transition",
                isActive ? "bg-muted" : "hover:bg-muted/50",
              )}
            >
              {/* Title — fills the row. Click = select, dblclick =
                  toggle connect/disconnect. The buttons are gone; the
                  row IS the action surface. */}
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() =>
                  dispatch({ type: "set-active-connection", id: c.id })
                }
                onDoubleClick={() => {
                  if (connected) void disconnect(c.id);
                  else void handleConnect(c);
                }}
                title={
                  connected
                    ? `${c.name} — double-click to disconnect`
                    : `${c.name} — double-click to connect`
                }
              >
                <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate text-sm">{c.name}</span>
              </button>

              {/* Edit is the only hover-revealed action — Delete lives
                  inside the edit dialog, Connect/Disconnect via dblclick. */}
              <Button
                size="sm"
                variant="ghost"
                className="h-5 w-5 shrink-0 p-0 opacity-0 transition group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: "open-form", mode: { editId: c.id } });
                }}
                title="Edit (Delete lives inside the edit dialog)"
              >
                <Pencil className="size-3" />
              </Button>

              {/* Status indicator pinned at the right edge. */}
              <StatusBadge status={status} />
            </li>
          );
        })}
      </ul>

      {/* Per-connection error line, displayed below the list since the
          row itself is now single-line. */}
      {state.connections.some((c) => state.errors[c.id]) && (
        <ul className="mt-1 flex flex-col gap-0.5 px-1 text-[11px] text-red-500">
          {state.connections.map((c) =>
            state.errors[c.id] ? (
              <li
                key={c.id}
                className="truncate"
                title={state.errors[c.id] ?? ""}
              >
                <span className="font-mono opacity-70">{c.name}:</span>{" "}
                {state.errors[c.id]}
              </li>
            ) : null,
          )}
        </ul>
      )}
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
