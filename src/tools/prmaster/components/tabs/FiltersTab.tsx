/**
 * Filters tab — CRUD over `NotificationFilter` rows. Built on shadcn
 * primitives so the form, list, and empty state share the same idiom as
 * Settings + AI Summary.
 */

import { useEffect, useState } from "react";
import {
  Bell,
  BellOff,
  Loader2,
  PencilLine,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Panel, PanelContent, PanelTitle } from "../shared/density";
import {
  prmasterTauri,
  type NotificationActionKind,
  type NotificationFilter,
} from "../../lib/tauri";
import { FilterForm } from "../shared/FilterForm";

export function FiltersTab() {
  const [rows, setRows] = useState<NotificationFilter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<NotificationFilter | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setRows(await prmasterTauri.listFilters());
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function newFilter(): NotificationFilter {
    const now = Date.now();
    return {
      id: crypto.randomUUID(),
      name: "",
      authors: [],
      repos: [],
      file_globs: [],
      title_regex: null,
      action: "sound_banner",
      enabled: true,
      created_at_ms: now,
      updated_at_ms: now,
    };
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center justify-between border-b bg-card/40 px-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">Filters</h2>
          <span className="text-xs text-muted-foreground">
            {rows.length} {rows.length === 1 ? "rule" : "rules"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Refresh
          </Button>
          <Button
            size="sm"
            disabled={editing !== null}
            onClick={() => setEditing(newFilter())}
          >
            <Plus className="size-4" />
            New filter
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-muted/20">
        <div className="grid gap-2 p-2">
          {error && (
            <Panel className="border-destructive/40 bg-destructive/5">
              <PanelContent className="p-2 text-xs text-destructive">
                {error}
              </PanelContent>
            </Panel>
          )}

          {editing && (
            <FilterForm
              initial={editing}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                void refresh();
              }}
            />
          )}

          {rows.length === 0 && !loading && !error && !editing && (
            <Panel className="border-dashed">
              <PanelContent className="flex flex-col items-center gap-1.5 py-6 text-center">
                <Bell className="size-5 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">
                  No filters yet — create one to route notifications.
                </p>
              </PanelContent>
            </Panel>
          )}

          <div className="grid gap-1.5">
            {rows.map((row) => (
              <FilterRow
                key={row.id}
                row={row}
                isEditing={editing?.id === row.id}
                onEdit={() => setEditing({ ...row })}
                onDelete={async () => {
                  try {
                    await prmasterTauri.deleteFilter(row.id);
                    await refresh();
                  } catch (err) {
                    setError(formatError(err));
                  }
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function FilterRow({
  row,
  isEditing,
  onEdit,
  onDelete,
}: {
  row: NotificationFilter;
  isEditing: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const Icon = row.enabled ? Bell : BellOff;
  return (
    <Panel
      className={cn(
        "transition-colors",
        isEditing && "ring-2 ring-ring",
      )}
    >
      <div className="flex items-start gap-2 px-2.5 py-1.5">
        <Icon
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            row.enabled ? "text-foreground" : "text-muted-foreground",
          )}
        />
        <div className="flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <PanelTitle className="text-sm">
              {row.name || "Untitled"}
            </PanelTitle>
            <ActionBadge action={row.action} />
            {!row.enabled && <Badge variant="outline">disabled</Badge>}
          </div>
          <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
            {row.authors.length > 0 && (
              <span>authors: {row.authors.join(", ")}</span>
            )}
            {row.repos.length > 0 && (
              <span>repos: {row.repos.join(", ")}</span>
            )}
            {row.file_globs.length > 0 && (
              <span>files: {row.file_globs.join(", ")}</span>
            )}
            {row.title_regex && (
              <span className="font-mono">title: /{row.title_regex}/i</span>
            )}
            {row.authors.length === 0 &&
              row.repos.length === 0 &&
              row.file_globs.length === 0 &&
              !row.title_regex && (
                <span className="italic">matches every PR</span>
              )}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onEdit}
            aria-label="Edit"
          >
            <PencilLine className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onDelete}
            aria-label="Delete"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function ActionBadge({ action }: { action: NotificationActionKind }) {
  const label = (() => {
    switch (action) {
      case "sound_banner":
        return "Sound + Banner";
      case "silent_banner":
        return "Silent Banner";
      case "badge_only":
        return "Badge Only";
      case "mute":
        return "Mute";
    }
  })();
  const variant = action === "mute" ? "outline" : "secondary";
  return <Badge variant={variant}>{label}</Badge>;
}

function formatError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
