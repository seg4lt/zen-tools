/**
 * AI Summary tab — generates per-(repo, week) Markdown reports.
 *
 * This component is a **thin presentational consumer** of
 * `useAiSummaryStore()`. All state (settings, cards, in-flight
 * cells, generation flag, year/week selection, provider status,
 * derived heatmap buckets, focused-week cards) lives in the
 * hoisted `AiSummaryStoreProvider` at the app-shell level. That
 * means switching tabs inside PRMaster (or even switching to a
 * different tool entirely) doesn't unmount the state — when the
 * user comes back, the heatmap, focused panel, and any in-flight
 * generation are exactly where they left them.
 *
 * What stays here:
 *   - Layout / render tree (Toolbar, YearHeatmap, FocusedWeekPanel,
 *     RepoCardRow, EmptyRepoChip, etc.).
 *   - Pure render-only sub-components (AddYearButton,
 *     ProviderStatusPill, NoMappingsHint, RepoEditPopoverButton,
 *     SummaryView).
 *   - Local UI state internal to those sub-components (popover
 *     open/closed, draft input value, "copied" flag).
 *
 * What moved out:
 *   - Every `useState` for `cards`, `cellStatus`, `generating`,
 *     `selectedYear`, `selectedWeek`, etc. → store state.
 *   - Bootstrap / focus-listener / provider-probe / week-auto-pick
 *     `useEffect`s → store provider.
 *   - All `useMemo` derivations (mappedRepos, cardIndex, yearOptions,
 *     cellsByWeek, pendingCount, focusedRange, focusedCards) → store.
 *   - Generation actions (generate, cancel, regenerateCell,
 *     regenerateFocusedWeek, editCell, deleteCell, copyAll, clearAll,
 *     addExtraYear) → store actions.
 */

import { useEffect, useMemo, useState } from "react";
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
import { type SummaryCard } from "../../lib/tauri";
import {
  calendarYearOfFiscalWeek,
  formatFiscalYear,
  formatRangeLabel,
  formatWeekTag,
  isPastWeek,
} from "../../lib/iso-week";
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from "../shared/density";
import { YearHeatmap } from "../shared/YearHeatmap";
import { MarkdownReader } from "../shared/MarkdownReader";
import {
  cardKey,
  useAiSummaryStore,
  type CellStatus,
  type ProviderStatus,
  type WeekRange,
} from "../../store/ai-summary-store";

// ────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────

export function AiSummaryTab() {
  const { state, actions } = useAiSummaryStore();
  const {
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
    yearOptions,
    cellsByWeek,
    pendingCount,
    focusedRange,
    focusedCards,
  } = state;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        yearOptions={yearOptions}
        selectedYear={selectedYear}
        onSelectYear={(y) => {
          actions.setSelectedYear(y);
          actions.setSelectedWeek(null); // re-pick on next effect
        }}
        onAddYear={actions.addExtraYear}
        currentYear={todayFy}
        mappedCount={mappedRepos.length}
        pendingCount={pendingCount}
        onGenerate={() => void actions.generate()}
        onCancel={actions.cancel}
        onCopyAll={() => void actions.copyAll()}
        onClearAll={() => void actions.clearAll()}
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
                  onClick={() => actions.setError(null)}
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
                    today={selectedYear === todayFy ? todayIso : null}
                    onSelectWeek={(w) => actions.setSelectedWeek(w)}
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
                  locked={
                    !isPastWeek(
                      calendarYearOfFiscalWeek(selectedYear, selectedWeek),
                      selectedWeek,
                      todayIso.year,
                      todayIso.week,
                    )
                  }
                  onRegenerateWeek={() => void actions.regenerateFocusedWeek()}
                  onRegenerate={(repo) =>
                    void actions.regenerateCell(repo, selectedYear, selectedWeek)
                  }
                  onDelete={(repo) =>
                    void actions.deleteCell(repo, selectedYear, selectedWeek)
                  }
                  onEdit={(prev, next) =>
                    void actions.editCell(prev, next, selectedYear, selectedWeek)
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
      <span
        className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        title="Fiscal year — Oct 1 → Sep 30, end-year-named (FY2026 = Oct 1 2025 → Sep 30 2026)"
      >
        FY
      </span>
      <div className="flex flex-wrap items-center gap-1">
        {yearOptions.map((year) => (
          <Button
            key={year}
            size="xs"
            variant={year === selectedYear ? "secondary" : "ghost"}
            className="font-mono"
            onClick={() => onSelectYear(year)}
            title={`Fiscal ${formatFiscalYear(year)} (Oct 1 ${year - 1} → Sep 30 ${year})`}
          >
            {formatFiscalYear(year)}
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
            title={`${formatFiscalYear(selectedYear)}: every mapped repo + week is already cached`}
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
                ? `Generate ${pendingCount} new summary card${pendingCount === 1 ? "" : "s"} for ${formatFiscalYear(selectedYear)}`
                : `Generate AI summaries for ${formatFiscalYear(selectedYear)}`
            }
          >
            <Sparkles className="size-4" />
            Generate {formatFiscalYear(selectedYear)}
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
          aria-label="Add fiscal year"
          title="Add an older fiscal year to the tab strip"
        >
          + FY
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-3">
        <div className="grid gap-2">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Add fiscal year
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
  locked,
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
  /** True when this week is the *current* ISO week or in the future.
   *  Generation buttons render disabled with a tooltip explaining
   *  that summaries only run on fully-past weeks. */
  locked: boolean;
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
              {formatFiscalYear(year)}
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
        ) : locked ? (
          <Button
            size="xs"
            variant="ghost"
            disabled
            className="text-muted-foreground"
            title="AI summaries only run on fully-past weeks. Wait until this week ends."
          >
            <Sparkles className="size-3" />
            Wait until week ends
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
                  locked={locked}
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
                    locked={locked}
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
  locked,
  onRegenerate,
  onDelete,
}: {
  repo: string;
  cellStatus: CellStatus | undefined;
  isStaleMapping: boolean;
  /** Whether the parent week is the current ISO week or in the
   *  future — the regen button is hidden in that case (only past
   *  weeks can be re-checked). */
  locked: boolean;
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
      {!locked && (
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
      )}
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
  locked,
  onRegenerate,
  onDelete,
  onEdit,
}: {
  repo: string;
  card: SummaryCard | undefined;
  status: CellStatus | undefined;
  isStaleMapping: boolean;
  mappedRepos: string[];
  /** True when the parent week is the current ISO week or in the
   *  future. Hides the regenerate button — only past weeks are
   *  generatable. Existing summaries stay readable. */
  locked: boolean;
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
          {!locked && card && onEdit && (
            <RepoEditPopoverButton
              currentRepo={card.repo}
              mappedRepos={mappedRepos}
              onSubmit={onEdit}
            />
          )}
          {!locked && (
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
          )}
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
