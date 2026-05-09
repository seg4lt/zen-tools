/**
 * One row in the virtualized commit list. Shows: parent-count dot,
 * short hash, message subject, ref chips, author + relative time.
 */

import { cn } from "@zen-tools/ui";
import { relativeTime } from "../../lib/format";
import type { Commit } from "../../lib/tauri";

export interface CommitRowProps {
  commit: Commit;
  selected: boolean;
  onClick: () => void;
}

export function CommitRow({ commit, selected, onClick }: CommitRowProps) {
  const isMerge = commit.parents.length > 1;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent",
        selected && "bg-accent",
      )}
      title={`${commit.shortHash}  ${commit.subject}`}
    >
      <span
        className={cn(
          "inline-block h-2.5 w-2.5 shrink-0 rounded-full border",
          isMerge
            ? "border-amber-500 bg-amber-500/20"
            : "border-muted-foreground bg-muted-foreground/30",
        )}
      />
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {commit.shortHash}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground">
        {commit.subject}
      </span>
      {commit.refs.slice(0, 2).map((r) => (
        <span
          key={r}
          className="hidden shrink-0 rounded border border-primary/30 bg-primary/10 px-1.5 py-px font-mono text-[10px] leading-none text-primary lg:inline"
        >
          {r}
        </span>
      ))}
      <span className="hidden w-20 shrink-0 truncate text-[11px] text-muted-foreground md:inline">
        {commit.authorName}
      </span>
      <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">
        {relativeTime(commit.committerTs)}
      </span>
    </button>
  );
}
