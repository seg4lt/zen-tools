/**
 * Horizontal commit-log filter bar — JetBrains-style: a single row of
 * compact controls for branch / user / date / path / search, plus a
 * popover for the lower-priority knobs (case-sensitive, regex, scope,
 * structural toggles, hash prefix).
 *
 * Replaces the old left-side `<CommitFilterPanel>` so the commit list
 * + diff get the full vertical real estate.
 */

import { useEffect, useMemo, useState } from "react";
import { Filter, X } from "lucide-react";
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@zen-tools/ui";

import {
  gitTauri,
  type BranchRef,
  type CommitLogFilter,
  type TextScope,
} from "../../lib/tauri";

export interface CommitFilterBarProps {
  repo: string;
  filter: CommitLogFilter;
  onChange: (next: CommitLogFilter) => void;
}

export function CommitFilterBar({ repo, filter, onChange }: CommitFilterBarProps) {
  const [branches, setBranches] = useState<BranchRef[]>([]);
  const [authors, setAuthors] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [b, a] = await Promise.all([
          gitTauri.listBranches(repo),
          gitTauri.listAuthors(repo, 500),
        ]);
        if (!cancelled) {
          setBranches(b);
          setAuthors(a);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("git: load filter dropdowns failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo]);

  const update = (patch: Partial<CommitLogFilter>) =>
    onChange({ ...filter, ...patch, skip: 0 });

  const text = filter.text ?? {
    query: "",
    scope: "message" as TextScope,
    caseSensitive: false,
    regex: false,
  };
  const updateText = (patch: Partial<typeof text>) =>
    onChange({ ...filter, text: { ...text, ...patch }, skip: 0 });

  // Are any "advanced" filters set? Used to badge the popover button.
  // `noMerges` is intentionally excluded — it's the default-on behavior
  // surfaced as a main-row chip, so it shouldn't make the "More"
  // button look "active".
  const advancedCount = useMemo(() => {
    let n = 0;
    if (text.query) n++;
    if (text.caseSensitive) n++;
    if (text.regex) n++;
    if (filter.mergesOnly) n++;
    if (filter.hashPrefix) n++;
    if (filter.path) n++;
    return n;
  }, [filter.mergesOnly, filter.hashPrefix, filter.path, text]);

  const hasAnyFilter =
    !!filter.branch ||
    !!filter.author ||
    !!filter.since ||
    !!filter.until ||
    advancedCount > 0;

  const reset = () => onChange({ skip: 0, limit: filter.limit ?? 200 });

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-2 py-1 text-[11px]">
      {/* Branch */}
      <Select
        value={filter.branch ?? "__all__"}
        onValueChange={(v) =>
          update({ branch: v === "__all__" ? undefined : v })
        }
      >
        <SelectTrigger className="h-7 min-w-[120px] text-[11px]" data-size="sm">
          <SelectValue placeholder="Branch" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">HEAD (default)</SelectItem>
          <SelectItem value="--all">All branches</SelectItem>
          {branches.map((b) => (
            <SelectItem key={b.fullName} value={b.name}>
              {b.isHead ? "★ " : ""}
              {b.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* User */}
      <Input
        list="git-authors-bar"
        placeholder="user"
        className="h-7 w-32 text-[11px]"
        value={filter.author ?? ""}
        onChange={(e) => update({ author: e.target.value || undefined })}
      />
      <datalist id="git-authors-bar">
        {authors.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>

      {/* Date range */}
      <Input
        type="date"
        title="Since"
        className="h-7 w-[130px] text-[11px]"
        value={filter.since ?? ""}
        onChange={(e) => update({ since: e.target.value || undefined })}
      />
      <span className="text-muted-foreground">→</span>
      <Input
        type="date"
        title="Until"
        className="h-7 w-[130px] text-[11px]"
        value={filter.until ?? ""}
        onChange={(e) => update({ until: e.target.value || undefined })}
      />

      {/* Free-text search */}
      <Input
        placeholder="search…"
        className="h-7 w-44 text-[11px]"
        value={text.query}
        onChange={(e) => updateText({ query: e.target.value })}
      />

      {/* Quick toggle for hiding merge commits — surfaced in the
          main row because most users want this on by default. The
          popover still has a "Merges only" mirror for symmetry. */}
      <ChipToggle
        label="No merges"
        on={!!filter.noMerges}
        onClick={() =>
          update({
            noMerges: !filter.noMerges,
            mergesOnly: false,
          })
        }
        title="Hide merge commits"
      />

      {/* Advanced popover */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant={advancedCount > 0 ? "secondary" : "ghost"}
            className="h-7 gap-1 px-2 text-[11px]"
          >
            <Filter className="h-3 w-3" />
            More
            {advancedCount > 0 && (
              <span className="rounded bg-primary/20 px-1 font-mono text-[10px] leading-tight text-primary">
                {advancedCount}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 space-y-3 p-3 text-[11px]">
          <div className="space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Path
            </div>
            <Input
              placeholder="src/foo.ts"
              className="h-7 text-[11px]"
              value={filter.path ?? ""}
              onChange={(e) =>
                update({ path: e.target.value || undefined })
              }
            />
          </div>

          <div className="space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Search options
            </div>
            <div className="flex items-center gap-1">
              <ChipToggle
                label="Aa"
                on={text.caseSensitive}
                onClick={() => updateText({ caseSensitive: !text.caseSensitive })}
                title="Case sensitive"
              />
              <ChipToggle
                label=".*"
                on={text.regex}
                onClick={() => updateText({ regex: !text.regex })}
                title="Regex"
              />
              <Select
                value={text.scope}
                onValueChange={(v) => updateText({ scope: v as TextScope })}
              >
                <SelectTrigger className="ml-auto h-7 w-32 text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="message">In message</SelectItem>
                  <SelectItem value="changes">In changes (-S)</SelectItem>
                  <SelectItem value="changesRegex">In changes (-G)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Structural
            </div>
            <div className="flex items-center gap-1">
              <ChipToggle
                label="Merges only"
                on={!!filter.mergesOnly}
                onClick={() =>
                  update({
                    mergesOnly: !filter.mergesOnly,
                    noMerges: false,
                  })
                }
              />
              <ChipToggle
                label="No merges"
                on={!!filter.noMerges}
                onClick={() =>
                  update({
                    noMerges: !filter.noMerges,
                    mergesOnly: false,
                  })
                }
              />
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Hash
            </div>
            <Input
              placeholder="prefix (e.g. a3b9)"
              className="h-7 text-[11px]"
              value={filter.hashPrefix ?? ""}
              onChange={(e) =>
                update({ hashPrefix: e.target.value || undefined })
              }
            />
          </div>
        </PopoverContent>
      </Popover>

      {hasAnyFilter && (
        <Button
          size="sm"
          variant="ghost"
          onClick={reset}
          className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
          title="Reset all filters"
        >
          <X className="h-3 w-3" />
          Clear
        </Button>
      )}
    </div>
  );
}

function ChipToggle({
  label,
  on,
  onClick,
  title,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "rounded border px-2 py-0.5 text-[11px] leading-none transition-colors",
        on
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:bg-accent",
      )}
    >
      {label}
    </button>
  );
}
