/**
 * AI Summary tab — port of the Swift `AISummaryView` + `AISummaryViewModel`.
 *
 * Behaviour, mirrored 1-to-1 with the reference app:
 *
 *   - Selected repos are **persisted** in `PrMasterSettings.selected_repos`
 *     so the picker survives a restart (matches the Swift `RepoManager`'s
 *     UserDefaults `"selectedRepos"` key).
 *   - Summary cards are **persisted** via `prmaster_load_ai_summaries`
 *     / `prmaster_save_ai_summaries` (matches the `aiSummaryCache`
 *     UserDefaults key).
 *   - The default date range is "today minus one month → today".
 *   - When the chosen range exceeds 7 days, it's split into 7-day
 *     weeks; one **week group** is rendered per range, with one
 *     **per-repo card** inside each group (the user explicitly wants
 *     per-repo subdivision so they can read repo-level summaries).
 *   - **Generate only what's new**: a click on Generate looks at the
 *     cached cards and only fires AI calls for `(week, repo)` pairs
 *     that aren't already complete. Adding a repo and re-clicking
 *     Generate fills in the missing repo column for every existing
 *     week without regenerating the rest.
 *   - **Copy all** concatenates every completed card's summary text
 *     joined with `\n\n`, exactly like the Swift version.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
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
import { RepoPicker } from "../shared/RepoPicker";

/** Status overlay for in-flight cells in the per-week grid. */
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
  /** Cards keyed by repo, in selection order. */
  cards: Map<string, SummaryCard>;
}

export function AiSummaryTab() {
  // ── Date range ──────────────────────────────────────────────────────
  const [since, setSince] = useState(() =>
    isoDate(new Date(Date.now() - 30 * 86_400 * 1000)),
  );
  const [until, setUntil] = useState(() => isoDate(new Date()));

  // ── Repos ───────────────────────────────────────────────────────────
  const [repos, setRepos] = useState<string[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposFetching, setReposFetching] = useState(false);
  const [reposCachedAt, setReposCachedAt] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<PrMasterSettings | null>(null);

  // ── Cached + in-flight summaries ────────────────────────────────────
  const [cards, setCards] = useState<SummaryCard[]>([]);
  const [cellStatus, setCellStatus] = useState<Map<string, CellStatus>>(
    new Map(),
  );
  const [generating, setGenerating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Flips to true when the user clicks Cancel; the generation loop
   *  watches the ref between iterations and bails out early. Reset
   *  inside `generate()` on entry so a fresh run always starts clean. */
  const cancelRef = useRef(false);

  // ── Provider status probe (cheap availability check via list_models) ─
  type ProviderStatus =
    | { kind: "checking" }
    | { kind: "ready" }
    | { kind: "missing"; message: string };
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
          setProviderStatus({
            kind: "missing",
            message: formatError(err),
          });
      }
    })();
    return () => {
      alive = false;
    };
    // Re-probe whenever the chosen provider changes.
  }, [settings?.ai_provider]);

  // ── Bootstrap: load persisted state in parallel ─────────────────────
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
        setSelected(new Set(s.selected_repos ?? []));
        setCards(list);
      } catch (err) {
        if (alive) setError(formatError(err));
      }
    })();
    void refreshRepos();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshRepos() {
    setReposLoading(true);
    try {
      const result = await prmasterTauri.listAccessibleRepos();
      setRepos(result.repos);
      setReposCachedAt(result.cached_at_ms);
    } catch (err) {
      console.warn("[ai-summary] listAccessibleRepos failed:", err);
    } finally {
      setReposLoading(false);
    }
  }

  async function fetchRepos() {
    setReposFetching(true);
    try {
      const result = await prmasterTauri.fetchRepos();
      setRepos(result.repos);
      setReposCachedAt(result.cached_at_ms);
    } catch (err) {
      console.warn("[ai-summary] fetchRepos failed:", err);
    } finally {
      setReposFetching(false);
    }
  }

  /** Persist the new selection back to `PrMasterSettings.selected_repos`. */
  async function persistSelected(next: Set<string>) {
    setSelected(next);
    if (!settings) return;
    const updated = { ...settings, selected_repos: [...next].sort() };
    setSettings(updated);
    try {
      await prmasterTauri.saveSettings(updated);
    } catch (err) {
      console.warn("[ai-summary] saveSettings failed:", err);
    }
  }

  function toggleRepo(repo: string) {
    const next = new Set(selected);
    if (next.has(repo)) next.delete(repo);
    else next.add(repo);
    void persistSelected(next);
  }

  async function persistCards(next: SummaryCard[]) {
    setCards(next);
    try {
      await prmasterTauri.saveAiSummaries(next);
    } catch (err) {
      console.warn("[ai-summary] saveAiSummaries failed:", err);
    }
  }

  // ── Derived: week ranges from start/end + cached cards by week ──────
  const weekRanges = useMemo<WeekRange[]>(
    () => splitIntoWeeks(since, until),
    [since, until],
  );

  /** Card lookup keyed by `${repo}|${since}|${until}` so we can detect
   *  what's already cached and skip re-generating it. */
  const cardIndex = useMemo(() => {
    const m = new Map<string, SummaryCard>();
    for (const c of cards) m.set(cardKey(c.repo, c.since, c.until), c);
    return m;
  }, [cards]);

  /** Group rendered weeks newest-first; each group lists every card we
   *  have for that week regardless of the current selection (so users
   *  can see history) plus placeholders for currently-selected repos
   *  that are still pending generation. */
  const visibleGroups = useMemo<WeekGroup[]>(() => {
    // Start from cached weeks, descending.
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
    // Layer in currently-pending weeks (e.g. the user just clicked
    // Generate so weeks exist as placeholders).
    for (const range of weekRanges) {
      const key = weekKey(range.since, range.until);
      if (!byWeek.has(key)) byWeek.set(key, { range, cards: new Map() });
    }
    return [...byWeek.values()].sort((a, b) =>
      b.range.since.localeCompare(a.range.since),
    );
  }, [cards, weekRanges]);

  // ── Generate (only weeks × repos that aren't already cached) ────────
  async function generate() {
    if (selected.size === 0) {
      setError("Pick at least one repository.");
      return;
    }
    if (weekRanges.length === 0) return;

    setError(null);
    setGenerating(true);
    cancelRef.current = false;

    // Compute the missing pairs.
    const queue: Array<{ repo: string; range: WeekRange }> = [];
    for (const range of weekRanges) {
      for (const repo of selected) {
        if (!cardIndex.has(cardKey(repo, range.since, range.until))) {
          queue.push({ repo, range });
        }
      }
    }

    if (queue.length === 0) {
      setStatusMessage("Already generated for every selected repo + week.");
      setGenerating(false);
      window.setTimeout(() => setStatusMessage(null), 2500);
      return;
    }

    // Mark queued cells as loading up-front so the grid lights up
    // instead of dripping in one pip at a time.
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

    // If the user cancelled mid-flight, drop the loading flag from any
    // still-pending cells so the grid stops spinning.
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

  /** Drop one (repo, week) card from the cache. */
  async function deleteCell(repo: string, range: WeekRange) {
    const next = cards.filter(
      (c) =>
        !(
          c.repo === repo && c.since === range.since && c.until === range.until
        ),
    );
    await persistCards(next);
  }

  /** Replace a card with a fresh generation at a different
   *  `(repo, since, until)` triple. Mirrors Swift's "Update Summary"
   *  popover from `CommitSummaryCard.swift:108–141`. */
  async function editCell(
    prevRepo: string,
    prevRange: WeekRange,
    nextRepo: string,
    nextRange: WeekRange,
  ) {
    const k = cardKey(nextRepo, nextRange.since, nextRange.until);
    setCellStatus((prev) => new Map(prev).set(k, { kind: "loading" }));
    // Drop the old card first so the cache key shifts cleanly even
    // when only the date range changed and the repo stayed the same.
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
      // Restore the old card on failure so the user doesn't lose data.
      await persistCards(cards);
      setCellStatus((prev) =>
        new Map(prev).set(k, { kind: "error", message: formatError(err) }),
      );
    }
  }

  async function copyAll() {
    // Concatenate every completed card across every week, ordered
    // newest-first by week then by repo, separated by blank lines —
    // matches Swift `copyAllSummaries`.
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
        repos={repos}
        reposLoading={reposLoading}
        reposFetching={reposFetching}
        reposCachedAt={reposCachedAt}
        selected={selected}
        onToggleRepo={toggleRepo}
        onClearRepos={() => void persistSelected(new Set())}
        onFetchRepos={() => void fetchRepos()}
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

          {visibleGroups.length === 0 ? (
            <EmptyHint hasSelection={selected.size > 0} />
          ) : (
            visibleGroups.map((group) => (
              <WeekGroupView
                key={`${group.range.since}|${group.range.until}`}
                group={group}
                selectedRepos={selected}
                cellStatus={cellStatus}
                allRepos={repos}
                onRegenerate={regenerateCell}
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
  repos,
  reposLoading,
  reposFetching,
  reposCachedAt,
  selected,
  onToggleRepo,
  onClearRepos,
  onFetchRepos,
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
  repos: string[];
  reposLoading: boolean;
  reposFetching: boolean;
  reposCachedAt: number | null;
  selected: Set<string>;
  onToggleRepo: (repo: string) => void;
  onClearRepos: () => void;
  onFetchRepos: () => void;
  onGenerate: () => void;
  onCancel: () => void;
  onCopyAll: () => void;
  onClearAll: () => void;
  generating: boolean;
  cardCount: number;
  providerStatus:
    | { kind: "checking" }
    | { kind: "ready" }
    | { kind: "missing"; message: string };
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

      <div className="flex min-w-[240px] flex-1 items-center gap-1">
        <div className="min-w-0 flex-1">
          <RepoPicker
            repos={repos}
            selected={selected}
            loading={reposLoading}
            fetching={reposFetching}
            cachedAtMs={reposCachedAt}
            compact
            onToggle={onToggleRepo}
            onClear={onClearRepos}
            onFetch={onFetchRepos}
          />
        </div>
      </div>

      {generating ? (
        <Button size="sm" variant="destructive" onClick={onCancel}>
          <XCircle className="size-3.5" />
          Cancel
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={selected.size === 0 || providerStatus.kind === "missing"}
          onClick={onGenerate}
        >
          <Sparkles className="size-3.5" />
          Generate{selected.size > 0 ? ` (${selected.size})` : ""}
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

function ProviderStatusPill({
  status,
}: {
  status:
    | { kind: "checking" }
    | { kind: "ready" }
    | { kind: "missing"; message: string };
}) {
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

function EmptyHint({ hasSelection }: { hasSelection: boolean }) {
  return (
    <Panel className="border-dashed">
      <PanelContent className="flex flex-col items-center gap-1.5 py-6 text-center">
        <Sparkles className="size-5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          {hasSelection
            ? "Pick a date range and click Generate to summarise your commits."
            : "Pick at least one repository and a date range, then Generate."}
        </p>
      </PanelContent>
    </Panel>
  );
}

function WeekGroupView({
  group,
  selectedRepos,
  cellStatus,
  allRepos,
  onRegenerate,
  onDelete,
  onEdit,
}: {
  group: WeekGroup;
  selectedRepos: Set<string>;
  cellStatus: Map<string, CellStatus>;
  allRepos: string[];
  onRegenerate: (repo: string, range: WeekRange) => void;
  onDelete: (repo: string, range: WeekRange) => void;
  onEdit: (
    prevRepo: string,
    prevRange: WeekRange,
    nextRepo: string,
    nextRange: WeekRange,
  ) => void;
}) {
  // Render order: cached cards first (alphabetical by repo), then any
  // currently-selected repos that don't yet have a card (so the grid
  // is predictable).
  const cachedRepos = [...group.cards.keys()].sort((a, b) =>
    a.localeCompare(b),
  );
  const pendingRepos = [...selectedRepos]
    .filter((r) => !group.cards.has(r))
    .sort((a, b) => a.localeCompare(b));
  const displayRepos = [...cachedRepos, ...pendingRepos];

  const totalCommits = [...group.cards.values()].reduce(
    (sum, c) => sum + c.commit_count,
    0,
  );

  // Each week is a collapsible accordion. Default-open so newly
  // generated cards are visible; users can collapse old weeks once
  // they've reviewed them. State is local to each group so collapsing
  // one doesn't affect the others.
  const [open, setOpen] = useState(true);

  return (
    <Panel>
      <PanelHeader className="cursor-pointer select-none gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="-mx-1 -my-1 flex flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent/40"
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
      </PanelHeader>
      {open && (
        <PanelContent className="grid gap-2 p-2">
          {displayRepos.length === 0 ? (
            <p className="py-2 text-center text-xs italic text-muted-foreground">
              No repositories selected for this week.
            </p>
          ) : (
            displayRepos.map((repo) => {
              const card = group.cards.get(repo);
              const status = cellStatus.get(
                cardKey(repo, group.range.since, group.range.until),
              );
              return (
                <RepoCardRow
                  key={repo}
                  repo={repo}
                  card={card}
                  status={status}
                  allRepos={allRepos}
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
            })
          )}
        </PanelContent>
      )}
    </Panel>
  );
}

function RepoCardRow({
  repo,
  card,
  status,
  allRepos,
  onRegenerate,
  onDelete,
  onEdit,
}: {
  repo: string;
  card: SummaryCard | undefined;
  status: CellStatus | undefined;
  allRepos: string[];
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
              allRepos={allRepos}
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
          <pre className="font-sans text-sm leading-relaxed whitespace-pre-wrap">
            {card.summary}
          </pre>
        ) : (
          <span className="text-xs italic text-muted-foreground">
            <Download className="mr-1 inline size-3" />
            Not generated yet — click Generate to fill in.
          </span>
        )}
      </div>
    </div>
  );
}

/** Per-card edit popover — port of Swift `CommitSummaryCard.swift`'s
 *  "Update Summary" sheet. Lets the user pick a different repo and a
 *  different date window for an existing card without losing it: the
 *  parent's `onSubmit` deletes the old card and queues a fresh
 *  generation at the new coordinates. */
function UpdatePopoverButton({
  card,
  allRepos,
  onSubmit,
}: {
  card: SummaryCard;
  allRepos: string[];
  onSubmit: (nextRepo: string, nextRange: WeekRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const initialSince = isoDate(new Date(card.since));
  const initialUntil = isoDate(new Date(card.until));
  const [since, setSince] = useState(initialSince);
  const [until, setUntil] = useState(initialUntil);
  const [repo, setRepo] = useState(card.repo);

  // Reset the form values whenever the popover (re)opens — the user
  // expects "edit again" to start from the current cached card, not
  // from whatever they typed last time.
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
                {(allRepos.includes(card.repo)
                  ? allRepos
                  : [card.repo, ...allRepos]
                ).map((r) => (
                  <SelectItem key={r} value={r} className="font-mono text-xs">
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
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

/** Stable cache key for a (repo, week) pair. */
function cardKey(repo: string, since: string, until: string): string {
  return `${repo}|${since}|${until}`;
}

/** Insert / replace a card in a flat array, keyed by (repo, since, until). */
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

/** Split `[since,until]` (date strings, inclusive) into 7-day windows.
 *  Each returned range is ISO with the same `T00:00:00Z` / `T23:59:59Z`
 *  bookends the backend already expects. Single window if the span is
 *  ≤ 7 days. Mirrors Swift `splitIntoWeeks`. */
function splitIntoWeeks(sinceDate: string, untilDate: string): WeekRange[] {
  // Treat both bounds as local midnight; convert to a UTC range with
  // matching offsets so the backend's `until` truly covers the end of
  // the user-picked day.
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
