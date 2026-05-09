/**
 * IntelliJ-style filter panel: branch, user, date range, path, and
 * a free-text search box with `Aa` / `.*` chips and a scope selector
 * that maps to `--grep` / `-S` / `-G`.
 */

import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
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

export interface CommitFilterPanelProps {
  repo: string;
  filter: CommitLogFilter;
  onChange: (next: CommitLogFilter) => void;
}

export function CommitFilterPanel({
  repo,
  filter,
  onChange,
}: CommitFilterPanelProps) {
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

  const update = (patch: Partial<CommitLogFilter>) => {
    onChange({ ...filter, ...patch, skip: 0 });
  };

  const text = filter.text ?? {
    query: "",
    scope: "message" as TextScope,
    caseSensitive: false,
    regex: false,
  };

  const updateText = (patch: Partial<typeof text>) => {
    onChange({ ...filter, text: { ...text, ...patch }, skip: 0 });
  };

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div className="flex flex-col gap-1">
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Branch
        </Label>
        <Select
          value={filter.branch ?? "__all__"}
          onValueChange={(v) =>
            update({ branch: v === "__all__" ? undefined : v })
          }
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="HEAD" />
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
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          User
        </Label>
        <Input
          className="h-8 text-xs"
          list="git-authors"
          placeholder="any author"
          value={filter.author ?? ""}
          onChange={(e) =>
            update({ author: e.target.value || undefined })
          }
        />
        <datalist id="git-authors">
          {authors.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Since
          </Label>
          <Input
            className="h-8 text-xs"
            type="date"
            value={filter.since ?? ""}
            onChange={(e) =>
              update({ since: e.target.value || undefined })
            }
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Until
          </Label>
          <Input
            className="h-8 text-xs"
            type="date"
            value={filter.until ?? ""}
            onChange={(e) =>
              update({ until: e.target.value || undefined })
            }
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Path
        </Label>
        <Input
          className="h-8 text-xs"
          placeholder="src/foo.ts"
          value={filter.path ?? ""}
          onChange={(e) => update({ path: e.target.value || undefined })}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Search
        </Label>
        <Input
          className="h-8 text-xs"
          placeholder="text…"
          value={text.query}
          onChange={(e) => updateText({ query: e.target.value })}
        />
        <div className="mt-1 flex flex-wrap items-center gap-1">
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

      <div className="flex flex-col gap-1">
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Structural
        </Label>
        <div className="flex flex-wrap items-center gap-1">
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
        <Input
          className="h-8 text-xs"
          placeholder="hash prefix (e.g. a3b9)"
          value={filter.hashPrefix ?? ""}
          onChange={(e) =>
            update({ hashPrefix: e.target.value || undefined })
          }
        />
      </div>

      <Button
        size="sm"
        variant="outline"
        className="mt-2"
        onClick={() => onChange({ skip: 0, limit: filter.limit ?? 200 })}
      >
        Reset filters
      </Button>
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
