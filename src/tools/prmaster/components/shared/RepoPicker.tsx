/**
 * Searchable multi-select dropdown — used by AiSummaryTab.
 *
 * Two modes:
 *   - default (`compact={false}`): trigger renders selected chips inline,
 *     with a meta row underneath showing counts + Reload.
 *   - compact (`compact={true}`): single-line trigger ("N selected" pill)
 *     with no meta row — fits inside the AI toolbar alongside other
 *     controls.
 */

import { useMemo, useState } from "react";
import { ChevronsUpDown, Download, Loader2, X } from "lucide-react";
import { Badge } from "@zen-tools/ui";
import { Button } from "@zen-tools/ui";
import { Checkbox } from "@zen-tools/ui";
import { Input } from "@zen-tools/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";

interface Props {
  repos: string[];
  selected: Set<string>;
  loading?: boolean;
  /** True while a force-refetch is in flight (separate spinner from `loading`). */
  fetching?: boolean;
  /** UNIX millis of the last cache update (drives the footer hint). */
  cachedAtMs?: number | null;
  /** Render a single-line trigger that fits inside a horizontal toolbar. */
  compact?: boolean;
  onToggle: (repo: string) => void;
  onClear: () => void;
  /** Force re-fetch from GitHub (ignores cache). Optional. */
  onFetch?: () => void;
}

const MAX_CHIPS = 4;

export function RepoPicker({
  repos,
  selected,
  loading,
  fetching,
  cachedAtMs,
  compact = false,
  onToggle,
  onClear,
  onFetch,
}: Props) {
  const [search, setSearch] = useState("");
  const selectedList = useMemo(() => [...selected], [selected]);
  const overflow = Math.max(0, selectedList.length - MAX_CHIPS);

  // Always alphabetical — items don't reshuffle on toggle, so the click
  // target stays put.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? repos.filter((r) => r.toLowerCase().includes(q)) : repos;
    return [...list].sort((a, b) => a.localeCompare(b));
  }, [repos, search]);

  const trigger = compact ? (
    <Button
      variant="outline"
      size="sm"
      type="button"
      className={cn(
        "h-8 w-full justify-between gap-2 px-2 font-normal",
        selectedList.length === 0 && "text-muted-foreground",
      )}
    >
      <span className="flex items-center gap-2 truncate">
        {selectedList.length === 0
          ? loading
            ? "Loading repositories…"
            : repos.length === 0
              ? "No repositories — click Fetch"
              : "Pick repositories…"
          : selectedList.length === 1
            ? selectedList[0]
            : `${selectedList.length} repos`}
      </span>
      <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
    </Button>
  ) : (
    <Button
      variant="outline"
      type="button"
      className="h-auto min-h-9 w-full justify-between gap-2 px-2 py-1.5 font-normal"
    >
      <div className="flex flex-1 flex-wrap items-center gap-1">
        {selectedList.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            {loading
              ? "Loading repositories…"
              : repos.length === 0
                ? "No repositories — click Fetch"
                : "Pick repositories…"}
          </span>
        ) : (
          <>
            {selectedList.slice(0, MAX_CHIPS).map((repo) => (
              <Chip
                key={repo}
                label={repo}
                onRemove={(e) => {
                  e.stopPropagation();
                  onToggle(repo);
                }}
              />
            ))}
            {overflow > 0 && (
              <Badge variant="secondary">+{overflow} more</Badge>
            )}
          </>
        )}
      </div>
      <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
    </Button>
  );

  return (
    <div className={cn("grid", compact ? "" : "gap-1.5")}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-[420px] p-0"
          // Don't auto-close after each item — multi-select needs to stay open.
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div className="border-b p-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter repos…"
              className="h-7 text-xs"
              autoFocus
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="p-3 text-center text-xs text-muted-foreground">
                {repos.length === 0
                  ? "No repositories returned by gh — click Reload."
                  : "No repos match your search."}
              </p>
            ) : (
              filtered.map((repo) => {
                const isOn = selected.has(repo);
                return (
                  <button
                    key={repo}
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onToggle(repo);
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent"
                  >
                    <Checkbox
                      checked={isOn}
                      tabIndex={-1}
                      className="pointer-events-none"
                    />
                    <span className="flex-1 truncate font-mono">{repo}</span>
                  </button>
                );
              })
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5 text-xs text-muted-foreground">
            <span className="truncate">
              {selectedList.length} selected · {repos.length} available
              {cachedAtMs ? ` · ${formatCacheAge(cachedAtMs)}` : ""}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              {selectedList.length > 0 && (
                <Button size="sm" variant="ghost" onClick={onClear}>
                  Clear
                </Button>
              )}
              {onFetch && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={fetching}
                  onClick={onFetch}
                  title="Fetch the full repo list from GitHub (ignores cache)"
                >
                  {fetching ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                  Fetch
                </Button>
              )}
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {!compact && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {selectedList.length} selected · {repos.length} available
          </span>
          {selectedList.length > 0 && (
            <Button size="sm" variant="ghost" onClick={onClear}>
              Clear
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Chip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: (e: React.MouseEvent) => void;
}) {
  return (
    <Badge variant="secondary" className="gap-1 pr-1 font-mono text-xs">
      <span className="max-w-[180px] truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        className="flex shrink-0 cursor-pointer rounded-full p-0.5 hover:bg-muted-foreground/20"
        aria-label={`Remove ${label}`}
      >
        <X className="size-3" />
      </button>
    </Badge>
  );
}

function formatCacheAge(cachedAtMs: number): string {
  const ageMs = Date.now() - cachedAtMs;
  if (ageMs < 60_000) return "cached just now";
  const mins = Math.round(ageMs / 60_000);
  if (mins < 60) return `cached ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `cached ${hours}h ago`;
  const days = Math.round(hours / 24);
  return `cached ${days}d ago`;
}
