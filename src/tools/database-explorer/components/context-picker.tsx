/**
 * Database / schema picker shown in the run toolbar — DataGrip-style
 * "current schema" affordance. Picking a value writes it into the store
 * and (for Postgres) is applied as `SET search_path` on the next query;
 * (for MSSQL) is applied as `USE [db]`.
 */

import { useEffect } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDbExplorerStore } from "../store/db-explorer-store";
import { useDbTree } from "../hooks/use-db-tree";
import type { DbConnectionPrefs } from "../lib/tauri";

interface ContextPickerProps {
  connection: DbConnectionPrefs;
  isConnected: boolean;
}

export function ContextPicker({ connection, isConnected }: ContextPickerProps) {
  const { state, dispatch } = useDbExplorerStore();
  const { fetchDatabases, fetchSchemas } = useDbTree();

  const tree = state.trees[connection.id];
  const activeDb =
    state.activeDbByConnection[connection.id] ?? connection.database;
  const activeSchema = state.activeSchemaByConnection[connection.id] ?? "";

  const databases = tree?.databases ?? [];
  const schemas = tree?.schemasByDb[activeDb] ?? [];

  // For MSSQL the user can switch databases, so make sure we have the
  // list. For Postgres list_databases returns only the connected DB so
  // we still call it (cheap) to populate the tree node display.
  useEffect(() => {
    if (!isConnected) return;
    if (!tree?.databases) {
      fetchDatabases(connection.id);
    }
  }, [isConnected, tree?.databases, fetchDatabases, connection.id]);

  // Auto-load schemas when the active DB changes.
  useEffect(() => {
    if (!isConnected || !activeDb) return;
    if (!tree?.schemasByDb[activeDb]) {
      fetchSchemas(connection.id, activeDb);
    }
  }, [isConnected, activeDb, tree?.schemasByDb, fetchSchemas, connection.id]);

  if (!isConnected) return null;

  return (
    <div className="flex items-center gap-1">
      {connection.driver === "mssql" && (
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex items-center gap-1 rounded border border-border/60 bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/50"
            title="Active database"
          >
            <span className="font-mono">{activeDb || "—"}</span>
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-auto">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide">
              Database
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {databases.length === 0 ? (
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Loading…
              </DropdownMenuLabel>
            ) : (
              databases.map((db) => (
                <DropdownMenuCheckboxItem
                  key={db}
                  checked={db === activeDb}
                  onCheckedChange={() =>
                    dispatch({
                      type: "set-active-database",
                      id: connection.id,
                      database: db,
                    })
                  }
                >
                  {db}
                </DropdownMenuCheckboxItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex items-center gap-1 rounded border border-border/60 bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/50"
          title={
            connection.driver === "postgres"
              ? "search_path schema"
              : "Schema (T-SQL: qualify table names)"
          }
        >
          <span className="font-mono">{activeSchema || "schema"}</span>
          <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-auto">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide">
            Schema
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={activeSchema === ""}
            onCheckedChange={() =>
              dispatch({
                type: "set-active-schema",
                id: connection.id,
                schema: "",
              })
            }
          >
            <span className="italic text-muted-foreground">(none)</span>
          </DropdownMenuCheckboxItem>
          {schemas.length === 0 ? (
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Loading…
            </DropdownMenuLabel>
          ) : (
            schemas.map((s) => (
              <DropdownMenuCheckboxItem
                key={s}
                checked={s === activeSchema}
                onCheckedChange={() =>
                  dispatch({
                    type: "set-active-schema",
                    id: connection.id,
                    schema: s,
                  })
                }
              >
                {s}
              </DropdownMenuCheckboxItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
