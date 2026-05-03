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

// ────────────────────────────────────────────────────────────────────
// Fiscal year (Oct 1 → Sep 30) helpers
// ────────────────────────────────────────────────────────────────────
//
// The user's "year" runs Oct 1 → Sep 30. We label fiscal years by the
// **end** calendar year (matches the common "FY26 ends in 2026"
// convention): Oct 1 2025 → Sep 30 2026 == FY2026.
//
// Within a single fiscal year, every ISO week number (1..53) appears
// at most once — calendar 2025 contributes ~weeks 40-52(+53), calendar
// 2026 contributes ~weeks 1-39 — so an ISO week number alone is enough
// to identify a slot when paired with a fiscal year.

/** Month index (0-based) where the fiscal year starts. October. */
export const FISCAL_YEAR_START_MONTH = 9;

/** The fiscal year (end-year-named) that contains the given calendar
 *  date. May 2026 → FY2026; Oct 1 2026 → FY2027; Sep 30 2026 → FY2026. */
export function fiscalYearOf(date: Date): number {
  const month = date.getUTCMonth();
  const year = date.getUTCFullYear();
  return month >= FISCAL_YEAR_START_MONTH ? year + 1 : year;
}

/** The fiscal year that contains the given ISO week. Anchor on the
 *  week's Thursday (the same canonical day ISO uses for assigning
 *  weeks to years) so every ISO week belongs to exactly one fiscal
 *  year — no overlap on the Oct-1 boundary. */
export function fiscalYearOfIsoWeek(year: number, week: number): number {
  const r = weekToRange(year, week);
  // Thursday = Monday + 3.
  const thursday = new Date(r.since);
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  return fiscalYearOf(thursday);
}

/** Ordered list of every ISO week that belongs to the given fiscal
 *  year, from the first week (October) to the last (September). */
export function fiscalWeekIds(
  fy: number,
): Array<{ year: number; week: number }> {
  const out: Array<{ year: number; week: number }> = [];
  const seen = new Set<string>();
  // Walk Oct 1 of (fy-1) → Sep 30 of fy day-by-day. Day-of-month 0 of
  // month October == Sep 30 (Date arithmetic). Step a few days back to
  // catch a border-Thursday week that begins late September.
  const cursor = new Date(Date.UTC(fy - 1, FISCAL_YEAR_START_MONTH, 1));
  cursor.setUTCDate(cursor.getUTCDate() - 6);
  const end = new Date(Date.UTC(fy, FISCAL_YEAR_START_MONTH, 0, 23, 59, 59));
  while (cursor <= end) {
    const w = isoWeekOf(cursor);
    if (fiscalYearOfIsoWeek(w.year, w.week) === fy) {
      const key = `${w.year}-${w.week}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(w);
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Total number of ISO weeks in the given fiscal year (52 or 53). */
export function weeksInFiscalYear(fy: number): number {
  return fiscalWeekIds(fy).length;
}

/** Given a fiscal year and an ISO week number that belongs to it,
 *  return the calendar year that ISO week sits in. Falls back to `fy`
 *  if the lookup fails (caller must have passed a stale week). */
export function calendarYearOfFiscalWeek(fy: number, isoWeek: number): number {
  for (const id of fiscalWeekIds(fy)) {
    if (id.week === isoWeek) return id.year;
  }
  return fy;
}

/** "FY2026" label. End-year naming. */
export function formatFiscalYear(fy: number): string {
  return `FY${fy}`;
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
