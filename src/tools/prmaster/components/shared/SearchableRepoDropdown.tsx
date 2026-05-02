/**
 * Single-select repository dropdown with substring/wildcard search and
 * an explicit "Fetch from GitHub" action. Used by the Settings ➜ Local
 * Repo Mappings editor.
 *
 * Mirrors the experience of the Swift `RepoListPicker` (search box +
 * scrollable list, selected items pinned to the top), but renders inside
 * a `DropdownMenu` so it composes with the rest of PRMaster's chrome.
 */
import { forwardRef, useMemo, useState } from "react";
import { ChevronsUpDown, Download, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Props {
  /** Repos to choose from (already filtered to "unmapped" by the caller). */
  items: string[];
  value: string | null;
  onChange: (next: string | null) => void;
  /** Called when the user clicks the inline reload button. */
  onReload?: () => void;
  /** Called when the user clicks "Fetch from GitHub" (force re-fetch). */
  onFetch?: () => void;
  loading?: boolean;
  fetching?: boolean;
  placeholder?: string;
  /** Footer line — e.g. cache age. */
  footer?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}

export function SearchableRepoDropdown({
  items,
  value,
  onChange,
  onReload,
  onFetch,
  loading = false,
  fetching = false,
  placeholder = "Pick a repository…",
  footer,
  disabled = false,
  className,
}: Props) {
  const [search, setSearch] = useState("");

  // Always alphabetical — even the selected value stays in its natural
  // alphabetical slot so the list never reshuffles between renders.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? items.filter((r) => r.toLowerCase().includes(q)) : items;
    return [...list].sort((a, b) => a.localeCompare(b));
  }, [items, search]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TriggerButton
          label={
            value ??
            (loading
              ? "Loading repositories…"
              : items.length === 0
                ? "No repositories — click Fetch"
                : placeholder)
          }
          empty={!value}
          disabled={disabled}
          className={className}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[420px] p-0"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="border-b p-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repos (matches anywhere)…"
            className="h-7 text-xs"
            autoFocus
            onKeyDown={(e) => {
              // Stop the menu's roving-focus from hijacking arrow keys.
              if (
                e.key === "ArrowDown" ||
                e.key === "ArrowUp" ||
                e.key === "ArrowLeft" ||
                e.key === "ArrowRight"
              ) {
                e.stopPropagation();
              }
            }}
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="p-3 text-center text-xs text-muted-foreground">
              {items.length === 0
                ? "No repositories cached. Click Fetch to load from GitHub."
                : "No repos match your search."}
            </p>
          ) : (
            filtered.map((repo) => {
              const isOn = value === repo;
              return (
                <button
                  key={repo}
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onChange(isOn ? null : repo);
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent",
                    isOn && "bg-accent",
                  )}
                >
                  <span className="flex-1 truncate font-mono">{repo}</span>
                  {isOn && (
                    <span className="text-xs text-muted-foreground">✓</span>
                  )}
                </button>
              );
            })
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5 text-xs text-muted-foreground">
          <span className="truncate">
            {footer ?? `${items.length} repositories cached`}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {onReload && (
              <Button
                size="sm"
                variant="ghost"
                disabled={loading || fetching}
                onClick={onReload}
                title="Reload cached list"
              >
                {loading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                Reload
              </Button>
            )}
            {onFetch && (
              <Button
                size="sm"
                variant="outline"
                disabled={fetching}
                onClick={onFetch}
                title="Re-fetch the full repo list from GitHub"
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
  );
}

const TriggerButton = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    empty: boolean;
    disabled: boolean;
    className?: string;
  } & React.ComponentProps<typeof Button>
>(function TriggerButton({ label, empty, disabled, className, ...rest }, ref) {
  return (
    <Button
      ref={ref}
      variant="outline"
      size="sm"
      type="button"
      disabled={disabled}
      className={cn(
        "h-8 min-w-[18rem] flex-1 justify-between gap-2 px-2 font-normal",
        empty && "text-muted-foreground",
        className,
      )}
      {...rest}
    >
      <span className="truncate font-mono text-xs">{label}</span>
      <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
    </Button>
  );
});
