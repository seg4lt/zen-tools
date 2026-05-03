/**
 * Database / schema picker shown on the connection-tabs row —
 * DataGrip-style "current schema" affordance. Picking a value
 * writes it into the store and (for Postgres) is applied as
 * `SET search_path` on the next query; (for MSSQL) is applied as
 * `USE [db]`.
 *
 * The picker uses a `cmdk`-backed Command popover so the user can
 * type-to-filter when they have many schemas / databases. Plain
 * DropdownMenuCheckboxItem rows would scroll a 50-schema list
 * indefinitely; the filter input above the list cuts that to a
 * one-keystroke search.
 */

import { useEffect, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@zen-tools/ui";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@zen-tools/ui";
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
        <FilterablePicker
          title="Active database"
          label={activeDb || "—"}
          items={databases}
          selected={activeDb}
          placeholder="Filter databases…"
          emptyText="No databases match"
          loading={!tree?.databases}
          loadingText="Loading databases…"
          onSelect={(db) =>
            dispatch({
              type: "set-active-database",
              id: connection.id,
              database: db,
            })
          }
        />
      )}

      <FilterablePicker
        title={
          connection.driver === "postgres"
            ? "search_path schema"
            : "Schema (T-SQL: qualify table names)"
        }
        label={activeSchema || "schema"}
        items={schemas}
        selected={activeSchema}
        placeholder="Filter schemas…"
        emptyText="No schemas match"
        loading={!tree?.schemasByDb[activeDb]}
        loadingText="Loading schemas…"
        // Add an explicit "(none)" option for Postgres — clears
        // `activeSchema` so the next query inherits whatever
        // search_path the connection was set up with.
        extraTopItem={
          connection.driver === "postgres"
            ? {
                value: "",
                label: "(none — use connection default)",
              }
            : undefined
        }
        onSelect={(s) =>
          dispatch({
            type: "set-active-schema",
            id: connection.id,
            schema: s,
          })
        }
      />
    </div>
  );
}

/**
 * Trigger button + Popover-hosted Command list. The Command list
 * filters in-place as the user types, no async work needed
 * (databases / schemas are pre-fetched into the tree state).
 */
function FilterablePicker({
  title,
  label,
  items,
  selected,
  placeholder,
  emptyText,
  loading,
  loadingText,
  extraTopItem,
  onSelect,
}: {
  title: string;
  label: string;
  items: string[];
  selected: string;
  placeholder: string;
  emptyText: string;
  loading: boolean;
  loadingText: string;
  /** Optional pinned item rendered above the items list — used to
   * surface "(none)" / clear-selection rows. */
  extraTopItem?: { value: string; label: string };
  onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="flex items-center gap-1 rounded border border-border/60 bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        title={title}
      >
        <span className="font-mono">{label}</span>
        <ChevronDown className="size-3" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={placeholder} className="h-8 text-[12px]" />
          <CommandList>
            {loading ? (
              <div className="py-3 text-center text-xs text-muted-foreground">
                {loadingText}
              </div>
            ) : (
              <>
                <CommandEmpty>{emptyText}</CommandEmpty>
                <CommandGroup>
                  {extraTopItem ? (
                    <CommandItem
                      value={extraTopItem.label}
                      onSelect={() => {
                        onSelect(extraTopItem.value);
                        setOpen(false);
                      }}
                      className="text-[12px]"
                    >
                      <span className="italic text-muted-foreground">
                        {extraTopItem.label}
                      </span>
                      {selected === extraTopItem.value ? (
                        <Check className="ml-auto size-3 text-muted-foreground" />
                      ) : null}
                    </CommandItem>
                  ) : null}
                  {items.map((it) => (
                    <CommandItem
                      key={it}
                      value={it}
                      onSelect={() => {
                        onSelect(it);
                        setOpen(false);
                      }}
                      className="font-mono text-[12px]"
                    >
                      {it}
                      {selected === it ? (
                        <Check className="ml-auto size-3 text-muted-foreground" />
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
