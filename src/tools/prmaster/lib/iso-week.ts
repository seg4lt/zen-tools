/**
 * ISO 8601 week-of-year helpers used by the AI Summary year grid.
 *
 * Week 1 is the week containing the year's first Thursday. Weeks
 * start on Monday and end on Sunday. Most years have 52 weeks; some
 * (any year where Jan 1 lands on Thursday, or a leap year with Jan 1
 * on Wednesday) have 53.
 *
 * The grid renders 52 cells by default and adds a 53rd only when the
 * selected year's calendar requires it, so a date the user picks
 * always lands in exactly one slot regardless of year length.
 */

/** ISO year + week number that the given UTC date falls into. */
export function isoWeekOf(date: Date): { year: number; week: number } {
  // Copy so we don't mutate the caller's Date.
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // Pin to the Thursday of the current ISO week — the day whose
  // calendar year is, by definition, the ISO year.
  const dayNum = d.getUTCDay() || 7; // Sunday → 7, not 0
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const year = d.getUTCFullYear();
  // Week number = #Thursdays since (and including) Jan 1.
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return { year, week };
}

/** Inclusive Monday → Sunday range covering ISO `(year, week)`. */
export function weekToRange(
  year: number,
  week: number,
): { since: Date; until: Date } {
  // Jan 4th always lands in ISO week 1; back up to its Monday.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));

  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  return { since: monday, until: sunday };
}

/** 52 or 53, depending on the year. A year has 53 ISO weeks when its
 *  Jan 1 is a Thursday, or when it's a leap year and Jan 1 is a
 *  Wednesday. */
export function weeksInYear(year: number): number {
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const jan1Day = jan1.getUTCDay() || 7; // Sunday → 7
  const isLeap = new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1;
  return jan1Day === 4 || (isLeap && jan1Day === 3) ? 53 : 52;
}

/** ISO weeks the given (since,until) range covers, deduped + sorted
 *  ascending by (year, week). Used to translate the user's free-form
 *  date inputs into the fixed grid slots. */
export function isoWeeksInRange(
  sinceIso: string,
  untilIso: string,
): Array<{ year: number; week: number }> {
  const start = new Date(sinceIso);
  const end = new Date(untilIso);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start > end
  ) {
    return [];
  }
  const seen = new Set<string>();
  const out: Array<{ year: number; week: number }> = [];
  // Step Mon→Mon to make sure we don't miss week boundaries when the
  // input range is short.
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  while (cursor <= end) {
    const w = isoWeekOf(cursor);
    const key = `${w.year}-${w.week}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(w);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  out.sort((a, b) =>
    a.year === b.year ? a.week - b.week : a.year - b.year,
  );
  return out;
}

/** "W34" / always 1-2 digit week number. */
export function formatWeekTag(week: number): string {
  return `W${week.toString().padStart(2, "0")}`;
}

/** A week is "generatable" only when it sits **strictly in the past** —
 *  the current ISO week itself is excluded because work that's still
 *  unfolding shouldn't be summarised mid-stream (commits land
 *  throughout, the report would go stale instantly). Future weeks are
 *  excluded for the obvious reason. So:
 *
 *    year < todayYear       → past, eligible
 *    year > todayYear       → future, locked
 *    year === todayYear     → eligible only when week < todayWeek
 */
export function isPastWeek(
  year: number,
  week: number,
  todayYear: number,
  todayWeek: number,
): boolean {
  if (year < todayYear) return true;
  if (year > todayYear) return false;
  return week < todayWeek;
}

/** "May 5 – May 11" (or "May 5" if same day). Used in card headers
 *  and copy-all dumps. */
export function formatRangeLabel(sinceIso: string, untilIso: string): string {
  const start = new Date(sinceIso);
  const end = new Date(untilIso);
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate()
  ) {
    return fmt(start);
  }
  return `${fmt(start)} – ${fmt(end)}`;
}
