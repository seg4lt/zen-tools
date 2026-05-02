/**
 * PR filter bar — mirrors PRMaster's Swift `FilterBar.swift`:
 *
 *   [Filter ▾]  [Author ▾]  [Repo ▾]  ... [×]  [Search…]
 *
 * - **Saved filter**: dropdown of `NotificationFilter`s (from
 *   `prmaster_list_filters`). Selecting one applies that filter's
 *   author / repo / glob / title-regex predicate.
 * - **Author / Repo**: derived from the rows the bar is filtering;
 *   each opens a multi-select dropdown (substring/wildcard search,
 *   stays open while you toggle multiple items).
 * - **Search**: free-text title / author substring match.
 *
 * Wired up as the `filterBar` slot of `EnrichedListView` on the Review
 * and Done tabs.
 */
import { forwardRef, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  Filter,
  Folder,
  Search,
  User,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  prmasterTauri,
  type EnrichedPullRequest,
  type NotificationFilter,
} from "../../lib/tauri";

export interface PrFilterState {
  authors: Set<string>;
  repos: Set<string>;
  search: string;
  savedFilterId: string | null;
}

export const emptyFilterState: PrFilterState = {
  authors: new Set(),
  repos: new Set(),
  search: "",
  savedFilterId: null,
};

export function applyPrFilters(
  rows: EnrichedPullRequest[],
  state: PrFilterState,
  savedFilters: NotificationFilter[],
): EnrichedPullRequest[] {
  let filtered = rows;

  const saved = state.savedFilterId
    ? savedFilters.find((f) => f.id === state.savedFilterId)
    : null;

  if (saved) {
    filtered = filtered.filter((row) => {
      const pr = row.pr;
      if (saved.authors.length > 0) {
        const author = pr.author?.login ?? "";
        if (!saved.authors.includes(author)) return false;
      }
      if (saved.repos.length > 0) {
        const full = pr.repository.nameWithOwner;
        const short = full.split("/", 2)[1] ?? full;
        if (!saved.repos.some((r) => r === full || r === short)) return false;
      }
      if (saved.title_regex) {
        try {
          if (!new RegExp(saved.title_regex, "i").test(pr.title)) return false;
        } catch {
          /* invalid regex -> skip the regex filter */
        }
      }
      return true;
    });
  }

  if (state.authors.size > 0) {
    filtered = filtered.filter((row) =>
      row.pr.author ? state.authors.has(row.pr.author.login) : false,
    );
  }
  if (state.repos.size > 0) {
    filtered = filtered.filter((row) =>
      state.repos.has(row.pr.repository.nameWithOwner),
    );
  }
  const q = state.search.trim().toLowerCase();
  if (q.length > 0) {
    filtered = filtered.filter((row) => {
      const pr = row.pr;
      return (
        pr.title.toLowerCase().includes(q) ||
        (pr.author?.login.toLowerCase().includes(q) ?? false)
      );
    });
  }
  return filtered;
}

export function PrFilterBar({
  rows,
  state,
  onChange,
}: {
  rows: EnrichedPullRequest[];
  state: PrFilterState;
  onChange: (next: PrFilterState) => void;
}) {
  const [savedFilters, setSavedFilters] = useState<NotificationFilter[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await prmasterTauri.listFilters();
        if (alive) setSavedFilters(list);
      } catch {
        // Filters tab will surface failures; the bar just hides the menu.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const allAuthors = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      const a = r.pr.author?.login;
      if (a) set.add(a);
    }
    return [...set].sort();
  }, [rows]);

  const allRepos = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.pr.repository.nameWithOwner);
    return [...set].sort();
  }, [rows]);

  const activeSaved = state.savedFilterId
    ? savedFilters.find((f) => f.id === state.savedFilterId)
    : null;

  const hasAny =
    !!activeSaved ||
    state.authors.size > 0 ||
    state.repos.size > 0 ||
    state.search.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Saved filter dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <FilterChipButton
            icon={Filter}
            label={activeSaved ? activeSaved.name : "Filter"}
            active={!!activeSaved}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Saved filters</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => onChange({ ...state, savedFilterId: null })}
          >
            No filter
          </DropdownMenuItem>
          {savedFilters.length > 0 && <DropdownMenuSeparator />}
          {savedFilters
            .filter((f) => f.enabled)
            .map((f) => (
              <DropdownMenuItem
                key={f.id}
                onSelect={() => onChange({ ...state, savedFilterId: f.id })}
              >
                <span className="flex-1 truncate">{f.name}</span>
                {state.savedFilterId === f.id && (
                  <Badge variant="secondary" className="ml-2">
                    on
                  </Badge>
                )}
              </DropdownMenuItem>
            ))}
          {savedFilters.length === 0 && (
            <DropdownMenuItem disabled>
              <span className="text-xs text-muted-foreground">
                Add filters in the Filters tab
              </span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <MultiSelectChip
        icon={User}
        label={
          state.authors.size === 0
            ? "Author"
            : state.authors.size === 1
              ? `@${[...state.authors][0]}`
              : `${state.authors.size} authors`
        }
        active={state.authors.size > 0}
        items={allAuthors}
        selected={state.authors}
        onToggle={(item) => {
          const next = new Set(state.authors);
          if (next.has(item)) next.delete(item);
          else next.add(item);
          onChange({ ...state, authors: next });
        }}
        onClear={() => onChange({ ...state, authors: new Set() })}
        formatItem={(s) => `@${s}`}
        placeholder="Filter authors…"
      />

      <MultiSelectChip
        icon={Folder}
        label={
          state.repos.size === 0
            ? "Repo"
            : state.repos.size === 1
              ? ([...state.repos][0]?.split("/")[1] ?? [...state.repos][0]!)
              : `${state.repos.size} repos`
        }
        active={state.repos.size > 0}
        items={allRepos}
        selected={state.repos}
        onToggle={(item) => {
          const next = new Set(state.repos);
          if (next.has(item)) next.delete(item);
          else next.add(item);
          onChange({ ...state, repos: next });
        }}
        onClear={() => onChange({ ...state, repos: new Set() })}
        formatItem={(s) => s}
        placeholder="Filter repos…"
        wide
      />

      {hasAny && (
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() =>
            onChange({
              authors: new Set(),
              repos: new Set(),
              search: "",
              savedFilterId: null,
            })
          }
          aria-label="Clear filters"
        >
          <X className="size-3.5" />
        </Button>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <Search className="size-3.5 text-muted-foreground" />
        <Input
          value={state.search}
          onChange={(e) => onChange({ ...state, search: e.target.value })}
          placeholder="Search title/author"
          className="h-7 w-44"
        />
      </div>
    </div>
  );
}

/** A chip-style trigger button that forwards refs so it can sit inside
 *  Radix `*Trigger asChild` slots without losing event wiring. */
const FilterChipButton = forwardRef<
  HTMLButtonElement,
  {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    active: boolean;
  } & React.ComponentProps<typeof Button>
>(function FilterChipButton({ icon: Icon, label, active, ...rest }, ref) {
  return (
    <Button
      ref={ref}
      variant={active ? "secondary" : "outline"}
      size="sm"
      type="button"
      className={cn("h-7 gap-1 px-2 text-xs font-normal")}
      {...rest}
    >
      <Icon className="size-3.5" />
      <span className="max-w-[140px] truncate">{label}</span>
      <ChevronDown className="size-3 text-muted-foreground" />
    </Button>
  );
});

function MultiSelectChip({
  icon,
  label,
  active,
  items,
  selected,
  onToggle,
  onClear,
  formatItem,
  placeholder,
  wide = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  items: string[];
  selected: Set<string>;
  onToggle: (item: string) => void;
  onClear: () => void;
  formatItem: (item: string) => string;
  placeholder: string;
  wide?: boolean;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? items.filter((i) => i.toLowerCase().includes(q)) : items;
    // Selected first, then alphabetic — same ordering as Swift RepoListPicker.
    return [...list].sort((a, b) => {
      const aSel = selected.has(a);
      const bSel = selected.has(b);
      if (aSel !== bSel) return aSel ? -1 : 1;
      return a.localeCompare(b);
    });
  }, [items, search, selected]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <FilterChipButton icon={icon} label={label} active={active} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={cn("p-0", wide ? "w-72" : "w-60")}
        // Multi-select: keep the menu open while toggling items + don't
        // steal focus back to the trigger after every click.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="border-b p-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={placeholder}
            className="h-7 text-xs"
            // Don't autofocus inside DropdownMenu — Radix's focus
            // management fights the Input which leads to "click does
            // nothing" on items below.
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
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="p-3 text-center text-xs text-muted-foreground">
              {items.length === 0 ? "Nothing to filter on yet." : "No matches."}
            </p>
          ) : (
            filtered.map((item) => {
              const isOn = selected.has(item);
              return (
                <button
                  key={item}
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onToggle(item);
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent"
                >
                  <Checkbox
                    checked={isOn}
                    tabIndex={-1}
                    className="pointer-events-none"
                  />
                  <span className="flex-1 truncate font-mono">
                    {formatItem(item)}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="flex items-center justify-between border-t px-2 py-1.5 text-xs text-muted-foreground">
          <span>
            {selected.size} selected · {items.length} available
          </span>
          {selected.size > 0 && (
            <Button size="sm" variant="ghost" onClick={onClear}>
              Clear
            </Button>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
