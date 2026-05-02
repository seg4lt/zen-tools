/**
 * AI Summary tab — generates per-(repo, week) Markdown reports.
 *
 * Navigation model: the user picks a **year** at the top, sees a
 * GitHub-contributions-style heatmap of all 52 (or 53) ISO weeks, and
 * clicks any cell to focus that single week's per-repo cards in the
 * panel below. No more vertical-stack-of-accordions; one focused week
 * at a time.
 *
 * Repo selection: only repositories with a local mapping in Settings
 * are summarised (mapped repo == fast `git log` path). The user has
 * no per-tab selection step — Generate runs against every mapped
 * repo.
 *
 * Persistence:
 *   - Cards: `prmaster_load_ai_summaries` / `prmaster_save_ai_summaries`.
 *   - Year / week selection: in-memory only.
 *
 * Card → ISO week mapping: cards are bucketed by `isoWeekOf(card.since)`,
 * **not** by exact range string, so legacy cards generated with
 * non-Monday-aligned ranges still appear in the right slot. New
 * generations always use `weekToRange(year, week)` so the canonical
 * Monday→Sunday span lands in the cache.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
  Pencil,
  RotateCcw,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  prmasterTauri,
  type PrMasterSettings,
  type SummaryCard,
} from "../../lib/tauri";
import {
  formatWeekTag,
  isoWeekOf,
  weekToRange,
  weeksInYear,
} from "../../lib/iso-week";
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from "../shared/density";
import {
  YearHeatmap,
  type CellState,
  type HeatCellInfo,
} from "../shared/YearHeatmap";
import { MarkdownReader } from "../shared/MarkdownReader";

/** How many years (ending at the current year) appear in the year-tab
 *  strip by default. Picked so a freshly-installed user sees enough
 *  history to drill into without having to click "+ Year" right away,
 *  while keeping the strip from getting visually noisy. Anything older
 *  is reachable via the "+ Year" picker. */
const DEFAULT_LOOKBACK_YEARS = 5;

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

type CellStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string };

interface WeekRange {
  since: string;
  until: string;
}

type ProviderStatus =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "missing"; message: string };

// ────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────

export function AiSummaryTab() {
  // ── Settings (mapped repos source of truth) ─────────────────────────
  const [settings, setSettings] = useState<PrMasterSettings | null>(null);

  // ── Cards + in-flight cells ─────────────────────────────────────────
  const [cards, setCards] = useState<SummaryCard[]>([]);
  const [cellStatus, setCellStatus] = useState<Map<string, CellStatus>>(
    new Map(),
  );
  const [generating, setGenerating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  // ── Provider status ─────────────────────────────────────────────────
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>({
    kind: "checking",
  });
  useEffect(() => {
    let alive = true;
    setProviderStatus({ kind: "checking" });
    void (async () => {
      try {
        await prmasterTauri.aiListModels();
        if (alive) setProviderStatus({ kind: "ready" });
      } catch (err) {
        if (alive)
          setProviderStatus({ kind: "missing", message: formatError(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [settings?.ai_provider]);

  // ── Year + week selection ───────────────────────────────────────────
  const todayIso = useMemo(() => isoWeekOf(new Date()), []);
  const [selectedYear, setSelectedYear] = useState(todayIso.year);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);

  // ── Bootstrap ──────────────────────────────────────────────────────
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

  // Refresh settings whenever the tab regains focus so a mapping added
  // in Settings shows up here without a hard reload.
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

  // Repos we summarise == repos with a local mapping.
  const mappedRepos = useMemo<string[]>(() => {
    if (!settings) return [];
    const set = new Set<string>();
    for (const m of settings.repo_mappings) {
      if (m.repo.length > 0) set.add(m.repo);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [settings]);

  // Cards bucketed by `(repo, isoWeek)` so legacy cards (non-Monday-
  // aligned ranges) still find their slot. Lookup key:
  // `${repo}|${year}-${week}`.
  const cardIndex = useMemo(() => {
    const m = new Map<string, SummaryCard>();
    for (const c of cards) {
      const w = isoWeekOf(new Date(c.since));
      m.set(weekKey(c.repo, w.year, w.week), c);
    }
    return m;
  }, [cards]);

  // Years the user has manually added via the "+ Year" button. We
  // keep these in plain in-memory state — once you've added an old
  // year you can always re-add it; no need to persist a list of "tab
  // bookmarks". Resets cleanly on app restart.
  const [extraYears, setExtraYears] = useState<Set<number>>(new Set());

  // Year tabs: union of
  //   - the last DEFAULT_LOOKBACK_YEARS (current year + N-1 prior),
  //     so brand-new users see a useful range without having to add
  //     anything manually
  //   - every year that already has at least one cached card
  //   - any year the user explicitly added via the "+ Year" picker
  // Sorted newest-first.
  const yearOptions = useMemo<number[]>(() => {
    const set = new Set<number>();
    for (let y = todayIso.year; y > todayIso.year - DEFAULT_LOOKBACK_YEARS; y--) {
      set.add(y);
    }
    for (const c of cards) {
      const w = isoWeekOf(new Date(c.since));
      set.add(w.year);
    }
    for (const y of extraYears) set.add(y);
    return [...set].sort((a, b) => b - a);
  }, [cards, todayIso.year, extraYears]);

  // Heatmap cell info for the selected year, keyed by week number.
  const cellsByWeek = useMemo<Map<number, HeatCellInfo>>(() => {
    const m = new Map<number, HeatCellInfo>();
    for (const c of cards) {
      const w = isoWeekOf(new Date(c.since));
      if (w.year !== selectedYear) continue;
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
    // Layer in-flight + partial state.
    const total = weeksInYear(selectedYear);
    for (let week = 1; week <= total; week++) {
      const bucket = m.get(week);
      const range = weekToRange(selectedYear, week);
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
        // Count repos *currently mapped* that have a card in this
        // week. A week is "complete" only when every mapped repo has
        // a card for that week; legacy cards from since-removed
        // mappings count as extras, not gaps.
        let mappedCovered = 0;
        for (const repo of mappedRepos) {
          if (cardIndex.has(weekKey(repo, selectedYear, week))) {
            mappedCovered += 1;
          }
        }
        state = mappedCovered === mappedRepos.length ? "complete" : "partial";
      }
      info.state = state;
      m.set(week, info);
    }
    return m;
  }, [cards, cardIndex, mappedRepos, selectedYear, cellStatus]);

  // Auto-pick a week when none is set, or when the user switches year
  // to one that doesn't include the previous selection.
  useEffect(() => {
    const total = weeksInYear(selectedYear);
    if (selectedWeek == null || selectedWeek > total) {
      // Same year as today → snap to today's week.
      // Otherwise → most-recent week with cards, fallback to W01.
      if (selectedYear === todayIso.year) {
        setSelectedWeek(todayIso.week);
        return;
      }
      let pick = 1;
      for (let w = total; w >= 1; w--) {
        const info = cellsByWeek.get(w);
        if (info && info.cached > 0) {
          pick = w;
          break;
        }
      }
      setSelectedWeek(pick);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear]);

  // ── Pending count for the toolbar (selected year, weeks <= today) ───
  const pendingCount = useMemo(() => {
    if (mappedRepos.length === 0) return 0;
    const total = weeksInYear(selectedYear);
    let n = 0;
    for (let w = 1; w <= total; w++) {
      // Skip future weeks in the current year.
      if (selectedYear === todayIso.year && w > todayIso.week) continue;
      for (const repo of mappedRepos) {
        if (!cardIndex.has(weekKey(repo, selectedYear, w))) n += 1;
      }
    }
    return n;
  }, [cardIndex, mappedRepos, selectedYear, todayIso]);

  // ── Persistence helper ──────────────────────────────────────────────
  async function persistCards(next: SummaryCard[]) {
    setCards(next);
    try {
      await prmasterTauri.saveAiSummaries(next);
    } catch (err) {
      console.warn("[ai-summary] saveAiSummaries failed:", err);
    }
  }

  // ── Generate every missing (mapped repo × week ≤ today) cell ────────
  async function generate() {
    if (mappedRepos.length === 0) {
      setError(
        "Add at least one local repo mapping in Settings to enable AI summaries.",
      );
      return;
    }
    setError(null);
    setGenerating(true);
    cancelRef.current = false;

    const total = weeksInYear(selectedYear);
    const queue: Array<{ repo: string; year: number; week: number }> = [];
    for (let w = 1; w <= total; w++) {
      if (selectedYear === todayIso.year && w > todayIso.week) continue;
      for (const repo of mappedRepos) {
        if (!cardIndex.has(weekKey(repo, selectedYear, w))) {
          queue.push({ repo, year: selectedYear, week: w });
        }
      }
    }

    if (queue.length === 0) {
      setStatusMessage(
        `Already generated for every mapped repo in ${selectedYear}.`,
      );
      setGenerating(false);
      window.setTimeout(() => setStatusMessage(null), 2500);
      return;
    }

    // Up-front loading flags so the heatmap lights up immediately.
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

    let nextCards = cards.slice();
    for (const { repo, year, week } of queue) {
      if (cancelRef.current) break;
      const r = weekToRange(year, week);
      const sinceIso = `${isoDate(r.since)}T00:00:00Z`;
      const untilIso = `${isoDate(r.until)}T23:59:59Z`;
      const k = cardKey(repo, sinceIso, untilIso);
      setStatusMessage(
        `Summarising ${repo} · ${formatWeekTag(week)} ${selectedYear}…`,
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
  }

  function cancelGeneration() {
    cancelRef.current = true;
  }

  // ── Per-cell ops (in the focused-week panel) ────────────────────────
  async function regenerateCell(repo: string, year: number, week: number) {
    const r = weekToRange(year, week);
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
      const next = upsertCardByWeek(cards, card);
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
  }

  async function deleteCell(repo: string, year: number, week: number) {
    const next = cards.filter((c) => {
      if (c.repo !== repo) return true;
      const w = isoWeekOf(new Date(c.since));
      return !(w.year === year && w.week === week);
    });
    await persistCards(next);
  }

  /** Bulk action: regenerate every cell in the currently-focused week
   *  (every mapped repo + any cached repos still hanging around). */
  async function regenerateFocusedWeek() {
    if (selectedWeek == null || generating) return;
    const year = selectedYear;
    const week = selectedWeek;

    const r = weekToRange(year, week);
    const sinceIso = `${isoDate(r.since)}T00:00:00Z`;
    const untilIso = `${isoDate(r.until)}T23:59:59Z`;

    const cachedReposThisWeek = cards
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

    let nextCards = cards.slice();
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
  }

  /** Replace a card with a fresh generation at a different repo (the
   *  week stays put — the heatmap is the canonical week picker). */
  async function editCell(
    prevRepo: string,
    nextRepo: string,
    year: number,
    week: number,
  ) {
    const r = weekToRange(year, week);
    const sinceIso = `${isoDate(r.since)}T00:00:00Z`;
    const untilIso = `${isoDate(r.until)}T23:59:59Z`;
    const k = cardKey(nextRepo, sinceIso, untilIso);
    setCellStatus((prev) => new Map(prev).set(k, { kind: "loading" }));
    const stripped = cards.filter((c) => {
      if (c.repo !== prevRepo) return true;
      const w = isoWeekOf(new Date(c.since));
      return !(w.year === year && w.week === week);
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
      await persistCards(cards);
      setCellStatus((prev) =>
        new Map(prev).set(k, { kind: "error", message: formatError(err) }),
      );
    }
  }

  async function copyAll() {
    const lines: string[] = [];
    // Group cards by ISO (year, week) so the dump comes out in
    // chronological order, year-by-year.
    const buckets = new Map<string, SummaryCard[]>();
    for (const c of cards) {
      const w = isoWeekOf(new Date(c.since));
      const key = `${w.year}-${String(w.week).padStart(2, "0")}`;
      const arr = buckets.get(key) ?? [];
      arr.push(c);
      buckets.set(key, arr);
    }
    const sortedKeys = [...buckets.keys()].sort().reverse();
    for (const key of sortedKeys) {
      const [year, weekStr] = key.split("-");
      const week = Number(weekStr);
      const r = weekToRange(Number(year), week);
      const label = `${formatWeekTag(week)} · ${formatRangeLabel(
        r.since.toISOString(),
        r.until.toISOString(),
      )}`;
      const repos = (buckets.get(key) ?? []).slice().sort((a, b) =>
        a.repo.localeCompare(b.repo),
      );
      for (const c of repos) {
        lines.push(`## ${label} · ${c.repo}`, "", c.summary, "");
      }
    }
    if (lines.length === 0) return;
    await writeText(lines.join("\n").trim() + "\n");
  }

  async function clearAll() {
    setCards([]);
    setCellStatus(new Map());
    try {
      await prmasterTauri.clearAiSummaries();
    } catch (err) {
      console.warn("[ai-summary] clearAiSummaries failed:", err);
    }
  }

  // ── Focused-week derivations ────────────────────────────────────────
  const focusedRange = useMemo<WeekRange | null>(() => {
    if (selectedWeek == null) return null;
    const r = weekToRange(selectedYear, selectedWeek);
    return {
      since: `${isoDate(r.since)}T00:00:00Z`,
      until: `${isoDate(r.until)}T23:59:59Z`,
    };
  }, [selectedYear, selectedWeek]);

  // Cards that fall in the focused (year, week) bucket.
  const focusedCards = useMemo<Map<string, SummaryCard>>(() => {
    const m = new Map<string, SummaryCard>();
    if (selectedWeek == null) return m;
    for (const c of cards) {
      const w = isoWeekOf(new Date(c.since));
      if (w.year === selectedYear && w.week === selectedWeek) {
        m.set(c.repo, c);
      }
    }
    return m;
  }, [cards, selectedYear, selectedWeek]);

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        yearOptions={yearOptions}
        selectedYear={selectedYear}
        onSelectYear={(y) => {
          setSelectedYear(y);
          setSelectedWeek(null); // re-pick on next effect
        }}
        onAddYear={(y) => {
          setExtraYears((prev) => {
            const next = new Set(prev);
            next.add(y);
            return next;
          });
          setSelectedYear(y);
          setSelectedWeek(null);
        }}
        currentYear={todayIso.year}
        mappedCount={mappedRepos.length}
        pendingCount={pendingCount}
        onGenerate={() => void generate()}
        onCancel={cancelGeneration}
        onCopyAll={() => void copyAll()}
        onClearAll={() => void clearAll()}
        generating={generating}
        cardCount={cards.length}
        providerStatus={providerStatus}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-muted/20">
        <div className="grid gap-2 p-2">
          {error && (
            <Panel className="border-destructive/40 bg-destructive/5">
              <PanelContent className="flex items-center justify-between gap-2 p-2 text-xs text-destructive">
                <span>{error}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setError(null)}
                >
                  Dismiss
                </Button>
              </PanelContent>
            </Panel>
          )}

          {statusMessage && (
            <Panel className="border-primary/30 bg-primary/5">
              <PanelContent className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {statusMessage}
              </PanelContent>
            </Panel>
          )}

          {settings && mappedRepos.length === 0 && cards.length === 0 ? (
            <NoMappingsHint />
          ) : (
            <>
              <Panel>
                <PanelContent className="p-2">
                  <YearHeatmap
                    year={selectedYear}
                    cells={cellsByWeek}
                    selectedWeek={selectedWeek}
                    todayWeek={
                      selectedYear === todayIso.year ? todayIso.week : null
                    }
                    onSelectWeek={(w) => setSelectedWeek(w)}
                  />
                </PanelContent>
              </Panel>

              {selectedWeek != null && focusedRange && (
                <FocusedWeekPanel
                  year={selectedYear}
                  week={selectedWeek}
                  range={focusedRange}
                  focusedCards={focusedCards}
                  mappedRepos={mappedRepos}
                  cellStatus={cellStatus}
                  generating={generating}
                  onRegenerateWeek={() => void regenerateFocusedWeek()}
                  onRegenerate={(repo) =>
                    void regenerateCell(repo, selectedYear, selectedWeek)
                  }
                  onDelete={(repo) =>
                    void deleteCell(repo, selectedYear, selectedWeek)
                  }
                  onEdit={(prev, next) =>
                    void editCell(prev, next, selectedYear, selectedWeek)
                  }
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Toolbar
// ────────────────────────────────────────────────────────────────────────

function Toolbar({
  yearOptions,
  selectedYear,
  onSelectYear,
  onAddYear,
  currentYear,
  mappedCount,
  pendingCount,
  onGenerate,
  onCancel,
  onCopyAll,
  onClearAll,
  generating,
  cardCount,
  providerStatus,
}: {
  yearOptions: number[];
  selectedYear: number;
  onSelectYear: (y: number) => void;
  onAddYear: (y: number) => void;
  currentYear: number;
  mappedCount: number;
  pendingCount: number;
  onGenerate: () => void;
  onCancel: () => void;
  onCopyAll: () => void;
  onClearAll: () => void;
  generating: boolean;
  cardCount: number;
  providerStatus: ProviderStatus;
}) {
  const upToDate = !generating && pendingCount === 0 && cardCount > 0;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b bg-card/40 px-3 py-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Year
      </span>
      <div className="flex flex-wrap items-center gap-1">
        {yearOptions.map((year) => (
          <Button
            key={year}
            size="xs"
            variant={year === selectedYear ? "secondary" : "ghost"}
            className="font-mono"
            onClick={() => onSelectYear(year)}
          >
            {year}
          </Button>
        ))}
        <AddYearButton
          existing={yearOptions}
          currentYear={currentYear}
          onAdd={onAddYear}
        />
      </div>

      <span
        className="ml-2 flex items-center gap-1 text-xs text-muted-foreground"
        title="Summaries run against every locally-mapped repo from Settings → Local repo mappings"
      >
        {mappedCount} mapped {mappedCount === 1 ? "repo" : "repos"}
      </span>

      <div className="ml-auto flex items-center gap-1">
        <ProviderStatusPill status={providerStatus} />
        {generating ? (
          <Button
            size="default"
            variant="destructive"
            onClick={onCancel}
            className="h-9"
          >
            <XCircle className="size-4" />
            Cancel
          </Button>
        ) : upToDate ? (
          <Button
            size="default"
            variant="outline"
            disabled
            className="h-9"
            title={`${selectedYear}: every mapped repo + week is already cached`}
          >
            <Sparkles className="size-4" />
            Up to date
          </Button>
        ) : (
          <Button
            size="default"
            disabled={
              mappedCount === 0 || providerStatus.kind === "missing"
            }
            onClick={onGenerate}
            className="h-9"
            title={
              pendingCount > 0
                ? `Generate ${pendingCount} new summary card${pendingCount === 1 ? "" : "s"} for ${selectedYear}`
                : `Generate AI summaries for ${selectedYear}`
            }
          >
            <Sparkles className="size-4" />
            Generate {selectedYear}
            {pendingCount > 0 && (
              <Badge
                variant="secondary"
                className="ml-0.5 bg-primary-foreground/20 text-primary-foreground"
              >
                {pendingCount} new
              </Badge>
            )}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={cardCount === 0}
          onClick={onCopyAll}
        >
          <Copy className="size-3.5" />
          Copy all
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={cardCount === 0}
          onClick={onClearAll}
        >
          <Trash2 className="size-3.5" />
          Clear
        </Button>
      </div>
    </div>
  );
}

/** "+ Year" tab — opens a small popover with a year input so the user
 *  can extend the heatmap navigator backwards (or forwards) past the
 *  default lookback window. Validates the input is a sane year, isn't
 *  already in the tab strip, and can't be a year `git log` will never
 *  reach (caps at 1970-current+1). */
function AddYearButton({
  existing,
  currentYear,
  onAdd,
}: {
  existing: number[];
  currentYear: number;
  onAdd: (y: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(currentYear - existing.length));

  // Re-prime the draft each time the popover opens so the user gets a
  // sensible starting point (one year older than the oldest currently
  // shown — usually what they want to add next).
  useEffect(() => {
    if (open) {
      const oldest = existing.length > 0 ? Math.min(...existing) : currentYear;
      setDraft(String(oldest - 1));
    }
  }, [open, existing, currentYear]);

  const parsed = Number(draft);
  const valid =
    Number.isInteger(parsed) &&
    parsed >= 1970 &&
    parsed <= currentYear + 1 &&
    !existing.includes(parsed);
  const reason = (() => {
    if (!Number.isInteger(parsed)) return "Enter a 4-digit year.";
    if (parsed < 1970) return "Pick a year ≥ 1970.";
    if (parsed > currentYear + 1) return "Year is too far in the future.";
    if (existing.includes(parsed)) return "Year is already shown.";
    return "";
  })();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          className="font-mono text-muted-foreground"
          aria-label="Add year"
          title="Add an older year to the tab strip"
        >
          + Year
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-3">
        <div className="grid gap-2">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Add year
          </Label>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              min={1970}
              max={currentYear + 1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid) {
                  e.preventDefault();
                  onAdd(parsed);
                  setOpen(false);
                }
              }}
              className="h-7 w-24 font-mono"
              autoFocus
            />
            <Button
              size="xs"
              disabled={!valid}
              onClick={() => {
                if (!valid) return;
                onAdd(parsed);
                setOpen(false);
              }}
            >
              Add
            </Button>
          </div>
          {!valid && draft.length > 0 && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">
              {reason}
            </span>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ProviderStatusPill({ status }: { status: ProviderStatus }) {
  if (status.kind === "checking") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Checking provider…
      </span>
    );
  }
  if (status.kind === "ready") {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="size-3" />
        Provider ready
      </span>
    );
  }
  return (
    <span
      className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
      title={status.message}
    >
      <AlertTriangle className="size-3" />
      Provider unavailable
    </span>
  );
}

function NoMappingsHint() {
  return (
    <Panel className="border-dashed">
      <PanelContent className="flex flex-col items-center gap-1.5 py-6 text-center">
        <Sparkles className="size-5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          No local repo mappings yet.
        </p>
        <p className="max-w-[420px] text-xs text-muted-foreground">
          Open <strong>Settings → Local repo mappings</strong> and point
          PRMaster at the local clones you want summarised.
        </p>
      </PanelContent>
    </Panel>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Focused week panel — shows ONE week's per-repo cards
// ────────────────────────────────────────────────────────────────────────

function FocusedWeekPanel({
  year,
  week,
  range,
  focusedCards,
  mappedRepos,
  cellStatus,
  generating,
  onRegenerateWeek,
  onRegenerate,
  onDelete,
  onEdit,
}: {
  year: number;
  week: number;
  range: WeekRange;
  focusedCards: Map<string, SummaryCard>;
  mappedRepos: string[];
  cellStatus: Map<string, CellStatus>;
  generating: boolean;
  onRegenerateWeek: () => void;
  onRegenerate: (repo: string) => void;
  onDelete: (repo: string) => void;
  onEdit: (prevRepo: string, nextRepo: string) => void;
}) {
  const cachedRepos = [...focusedCards.keys()].sort((a, b) =>
    a.localeCompare(b),
  );
  const reposWithCommits = cachedRepos.filter(
    (r) => (focusedCards.get(r)?.commit_count ?? 0) > 0,
  );
  const emptyRepos = cachedRepos.filter(
    (r) => (focusedCards.get(r)?.commit_count ?? 0) === 0,
  );
  const pendingRepos = mappedRepos
    .filter((r) => !focusedCards.has(r))
    .sort((a, b) => a.localeCompare(b));
  const gridRepos = [...reposWithCommits, ...pendingRepos];
  const displayRepos = [...cachedRepos, ...pendingRepos];

  const totalCommits = [...focusedCards.values()].reduce(
    (sum, c) => sum + c.commit_count,
    0,
  );
  const inFlight = displayRepos.some((repo) => {
    const s = cellStatus.get(cardKey(repo, range.since, range.until));
    return s?.kind === "loading";
  });
  const complete =
    !inFlight &&
    displayRepos.length > 0 &&
    displayRepos.every((repo) => focusedCards.has(repo));

  return (
    <Panel>
      <PanelHeader className="select-none gap-2">
        <div className="flex flex-1 items-center gap-2">
          <PanelTitle>
            {formatWeekTag(week)} · {formatRangeLabel(range.since, range.until)}
            <span className="ml-1 text-[10px] font-normal text-muted-foreground">
              {year}
            </span>
          </PanelTitle>
          {inFlight ? (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              generating…
            </span>
          ) : complete ? (
            <span className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-3" />
              generated
            </span>
          ) : null}
          {totalCommits > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {totalCommits} commits
            </Badge>
          )}
          <Badge variant="outline" className="text-[10px]">
            {focusedCards.size}/{displayRepos.length} repos
          </Badge>
        </div>
        {inFlight ? (
          <Button
            size="xs"
            variant="ghost"
            disabled
            className="text-muted-foreground"
          >
            <Loader2 className="size-3 animate-spin" />
            Generating…
          </Button>
        ) : complete ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={generating}
            onClick={onRegenerateWeek}
            title="Re-evaluate every summary in this week"
          >
            <RotateCcw className="size-3" />
            Regenerate
          </Button>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            disabled={generating || displayRepos.length === 0}
            onClick={onRegenerateWeek}
            title="Generate every summary in this week"
          >
            <Sparkles className="size-3" />
            Generate week
          </Button>
        )}
      </PanelHeader>
      <PanelContent className="grid gap-2 p-2">
        {gridRepos.length > 0 ? (
          <div className="grid grid-cols-1 items-start gap-2 md:grid-cols-2 xl:grid-cols-3">
            {gridRepos.map((repo) => {
              const card = focusedCards.get(repo);
              const status = cellStatus.get(
                cardKey(repo, range.since, range.until),
              );
              const isStaleMapping =
                !!card && !mappedRepos.includes(repo);
              return (
                <RepoCardRow
                  key={repo}
                  repo={repo}
                  card={card}
                  status={status}
                  isStaleMapping={isStaleMapping}
                  mappedRepos={mappedRepos}
                  onRegenerate={() => onRegenerate(repo)}
                  onDelete={card ? () => onDelete(repo) : undefined}
                  onEdit={
                    card
                      ? (nextRepo) => onEdit(repo, nextRepo)
                      : undefined
                  }
                />
              );
            })}
          </div>
        ) : null}

        {emptyRepos.length > 0 && (
          <div className="rounded border bg-muted/30 px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                No commits this week
              </span>
              {emptyRepos.map((repo) => {
                const isStale = !mappedRepos.includes(repo);
                return (
                  <EmptyRepoChip
                    key={repo}
                    repo={repo}
                    cellStatus={cellStatus.get(
                      cardKey(repo, range.since, range.until),
                    )}
                    isStaleMapping={isStale}
                    onRegenerate={() => onRegenerate(repo)}
                    onDelete={() => onDelete(repo)}
                  />
                );
              })}
            </div>
          </div>
        )}

        {gridRepos.length === 0 && emptyRepos.length === 0 && (
          <p className="py-2 text-center text-xs italic text-muted-foreground">
            Nothing for this week yet — click <strong>Generate week</strong> to
            run.
          </p>
        )}
      </PanelContent>
    </Panel>
  );
}

function EmptyRepoChip({
  repo,
  cellStatus,
  isStaleMapping,
  onRegenerate,
  onDelete,
}: {
  repo: string;
  cellStatus: CellStatus | undefined;
  isStaleMapping: boolean;
  onRegenerate: () => void;
  onDelete: () => void;
}) {
  const isLoading = cellStatus?.kind === "loading";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 font-mono text-[11px]",
        isStaleMapping && "border-amber-500/50",
      )}
      title={
        isStaleMapping
          ? `${repo} (no longer mapped — kept for reference)`
          : repo
      }
    >
      <span className="truncate">{repo}</span>
      <button
        type="button"
        disabled={isLoading}
        onClick={onRegenerate}
        className="cursor-pointer rounded p-0.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        aria-label={`Regenerate ${repo}`}
        title="Re-check for commits"
      >
        {isLoading ? (
          <Loader2 className="size-2.5 animate-spin" />
        ) : (
          <RotateCcw className="size-2.5" />
        )}
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="cursor-pointer rounded p-0.5 hover:bg-muted"
        aria-label={`Drop ${repo} from cache`}
        title="Drop from cache"
      >
        <Trash2 className="size-2.5" />
      </button>
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Per-repo card (one row inside the focused-week panel)
// ────────────────────────────────────────────────────────────────────────

function RepoCardRow({
  repo,
  card,
  status,
  isStaleMapping,
  mappedRepos,
  onRegenerate,
  onDelete,
  onEdit,
}: {
  repo: string;
  card: SummaryCard | undefined;
  status: CellStatus | undefined;
  isStaleMapping: boolean;
  mappedRepos: string[];
  onRegenerate: () => void;
  onDelete?: () => void;
  onEdit?: (nextRepo: string) => void;
}) {
  const isLoading = status?.kind === "loading";
  const isError = status?.kind === "error";
  const [copied, setCopied] = useState(false);

  async function copyOne() {
    if (!card) return;
    await writeText(card.summary);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="rounded-md border bg-background">
      <div className="flex items-center justify-between gap-2 border-b px-2 py-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-xs">{repo}</span>
          {card && (
            <Badge variant="outline" className="text-[10px]">
              {card.commit_count} commits
            </Badge>
          )}
          {card?.cost_usd != null && (
            <Badge variant="outline" className="text-[10px]">
              ${card.cost_usd.toFixed(3)}
            </Badge>
          )}
          {isStaleMapping && (
            <Badge
              variant="outline"
              className="border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-400"
              title="This repo has no local mapping in Settings."
            >
              unmapped
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {card && (
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => void copyOne()}
              aria-label="Copy summary"
              title="Copy"
            >
              {copied ? (
                <span className="text-[10px] font-medium">✓</span>
              ) : (
                <Copy className="size-3" />
              )}
            </Button>
          )}
          {card && onEdit && (
            <RepoEditPopoverButton
              currentRepo={card.repo}
              mappedRepos={mappedRepos}
              onSubmit={onEdit}
            />
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={isLoading}
            onClick={onRegenerate}
            aria-label={card ? "Regenerate" : "Generate"}
            title={card ? "Regenerate" : "Generate"}
          >
            {isLoading ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RotateCcw className="size-3" />
            )}
          </Button>
          {onDelete && (
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={onDelete}
              aria-label="Delete"
              title="Delete"
            >
              <Trash2 className="size-3" />
            </Button>
          )}
        </div>
      </div>
      <div className="p-2 text-sm">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Summarising…
          </div>
        ) : isError ? (
          <pre className="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs whitespace-pre-wrap text-destructive">
            {(status as { kind: "error"; message: string }).message}
          </pre>
        ) : card ? (
          <SummaryView summary={card.summary} />
        ) : (
          <span className="text-xs italic text-muted-foreground">
            Not generated yet — click Generate to fill in.
          </span>
        )}
      </div>
    </div>
  );
}

function SummaryView({ summary }: { summary: string }) {
  return (
    <div className="max-h-[20rem] overflow-y-auto rounded">
      <MarkdownReader source={summary} />
    </div>
  );
}

/** Per-card edit popover: lets the user swap which mapped repo a card
 *  belongs to (the week stays put — heatmap is the canonical week
 *  picker, not this popover). */
function RepoEditPopoverButton({
  currentRepo,
  mappedRepos,
  onSubmit,
}: {
  currentRepo: string;
  mappedRepos: string[];
  onSubmit: (nextRepo: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState(currentRepo);

  useEffect(() => {
    if (open) setRepo(currentRepo);
  }, [open, currentRepo]);

  const repoOptions = useMemo(() => {
    if (mappedRepos.includes(currentRepo)) return mappedRepos;
    return [currentRepo, ...mappedRepos];
  }, [mappedRepos, currentRepo]);

  const dirty = repo !== currentRepo;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Switch repo for this summary"
          title="Switch repo (within this week)"
        >
          <Pencil className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[280px] p-3">
        <div className="grid gap-2">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Switch repo
          </Label>
          <Select value={repo} onValueChange={setRepo}>
            <SelectTrigger size="sm" className="h-7 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {repoOptions.map((r) => (
                <SelectItem key={r} value={r} className="font-mono text-xs">
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={!dirty}
              onClick={() => {
                onSubmit(repo);
                setOpen(false);
              }}
            >
              <RotateCcw className="size-3" />
              Re-generate
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
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

function formatRangeLabel(sinceIso: string, untilIso: string): string {
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

function formatError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
