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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
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
        <div className="grid gap-3 p-3">
          {error && (
            <Card className="border-destructive/40 bg-destructive/5">
              <CardContent className="p-3 text-sm text-destructive">
                {error}
              </CardContent>
            </Card>
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
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
                <Bell className="size-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No filters yet.
                </p>
                <p className="text-xs text-muted-foreground">
                  Create one to route notifications to sound, banner,
                  badge, or mute.
                </p>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-2">
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
    <Card
      className={cn(
        "transition-colors",
        isEditing && "ring-2 ring-ring",
      )}
    >
      <CardHeader className="flex flex-row items-start gap-3 space-y-0 p-4">
        <Icon
          className={cn(
            "mt-0.5 size-4 shrink-0",
            row.enabled ? "text-foreground" : "text-muted-foreground",
          )}
        />
        <div className="flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-sm">{row.name || "Untitled"}</CardTitle>
            <ActionBadge action={row.action} />
            {!row.enabled && <Badge variant="outline">disabled</Badge>}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
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
      </CardHeader>
    </Card>
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
