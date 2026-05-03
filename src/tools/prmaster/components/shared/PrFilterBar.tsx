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
import { Button } from "@zen-tools/ui";
import { Checkbox } from "@zen-tools/ui";
import { Input } from "@zen-tools/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import {
  prmasterTauri,
  type EnrichedPullRequest,
  type NotificationFilter,
} from "../../lib/tauri";

export interface PrFilterState {
  authors: Set<string>;
  repos: Set<string>;
  search: string;
  /** Saved filter IDs — multi-select: a row passes when it matches ANY
   *  of the selected saved filters. Empty = saved-filter chip is off. */
  savedFilterIds: Set<string>;
}

export const emptyFilterState: PrFilterState = {
  authors: new Set(),
  repos: new Set(),
  search: "",
  savedFilterIds: new Set(),
};

/** Does a single saved filter match this row? — same predicate the engine
 *  uses for notifications. File globs are intentionally skipped (we don't
 *  always have file paths client-side). */
function rowMatchesSavedFilter(
  row: EnrichedPullRequest,
  saved: NotificationFilter,
): boolean {
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
      /* invalid regex -> skip the regex predicate */
    }
  }
  return true;
}

export function applyPrFilters(
  rows: EnrichedPullRequest[],
  state: PrFilterState,
  savedFilters: NotificationFilter[],
): EnrichedPullRequest[] {
  let filtered = rows;

  // Saved filters → OR-match (a PR passes if it matches any picked one).
  // Mirrors how Author/Repo chips work: multiple selections widen the
  // result rather than narrow it.
  if (state.savedFilterIds.size > 0) {
    const active = savedFilters.filter((f) => state.savedFilterIds.has(f.id));
    if (active.length > 0) {
      filtered = filtered.filter((row) =>
        active.some((f) => rowMatchesSavedFilter(row, f)),
      );
    }
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

  // Saved-filter chip is keyed by id; we look up the human name in
  // `formatItem`/`labelFor` so the underlying MultiSelectChip stays
  // generic over `string` items (consistent with Author/Repo).
  const enabledSavedFilters = useMemo(
    () => savedFilters.filter((f) => f.enabled),
    [savedFilters],
  );
  const enabledSavedFilterIds = useMemo(
    () => enabledSavedFilters.map((f) => f.id),
    [enabledSavedFilters],
  );
  const savedFilterNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of enabledSavedFilters) map.set(f.id, f.name);
    return map;
  }, [enabledSavedFilters]);

  const hasAny =
    state.savedFilterIds.size > 0 ||
    state.authors.size > 0 ||
    state.repos.size > 0 ||
    state.search.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <MultiSelectChip
        icon={Filter}
        label={
          state.savedFilterIds.size === 0
            ? "Filter"
            : state.savedFilterIds.size === 1
              ? savedFilterNameById.get([...state.savedFilterIds][0]!) ??
                "1 filter"
              : `${state.savedFilterIds.size} filters`
        }
        active={state.savedFilterIds.size > 0}
        items={enabledSavedFilterIds}
        selected={state.savedFilterIds}
        onToggle={(id) => {
          const next = new Set(state.savedFilterIds);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          onChange({ ...state, savedFilterIds: next });
        }}
        onClear={() => onChange({ ...state, savedFilterIds: new Set() })}
        formatItem={(id) => savedFilterNameById.get(id) ?? id}
        sortKey={(id) => savedFilterNameById.get(id) ?? id}
        placeholder="Filter saved filters…"
        emptyMessage="No saved filters — add them in the Filters tab"
      />

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
              savedFilterIds: new Set(),
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
  sortKey,
  placeholder,
  emptyMessage,
  wide = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  items: string[];
  selected: Set<string>;
  onToggle: (item: string) => void;
  onClear: () => void;
  /** How an item is rendered in the list. Defaults to identity. */
  formatItem: (item: string) => string;
  /** Optional override for what to compare on when sorting / searching.
   *  Defaults to `formatItem`. Useful when items are opaque IDs whose
   *  display label lives elsewhere (e.g. saved-filter ids). */
  sortKey?: (item: string) => string;
  placeholder: string;
  /** Message shown when the list is empty (no items at all, vs no search match). */
  emptyMessage?: string;
  wide?: boolean;
}) {
  const [search, setSearch] = useState("");
  const keyOf = sortKey ?? formatItem;
  // Always alphabetical — items must NOT jump around as the user toggles
  // them, since that destroys the click target a user is aiming at.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? items.filter((i) => keyOf(i).toLowerCase().includes(q))
      : items;
    return [...list].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  }, [items, search, keyOf]);

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
              {items.length === 0
                ? emptyMessage ?? "Nothing to filter on yet."
                : "No matches."}
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
