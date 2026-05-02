/**
 * Single compact connection picker that replaces the previous tab
 * strip. Designed to scale to N connections without overflow:
 *
 *   - One button shows the active connection (driver dot + name +
 *     ▾). Always one row tall, no matter how many connections you
 *     have saved.
 *   - Click → dropdown menu listing every saved connection with
 *     status (●connected / ○disconnected / spinner / red ✕).
 *   - Selecting a row sets it active AND auto-connects if it
 *     wasn't already (one click, no double-click).
 *   - Footer items: + Add connection, ✎ Edit current, ✕ Disconnect
 *     current. Sticky to the menu bottom so the list above is what
 *     scrolls when you have 50 connections.
 *
 * No border-ring "you are here" outline — the active state lives
 * inside the dropdown's selected-item highlight, which is far
 * quieter than a glowing accent on the row itself.
 */

import { Database, LogOut, Pencil, Plus, ChevronDown, Check, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useDbExplorerStore } from "../store/db-explorer-store";
import { useDbConnection } from "../hooks/use-db-connection";
import { useDbTree } from "../hooks/use-db-tree";
import type { DbConnectionPrefs } from "../lib/tauri";

/**
 * Per-driver accent — small dot only. The previous "2-px ring around
 * the active tab" treatment was too loud; restricting the colour to
 * a 6-px circle gives the eye a quiet driver signal without the row
 * itself looking like it's on fire.
 */
function driverAccent(driver: DbConnectionPrefs["driver"] | undefined): string {
  switch (driver) {
    case "postgres":
      return "var(--chart-2)";
    case "mssql":
      return "var(--chart-1)";
    default:
      return "var(--muted-foreground)";
  }
}

export function ConnectionTabs() {
  const { state, dispatch } = useDbExplorerStore();
  const { connect, disconnect } = useDbConnection();
  const { fetchDatabases } = useDbTree();

  const connections = state.connections;
  const activeId = state.activeConnectionId;
  const active =
    connections.find((c) => c.id === activeId) ?? null;
  const activeStatus = active ? state.status[active.id] : undefined;
  const activeAccent = driverAccent(active?.driver);

  async function handlePick(c: DbConnectionPrefs) {
    dispatch({ type: "set-active-connection", id: c.id });
    const status = state.status[c.id];
    if (status !== "connected" && status !== "connecting") {
      await connect(c.id);
      // Match the old ConnectionList dblclick flow — kick the
      // catalog load so the schema tree populates without a
      // follow-up click.
      fetchDatabases(c.id);
    }
  }

  return (
    // Thin top rail — same `bg-muted/60` vocabulary as before so
    // the editor-tab and result-tab strips are still in the same
    // visual family. Single-row regardless of connection count.
    <div className="flex shrink-0 items-center gap-1 border-b border-border/60 bg-muted/40 px-2 py-1 text-[11px]">
      <DropdownMenu>
        {/* No `asChild` + Button wrapper here — that pattern was
            swallowing the click in this codebase (the trigger
            opened nothing). The matching context-picker.tsx file
            uses DropdownMenuTrigger directly as a styled button,
            and that one works; we follow that proven shape. */}
        <DropdownMenuTrigger
          className="flex h-7 items-center gap-1.5 rounded px-2 text-[11px] transition hover:bg-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          title={
            active
              ? `Switch connection — currently ${active.name}`
              : "Pick a connection"
          }
        >
          {/* Driver-coloured dot — the only spot of colour, and
              only when the connection is live. Kept to a 6-px
              circle so it doesn't dominate the row. */}
          <StatusGlyph status={activeStatus} accent={activeAccent} />
          <Database className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-mono">
            {active ? active.name : "no connection"}
          </span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          // Cap the menu height so a 20+ connection list scrolls
          // inside the dropdown rather than running past the
          // viewport edge.
          className="w-72 max-h-[50vh] overflow-y-auto"
        >
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Connections ({connections.length})
          </DropdownMenuLabel>

          {connections.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              No connections yet.
            </div>
          ) : (
            connections.map((c) => {
              const status = state.status[c.id] ?? "disconnected";
              const isActive = c.id === activeId;
              const accent = driverAccent(c.driver);
              return (
                <DropdownMenuItem
                  key={c.id}
                  onSelect={() => void handlePick(c)}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5",
                    isActive && "bg-accent/60",
                  )}
                >
                  <StatusGlyph status={status} accent={accent} />
                  <Database
                    className="size-3.5 shrink-0 text-muted-foreground"
                    style={{
                      color: status === "connected" ? accent : undefined,
                    }}
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate font-mono",
                      isActive && "font-medium",
                    )}
                  >
                    {c.name}
                  </span>
                  {isActive ? (
                    <Check className="size-3 shrink-0 text-muted-foreground" />
                  ) : null}
                </DropdownMenuItem>
              );
            })
          )}

          <DropdownMenuSeparator />

          {/* Footer actions, pinned. The disconnect / edit ones
              only render when there's an active connection to act
              on; the add action is always available. */}
          {active ? (
            <>
              <DropdownMenuItem
                onSelect={() =>
                  dispatch({
                    type: "open-form",
                    mode: { editId: active.id },
                  })
                }
                className="gap-2 px-2 py-1.5"
              >
                <Pencil className="size-3.5 shrink-0" />
                Edit {active.name}
              </DropdownMenuItem>
              {(activeStatus === "connected" || activeStatus === "connecting") && (
                <DropdownMenuItem
                  onSelect={() => void disconnect(active.id)}
                  className="gap-2 px-2 py-1.5"
                >
                  <LogOut className="size-3.5 shrink-0" />
                  Disconnect {active.name}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem
            onSelect={() => dispatch({ type: "open-form", mode: "new" })}
            className="gap-2 px-2 py-1.5"
          >
            <Plus className="size-3.5 shrink-0" />
            Add connection
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Right-edge fast Add — duplicates the menu's last item but
          puts it one click away when the user just wants to add a
          new connection without browsing the list first. */}
      <span className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => dispatch({ type: "open-form", mode: "new" })}
        title="Add a new database connection"
      >
        <Plus className="size-3" />
        Add
      </Button>
    </div>
  );
}

/**
 * Compact 6-px glyph that summarises a connection's state.
 *
 *   - connected     → driver-coloured solid dot
 *   - connecting    → spinner
 *   - error         → red alert icon
 *   - disconnected  → hollow ring
 *
 * Kept tiny on purpose — the row's name is the primary scan
 * target, the glyph is just a subtitle.
 */
function StatusGlyph({
  status,
  accent,
}: {
  status: string | undefined;
  accent: string;
}) {
  switch (status) {
    case "connected":
      return (
        <span
          className="inline-block size-1.5 shrink-0 rounded-full"
          style={{ background: accent }}
        />
      );
    case "connecting":
      return <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />;
    case "error":
      return <AlertCircle className="size-3 shrink-0 text-destructive" />;
    default:
      return (
        <span className="inline-block size-1.5 shrink-0 rounded-full border border-muted-foreground/40" />
      );
  }
}
