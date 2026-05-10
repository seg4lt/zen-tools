/**
 * Top-level container for the **AI Review** tab on the PR Master
 * review page. Three states drive the body:
 *
 *   1. **Pre-run**  — model picker + Start review button (or the
 *      missing-clone error card when the local repo isn't mapped).
 *   2. **Live**     — streaming JSONL log from Claude. The header
 *      offers a Cancel button.
 *   3. **Loaded**   — a finished run's data, viewable in two modes:
 *        * `log`    — replay of the streaming events for that run
 *                     (default after a fresh run finishes — we never
 *                     auto-jump to the report).
 *        * `report` — severity-grouped findings with copy buttons,
 *                     syntax highlighting, and per-finding
 *                     "Post inline comment" actions.
 *      The header carries a toggle between the two modes, the
 *      History panel, and the Prompt disclosure.
 *
 * Cached-report fast-path: on mount we call `aiReviewListRuns(prRef)`
 * and, if the newest persisted run targets the current PR head SHA
 * and has `status === "done"`, we render its **log** view — keeping
 * the user one click away from the report without forcing them into
 * it. The History panel can flip to any prior run; each row carries
 * both a "Log" and a "Report" action so the user can re-watch the
 * original streaming session even after the app has restarted.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, cn } from "@zen-tools/ui";
import {
  Brain,
  ListChecks,
  Play,
  RotateCw,
  ScrollText,
  Square,
} from "lucide-react";
import {
  prmasterTauri,
  prRefFor,
  type AiReviewEvent,
  type AiReviewFinding,
  type AiReviewReportResp,
  type AiReviewRunSummary,
  type EnrichedPullRequest,
  type PrDiff,
  type PrRef,
} from "../../lib/tauri";
import {
  aiReviewStore,
  ensureAiReviewSubscription,
  prKey,
  useAiReviewState,
} from "../../store/ai-review-store";
import { AiReviewLogPane } from "./AiReviewLogPane";
import { AiReviewMissingRepo } from "./AiReviewMissingRepo";
import { AiReviewModelPicker } from "./AiReviewModelPicker";
import { AiReviewReportView } from "./AiReviewReportView";

interface Props {
  /** The enriched PR row this review page is currently showing. */
  pr: EnrichedPullRequest;
}

/** What's currently loaded into the viewer (either the live run's
 *  in-memory state, or a historical run pulled from disk). */
interface LoadedRun {
  runId: string;
  events: AiReviewEvent[];
  findings: AiReviewFinding[];
  overallSummary: string;
  prompt: string;
  legacyHtml: string | null;
  model: string;
  costUsd: number | null;
  finishedAtMs: number | null;
  headSha: string;
}

/** Which body view is active when there's a loaded run. The user can
 *  flip between them via the header toggle; we never auto-flip. */
type ViewMode = "log" | "report";

export function PrAiReviewView({ pr }: Props) {
  const ref: PrRef = useMemo(() => prRefFor(pr.pr), [pr.pr]);
  const key = prKey(ref.owner, ref.repo, ref.number);
  const slot = useAiReviewState(key);

  const [headSha, setHeadSha] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [model, setModel] = useState<string>(() => readStoredModel());
  const [missingRepo, setMissingRepo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState<LoadedRun | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("log");
  const [history, setHistory] = useState<AiReviewRunSummary[]>([]);
  const [postingIds, setPostingIds] = useState<Set<string>>(new Set());
  const [postedIds, setPostedIds] = useState<Set<string>>(new Set());
  const subscribedRef = useRef(false);

  // Subscribe once globally to the Tauri event channel.
  useEffect(() => {
    if (subscribedRef.current) return;
    subscribedRef.current = true;
    void ensureAiReviewSubscription();
  }, []);

  // Resolve the head SHA for this PR — required to know whether a
  // cached review can be reused.
  useEffect(() => {
    let alive = true;
    setHeadSha(null);
    setDiffError(null);
    void (async () => {
      try {
        const diff: PrDiff = await prmasterTauri.getPrDiff(
          ref,
          pr.detail?.baseRefName ?? null,
          pr.detail?.headRefName ?? null,
        );
        if (!alive) return;
        setHeadSha(diff.headSha);
      } catch (e) {
        if (!alive) return;
        setDiffError(formatErr(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [pr.detail?.baseRefName, pr.detail?.headRefName, ref]);

  const refreshHistory = useCallback(async () => {
    try {
      const runs = await prmasterTauri.aiReviewListRuns(ref);
      setHistory(runs);
      aiReviewStore.setRuns(key, runs);
      return runs;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[ai-review] history fetch failed:", formatErr(e));
      return [];
    }
  }, [key, ref]);

  // On head-sha resolve: hydrate history and, if the newest run
  // targets the current head SHA, lazily load its **log view** (we
  // never auto-flip to the findings report — the user opts in via
  // the header toggle).
  useEffect(() => {
    if (!headSha) return;
    let alive = true;
    void (async () => {
      const runs = await refreshHistory();
      if (!alive) return;
      const cached = pickCachedRun(runs, headSha);
      if (cached) {
        try {
          const resp = await prmasterTauri.aiReviewGetReport(cached.run_id);
          if (!alive) return;
          setLoaded(reportRespToLoaded(cached.run_id, resp));
          setViewMode("log");
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("[ai-review] cached report fetch failed:", formatErr(e));
        }
      } else {
        setLoaded(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [headSha, refreshHistory]);

  // When a live run finishes, refresh history **and** silently load
  // the just-finished run into `loaded` — but keep `viewMode` on
  // "log" so the user stays on the streaming log they were watching.
  // Loading `loaded` is what lets the header surface a Log/Report
  // toggle: without it the only way back to the report would be the
  // History panel, which is overkill for the run that just ended.
  useEffect(() => {
    if (!headSha) return;
    if (slot.status !== "done") return;
    let alive = true;
    void (async () => {
      const runs = await refreshHistory();
      if (!alive) return;
      const cached = pickCachedRun(runs, headSha);
      if (!cached) return;
      try {
        const resp = await prmasterTauri.aiReviewGetReport(cached.run_id);
        if (!alive) return;
        setLoaded(reportRespToLoaded(cached.run_id, resp));
        setViewMode("log");
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          "[ai-review] post-finish report load failed:",
          formatErr(e),
        );
      }
    })();
    // Reset post-confirmation state for the new run.
    setPostedIds(new Set());
    setPostingIds(new Set());
    return () => {
      alive = false;
    };
  }, [headSha, refreshHistory, slot.status]);

  // If a live run exists in the registry (e.g. user navigated away and
  // back), replay its events into the store.
  useEffect(() => {
    if (!slot.liveRunId) return;
    let alive = true;
    void (async () => {
      try {
        const status = await prmasterTauri.aiReviewStatus(slot.liveRunId!);
        if (!alive || !status) return;
        aiReviewStore.replayStatus(
          key,
          slot.liveRunId!,
          status.status,
          status.events,
          status.report_path,
        );
      } catch {
        // ignore — the live event stream will recover the buffer
      }
    })();
    return () => {
      alive = false;
    };
  }, [key, slot.liveRunId]);

  const onStart = useCallback(async () => {
    if (!headSha) return;
    setBusy(true);
    setMissingRepo(null);
    try {
      const resp = await prmasterTauri.aiReviewStart({
        pr: ref,
        headSha,
        headBranch: pr.detail?.headRefName ?? null,
        baseBranch: pr.detail?.baseRefName ?? null,
        model: model || null,
      });
      writeStoredModel(model);
      aiReviewStore.startRun(key, resp.run_id);
      setLoaded(null);
      setViewMode("log");
    } catch (e) {
      const msg = formatErr(e);
      if (msg.toLowerCase().includes("local clone not registered")) {
        setMissingRepo(`${ref.owner}/${ref.repo}`);
      } else {
        aiReviewStore.appendEvent("__local__", {
          kind: "error",
          message: msg,
        });
      }
    } finally {
      setBusy(false);
    }
  }, [headSha, key, model, pr.detail?.baseRefName, pr.detail?.headRefName, ref]);

  const onCancel = useCallback(async () => {
    if (!slot.liveRunId) return;
    await prmasterTauri.aiReviewCancel(slot.liveRunId);
    aiReviewStore.markCancelled(slot.liveRunId);
  }, [slot.liveRunId]);

  const onPostFinding = useCallback(
    async (findingId: string, body: string) => {
      if (!loaded) return;
      if (postingIds.has(findingId) || postedIds.has(findingId)) return;
      setPostingIds((prev) => new Set(prev).add(findingId));
      try {
        await prmasterTauri.aiReviewPostFinding(loaded.runId, findingId, body);
        setPostedIds((prev) => new Set(prev).add(findingId));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[ai-review] post finding failed:", formatErr(e));
        // Re-throw so the card's submit handler can surface it (e.g.
        // keep the editor open with the user's draft intact instead
        // of silently collapsing into a stale "Posted" state).
        throw e;
      } finally {
        setPostingIds((prev) => {
          const next = new Set(prev);
          next.delete(findingId);
          return next;
        });
      }
    },
    [loaded, postedIds, postingIds],
  );

  const onLoadFindingDraft = useCallback(
    async (findingId: string): Promise<string> => {
      if (!loaded) return "";
      return await prmasterTauri.aiReviewPreviewFindingBody(
        loaded.runId,
        findingId,
      );
    },
    [loaded],
  );

  const loadRun = useCallback(
    async (runId: string, mode: ViewMode) => {
      try {
        const resp = await prmasterTauri.aiReviewGetReport(runId);
        setLoaded(reportRespToLoaded(runId, resp));
        setViewMode(mode);
        // New run loaded → reset session-local post tracking so the
        // user can re-post (idempotency is GitHub's problem; we just
        // don't pretend a previous run's posts apply here).
        setPostedIds(new Set());
        setPostingIds(new Set());
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[ai-review] open run failed:", formatErr(e));
      }
    },
    [],
  );

  /** History row → Open report. */
  const onSelectRunReport = useCallback(
    (runId: string) => void loadRun(runId, "report"),
    [loadRun],
  );

  /** History row → Open log replay. */
  const onSelectRunLog = useCallback(
    (runId: string) => void loadRun(runId, "log"),
    [loadRun],
  );

  /** "Show log" button inside the report view → flip back to the
   *  streaming log of the currently-loaded run. The page-header
   *  toggle does the same thing; this exists so the user doesn't
   *  have to reach for the header when they're already inside the
   *  report. */
  const onShowLogForLoaded = useCallback(() => {
    setViewMode("log");
  }, []);

  const onRerun = useCallback(() => {
    setLoaded(null);
    setViewMode("log");
    void onStart();
  }, [onStart]);

  if (missingRepo) {
    return (
      <AiReviewMissingRepo
        repo={missingRepo}
        onDismiss={() => setMissingRepo(null)}
      />
    );
  }

  const isLive =
    slot.liveRunId !== null &&
    slot.status !== "done" &&
    slot.status !== "error" &&
    slot.status !== "cancelled";

  // While a live run is in flight, prefer `slot.events` (which the
  // mpsc subscription pushes into in real time). After the run
  // finishes, `loaded.events` is a persisted snapshot of the same
  // list — using it lets the user replay any historical run via
  // the History panel without us having to restore registry state.
  const logEvents: AiReviewEvent[] = isLive
    ? slot.events
    : loaded
      ? loaded.events
      : slot.events;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <header className="flex shrink-0 items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Brain className="size-3.5 text-blue-500" />
          <span className="font-medium">AI Review</span>
          {headSha && (
            <span className="font-mono text-[10px] text-muted-foreground">
              head {headSha.slice(0, 12)}
            </span>
          )}
          {slot.status !== "idle" && (
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                statusBadgeClass(slot.status),
              )}
            >
              {slot.status}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Model picker is visible whenever a run isn't in flight,
              including when a previous report is loaded — so the user
              can pick a different model before clicking Re-run. The
              currently-selected model only takes effect on the *next*
              start; the model used for the loaded report is shown
              separately in the report header's meta strip. */}
          {!isLive && (
            <AiReviewModelPicker value={model} onChange={setModel} />
          )}
          {/* Log / Report segmented toggle — visible whenever a
              finished run is loaded (either just-finished from this
              session or pulled from history via the History panel).
              The body branches off `viewMode`; the toggle is the
              user's primary way to flip between the streaming log
              and the severity-grouped findings without leaving the
              tab. */}
          {!isLive && loaded && (
            <ViewModeToggle
              value={viewMode}
              onChange={setViewMode}
              hasFindings={loaded.findings.length > 0}
            />
          )}
          {isLive ? (
            <Button size="xs" variant="outline" onClick={onCancel}>
              <Square className="size-3" />
              Cancel
            </Button>
          ) : loaded ? (
            <Button
              size="xs"
              variant="outline"
              onClick={onRerun}
              disabled={!headSha || busy}
            >
              <RotateCw className="size-3" />
              Re-run
            </Button>
          ) : (
            <Button
              size="xs"
              variant="default"
              onClick={() => void onStart()}
              disabled={!headSha || busy}
            >
              <Play className="size-3" />
              {busy ? "Starting…" : "Start review"}
            </Button>
          )}
        </div>
      </header>

      {diffError && !headSha && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Failed to resolve PR head SHA: {diffError}
        </div>
      )}

      <div className="min-h-0 flex-1">
        {isLive ? (
          <AiReviewLogPane events={logEvents} />
        ) : loaded && viewMode === "report" ? (
          <AiReviewReportView
            findings={loaded.findings}
            overallSummary={loaded.overallSummary}
            model={loaded.model}
            costUsd={loaded.costUsd}
            finishedAtMs={loaded.finishedAtMs}
            headSha={loaded.headSha}
            prompt={loaded.prompt}
            legacyHtml={loaded.legacyHtml}
            history={history}
            currentRunId={loaded.runId}
            onSelectRun={onSelectRunReport}
            onSelectRunLog={onSelectRunLog}
            onShowLog={onShowLogForLoaded}
            onPostFinding={onPostFinding}
            onLoadFindingDraft={onLoadFindingDraft}
            postingIds={postingIds}
            postedIds={postedIds}
          />
        ) : loaded || logEvents.length > 0 ? (
          // Log mode: either a loaded run's persisted events, or
          // mid-session live events that haven't yet been promoted
          // into a `loaded` snapshot (very narrow race window
          // between `status === "done"` firing and the post-finish
          // effect resolving `aiReviewGetReport`).
          <AiReviewLogPane events={logEvents} />
        ) : (
          <PreRunHero
            costHint={history.length > 0 ? history[0] : null}
            history={history}
            onSelectReport={onSelectRunReport}
            onSelectLog={onSelectRunLog}
          />
        )}
      </div>
    </div>
  );
}

/** Two-button segmented toggle for the page header. The Report
 *  button is disabled with a tooltip when the run produced zero
 *  findings — there's nothing to render — but the user can still
 *  flip to the log to see what Claude did. */
function ViewModeToggle({
  value,
  onChange,
  hasFindings,
}: {
  value: ViewMode;
  onChange: (next: ViewMode) => void;
  hasFindings: boolean;
}) {
  return (
    <div className="inline-flex h-6 items-center rounded-md border border-border/60 bg-background/50 p-0.5 text-[10.5px]">
      <button
        type="button"
        onClick={() => onChange("log")}
        className={cn(
          "flex items-center gap-1 rounded px-2 py-0.5 transition-colors",
          value === "log"
            ? "bg-card text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={value === "log"}
      >
        <ScrollText className="size-3" />
        Log
      </button>
      <button
        type="button"
        onClick={() => onChange("report")}
        disabled={!hasFindings}
        className={cn(
          "flex items-center gap-1 rounded px-2 py-0.5 transition-colors",
          value === "report"
            ? "bg-card text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
          !hasFindings && "cursor-not-allowed opacity-50 hover:text-muted-foreground",
        )}
        aria-pressed={value === "report"}
        title={hasFindings ? "Show severity-grouped findings" : "No findings to show"}
      >
        <ListChecks className="size-3" />
        Report
      </button>
    </div>
  );
}

function reportRespToLoaded(
  runId: string,
  resp: AiReviewReportResp,
): LoadedRun {
  return {
    runId,
    events: resp.events ?? [],
    findings: resp.findings,
    overallSummary: resp.overall_summary,
    prompt: resp.prompt,
    legacyHtml: resp.html,
    model: resp.model,
    costUsd: resp.cost_usd,
    finishedAtMs: resp.finished_at_ms,
    headSha: resp.head_sha,
  };
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "running":
    case "starting":
      return "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400";
    case "done":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "error":
      return "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400";
    case "cancelled":
      return "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function PreRunHero({
  costHint,
  history,
  onSelectReport,
  onSelectLog,
}: {
  costHint: AiReviewRunSummary | null;
  history: AiReviewRunSummary[];
  onSelectReport: (runId: string) => void;
  onSelectLog: (runId: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-4">
      <div className="grid max-w-md gap-3 rounded-md border bg-card/40 p-5 text-center text-xs text-muted-foreground">
        <Brain className="mx-auto size-6 text-blue-500" />
        <div className="text-sm font-medium text-foreground">
          Run an AI code review
        </div>
        <p>
          Spins up a detached worktree at the PR head commit, runs Claude
          with read-only tools, and surfaces a severity-grouped report
          you can post directly as inline review comments.
        </p>
        {costHint && (
          <p className="text-[10px]">
            Last run on this PR cost {fmtCost(costHint.cost_usd)}.
          </p>
        )}
      </div>
      {history.length > 0 && (
        <div className="w-full max-w-md rounded-md border bg-background/40">
          <div className="border-b bg-muted/40 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Past reviews
          </div>
          <ul className="divide-y divide-border/40">
            {history.slice(0, 5).map((run) => (
              <li
                key={run.run_id}
                className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] hover:bg-muted/30"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="font-mono text-muted-foreground">
                    {run.head_sha.slice(0, 8)}
                  </span>
                  <span className="font-medium text-foreground">
                    {run.status}
                  </span>
                  <span className="text-muted-foreground">
                    {fmtCost(run.cost_usd)}
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => onSelectLog(run.run_id)}
                    className="h-5 px-2 text-[10px]"
                    title="Replay this run's streaming log"
                  >
                    Log
                  </Button>
                  {run.status === "done" && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => onSelectReport(run.run_id)}
                      className="h-5 px-2 text-[10px]"
                      title="Open this run's findings report"
                    >
                      Report
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function fmtCost(usd: number | null): string {
  if (usd == null) return "—";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function pickCachedRun(
  runs: AiReviewRunSummary[],
  headSha: string,
): AiReviewRunSummary | null {
  for (const r of runs) {
    if (r.head_sha === headSha && r.status === "done") return r;
  }
  return null;
}

function formatErr(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

const MODEL_KEY = "prmaster.aiReview.model";

function readStoredModel(): string {
  try {
    return localStorage.getItem(MODEL_KEY) ?? "sonnet";
  } catch {
    return "sonnet";
  }
}

function writeStoredModel(value: string): void {
  try {
    localStorage.setItem(MODEL_KEY, value);
  } catch {
    /* ignore */
  }
}
