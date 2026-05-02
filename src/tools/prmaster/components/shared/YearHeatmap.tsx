/**
 * GitHub-contributions-style year heatmap for the AI Summary tab.
 *
 * Layout: four rows × thirteen columns (52 cells), one row per
 * quarter — Q1 = W01-W13, Q2 = W14-W26, Q3 = W27-W39, Q4 = W40-W52.
 * Years with a 53rd ISO week (rare; happens when Jan 1 lands on
 * Thursday or in some leap years on Wednesday) get the 53rd cell
 * appended to the Q4 row.
 *
 * Each cell is a clickable button colored by its `state`:
 *
 *   empty     no cached card for any repo in this week
 *   partial   some repos cached, others still missing
 *   complete  every mapped repo has a cached card for this week
 *   inFlight  at least one cell is currently queued or running
 *
 * The selected week gets a primary-coloured ring. Future weeks (past
 * the current ISO week of the current year) get a slight opacity drop
 * so the user can see at a glance "I haven't reached there yet."
 */
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatWeekTag,
  weekToRange,
  weeksInYear,
} from "../../lib/iso-week";

export type CellState = "empty" | "partial" | "complete" | "inFlight";

export interface HeatCellInfo {
  state: CellState;
  /** Total commits across every cached card for this week. */
  commits: number;
  /** Repos that already have a cached card for this week. */
  cached: number;
  /** Currently-mapped repos for the selected scope (so partial vs
   *  complete is computable downstream). */
  mapped: number;
}

interface Props {
  year: number;
  /** Map keyed by ISO week number (1..53). Weeks with no entry render
   *  as `empty`. */
  cells: Map<number, HeatCellInfo>;
  selectedWeek: number | null;
  /** Today's `(year, week)` so we can dim future cells in the current
   *  year. `null` to disable the dim. */
  todayWeek: number | null;
  onSelectWeek: (week: number) => void;
}

const QUARTER_LABELS = ["Q1", "Q2", "Q3", "Q4"];

export function YearHeatmap({
  year,
  cells,
  selectedWeek,
  todayWeek,
  onSelectWeek,
}: Props) {
  const total = weeksInYear(year);

  // Build four quarter rows. Q1 = 1..13, Q2 = 14..26, Q3 = 27..39,
  // Q4 = 40..(total). The 53rd week (when present) gets tacked onto
  // Q4 so we never crash out of bounds.
  const rows: number[][] = [
    [],
    [],
    [],
    [],
  ];
  for (let w = 1; w <= total; w++) {
    const rowIdx = Math.min(3, Math.floor((w - 1) / 13));
    rows[rowIdx].push(w);
  }

  return (
    <div className="space-y-1">
      {rows.map((weeks, rowIdx) => (
        <div key={rowIdx} className="flex items-center gap-2">
          <span className="w-6 shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {QUARTER_LABELS[rowIdx]}
          </span>
          <div
            className="grid gap-0.5"
            // Fixed-size cells (GitHub-contributions style) — keeps
            // the heatmap visually dense and the cell-to-cell ratio
            // consistent regardless of viewport width. ~16px square
            // is small but still hoverable + readable.
            style={{ gridTemplateColumns: "repeat(13, 16px)" }}
          >
            {weeks.map((week) => {
              const info = cells.get(week) ?? {
                state: "empty" as const,
                commits: 0,
                cached: 0,
                mapped: 0,
              };
              const isSelected = selectedWeek === week;
              const isFuture =
                todayWeek != null && week > todayWeek;
              return (
                <HeatCell
                  key={week}
                  year={year}
                  week={week}
                  info={info}
                  isSelected={isSelected}
                  isFuture={isFuture}
                  onClick={() => onSelectWeek(week)}
                />
              );
            })}
          </div>
        </div>
      ))}
      <Legend />
    </div>
  );
}

function HeatCell({
  year,
  week,
  info,
  isSelected,
  isFuture,
  onClick,
}: {
  year: number;
  week: number;
  info: HeatCellInfo;
  isSelected: boolean;
  isFuture: boolean;
  onClick: () => void;
}) {
  const range = weekToRange(year, week);
  const tipDate = `${formatRangeShort(range.since, range.until)}`;
  const tip = (() => {
    switch (info.state) {
      case "inFlight":
        return `${formatWeekTag(week)} · ${tipDate} · generating…`;
      case "complete":
        return `${formatWeekTag(week)} · ${tipDate} · ${info.commits} commits across ${info.cached}/${info.mapped} repos`;
      case "partial":
        return `${formatWeekTag(week)} · ${tipDate} · partial (${info.cached}/${info.mapped} repos cached)`;
      default:
        return `${formatWeekTag(week)} · ${tipDate} · not generated`;
    }
  })();

  return (
    <button
      type="button"
      onClick={onClick}
      title={tip}
      aria-label={tip}
      className={cn(
        "relative flex aspect-square cursor-pointer items-center justify-center rounded-sm transition-colors",
        // State-driven base colour. Light + dark mode pairs. Cells
        // are ~16px so colour + tooltip carry all the info; we don't
        // print the week number in the cell itself anymore.
        info.state === "empty" &&
          "bg-muted/30 hover:bg-muted/60 dark:bg-muted/20 dark:hover:bg-muted/40",
        info.state === "partial" &&
          "bg-amber-300/70 hover:bg-amber-300 dark:bg-amber-700/60 dark:hover:bg-amber-700/80",
        info.state === "complete" &&
          "bg-emerald-300/80 hover:bg-emerald-300 dark:bg-emerald-700/70 dark:hover:bg-emerald-700/90",
        info.state === "inFlight" &&
          "animate-pulse bg-primary/40 hover:bg-primary/60",
        // Selection ring + future-week dim layered last so they win.
        isSelected && "ring-1 ring-primary ring-offset-1 ring-offset-card",
        isFuture && info.state === "empty" && "opacity-40",
      )}
    >
      {info.state === "inFlight" && (
        <Loader2 className="size-2.5 animate-spin text-primary-foreground/80" />
      )}
    </button>
  );
}

function Legend() {
  return (
    <div className="ml-8 flex items-center gap-3 pt-1 text-[10px] text-muted-foreground">
      <LegendChip className="bg-muted/30 dark:bg-muted/20" label="empty" />
      <LegendChip
        className="bg-amber-300/70 dark:bg-amber-700/60"
        label="partial"
      />
      <LegendChip
        className="bg-emerald-300/80 dark:bg-emerald-700/70"
        label="generated"
      />
      <LegendChip className="bg-primary/40" label="generating" />
    </div>
  );
}

function LegendChip({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("inline-block size-2.5 rounded-sm", className)} />
      {label}
    </span>
  );
}

function formatRangeShort(since: Date, until: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${fmt(since)} – ${fmt(until)}`;
}
