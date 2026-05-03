/**
 * Hoisted store for the AI Summary tab.
 *
 * Lives at the app-shell level (next to `PrMasterStoreProvider`) so
 * its state survives every tab switch, tool switch, and window
 * focus change for the lifetime of the app. The AI tab itself is
 * just a presentational consumer — when Radix unmounts its
 * `TabsContent` (e.g. user clicks Settings while a generation is in
 * flight), the in-flight provider calls keep running and their
 * `setCellStatus` / `setGenerating` updates land here in the store
 * — so when the user comes back, the UI shows the live spinner +
 * cells in flight, not a frozen snapshot.
 *
 * The shape mirrors `prmaster-store.tsx`: a provider holds the state
 * and exposes `{ state, actions }` via Context. State is plain
 * `useState`s rather than a reducer because most transitions are
 * driven by async side-effects (network calls, debounced loops),
 * which fit `useState` setters cleanly without an action enum that
 * would just duplicate the function names.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  prmasterTauri,
  type PrMasterSettings,
  type SummaryCard,
} from "../lib/tauri";
import {
  calendarYearOfFiscalWeek,
  fiscalWeekIds,
  fiscalYearOf,
  fiscalYearOfIsoWeek,
  formatFiscalYear,
  formatRangeLabel,
  formatWeekTag,
  isPastWeek,
  isoWeekOf,
  weekToRange,
} from "../lib/iso-week";
import type { CellState, HeatCellInfo } from "../components/shared/YearHeatmap";

/** How many fiscal years (ending at the current FY) appear in the
 *  year-tab strip by default. Picked so a freshly-installed user sees
 *  enough history to drill into without having to click "+ Year" right
 *  away, while keeping the strip from getting visually noisy. Anything
 *  older is reachable via the "+ Year" picker. */
const DEFAULT_LOOKBACK_YEARS = 5;

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

export type CellStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string };

export interface WeekRange {
  /** ISO with `T00:00:00Z`. */
  since: string;
  /** ISO with `T23:59:59Z`. */
  until: string;
}

export type ProviderStatus =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "missing"; message: string };

export interface AiSummaryState {
  // ── Source state ────────────────────────────────────────────────────
  settings: PrMasterSettings | null;
  cards: SummaryCard[];
  cellStatus: Map<string, CellStatus>;
  generating: boolean;
  statusMessage: string | null;
  error: string | null;
  providerStatus: ProviderStatus;
  /** Selected **fiscal** year (Oct 1 → Sep 30, end-year-named so e.g.
   *  Oct 1 2025 → Sep 30 2026 == 2026). Drives `yearOptions` selection
   *  + heatmap filter. */
  selectedYear: number;
  /** ISO week number (1..53) of the focused cell within `selectedYear`.
   *  Within a single fiscal year each ISO week appears at most once,
   *  so this scalar plus `selectedYear` uniquely identifies a slot.
   *  Translate to (calendar year, week) via `calendarYearOfFiscalWeek`
   *  before calling `weekToRange` / `weekKey`. */
  selectedWeek: number | null;
  /** Today's ISO week (calendar year + week number). Memoised once at
   *  provider mount so derived filters (past-week gating, future-cell
   *  dimming) don't drift during a long-lived session. */
  todayIso: { year: number; week: number };
  /** Today's fiscal year. Same memoisation as `todayIso`. */
  todayFy: number;

  // ── Derived ─────────────────────────────────────────────────────────
  mappedRepos: string[];
  /** `(repo, calYear, isoWeek)` lookup. Key: `${repo}|${calYear}-${week}`. */
  cardIndex: Map<string, SummaryCard>;
  /** Fiscal years available in the picker — recent N + any year that
   *  appears in `cards`. */
  yearOptions: number[];
  /** Heatmap cell info for the selected fiscal year, keyed by ISO week
   *  number. Includes future / locked weeks too — the heatmap dims
   *  them based on a separate flag. */
  cellsByWeek: Map<number, HeatCellInfo>;
  /** Ordered list of `(calYear, isoWeek)` IDs that make up the selected
   *  fiscal year, from October (Q1) through September (Q4). Used by
   *  the heatmap to lay out cells in fiscal order and by every loop
   *  that iterates "every week in the selected year". */
  fyWeekIds: Array<{ year: number; week: number }>;
  /** Strictly-past (mapped repo × week) pairs in the selected year
   *  that aren't yet cached. Drives the toolbar's "Generate (N new)"
   *  badge. */
  pendingCount: number;
  focusedRange: WeekRange | null;
  focusedCards: Map<string, SummaryCard>;
}

export interface AiSummaryActions {
  generate: () => Promise<void>;
  cancel: () => void;
  regenerateCell: (repo: string, year: number, week: number) => Promise<void>;
  regenerateFocusedWeek: () => Promise<void>;
  editCell: (
    prevRepo: string,
    nextRepo: string,
    year: number,
    week: number,
  ) => Promise<void>;
  deleteCell: (repo: string, year: number, week: number) => Promise<void>;
  copyAll: () => Promise<void>;
  clearAll: () => Promise<void>;
  setSelectedYear: (year: number) => void;
  setSelectedWeek: (week: number | null) => void;
  addExtraYear: (year: number) => void;
  setError: (message: string | null) => void;
}

// ────────────────────────────────────────────────────────────────────────
// Context
// ────────────────────────────────────────────────────────────────────────

const Ctx = createContext<{
  state: AiSummaryState;
  actions: AiSummaryActions;
} | null>(null);

export function AiSummaryStoreProvider({ children }: { children: ReactNode }) {
  // ── Source state ────────────────────────────────────────────────────
  const [settings, setSettings] = useState<PrMasterSettings | null>(null);
  const [cards, setCards] = useState<SummaryCard[]>([]);
  const [cellStatus, setCellStatus] = useState<Map<string, CellStatus>>(
    new Map(),
  );
  const [generating, setGenerating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>({
    kind: "checking",
  });

  const todayIso = useMemo(() => isoWeekOf(new Date()), []);
  const todayFy = useMemo(() => fiscalYearOf(new Date()), []);
  // `selectedYear` is the FISCAL year the user is currently browsing.
  // See state interface comment for translation rules.
  const [selectedYear, setSelectedYear] = useState(todayFy);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  const [extraYears, setExtraYears] = useState<Set<number>>(new Set());

  /** Cancellation flag for the active generation pass. A ref because
   *  the loop reads it between iterations and we don't want a
   *  state-update render cycle on every check. */
  const cancelRef = useRef(false);

  // ── Bootstrap (runs once at provider mount) ─────────────────────────
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [s, list] = await Promise.all([
          prmasterTauri.getSettings(),
          prmasterTauri.loadAiSummaries(),
        ]);
        if (!alive) return;
        setSettings(s);
        setCards(list);
      } catch (err) {
        if (alive) setError(formatError(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Settings refresh on window focus — picks up Settings-tab edits to
  // `repo_mappings`, `extra_authors`, `ai_provider`, etc. without a
  // full reload.
  useEffect(() => {
    function onFocus() {
      void (async () => {
        try {
          setSettings(await prmasterTauri.getSettings());
        } catch (err) {
          console.warn("[ai-summary] settings refresh failed:", err);
        }
      })();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Probe the AI provider on bootstrap + whenever the user swaps it
  // in Settings. The result drives the toolbar's status pill.
  useEffect(() => {
    let alive = true;
    setProviderStatus({ kind: "checking" });
    void (async () => {
      try {
        await prmasterTauri.aiListModels();
        if (alive) setProviderStatus({ kind: "ready" });
      } catch (err) {
        if (alive) {
          setProviderStatus({ kind: "missing", message: formatError(err) });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [settings?.ai_provider]);

  // ── Derived state ───────────────────────────────────────────────────
  const mappedRepos = useMemo<string[]>(() => {
    if (!settings) return [];
    const set = new Set<string>();
    for (const m of settings.repo_mappings) {
      if (m.repo.length > 0) set.add(m.repo);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [settings]);

  const cardIndex = useMemo(() => {
    const m = new Map<string, SummaryCard>();
    for (const c of cards) {
      const w = isoWeekOf(new Date(c.since));
      // Key on calendar year — that's what every lookup uses (a card's
      // (calYear, week) identity is fiscal-year-agnostic).
      m.set(weekKey(c.repo, w.year, w.week), c);
    }
    return m;
  }, [cards]);

  const yearOptions = useMemo<number[]>(() => {
    const set = new Set<number>();
    for (let y = todayFy; y > todayFy - DEFAULT_LOOKBACK_YEARS; y--) {
      set.add(y);
    }
    for (const c of cards) {
      const w = isoWeekOf(new Date(c.since));
      set.add(fiscalYearOfIsoWeek(w.year, w.week));
    }
    for (const y of extraYears) set.add(y);
    return [...set].sort((a, b) => b - a);
  }, [cards, todayFy, extraYears]);

  // Pre-compute the (calYear, isoWeek) ordering for the selected
  // fiscal year. Used by every loop that iterates "weeks in the
  // selected year" + by the heatmap's cell layout.
  const fyWeekIds = useMemo(
    () => fiscalWeekIds(selectedYear),
    [selectedYear],
  );

  const cellsByWeek = useMemo<Map<number, HeatCellInfo>>(() => {
    const m = new Map<number, HeatCellInfo>();
    for (const c of cards) {
      const w = isoWeekOf(new Date(c.since));
      if (fiscalYearOfIsoWeek(w.year, w.week) !== selectedYear) continue;
      let bucket = m.get(w.week);
      if (!bucket) {
        bucket = {
          state: "complete",
          commits: 0,
          cached: 0,
          mapped: mappedRepos.length,
        };
        m.set(w.week, bucket);
      }
      bucket.commits += c.commit_count;
      bucket.cached += 1;
    }
    for (const { year: calYear, week } of fyWeekIds) {
      const bucket = m.get(week);
      const range = weekToRange(calYear, week);
      const sinceIso = `${isoDate(range.since)}T00:00:00Z`;
      const untilIso = `${isoDate(range.until)}T23:59:59Z`;

      const inFlight = mappedRepos.some((repo) => {
        const k = cardKey(repo, sinceIso, untilIso);
        return cellStatus.get(k)?.kind === "loading";
      });

      const info: HeatCellInfo = bucket ?? {
        state: "empty",
        commits: 0,
        cached: 0,
        mapped: mappedRepos.length,
      };
      info.mapped = mappedRepos.length;

      let state: CellState;
      if (inFlight) state = "inFlight";
      else if (info.cached === 0) state = "empty";
      else if (mappedRepos.length === 0) state = "complete";
      else {
        let mappedCovered = 0;
        for (const repo of mappedRepos) {
          if (cardIndex.has(weekKey(repo, calYear, week))) {
            mappedCovered += 1;
          }
        }
        state = mappedCovered === mappedRepos.length ? "complete" : "partial";
      }
      info.state = state;
      m.set(week, info);
    }
    return m;
  }, [cards, cardIndex, mappedRepos, selectedYear, fyWeekIds, cellStatus]);

  // Auto-pick a week when none is set, or when the user switches year
  // to one that doesn't include the previous selection.
  useEffect(() => {
    const inSelectedFy = fyWeekIds.some((id) => id.week === selectedWeek);
    if (selectedWeek == null || !inSelectedFy) {
      if (selectedYear === todayFy) {
        setSelectedWeek(todayIso.week);
        return;
      }
      // Pick the most recent week in this fiscal year that has cached
      // data; fall back to the last week of the FY if nothing is
      // cached yet.
      const reversed = [...fyWeekIds].reverse();
      const picked =
        reversed.find((id) => (cellsByWeek.get(id.week)?.cached ?? 0) > 0) ??
        reversed[0];
      if (picked) setSelectedWeek(picked.week);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear]);

  const pendingCount = useMemo(() => {
    if (mappedRepos.length === 0) return 0;
    let n = 0;
    for (const { year: calYear, week: w } of fyWeekIds) {
      if (!isPastWeek(calYear, w, todayIso.year, todayIso.week)) continue;
      for (const repo of mappedRepos) {
        if (!cardIndex.has(weekKey(repo, calYear, w))) n += 1;
      }
    }
    return n;
  }, [cardIndex, mappedRepos, fyWeekIds, todayIso]);

  const focusedRange = useMemo<WeekRange | null>(() => {
    if (selectedWeek == null) return null;
    const calYear = calendarYearOfFiscalWeek(selectedYear, selectedWeek);
    const r = weekToRange(calYear, selectedWeek);
    return {
      since: `${isoDate(r.since)}T00:00:00Z`,
      until: `${isoDate(r.until)}T23:59:59Z`,
    };
  }, [selectedYear, selectedWeek]);

  const focusedCards = useMemo<Map<string, SummaryCard>>(() => {
    const m = new Map<string, SummaryCard>();
    if (selectedWeek == null) return m;
    const calYear = calendarYearOfFiscalWeek(selectedYear, selectedWeek);
    for (const c of cards) {
      const w = isoWeekOf(new Date(c.since));
      if (w.year === calYear && w.week === selectedWeek) {
        m.set(c.repo, c);
      }
    }
    return m;
  }, [cards, selectedYear, selectedWeek]);

  // ── Persistence ─────────────────────────────────────────────────────
  // Closures over the latest `cards` to avoid stale closures inside
  // long-running async loops.
  const cardsRef = useRef(cards);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  const persistCards = useCallback(async (next: SummaryCard[]) => {
    setCards(next);
    cardsRef.current = next;
    try {
      await prmasterTauri.saveAiSummaries(next);
    } catch (err) {
      console.warn("[ai-summary] saveAiSummaries failed:", err);
    }
  }, []);

  // ── Actions ─────────────────────────────────────────────────────────

  /** Generate every missing (mapped repo × strictly-past week) cell
   *  in the selected year. Skips cached. */
  const generate = useCallback(async () => {
    if (mappedRepos.length === 0) {
      setError(
        "Add at least one local repo mapping in Settings to enable AI summaries.",
      );
      return;
    }
    setError(null);
    setGenerating(true);
    cancelRef.current = false;

    const queue: Array<{ repo: string; year: number; week: number }> = [];
    for (const { year: calYear, week: w } of fyWeekIds) {
      if (!isPastWeek(calYear, w, todayIso.year, todayIso.week)) continue;
      for (const repo of mappedRepos) {
        if (!cardIndex.has(weekKey(repo, calYear, w))) {
          queue.push({ repo, year: calYear, week: w });
        }
      }
    }

    if (queue.length === 0) {
      setStatusMessage(
        `Already generated for every mapped repo in ${formatFiscalYear(selectedYear)}.`,
      );
      setGenerating(false);
      window.setTimeout(() => setStatusMessage(null), 2500);
      return;
    }

    setCellStatus((prev) => {
      const next = new Map(prev);
      for (const { repo, year, week } of queue) {
        const r = weekToRange(year, week);
        const sinceIso = `${isoDate(r.since)}T00:00:00Z`;
        const untilIso = `${isoDate(r.until)}T23:59:59Z`;
        next.set(cardKey(repo, sinceIso, untilIso), { kind: "loading" });
      }
      return next;
    });

    let nextCards = cardsRef.current.slice();
    for (const { repo, year, week } of queue) {
      if (cancelRef.current) break;
      const r = weekToRange(year, week);
      const sinceIso = `${isoDate(r.since)}T00:00:00Z`;
      const untilIso = `${isoDate(r.until)}T23:59:59Z`;
      const k = cardKey(repo, sinceIso, untilIso);
      setStatusMessage(
        `Summarising ${repo} · ${formatWeekTag(week)} ${year}…`,
      );
      try {
        const card = await prmasterTauri.aiSummary({
          repo,
          since: sinceIso,
          until: untilIso,
          force: false,
        });
        if (cancelRef.current) break;
        nextCards = upsertCardByWeek(nextCards, card);
        await persistCards(nextCards);
        setCellStatus((prev) => {
          const next = new Map(prev);
          next.delete(k);
          return next;
        });
      } catch (err) {
        const message = formatError(err);
        setCellStatus((prev) =>
          new Map(prev).set(k, { kind: "error", message }),
        );
      }
    }

    if (cancelRef.current) {
      setCellStatus((prev) => {
        const next = new Map(prev);
        for (const [k, v] of next) {
          if (v.kind === "loading") next.delete(k);
        }
        return next;
      });
      setStatusMessage("Generation cancelled.");
      window.setTimeout(() => setStatusMessage(null), 2000);
    } else {
      setStatusMessage(null);
    }
    setGenerating(false);
  }, [mappedRepos, fyWeekIds, todayIso, cardIndex, persistCards]);

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  /** Force-regenerate one (repo, week) pair. The `year` argument is the
   *  **fiscal** year currently selected in the UI; translated to the
   *  calendar year of the focused ISO week before any date math. */
  const regenerateCell = useCallback(
    async (repo: string, fy: number, week: number) => {
      const calYear = calendarYearOfFiscalWeek(fy, week);
      if (!isPastWeek(calYear, week, todayIso.year, todayIso.week)) {
        setError(
          "AI summaries only run on fully-past weeks. Wait until this week ends before generating.",
        );
        return;
      }
      const r = weekToRange(calYear, week);
      const sinceIso = `${isoDate(r.since)}T00:00:00Z`;
      const untilIso = `${isoDate(r.until)}T23:59:59Z`;
      const k = cardKey(repo, sinceIso, untilIso);
      setCellStatus((prev) => new Map(prev).set(k, { kind: "loading" }));
      try {
        const card = await prmasterTauri.aiSummary({
          repo,
          since: sinceIso,
          until: untilIso,
          force: true,
        });
        const next = upsertCardByWeek(cardsRef.current, card);
        await persistCards(next);
        setCellStatus((prev) => {
          const x = new Map(prev);
          x.delete(k);
          return x;
        });
      } catch (err) {
        setCellStatus((prev) =>
          new Map(prev).set(k, { kind: "error", message: formatError(err) }),
        );
      }
    },
    [todayIso, persistCards],
  );

  /** Delete the cached card for `(repo, week)` in the given fiscal year. */
  const deleteCell = useCallback(
    async (repo: string, fy: number, week: number) => {
      const calYear = calendarYearOfFiscalWeek(fy, week);
      const next = cardsRef.current.filter((c) => {
        if (c.repo !== repo) return true;
        const w = isoWeekOf(new Date(c.since));
        return !(w.year === calYear && w.week === week);
      });
      await persistCards(next);
    },
    [persistCards],
  );

  const regenerateFocusedWeek = useCallback(async () => {
    if (selectedWeek == null || generating) return;
    // selectedYear is the fiscal year — translate to the calendar year
    // the focused ISO week actually sits in.
    const year = calendarYearOfFiscalWeek(selectedYear, selectedWeek);
    const week = selectedWeek;
    if (!isPastWeek(year, week, todayIso.year, todayIso.week)) {
      setError(
        "AI summaries only run on fully-past weeks. Wait until this week ends before generating.",
      );
      return;
    }

    const r = weekToRange(year, week);
    const sinceIso = `${isoDate(r.since)}T00:00:00Z`;
    const untilIso = `${isoDate(r.until)}T23:59:59Z`;

    const cachedReposThisWeek = cardsRef.current
      .filter((c) => {
        const w = isoWeekOf(new Date(c.since));
        return w.year === year && w.week === week;
      })
      .map((c) => c.repo);
    const targets = Array.from(
      new Set([...mappedRepos, ...cachedReposThisWeek]),
    ).sort((a, b) => a.localeCompare(b));
    if (targets.length === 0) return;

    setError(null);
    setGenerating(true);
    cancelRef.current = false;

    setCellStatus((prev) => {
      const next = new Map(prev);
      for (const repo of targets) {
        next.set(cardKey(repo, sinceIso, untilIso), { kind: "loading" });
      }
      return next;
    });

    let nextCards = cardsRef.current.slice();
    for (const repo of targets) {
      if (cancelRef.current) break;
      const k = cardKey(repo, sinceIso, untilIso);
      setStatusMessage(`Regenerating ${repo} · ${formatWeekTag(week)}…`);
      try {
        const card = await prmasterTauri.aiSummary({
          repo,
          since: sinceIso,
          until: untilIso,
          force: true,
        });
        if (cancelRef.current) break;
        nextCards = upsertCardByWeek(nextCards, card);
        await persistCards(nextCards);
        setCellStatus((prev) => {
          const next = new Map(prev);
          next.delete(k);
          return next;
        });
      } catch (err) {
        setCellStatus((prev) =>
          new Map(prev).set(k, {
            kind: "error",
            message: formatError(err),
          }),
        );
      }
    }
    if (cancelRef.current) {
      setCellStatus((prev) => {
        const next = new Map(prev);
        for (const [k, v] of next) {
          if (v.kind === "loading") next.delete(k);
        }
        return next;
      });
      setStatusMessage("Generation cancelled.");
      window.setTimeout(() => setStatusMessage(null), 2000);
    } else {
      setStatusMessage(null);
    }
    setGenerating(false);
  }, [
    selectedWeek,
    selectedYear,
    generating,
    mappedRepos,
    todayIso,
    persistCards,
  ]);

  const editCell = useCallback(
    async (
      prevRepo: string,
      nextRepo: string,
      fy: number,
      week: number,
    ) => {
      const calYear = calendarYearOfFiscalWeek(fy, week);
      const r = weekToRange(calYear, week);
      const sinceIso = `${isoDate(r.since)}T00:00:00Z`;
      const untilIso = `${isoDate(r.until)}T23:59:59Z`;
      const k = cardKey(nextRepo, sinceIso, untilIso);
      setCellStatus((prev) => new Map(prev).set(k, { kind: "loading" }));
      const stripped = cardsRef.current.filter((c) => {
        if (c.repo !== prevRepo) return true;
        const w = isoWeekOf(new Date(c.since));
        return !(w.year === calYear && w.week === week);
      });
      try {
        const card = await prmasterTauri.aiSummary({
          repo: nextRepo,
          since: sinceIso,
          until: untilIso,
          force: true,
        });
        await persistCards(upsertCardByWeek(stripped, card));
        setCellStatus((prev) => {
          const x = new Map(prev);
          x.delete(k);
          return x;
        });
      } catch (err) {
        // Restore prior state on failure so we don't lose the old card.
        await persistCards(cardsRef.current);
        setCellStatus((prev) =>
          new Map(prev).set(k, { kind: "error", message: formatError(err) }),
        );
      }
    },
    [persistCards],
  );

  const copyAll = useCallback(async () => {
    const lines: string[] = [];

    // Scope: **the currently-selected fiscal year only**. The button
    // used to copy every card across every FY in one shot, which is
    // almost never what users want — pasting a multi-year report
    // into a quarterly review forces them to delete most of it.
    // If the user wants all years, they cycle the year-strip and
    // re-copy. The toolbar label reflects this (`Copy FYxxxx`).
    const targetFy = selectedYear;

    // Bucket by (fiscalYear, ISO week). Skip cards where the project
    // had **no commits** in the window — there's nothing useful to
    // paste, and an empty/boilerplate AI summary just adds noise.
    type Bucket = {
      fy: number;
      week: number;
      calYear: number;
      cards: SummaryCard[];
    };
    const buckets = new Map<string, Bucket>();
    for (const c of cardsRef.current) {
      if (c.commit_count <= 0) continue;
      const w = isoWeekOf(new Date(c.since));
      const fy = fiscalYearOfIsoWeek(w.year, w.week);
      if (fy !== targetFy) continue;
      const key = `${fy}|${String(w.week).padStart(2, "0")}`;
      const b = buckets.get(key) ?? {
        fy,
        week: w.week,
        calYear: w.year,
        cards: [],
      };
      b.cards.push(c);
      buckets.set(key, b);
    }

    // Within the FY: most-recent week first (chronologically by
    // Monday date — not ISO week number — so a week-1 in early
    // January sorts later than a week-52 in late December within
    // the same FY). Repos alphabetical within a bucket.
    const ordered = [...buckets.values()].sort((a, b) => {
      const aMonday = weekToRange(a.calYear, a.week).since.getTime();
      const bMonday = weekToRange(b.calYear, b.week).since.getTime();
      return bMonday - aMonday;
    });

    for (const b of ordered) {
      const r = weekToRange(b.calYear, b.week);
      const label = `${formatFiscalYear(b.fy)} · ${formatWeekTag(b.week)} · ${formatRangeLabel(
        r.since.toISOString(),
        r.until.toISOString(),
      )}`;
      const repos = b.cards
        .slice()
        .sort((a, b2) => a.repo.localeCompare(b2.repo));
      for (const c of repos) {
        lines.push(`## ${label} · ${c.repo}`, "", c.summary, "");
      }
    }

    if (lines.length === 0) return;
    await writeText(lines.join("\n").trim() + "\n");
  }, [selectedYear]);

  const clearAll = useCallback(async () => {
    setCards([]);
    cardsRef.current = [];
    setCellStatus(new Map());
    try {
      await prmasterTauri.clearAiSummaries();
    } catch (err) {
      console.warn("[ai-summary] clearAiSummaries failed:", err);
    }
  }, []);

  const addExtraYear = useCallback((year: number) => {
    setExtraYears((prev) => {
      const next = new Set(prev);
      next.add(year);
      return next;
    });
    setSelectedYear(year);
    setSelectedWeek(null);
  }, []);

  // ── Assemble + memoise the context value ───────────────────────────
  const state: AiSummaryState = {
    settings,
    cards,
    cellStatus,
    generating,
    statusMessage,
    error,
    providerStatus,
    selectedYear,
    selectedWeek,
    todayIso,
    todayFy,
    mappedRepos,
    cardIndex,
    yearOptions,
    cellsByWeek,
    fyWeekIds,
    pendingCount,
    focusedRange,
    focusedCards,
  };

  const actions: AiSummaryActions = useMemo(
    () => ({
      generate,
      cancel,
      regenerateCell,
      regenerateFocusedWeek,
      editCell,
      deleteCell,
      copyAll,
      clearAll,
      setSelectedYear,
      setSelectedWeek,
      addExtraYear,
      setError,
    }),
    [
      generate,
      cancel,
      regenerateCell,
      regenerateFocusedWeek,
      editCell,
      deleteCell,
      copyAll,
      clearAll,
      addExtraYear,
    ],
  );

  const value = useMemo(() => ({ state, actions }), [state, actions]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAiSummaryStore() {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      "useAiSummaryStore must be used inside <AiSummaryStoreProvider>",
    );
  }
  return ctx;
}

// ────────────────────────────────────────────────────────────────────────
// Local helpers (kept here so the tab doesn't have to know about them)
// ────────────────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function cardKey(repo: string, since: string, until: string): string {
  return `${repo}|${since}|${until}`;
}

function weekKey(repo: string, year: number, week: number): string {
  return `${repo}|${year}-${String(week).padStart(2, "0")}`;
}

/** Insert / replace a card by its `(repo, isoWeek)` bucket so legacy
 *  cards (non-Monday-aligned ranges) get cleanly superseded by ISO-
 *  aligned ones on regeneration — no orphan duplicates. */
function upsertCardByWeek(
  cards: SummaryCard[],
  next: SummaryCard,
): SummaryCard[] {
  const nextWeek = isoWeekOf(new Date(next.since));
  const filtered = cards.filter((c) => {
    if (c.repo !== next.repo) return true;
    const w = isoWeekOf(new Date(c.since));
    return w.year !== nextWeek.year || w.week !== nextWeek.week;
  });
  return [next, ...filtered];
}

function formatError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

// Re-export a few derived helpers the tab still needs at render time.
// These live in `iso-week.ts`; the tab imports them via the store
// barrel so it has one source of truth.
export { cardKey };
