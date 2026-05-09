/**
 * One row in the virtualized commit list. Shows: parent-count dot,
 * short hash, message subject, ref chips, author + relative time.
 *
 * Visual states:
 *   - `primary` — the focused row (its diff/detail is showing).
 *   - `selected` — the row is in the multi-selection set (may or
 *     may not be the primary).
 *   - neither — default look.
 */

import { cn } from "@zen-tools/ui";
import { relativeTime } from "../../lib/format";
import type { Commit } from "../../lib/tauri";

export interface CommitRowProps {
  commit: Commit;
  /** Row is in the selection set. */
  selected: boolean;
  /** Row is the focused / primary commit (drives the detail pane). */
  primary: boolean;
  onClick: (e: React.MouseEvent) => void;
}

export function CommitRow({
  commit,
  selected,
  primary,
  onClick,
}: CommitRowProps) {
  const isMerge = commit.parents.length > 1;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent",
        // Primary = solid accent. Secondary (in set, not primary) =
        // dimmer accent + a left-side primary stripe so multi-select
        // is unmistakable at a glance.
        primary && "bg-accent",
        selected &&
          !primary &&
          "bg-primary/15 before:absolute before:left-0 before:top-0 before:h-full before:w-0.5 before:bg-primary before:content-['']",
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
