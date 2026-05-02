/**
 * AI Summary tab — generates per-(repo, week) Markdown reports.
 *
 * Repo selection model (intentional simplification over the Swift app):
 * we **only** summarise repositories that have a local mapping in
 * Settings. A mapping points at a local clone, which lets the engine
 * read commits via `git log` / `git show` instead of `gh api repos/…`
 * — local is *much* faster (no rate limits, no network). Without a
 * mapping the engine can technically still hit the GitHub API, but
 * the experience is so much slower that we treat "mapped" as the
 * supported set.
 *
 * Consequences:
 *   - No repo dropdown on the AI tab. Mappings live in Settings; this
 *     tab just consumes them.
 *   - Generate runs against **every mapped repo × every week** in the
 *     selected date range. Already-generated `(repo, week)` cells are
 *     skipped automatically.
 *   - Cards from removed mappings remain visible (so you can still
 *     read or delete old summaries) but won't be re-generated.
 *
 * Persistence:
 *   - Summary cards: `prmaster_load_ai_summaries` /
 *     `prmaster_save_ai_summaries` (UserConfig SQLite blob).
 *   - Date range: in-memory only (Swift parity — defaults to "last 30
 *     days" on every launch).
 *
 * Diagnostics:
 *   - Every `aiSummary` call is recorded on the engine's
 *     `AiRunRecord` log and rendered in the API Stats tab so the
 *     resolved provider + model is visible.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
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
import { MarkdownReader } from "../shared/MarkdownReader";
import {
  prmasterTauri,
  type PrMasterSettings,
  type SummaryCard,
} from "../../lib/tauri";
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from "../shared/density";

/** Status overlay for in-flight cells. */
type CellStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string };

interface WeekRange {
  /** ISO with `T00:00:00Z`. */
  since: string;
  /** ISO with `T23:59:59Z`. */
  until: string;
}

interface WeekGroup {
  range: WeekRange;
  /** Cards keyed by repo. */
  cards: Map<string, SummaryCard>;
}

type ProviderStatus =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "missing"; message: string };

export function AiSummaryTab() {
  // ── Date range ──────────────────────────────────────────────────────
  const [since, setSince] = useState(() =>
    isoDate(new Date(Date.now() - 30 * 86_400 * 1000)),
  );
  const [until, setUntil] = useState(() => isoDate(new Date()));

  // ── Settings (mapped repos come from here) ──────────────────────────
  const [settings, setSettings] = useState<PrMasterSettings | null>(null);

  // ── Cached + in-flight summaries ────────────────────────────────────
  const [cards, setCards] = useState<SummaryCard[]>([]);
  const [cellStatus, setCellStatus] = useState<Map<string, CellStatus>>(
    new Map(),
  );
  const [generating, setGenerating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  // ── Provider status probe ───────────────────────────────────────────
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

  // ── Bootstrap: load settings + persisted cards in parallel ──────────
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

  // Refresh settings whenever the tab regains focus, so adding a
  // mapping in Settings shows up here without a hard reload.
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

  // The repos we summarise == the repos with a local mapping in
  // Settings. Sorted + deduped so callers downstream get a stable
  // ordering.
  const mappedRepos = useMemo<string[]>(() => {
    if (!settings) return [];
    const set = new Set<string>();
    for (const m of settings.repo_mappings) {
      if (m.repo.length > 0) set.add(m.repo);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [settings]);

  async function persistCards(next: SummaryCard[]) {
    setCards(next);
    try {
      await prmasterTauri.saveAiSummaries(next);
    } catch (err) {
      console.warn("[ai-summary] saveAiSummaries failed:", err);
    }
  }

  // ── Derived: week ranges + cached card index ────────────────────────
  const weekRanges = useMemo<WeekRange[]>(
    () => splitIntoWeeks(since, until),
    [since, until],
  );

  /** Card lookup keyed by `${repo}|${since}|${until}`. */
  const cardIndex = useMemo(() => {
    const m = new Map<string, SummaryCard>();
    for (const c of cards) m.set(cardKey(c.repo, c.since, c.until), c);
    return m;
  }, [cards]);

  /** Render groups newest-first; show cached cards (even from removed
   *  mappings) plus pending placeholders for currently-mapped repos. */
  const visibleGroups = useMemo<WeekGroup[]>(() => {
    const weekKey = (since: string, until: string) => `${since}|${until}`;
    const byWeek = new Map<string, WeekGroup>();
    for (const card of cards) {
      const key = weekKey(card.since, card.until);
      let g = byWeek.get(key);
      if (!g) {
        g = {
          range: { since: card.since, until: card.until },
          cards: new Map(),
        };
        byWeek.set(key, g);
      }
      g.cards.set(card.repo, card);
    }
    for (const range of weekRanges) {
      const key = weekKey(range.since, range.until);
      if (!byWeek.has(key)) byWeek.set(key, { range, cards: new Map() });
    }
    return [...byWeek.values()].sort((a, b) =>
      b.range.since.localeCompare(a.range.since),
    );
  }, [cards, weekRanges]);

  // ── Generate (every mapped repo × every week, skipping cached) ──────
  async function generate() {
    if (mappedRepos.length === 0) {
      setError(
        "Add at least one local repo mapping in Settings to enable AI summaries.",
      );
      return;
    }
    if (weekRanges.length === 0) return;

    setError(null);
    setGenerating(true);
    cancelRef.current = false;

    const queue: Array<{ repo: string; range: WeekRange }> = [];
    for (const range of weekRanges) {
      for (const repo of mappedRepos) {
        if (!cardIndex.has(cardKey(repo, range.since, range.until))) {
          queue.push({ repo, range });
        }
      }
    }

    if (queue.length === 0) {
      setStatusMessage(
        "Already generated for every mapped repo + week in this range.",
      );
      setGenerating(false);
      window.setTimeout(() => setStatusMessage(null), 2500);
      return;
    }

    setCellStatus((prev) => {
      const next = new Map(prev);
      for (const { repo, range } of queue) {
        next.set(cardKey(repo, range.since, range.until), { kind: "loading" });
      }
      return next;
    });

    let nextCards = cards.slice();
    for (const { repo, range } of queue) {
      if (cancelRef.current) break;
      const k = cardKey(repo, range.since, range.until);
      setStatusMessage(
        `Summarising ${repo} · ${formatRangeLabel(range.since, range.until)}…`,
      );
      try {
        const card = await prmasterTauri.aiSummary({
          repo,
          since: range.since,
          until: range.until,
          force: false,
        });
        if (cancelRef.current) break;
        nextCards = upsertCard(nextCards, card);
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

  /** Force-regenerate one (repo, week) pair. */
  async function regenerateCell(repo: string, range: WeekRange) {
    const k = cardKey(repo, range.since, range.until);
    setCellStatus((prev) => new Map(prev).set(k, { kind: "loading" }));
    try {
      const card = await prmasterTauri.aiSummary({
        repo,
        since: range.since,
        until: range.until,
        force: true,
      });
      const next = upsertCard(cards, card);
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

  /** Bulk action — regenerate every cached card in `range`, plus
   *  generate fresh cards for any currently-mapped repo that doesn't
   *  yet have one. Wired to the "Regenerate week" button on each
   *  WeekGroupView header so the user can refresh a whole week with
   *  one click instead of clicking the per-card icon for each repo. */
  async function regenerateWeek(range: WeekRange) {
    if (generating) return;

    // Mapped repos plus any cached repos in this week (so removed-
    // mapping cards still get refreshed if the user explicitly asks
    // for it). Dedup + alphabetical for predictable status messages.
    const cached = cards
      .filter((c) => c.since === range.since && c.until === range.until)
      .map((c) => c.repo);
    const targets = Array.from(new Set([...mappedRepos, ...cached])).sort(
      (a, b) => a.localeCompare(b),
    );
    if (targets.length === 0) return;

    setError(null);
    setGenerating(true);
    cancelRef.current = false;

    setCellStatus((prev) => {
      const next = new Map(prev);
      for (const repo of targets) {
        next.set(cardKey(repo, range.since, range.until), { kind: "loading" });
      }
      return next;
    });

    let nextCards = cards.slice();
    const label = formatRangeLabel(range.since, range.until);
    for (const repo of targets) {
      if (cancelRef.current) break;
      const k = cardKey(repo, range.since, range.until);
      setStatusMessage(`Regenerating ${repo} · ${label}…`);
      try {
        const card = await prmasterTauri.aiSummary({
          repo,
          since: range.since,
          until: range.until,
          force: true,
        });
        if (cancelRef.current) break;
        nextCards = upsertCard(nextCards, card);
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

  /** Drop one (repo, week) card from the cache. */
  async function deleteCell(repo: string, range: WeekRange) {
    const next = cards.filter(
      (c) =>
        !(
          c.repo === repo &&
          c.since === range.since &&
          c.until === range.until
        ),
    );
    await persistCards(next);
  }

  /** Replace a card with a fresh generation at a different
   *  `(repo, since, until)` triple. Edit popover only offers mapped
   *  repos as targets — switching to a non-mapped repo would force a
   *  slow remote fetch and defeat the purpose. */
  async function editCell(
    prevRepo: string,
    prevRange: WeekRange,
    nextRepo: string,
    nextRange: WeekRange,
  ) {
    const k = cardKey(nextRepo, nextRange.since, nextRange.until);
    setCellStatus((prev) => new Map(prev).set(k, { kind: "loading" }));
    const stripped = cards.filter(
      (c) =>
        !(
          c.repo === prevRepo &&
          c.since === prevRange.since &&
          c.until === prevRange.until
        ),
    );
    try {
      const card = await prmasterTauri.aiSummary({
        repo: nextRepo,
        since: nextRange.since,
        until: nextRange.until,
        force: true,
      });
      await persistCards(upsertCard(stripped, card));
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
    for (const group of visibleGroups) {
      for (const [repo, card] of group.cards) {
        lines.push(
          `## ${formatRangeLabel(group.range.since, group.range.until)} · ${repo}`,
          "",
          card.summary,
          "",
        );
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        since={since}
        until={until}
        onSince={setSince}
        onUntil={setUntil}
        mappedCount={mappedRepos.length}
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
          ) : visibleGroups.length === 0 ? (
            <EmptyHint />
          ) : (
            visibleGroups.map((group) => (
              <WeekGroupView
                key={`${group.range.since}|${group.range.until}`}
                group={group}
                mappedRepos={mappedRepos}
                cellStatus={cellStatus}
                generating={generating}
                onRegenerate={regenerateCell}
                onRegenerateWeek={regenerateWeek}
                onDelete={deleteCell}
                onEdit={editCell}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Toolbar({
  since,
  until,
  onSince,
  onUntil,
  mappedCount,
  onGenerate,
  onCancel,
  onCopyAll,
  onClearAll,
  generating,
  cardCount,
  providerStatus,
}: {
  since: string;
  until: string;
  onSince: (v: string) => void;
  onUntil: (v: string) => void;
  mappedCount: number;
  onGenerate: () => void;
  onCancel: () => void;
  onCopyAll: () => void;
  onClearAll: () => void;
  generating: boolean;
  cardCount: number;
  providerStatus: ProviderStatus;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b bg-card/40 px-3 py-1.5">
      <Label htmlFor="since" className="text-xs text-muted-foreground">
        Since
      </Label>
      <Input
        id="since"
        type="date"
        value={since}
        onChange={(e) => onSince(e.target.value)}
        className="h-7 w-[130px]"
      />
      <Label htmlFor="until" className="text-xs text-muted-foreground">
        Until
      </Label>
      <Input
        id="until"
        type="date"
        value={until}
        onChange={(e) => onUntil(e.target.value)}
        className="h-7 w-[130px]"
      />

      <span
        className="flex items-center gap-1 text-xs text-muted-foreground"
        title="Summaries run against every locally-mapped repo from Settings → Local repo mappings"
      >
        <Folder className="size-3.5" />
        {mappedCount} mapped {mappedCount === 1 ? "repo" : "repos"}
      </span>

      {generating ? (
        <Button size="sm" variant="destructive" onClick={onCancel}>
          <XCircle className="size-3.5" />
          Cancel
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={
            mappedCount === 0 || providerStatus.kind === "missing"
          }
          onClick={onGenerate}
        >
          <Sparkles className="size-3.5" />
          Generate
        </Button>
      )}

      <div className="ml-auto flex items-center gap-1">
        <ProviderStatusPill status={providerStatus} />
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
        <Folder className="size-5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          No local repo mappings yet.
        </p>
        <p className="max-w-[420px] text-xs text-muted-foreground">
          Open <strong>Settings → Local repo mappings</strong> and point
          PRMaster at the local clones you want summarised. AI summaries
          run against those mapped repos by default — local{" "}
          <code className="font-mono">git log</code> is much faster than{" "}
          <code className="font-mono">gh api</code>.
        </p>
      </PanelContent>
    </Panel>
  );
}

function EmptyHint() {
  return (
    <Panel className="border-dashed">
      <PanelContent className="flex flex-col items-center gap-1.5 py-6 text-center">
        <Sparkles className="size-5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Pick a date range and click Generate.
        </p>
      </PanelContent>
    </Panel>
  );
}

function WeekGroupView({
  group,
  mappedRepos,
  cellStatus,
  generating,
  onRegenerate,
  onRegenerateWeek,
  onDelete,
  onEdit,
}: {
  group: WeekGroup;
  mappedRepos: string[];
  cellStatus: Map<string, CellStatus>;
  /** Whether *any* generation pass is in flight — disables the bulk
   *  Regenerate-week button so two passes can't fight each other. */
  generating: boolean;
  onRegenerate: (repo: string, range: WeekRange) => void;
  onRegenerateWeek: (range: WeekRange) => void;
  onDelete: (repo: string, range: WeekRange) => void;
  onEdit: (
    prevRepo: string,
    prevRange: WeekRange,
    nextRepo: string,
    nextRange: WeekRange,
  ) => void;
}) {
  // Show cached cards first (alphabetical), then any currently-mapped
  // repos that don't yet have a card. Cards from removed mappings stay
  // visible (so you can read or delete them) but won't get a fresh
  // run unless explicitly regenerated.
  //
  // Split the cached set into two buckets:
  //   - reposWithCommits  → render as full cards in the responsive
  //     grid (these have an actual summary worth reading)
  //   - emptyRepos        → render as compact chips below the grid
  //     so a week where 8 of 10 repos had zero commits doesn't
  //     produce 8 empty boxes
  // Pending (not-yet-generated) repos still flow through the grid as
  // "Not generated yet" placeholders.
  const cachedRepos = [...group.cards.keys()].sort((a, b) =>
    a.localeCompare(b),
  );
  const reposWithCommits = cachedRepos.filter((r) => {
    const c = group.cards.get(r);
    return !!c && c.commit_count > 0;
  });
  const emptyRepos = cachedRepos.filter((r) => {
    const c = group.cards.get(r);
    return !!c && c.commit_count === 0;
  });
  const pendingRepos = mappedRepos
    .filter((r) => !group.cards.has(r))
    .sort((a, b) => a.localeCompare(b));
  const gridRepos = [...reposWithCommits, ...pendingRepos];
  const displayRepos = [...cachedRepos, ...pendingRepos];

  const totalCommits = [...group.cards.values()].reduce(
    (sum, c) => sum + c.commit_count,
    0,
  );

  // Default open so freshly generated cards are visible.
  const [open, setOpen] = useState(true);

  // `overflow-hidden` on the Panel: keeps the rounded-md corners from
  // clipping the sticky header oddly when it scrolls inside its panel
  // — without it the corner radius shows on top of the stuck header
  // during scroll.
  return (
    <Panel className="overflow-hidden">
      {/* The header is `sticky top-0` within the surrounding scroll
          container, so as the user reads through this week's repo
          cards the date label stays pinned at the top. As soon as
          this week's last card scrolls past, the panel itself leaves
          the viewport and the next week's header takes over —
          standard CSS sticky behaviour, no JS. The explicit `bg-card`
          is needed so content scrolling underneath the stuck header
          doesn't bleed through. */}
      <PanelHeader className="sticky top-0 z-10 select-none gap-2 bg-card shadow-[0_1px_0_rgba(0,0,0,0.04)]">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="-mx-1 -my-1 flex flex-1 cursor-pointer items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent/40"
          aria-expanded={open}
          aria-label={open ? "Collapse week" : "Expand week"}
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <PanelTitle>
            {formatRangeLabel(group.range.since, group.range.until)}
          </PanelTitle>
          {totalCommits > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {totalCommits} commits
            </Badge>
          )}
          <Badge variant="outline" className="text-[10px]">
            {group.cards.size}/{displayRepos.length} repos
          </Badge>
        </button>
        {/* Bulk action: regenerate every repo card in this week with
            one click. Sits next to the chevron so the per-row
            buttons aren't the only path. Disabled while any
            generation pass is running so two passes can't fight. */}
        <Button
          size="xs"
          variant="ghost"
          disabled={generating || displayRepos.length === 0}
          onClick={(e) => {
            e.stopPropagation();
            onRegenerateWeek(group.range);
          }}
          aria-label="Regenerate every summary in this week"
          title="Regenerate every summary in this week"
        >
          <RotateCcw className="size-3" />
          Regenerate week
        </Button>
      </PanelHeader>
      {open && (
        <>
          {/* Responsive grid for repos that actually shipped commits
              this week. 1 column at popover width, 2 once we have
              ~768px, 3 at ~1280px+. `items-start` keeps each card
              sized to its natural content rather than stretching to
              match the tallest sibling. */}
          {gridRepos.length > 0 && (
            <PanelContent className="grid grid-cols-1 items-start gap-2 p-2 md:grid-cols-2 xl:grid-cols-3">
              {gridRepos.map((repo) => {
                const card = group.cards.get(repo);
                const status = cellStatus.get(
                  cardKey(repo, group.range.since, group.range.until),
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
                    onRegenerate={() => onRegenerate(repo, group.range)}
                    onDelete={
                      card ? () => onDelete(repo, group.range) : undefined
                    }
                    onEdit={
                      card
                        ? (nextRepo, nextRange) =>
                            onEdit(repo, group.range, nextRepo, nextRange)
                        : undefined
                    }
                  />
                );
              })}
            </PanelContent>
          )}

          {/* Repos that we ran summaries for but found zero commits.
              Park them in a compact chip strip so a week where most
              mapped repos were quiet doesn't waste a full grid card
              per repo. Each chip carries a regenerate + delete pair
              for the rare case the user wants to retry one. */}
          {emptyRepos.length > 0 && (
            <div className="border-t bg-muted/30 px-2 py-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  No commits this week
                </span>
                {emptyRepos.map((repo) => (
                  <EmptyRepoChip
                    key={repo}
                    repo={repo}
                    range={group.range}
                    cellStatus={cellStatus.get(
                      cardKey(repo, group.range.since, group.range.until),
                    )}
                    isStaleMapping={!mappedRepos.includes(repo)}
                    onRegenerate={() => onRegenerate(repo, group.range)}
                    onDelete={() => onDelete(repo, group.range)}
                  />
                ))}
              </div>
            </div>
          )}

          {gridRepos.length === 0 && emptyRepos.length === 0 && (
            <PanelContent className="p-2">
              <p className="py-2 text-center text-xs italic text-muted-foreground">
                {displayRepos.length === 0
                  ? "No mapped repos for this week."
                  : "Generate to fill in this week."}
              </p>
            </PanelContent>
          )}
        </>
      )}
    </Panel>
  );
}

/** Compact chip used in the "No commits this week" footer. Carries the
 *  same regenerate / delete affordances as a full RepoCardRow but in
 *  the height of one line. */
function EmptyRepoChip({
  repo,
  range,
  cellStatus,
  isStaleMapping,
  onRegenerate,
  onDelete,
}: {
  repo: string;
  range: WeekRange;
  cellStatus: CellStatus | undefined;
  isStaleMapping: boolean;
  onRegenerate: () => void;
  onDelete: () => void;
}) {
  const isLoading = cellStatus?.kind === "loading";
  // Range is unused inside the chip itself but it carries the cache
  // coordinates the caller needs — referenced via the closures above.
  void range;
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
  onEdit?: (nextRepo: string, nextRange: WeekRange) => void;
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
              title="This repo has no local mapping in Settings — kept around so you can read or delete the cached summary."
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
            <UpdatePopoverButton
              card={card}
              mappedRepos={mappedRepos}
              onSubmit={(nextRepo, nextRange) => onEdit(nextRepo, nextRange)}
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
          // Fixed-height viewport — anything taller scrolls inside the
          // card so a single chatty summary can't blow up the page
          // height. ~20rem is roughly 12 lines of text, plenty for a
          // weekly report at a glance and a comfortable scroll target
          // for longer ones. CodeMirror handles its own internal
          // scrolling once the host is height-bounded.
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

/** Fixed-height Markdown viewport for AI summary text. Anything taller
 *  than ~20rem scrolls inside the card so a chatty summary can't blow
 *  up the page height. */
function SummaryView({ summary }: { summary: string }) {
  return (
    <div className="max-h-[20rem] overflow-y-auto rounded">
      <MarkdownReader source={summary} />
    </div>
  );
}

/** Per-card edit popover. Only mapped repos are offered as targets so
 *  switching never accidentally fires a slow `gh api` fetch. The
 *  card's current repo is always listed even if it's no longer
 *  mapped, so the user can edit the date range without changing repo. */
function UpdatePopoverButton({
  card,
  mappedRepos,
  onSubmit,
}: {
  card: SummaryCard;
  mappedRepos: string[];
  onSubmit: (nextRepo: string, nextRange: WeekRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const initialSince = isoDate(new Date(card.since));
  const initialUntil = isoDate(new Date(card.until));
  const [since, setSince] = useState(initialSince);
  const [until, setUntil] = useState(initialUntil);
  const [repo, setRepo] = useState(card.repo);

  useEffect(() => {
    if (open) {
      setSince(initialSince);
      setUntil(initialUntil);
      setRepo(card.repo);
    }
  }, [open, initialSince, initialUntil, card.repo]);

  const dirty =
    since !== initialSince || until !== initialUntil || repo !== card.repo;
  const valid = repo.length > 0 && since.length > 0 && until.length > 0;

  const repoOptions = useMemo(() => {
    if (mappedRepos.includes(card.repo)) return mappedRepos;
    return [card.repo, ...mappedRepos];
  }, [mappedRepos, card.repo]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Edit summary"
          title="Edit (date range / repo)"
        >
          <Pencil className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-3">
        <div className="grid gap-2">
          <div className="grid grid-cols-[auto_1fr] items-center gap-2">
            <Label
              htmlFor={`update-since-${card.repo}`}
              className="text-[10px] uppercase tracking-wide text-muted-foreground"
            >
              Since
            </Label>
            <Input
              id={`update-since-${card.repo}`}
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="h-7"
            />
            <Label
              htmlFor={`update-until-${card.repo}`}
              className="text-[10px] uppercase tracking-wide text-muted-foreground"
            >
              Until
            </Label>
            <Input
              id={`update-until-${card.repo}`}
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="h-7"
            />
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Repo
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
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={!dirty || !valid}
              onClick={() => {
                onSubmit(repo, {
                  since: `${since}T00:00:00Z`,
                  until: `${until}T23:59:59Z`,
                });
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
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function cardKey(repo: string, since: string, until: string): string {
  return `${repo}|${since}|${until}`;
}

function upsertCard(cards: SummaryCard[], next: SummaryCard): SummaryCard[] {
  const key = cardKey(next.repo, next.since, next.until);
  const existing = cards.findIndex(
    (c) => cardKey(c.repo, c.since, c.until) === key,
  );
  if (existing >= 0) {
    const out = cards.slice();
    out[existing] = next;
    return out;
  }
  return [next, ...cards];
}

function splitIntoWeeks(sinceDate: string, untilDate: string): WeekRange[] {
  const start = new Date(`${sinceDate}T00:00:00`);
  const end = new Date(`${untilDate}T23:59:59`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  if (start > end) return [];

  const dayMs = 86_400_000;
  const spanDays = Math.ceil((end.getTime() - start.getTime()) / dayMs);
  if (spanDays <= 7) {
    return [{ since: `${sinceDate}T00:00:00Z`, until: `${untilDate}T23:59:59Z` }];
  }

  const weeks: WeekRange[] = [];
  let cursor = new Date(start);
  while (cursor < end) {
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);
    const weekClampedEnd = weekEnd > end ? end : weekEnd;
    weeks.push({
      since: `${isoDate(cursor)}T00:00:00Z`,
      until: `${isoDate(weekClampedEnd)}T23:59:59Z`,
    });
    cursor = new Date(weekClampedEnd);
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  return weeks;
}

function formatRangeLabel(sinceIso: string, untilIso: string): string {
  const start = new Date(sinceIso);
  const end = new Date(untilIso);
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
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
