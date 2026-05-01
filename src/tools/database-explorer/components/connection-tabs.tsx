/**
 * Tab strip showing every currently-connected database. Clicking a tab
 * makes that connection active in the editor + results pane. Closing a
 * tab disconnects (the saved connection stays in the sidebar).
 *
 * Multiple connections can be live at once — each has its own editor
 * buffer, its own results, and queries on different connections run
 * independently (one slow query doesn't block another).
 */

import { Database, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDbExplorerStore } from "../store/db-explorer-store";
import { useDbConnection } from "../hooks/use-db-connection";

export function ConnectionTabs() {
  const { state, dispatch } = useDbExplorerStore();
  const { disconnect } = useDbConnection();

  // A connection is "open" (eligible for a tab) iff it's currently
  // connected. Connection metadata in the sidebar isn't enough — we
  // only show a tab once the live registry has it.
  const openTabs = state.connections.filter(
    (c) => state.status[c.id] === "connected" || state.running[c.id],
  );

  if (openTabs.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border/60 bg-muted/20 px-1 py-0.5">
      {openTabs.map((c) => {
        const isActive = state.activeConnectionId === c.id;
        return (
          <div
            key={c.id}
            className={
              "group flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] transition " +
              (isActive
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:bg-muted/50")
            }
          >
            <button
              type="button"
              className="flex items-center gap-1.5"
              onClick={() =>
                dispatch({ type: "set-active-connection", id: c.id })
              }
            >
              <Database className="size-3" />
              <span className="font-mono">{c.name}</span>
              {state.running[c.id] && (
                <span className="ml-1 inline-block size-1.5 animate-pulse rounded-full bg-foreground/60" />
              )}
            </button>
            <Button
              variant="ghost"
              size="sm"
              className="h-4 w-4 p-0 opacity-0 transition group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                void disconnect(c.id);
                if (isActive) {
                  // Pick another live tab if one exists, otherwise null.
                  const next = openTabs.find((t) => t.id !== c.id);
                  dispatch({
                    type: "set-active-connection",
                    id: next?.id ?? null,
                  });
                }
              }}
              title="Close (disconnect)"
            >
              <X className="size-3" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
