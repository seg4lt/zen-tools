/**
 * GitHub-contributions-style fiscal-year heatmap for the AI Summary tab.
 *
 * Layout: four rows × thirteen columns (52 cells), one row per
 * fiscal quarter:
 *
 *   Q1 = Oct, Nov, Dec  (first 13 weeks of the fiscal year)
 *   Q2 = Jan, Feb, Mar
 *   Q3 = Apr, May, Jun
 *   Q4 = Jul, Aug, Sep
 *
 * Fiscal years that contain a 53rd ISO week (rare) get the 53rd cell
 * appended to the Q4 row.
 *
 * Each cell is a clickable button colored by its `state`:
 *
 *   empty     no cached card for any repo in this week
 *   partial   some repos cached, others still missing
 *   complete  every mapped repo has a cached card for this week
 *   inFlight  at least one cell is currently queued or running
 *
 * The selected week gets a primary-coloured ring. Future weeks (the
 * current ISO week of the current fiscal year, plus any weeks past
 * it) get a slight opacity drop so the user can see at a glance
 * "I haven't reached there yet."
 */
import { Loader2 } from "lucide-react";
import { cn } from "@zen-tools/ui";
import { fiscalWeekIds, formatWeekTag, weekToRange } from "../../lib/iso-week";

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
  /** Fiscal year — Oct 1 of (year-1) → Sep 30 of (year). */
  year: number;
  /** Map keyed by ISO week number (1..53). Within a single fiscal
   *  year each ISO week appears at most once, so the scalar key is
   *  unambiguous. Weeks with no entry render as `empty`. */
  cells: Map<number, HeatCellInfo>;
  selectedWeek: number | null;
  /** Today's calendar (year, ISO week). Cells whose `(calYear, week)`
   *  Monday is **on or after** today's Monday render dimmed, marking
   *  the still-running and future weeks. Pass `null` to disable
   *  dimming (e.g. when the user is browsing a past fiscal year). */
  today: { year: number; week: number } | null;
  onSelectWeek: (week: number) => void;
}

const QUARTER_LABELS = ["Q1", "Q2", "Q3", "Q4"];

export function YearHeatmap({
  year,
  cells,
  selectedWeek,
  today,
  onSelectWeek,
}: Props) {
  // Fiscal-year-ordered list of `(calYear, isoWeek)` IDs:
  // Oct → Dec → Jan → … → Sep.
  const ids = fiscalWeekIds(year);

  // Build four quarter rows. Position 0..12 = Q1 (Oct-Dec),
  // 13..25 = Q2 (Jan-Mar), 26..38 = Q3 (Apr-Jun), 39..end = Q4
  // (Jul-Sep). 53-week fiscal years tack the extra cell onto Q4.
  const rows: Array<Array<{ calYear: number; week: number }>> = [
    [],
    [],
    [],
    [],
  ];
  ids.forEach((id, idx) => {
    const rowIdx = Math.min(3, Math.floor(idx / 13));
    rows[rowIdx].push({ calYear: id.year, week: id.week });
  });

  // Today's Monday timestamp — used to decide which cells are
  // "current or future" (locked from generation). Computed once;
  // the heatmap only re-renders when `today` changes.
  const todayMondayMs =
    today != null
      ? weekToRange(today.year, today.week).since.getTime()
      : null;

  return (
    <div className="space-y-1">
      {rows.map((cells_, rowIdx) => (
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
            {cells_.map(({ calYear, week }) => {
              const info = cells.get(week) ?? {
                state: "empty" as const,
                commits: 0,
                cached: 0,
                mapped: 0,
              };
              const isSelected = selectedWeek === week;
              // A week is "locked" when it's still ongoing or in the
              // future — generation only runs on fully-past weeks
              // (isPastWeek). Compare by Monday date so the lock
              // honours fiscal-year ordering across the calendar
              // boundary (Q4 of cal-2025 → Q1 of FY2026 still
              // unlocked while Q3 of FY2026 sitting in cal-2026 may
              // be locked).
              const cellMondayMs = weekToRange(calYear, week).since.getTime();
              const isLocked =
                todayMondayMs != null && cellMondayMs >= todayMondayMs;
              const isCurrent =
                todayMondayMs != null && cellMondayMs === todayMondayMs;
              return (
                <HeatCell
                  key={`${calYear}-${week}`}
                  year={calYear}
                  week={week}
                  info={info}
                  isSelected={isSelected}
                  isLocked={isLocked}
                  isCurrent={isCurrent}
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
  isLocked,
  isCurrent,
  onClick,
}: {
  year: number;
  week: number;
  info: HeatCellInfo;
  isSelected: boolean;
  /** Current week or any future week — not eligible for AI generation
   *  yet (only fully-past weeks are). Renders dimmer + the tooltip
   *  explains why. */
  isLocked: boolean;
  /** Specifically the current ISO week. Gets a faint outline so it's
   *  recognisable as "you're here" alongside the dim. */
  isCurrent: boolean;
  onClick: () => void;
}) {
  const range = weekToRange(year, week);
  const tipDate = `${formatRangeShort(range.since, range.until)}`;
  const lockNote = isLocked
    ? isCurrent
      ? " · current week (wait until it ends to generate)"
      : " · future week (locked)"
    : "";
  const tip = (() => {
    switch (info.state) {
      case "inFlight":
        return `${formatWeekTag(week)} · ${tipDate} · generating…`;
      case "complete":
        return `${formatWeekTag(week)} · ${tipDate} · ${info.commits} commits across ${info.cached}/${info.mapped} repos${lockNote}`;
      case "partial":
        return `${formatWeekTag(week)} · ${tipDate} · partial (${info.cached}/${info.mapped} repos cached)${lockNote}`;
      default:
        return `${formatWeekTag(week)} · ${tipDate} · not generated${lockNote}`;
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
        //
        // Empty cells use `muted-foreground` (a mid-grey that flips
        // with the theme) at modest opacity rather than `muted` —
        // `muted` is so close to `card` that empty cells were
        // basically invisible against the surrounding panel
        // background. `muted-foreground/20` is dark-on-light in
        // light mode and light-on-dark in dark mode, so empty cells
        // read clearly in both.
        info.state === "empty" &&
          "bg-muted-foreground/20 hover:bg-muted-foreground/35",
        info.state === "partial" &&
          "bg-amber-300/70 hover:bg-amber-300 dark:bg-amber-700/60 dark:hover:bg-amber-700/80",
        info.state === "complete" &&
          "bg-emerald-300/80 hover:bg-emerald-300 dark:bg-emerald-700/70 dark:hover:bg-emerald-700/90",
        info.state === "inFlight" &&
          "animate-pulse bg-primary/40 hover:bg-primary/60",
        // Selection ring + locked-week dim layered last so they win.
        isSelected && "ring-1 ring-primary ring-offset-1 ring-offset-card",
        // Current + future weeks aren't generatable yet — dim them so
        // the past-vs-pending split is obvious at a glance.
        isLocked && info.state === "empty" && "opacity-50",
        // The current week additionally gets a hairline outline so
        // users can tell "you're here" from a future week.
        isCurrent &&
          "outline outline-1 outline-dashed outline-offset-[-2px] outline-primary/60",
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
      <LegendChip className="bg-muted-foreground/20" label="empty" />
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
