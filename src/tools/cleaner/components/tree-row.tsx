/**
 * Single row inside the cleaner tree.
 *
 * Section rows show only a chevron + label.
 * Leaf rows show a chevron-spacer, an icon, the label, the action chip,
 * and the size summary.  Sizes that haven't yet settled render an
 * inline `…` placeholder instead of a value.
 */

import {
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  GitBranch,
  HardDrive,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { ActionChip } from "./action-chip";
import { fmtSize, type CleanerNodeAction, type CleanerTreeNode } from "../lib/tauri";

const ROW_HEIGHT = 28;

export interface TreeRowProps {
  node: CleanerTreeNode;
  /** Effective expansion state passed from the parent (handles default-open). */
  expanded: boolean;
  /** Currently-marked action — `none` if absent. */
  action: CleanerNodeAction;
  /** Cursor highlight. */
  active: boolean;
  /** Bulk-run is in flight — disable input. */
  disabled: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
  onCycleAction: () => void;
}

export function TreeRow({
  node,
  expanded,
  action,
  active,
  disabled,
  onSelect,
  onToggleExpand,
  onCycleAction,
}: TreeRowProps) {
  const indent = node.depth * 14 + 6;

  if (node.kind === "section") {
    return (
      <button
        type="button"
        onClick={onToggleExpand}
        onFocus={onSelect}
        className={cn(
          "group flex w-full items-center gap-1.5 px-2 text-left transition-colors",
          "border-b border-border/40 bg-muted/30 hover:bg-muted/50",
          active && "bg-accent/40",
        )}
        style={{ height: ROW_HEIGHT, paddingLeft: indent }}
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {node.label}
        </span>
        <span className="ml-2 text-[10px] font-normal normal-case tracking-normal text-muted-foreground/60">
          {node.children.length} item{node.children.length === 1 ? "" : "s"}
        </span>
      </button>
    );
  }

  // Leaf row.
  const Icon = node.kind === "repo" ? GitBranch : HardDrive;
  const isRepo = node.kind === "repo";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="treeitem"
          aria-selected={active}
          onClick={() => onSelect()}
          className={cn(
            "group/leaf flex w-full min-w-0 cursor-default items-center gap-2 px-2 transition-colors",
            "hover:bg-muted/40",
            active && "bg-accent/40",
            action === "clean" && "ring-inset ring-1 ring-amber-500/20",
            action === "delete" && "ring-inset ring-1 ring-destructive/30",
          )}
          style={{ height: ROW_HEIGHT, paddingLeft: indent }}
        >
          <span className="size-3 shrink-0" />
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              isRepo ? "text-primary/70" : "text-fuchsia-500/80",
            )}
          />
          <span className="shrink-0 truncate font-mono text-xs">
            {node.label}
          </span>
          {/* Path tail — secondary, hidden on narrow views via overflow */}
          <span
            className="hidden min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/60 sm:inline"
            title={node.path}
          >
            {node.path}
          </span>
          {/* Size column */}
          <SizeSummary node={node} action={action} />
          {/* Action chip — last column so it lines up across rows */}
          <ActionChip
            kind={isRepo ? "repo" : "globalPath"}
            action={action}
            active={active}
            disabled={disabled}
            onCycle={(e) => {
              e.stopPropagation();
              onCycleAction();
            }}
          />
          {/* The "expand" affordance for leaves is invisible — keyboard
              h/l on a leaf jumps to the section parent / first child. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="hidden"
            onClick={onToggleExpand}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void writeText(node.path)}>
          <Copy className="size-3.5" /> Copy path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void writeText(node.label)}>
          <Copy className="size-3.5" /> Copy name
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface SizeSummaryProps {
  node: CleanerTreeNode;
  action: CleanerNodeAction;
}

/**
 * Inline size readout matching the ratatui reference:
 *   `clean: 142.3 M · delete: 1.2 G`
 *
 * Each side renders independently — once `cleanSize` lands the left
 * half flips from `…` to the value, and similarly for `delete`. When
 * the active row is marked, the matching side is highlighted in its
 * action color.
 */
function SizeSummary({ node, action }: SizeSummaryProps) {
  if (node.kind === "repo") {
    const cleanReady = node.cleanSize != null || node.sizeDone;
    const deleteReady = node.deleteSize != null || node.sizeDone;
    return (
      <span className="ml-auto inline-flex shrink-0 items-baseline gap-1.5 font-mono text-[10px]">
        <SizeField
          label="clean"
          value={node.cleanSize}
          ready={cleanReady}
          highlight={action === "clean"}
          highlightClass="text-amber-600 dark:text-amber-300"
        />
        <span className="text-muted-foreground/30">·</span>
        <SizeField
          label="delete"
          value={node.deleteSize}
          ready={deleteReady}
          highlight={action === "delete"}
          highlightClass="text-destructive"
        />
      </span>
    );
  }

  // globalPath row — single size, no clean/delete split.
  return (
    <span
      className={cn(
        "ml-auto inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground/80",
        action === "delete" && "font-semibold text-destructive",
      )}
    >
      <Folder className="size-2.5 opacity-50" />
      <SizeField
        label=""
        value={node.size}
        ready={node.sizeDone}
        highlight={action === "delete"}
        highlightClass="text-destructive"
        compact
      />
    </span>
  );
}

interface SizeFieldProps {
  label: string;
  value: number | null;
  ready: boolean;
  highlight: boolean;
  highlightClass: string;
  compact?: boolean;
}

/**
 * One half of the `clean: X · delete: Y` readout.  Renders `…` until
 * the estimate is ready, then animates the value in with a quick
 * `fade-in zoom-in-95` so the user can see each row "fill up" as the
 * size worker progresses through the list.
 */
function SizeField({
  label,
  value,
  ready,
  highlight,
  highlightClass,
  compact,
}: SizeFieldProps) {
  const display = ready ? (value != null ? fmtSize(value) : "?") : "…";
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1",
        ready ? "text-foreground/80" : "text-muted-foreground/50",
        highlight && ready && "font-semibold",
        highlight && ready && highlightClass,
      )}
    >
      {!compact && label ? (
        <span className="text-muted-foreground/50">{label}:</span>
      ) : null}
      <span
        // Subtle pop when the value first appears — not on every
        // re-render; React keys this on the value text itself so the
        // animation only retriggers when the displayed string actually
        // changes from `…` to a real size.
        key={display}
        className={cn(
          "tabular-nums",
          ready &&
            value != null &&
            "animate-in fade-in zoom-in-95 duration-200 ease-out",
        )}
      >
        {display}
      </span>
    </span>
  );
}
