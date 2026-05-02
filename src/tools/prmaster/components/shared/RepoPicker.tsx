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
import { ChevronsUpDown, Loader2, RefreshCw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface Props {
  repos: string[];
  selected: Set<string>;
  loading?: boolean;
  /** Render a single-line trigger that fits inside a horizontal toolbar. */
  compact?: boolean;
  onToggle: (repo: string) => void;
  onClear: () => void;
  onReload: () => void;
}

const MAX_CHIPS = 4;

export function RepoPicker({
  repos,
  selected,
  loading,
  compact = false,
  onToggle,
  onClear,
  onReload,
}: Props) {
  const [open, setOpen] = useState(false);
  const selectedList = useMemo(() => [...selected], [selected]);
  const overflow = Math.max(0, selectedList.length - MAX_CHIPS);

  const trigger = compact ? (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        "h-8 w-full justify-between gap-2 px-2 font-normal",
        selectedList.length === 0 && "text-muted-foreground",
      )}
    >
      <span className="flex items-center gap-2 truncate">
        {selectedList.length === 0
          ? "Pick repositories…"
          : selectedList.length === 1
            ? selectedList[0]
            : `${selectedList.length} repos`}
      </span>
      <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
    </Button>
  ) : (
    <Button
      variant="outline"
      className="h-auto min-h-9 w-full justify-between gap-2 px-2 py-1.5 font-normal"
    >
      <div className="flex flex-1 flex-wrap items-center gap-1">
        {selectedList.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            Pick repositories…
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
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent align="start" className="w-[420px] p-0">
          <Command>
            <CommandInput placeholder="Filter repos…" />
            <CommandList className="max-h-72">
              <CommandEmpty>No repos match.</CommandEmpty>
              <CommandGroup>
                {repos.map((repo) => {
                  const isSelected = selected.has(repo);
                  return (
                    <CommandItem
                      key={repo}
                      value={repo}
                      onSelect={() => onToggle(repo)}
                      className="gap-2 font-mono text-xs"
                    >
                      <Checkbox
                        checked={isSelected}
                        tabIndex={-1}
                        className="pointer-events-none"
                      />
                      <span className="flex-1 truncate">{repo}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
            <div className="flex items-center justify-between border-t px-2 py-1.5 text-xs text-muted-foreground">
              <span>
                {selectedList.length} selected · {repos.length} available
              </span>
              <div className="flex items-center gap-1">
                {selectedList.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={onClear}>
                    Clear
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={loading}
                  onClick={onReload}
                >
                  {loading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  Reload
                </Button>
              </div>
            </div>
          </Command>
        </PopoverContent>
      </Popover>

      {!compact && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {selectedList.length} selected · {repos.length} available
          </span>
          <div className="flex items-center gap-1">
            {selectedList.length > 0 && (
              <Button size="sm" variant="ghost" onClick={onClear}>
                Clear
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={onReload}
            >
              {loading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Reload
            </Button>
          </div>
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
