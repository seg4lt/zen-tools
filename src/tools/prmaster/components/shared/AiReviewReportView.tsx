/**
 * Native React renderer for an AI review report.
 *
 * Replaces the iframe-based renderer that initially shipped: we now
 * drive the UI from the parsed `findings: AiReviewFinding[]` array
 * so we get full control over snippet presentation (line numbers,
 * syntax highlighting, copy buttons), action wiring (per-finding
 * "Post inline comment" goes through the existing
 * `prmaster_add_review_comment` path), and progressive disclosure
 * (View prompt, history of past runs).
 *
 * The legacy HTML report is still surfaced behind a "Raw HTML"
 * toggle for runs the user generated before this renderer landed.
 */

import { useMemo, useState } from "react";
import { Button, cn } from "@zen-tools/ui";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Code2,
  FileSearch,
  History,
  ListChecks,
  Loader2,
  MessageSquareText,
  Send,
  ScrollText,
  Sparkles,
} from "lucide-react";
import type {
  AiReviewClarificationTurn,
  AiReviewFinding,
  AiReviewPreviousFindingResult,
  AiReviewRunSummary,
} from "../../lib/tauri";
import { AiReviewFindingCard } from "./AiReviewFindingCard";

interface Props {
  /** Findings to render, in author-preferred order. */
  findings: AiReviewFinding[];
  /** One-sentence overall verdict from the run. */
  overallSummary: string;
  /** High-level bullets summarizing what changed in the PR. */
  changeSummary: string[];
  /** Resolved Claude model the run used. */
  model: string;
  /** Reported cost in USD. */
  costUsd: number | null;
  /** When the run finished (UNIX millis). */
  finishedAtMs: number | null;
  /** Head SHA the review ran against. */
  headSha: string;
  /** Current PR head SHA, used to flag historical reports. */
  currentHeadSha: string;
  /** Prompt sent to Claude, for the audit disclosure. */
  prompt: string;
  /** Legacy HTML body (older runs only). */
  legacyHtml: string | null;
  /** Past runs index for this PR — newest first. */
  history: AiReviewRunSummary[];
  /** Currently displayed run id (so we can mark it in the history). */
  currentRunId: string | null;
  /** User wants to **open the report** for a specific past run. */
  onSelectRun: (runId: string) => void;
  /** User wants to **open the streaming log** for a specific past run.
   *  The host loads that run's events and flips PrAiReviewView to
   *  log mode. Lets the user re-watch any session that ever ran on
   *  this PR, even after the app has restarted. */
  onSelectRunLog: (runId: string) => void;
  /** User clicked the header toggle to switch to the streaming log
   *  for the currently-displayed run. */
  onShowLog: () => void;
  /** User clicked Post in the inline editor for a finding. The body
   *  is whatever they finally chose to post — possibly edited from
   *  the default. */
  onPostFinding: (findingId: string, body: string) => Promise<void> | void;
  /** Fetch the default formatted body for a finding so the inline
   *  editor can pre-fill its textarea. Resolved by the backend's
   *  `prmaster_ai_review_preview_finding_body` command. */
  onLoadFindingDraft: (findingId: string) => Promise<string>;
  /** Set of finding ids currently posting (to disable the button). */
  postingIds: Set<string>;
  /** Set of finding ids that have been successfully posted in this session. */
  postedIds: Set<string>;
  clarifications: AiReviewClarificationTurn[];
  previousFindings: AiReviewPreviousFindingResult[];
  canAsk: boolean;
  asking: boolean;
  askError: string | null;
  onAsk: (question: string) => Promise<void>;
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;
type SeverityBucket = (typeof SEVERITY_ORDER)[number];

export function AiReviewReportView(props: Props) {
  const grouped = useMemo(() => groupBySeverity(props.findings), [
    props.findings,
  ]);
  const totalCount = props.findings.length;
  const isOutdated = props.headSha !== props.currentHeadSha;
  const severityCounts = useMemo(
    () =>
      Object.fromEntries(
        SEVERITY_ORDER.map((severity) => [
          severity,
          grouped.get(severity)?.length ?? 0,
        ]),
      ) as Record<SeverityBucket, number>,
    [grouped],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      <ReportHeader
        overallSummary={props.overallSummary}
        changeSummary={props.changeSummary}
        model={props.model}
        costUsd={props.costUsd}
        finishedAtMs={props.finishedAtMs}
        headSha={props.headSha}
        currentHeadSha={props.currentHeadSha}
        totalCount={totalCount}
        severityCounts={severityCounts}
        prompt={props.prompt}
        legacyHtml={props.legacyHtml}
        history={props.history}
        currentRunId={props.currentRunId}
        onSelectRun={props.onSelectRun}
        onSelectRunLog={props.onSelectRunLog}
        onShowLog={props.onShowLog}
      />
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-1 pb-4 pr-2">
        {props.previousFindings.length > 0 && (
          <PreviousFindings results={props.previousFindings} />
        )}
        {totalCount === 0 ? (
          <EmptyFindings overallSummary={props.overallSummary} />
        ) : (
          <div className="flex flex-col gap-5">
            {SEVERITY_ORDER.map((sev) => {
              const items = grouped.get(sev);
              if (!items || items.length === 0) return null;
              return (
                <SeveritySection key={sev} severity={sev} count={items.length}>
                  <div className="flex flex-col gap-2.5">
                    {items.map((f) => (
                      <AiReviewFindingCard
                        key={f.id}
                        finding={f}
                        onPost={props.onPostFinding}
                        onLoadDraft={props.onLoadFindingDraft}
                        posting={props.postingIds.has(f.id)}
                        posted={props.postedIds.has(f.id)}
                        reviewOutdated={isOutdated}
                      />
                    ))}
                  </div>
                </SeveritySection>
              );
            })}
          </div>
        )}
        <ClarificationThread
          turns={props.clarifications}
          canAsk={props.canAsk}
          asking={props.asking}
          error={props.askError}
          onAsk={props.onAsk}
        />
      </div>
    </div>
  );
}

function ReportHeader({
  overallSummary,
  changeSummary,
  model,
  costUsd,
  finishedAtMs,
  headSha,
  currentHeadSha,
  totalCount,
  severityCounts,
  prompt,
  legacyHtml,
  history,
  currentRunId,
  onSelectRun,
  onSelectRunLog,
  onShowLog,
}: {
  overallSummary: string;
  changeSummary: string[];
  model: string;
  costUsd: number | null;
  finishedAtMs: number | null;
  headSha: string;
  currentHeadSha: string;
  totalCount: number;
  severityCounts: Record<SeverityBucket, number>;
  prompt: string;
  legacyHtml: string | null;
  history: AiReviewRunSummary[];
  currentRunId: string | null;
  onSelectRun: (runId: string) => void;
  onSelectRunLog: (runId: string) => void;
  onShowLog: () => void;
}) {
  const [openPanel, setOpenPanel] = useState<
    "history" | "prompt" | "raw" | null
  >(null);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const isOutdated = headSha !== currentHeadSha;
  const togglePanel = (next: "history" | "prompt" | "raw") =>
    setOpenPanel((prev) => (prev === next ? null : next));

  return (
    <header className="shrink-0 rounded-lg border bg-card/70 px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className={cn(
            "flex size-7 items-center justify-center rounded-md border",
            totalCount === 0
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
          )}>
            {totalCount === 0 ? <CheckCircle2 className="size-4" /> : <Sparkles className="size-4" />}
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Review outcome
            </div>
            <div className="text-xs font-medium text-foreground">
              {totalCount === 0
                ? "No actionable findings"
                : `${totalCount} actionable finding${totalCount === 1 ? "" : "s"}`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            onClick={onShowLog}
            className="h-5 gap-1 px-1.5 text-[10px]"
            title="Switch back to the streaming log of this run"
          >
            <ScrollText className="size-2.5" />
            Log
          </Button>
          <DisclosureButton
            label="Summary"
            icon={<ListChecks className="size-2.5" />}
            active={summaryExpanded}
            onClick={() => setSummaryExpanded((open) => !open)}
          />
          <DisclosureButton
            label="History"
            icon={<History className="size-2.5" />}
            count={history.length || undefined}
            active={openPanel === "history"}
            onClick={() => togglePanel("history")}
          />
          <DisclosureButton
            label="Prompt"
            icon={<FileSearch className="size-2.5" />}
            active={openPanel === "prompt"}
            onClick={() => togglePanel("prompt")}
          />
          {legacyHtml && (
            <DisclosureButton
              label="HTML"
              icon={<Code2 className="size-2.5" />}
              active={openPanel === "raw"}
              onClick={() => togglePanel("raw")}
            />
          )}
        </div>
      </div>
      {isOutdated && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            This report reviewed <code className="font-mono">{headSha.slice(0, 8)}</code>,
            but the PR is now at <code className="font-mono">{currentHeadSha.slice(0, 8)}</code>.
            Findings and inline anchors may be outdated.
          </span>
        </div>
      )}
      <p className={cn(
        "mt-3 text-sm font-medium leading-relaxed text-foreground",
        !summaryExpanded && "line-clamp-1",
      )}>
        {overallSummary || (totalCount === 0
          ? "The review completed without identifying an actionable defect."
          : "The review identified issues that need attention.")}
      </p>
      {summaryExpanded && changeSummary.length > 0 && (
        <div className="mt-3 rounded-md border border-border/60 bg-background/45 px-3 py-2.5">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            What changed
          </div>
          <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-foreground/80 marker:text-muted-foreground">
            {changeSummary.map((item, i) => (
              <li key={`${i}-${item}`}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <MetaPill mono>head {headSha.slice(0, 12)}</MetaPill>
        <MetaPill mono>{model}</MetaPill>
        {costUsd != null && <MetaPill>{fmtCost(costUsd)}</MetaPill>}
        {finishedAtMs && <MetaPill>{fmtTime(finishedAtMs)}</MetaPill>}
        {totalCount > 0 && SEVERITY_ORDER.map((severity) => {
          const count = severityCounts[severity];
          if (count === 0) return null;
          return (
            <span
              key={severity}
              className={cn(
                "rounded-full border px-2 py-1 text-[10px] font-semibold capitalize",
                severityChipClass(severity),
              )}
            >
              {severity} {count}
            </span>
          );
        })}
      </div>
      {openPanel === "history" && (
        <HistoryPanel
          history={history}
          currentRunId={currentRunId}
          currentHeadSha={currentHeadSha}
          onSelectReport={onSelectRun}
          onSelectLog={onSelectRunLog}
        />
      )}
      {openPanel === "prompt" && <PromptPanel prompt={prompt} />}
      {openPanel === "raw" && legacyHtml && <RawHtmlPanel html={legacyHtml} />}
    </header>
  );
}

function MetaPill({
  children,
  mono = false,
}: {
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <span
      className={cn(
        "rounded-full border border-border/60 bg-muted/35 px-2 py-1 text-[10px] text-muted-foreground",
        mono && "font-mono",
      )}
    >
      {children}
    </span>
  );
}

function DisclosureButton({
  label,
  icon,
  active,
  count,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <Button
      size="xs"
      variant={active ? "default" : "outline"}
      onClick={onClick}
      className="h-5 gap-1 px-1.5 text-[10px]"
    >
      {icon}
      {label}
      {count != null && (
        <span className="ml-0.5 rounded-full bg-muted px-1 py-px text-[9px] font-mono text-muted-foreground">
          {count}
        </span>
      )}
      {active ? (
        <ChevronUp className="size-2.5" />
      ) : (
        <ChevronDown className="size-2.5" />
      )}
    </Button>
  );
}

function HistoryPanel({
  history,
  currentRunId,
  currentHeadSha,
  onSelectReport,
  onSelectLog,
}: {
  history: AiReviewRunSummary[];
  currentRunId: string | null;
  currentHeadSha: string;
  /** Open the **report** for this run (severity-grouped findings). */
  onSelectReport: (runId: string) => void;
  /** Open the **streaming log** for this run (the original session
   *  events — thoughts, tool calls, results — replayed from disk). */
  onSelectLog: (runId: string) => void;
}) {
  if (history.length === 0) {
    return (
      <div className="mt-3 rounded-md border bg-muted/30 p-3 text-center text-[11px] text-muted-foreground">
        No past reviews on this PR yet.
      </div>
    );
  }
  return (
    <div className="mt-3 max-h-60 overflow-y-auto rounded-md border bg-background/40">
      <table className="w-full table-fixed text-[11px]">
        <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="w-32 px-2 py-1.5 text-left font-medium">When</th>
            <th className="w-20 px-2 py-1.5 text-left font-medium">Status</th>
            <th className="w-24 px-2 py-1.5 text-left font-medium">Model</th>
            <th className="w-24 px-2 py-1.5 text-left font-medium">Head</th>
            <th className="w-16 px-2 py-1.5 text-left font-medium">Cost</th>
            <th className="w-32 px-2 py-1.5"></th>
          </tr>
        </thead>
        <tbody>
          {history.map((run) => {
            const active = run.run_id === currentRunId;
            return (
              <tr
                key={run.run_id}
                className={cn(
                  "border-t border-border/40 transition-colors hover:bg-muted/40",
                  active && "bg-blue-500/10",
                )}
              >
                <td className="px-2 py-1.5 text-foreground">
                  {fmtTime(run.started_at_ms)}
                </td>
                <td className="px-2 py-1.5">
                  <span className={cn("font-medium", historyStatusColor(run.status))}>
                    {run.status}
                  </span>
                </td>
                <td className="px-2 py-1.5 font-mono text-muted-foreground">
                  {run.model}
                </td>
                <td className="px-2 py-1.5 font-mono text-muted-foreground">
                  <div className="flex flex-col gap-0.5">
                    <span>{run.head_sha.slice(0, 8)}</span>
                    <span className={cn(
                      "font-sans text-[9px]",
                      run.head_sha === currentHeadSha
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-amber-600 dark:text-amber-400",
                    )}>
                      {run.head_sha === currentHeadSha ? "Current commit" : "Older commit"}
                    </span>
                  </div>
                </td>
                <td className="px-2 py-1.5 text-muted-foreground">
                  {fmtCost(run.cost_usd)}
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center justify-end gap-0.5">
                    {active ? (
                      <span className="px-1.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                        Current
                      </span>
                    ) : (
                      <>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => onSelectLog(run.run_id)}
                          className="h-5 gap-1 px-1.5 text-[10px]"
                          title="Replay this run's streaming log"
                        >
                          <ScrollText className="size-3" />
                          Log
                        </Button>
                        {run.status === "done" && (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => onSelectReport(run.run_id)}
                            className="h-5 gap-1 px-1.5 text-[10px]"
                            title="Open this run's findings report"
                          >
                            <ListChecks className="size-3" />
                            Report
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PromptPanel({ prompt }: { prompt: string }) {
  if (!prompt) {
    return (
      <div className="mt-3 rounded-md border bg-muted/30 p-3 text-center text-[11px] text-muted-foreground">
        Prompt was not persisted for this run.
      </div>
    );
  }
  return (
    <div className="mt-3 max-h-72 overflow-y-auto rounded-md border bg-[var(--code-bg,_#0a0c10)] p-3">
      <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-foreground/90">
        {prompt}
      </pre>
    </div>
  );
}

function RawHtmlPanel({ html }: { html: string }) {
  return (
    <iframe
      title="Legacy AI review report"
      sandbox="allow-same-origin"
      srcDoc={html}
      className="mt-3 block h-72 w-full rounded-md border bg-background"
    />
  );
}

function SeveritySection({
  severity,
  count,
  children,
}: {
  severity: SeverityBucket;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2
        className={cn(
          "mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em]",
          severityHeadingColor(severity),
        )}
      >
        <span>{severity}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
          {count}
        </span>
      </h2>
      {children}
    </section>
  );
}

function EmptyFindings({ overallSummary }: { overallSummary: string }) {
  return (
    <div className="flex min-h-48 items-center justify-center">
      <div className="grid max-w-lg gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-8 text-center shadow-sm">
        <CheckCircle2 className="mx-auto size-7 text-emerald-500" />
        <div className="text-base font-semibold text-emerald-700 dark:text-emerald-400">
          Review complete — no actionable findings
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {overallSummary || "Claude reviewed the diff and didn't surface anything actionable."}
        </p>
      </div>
    </div>
  );
}

function PreviousFindings({
  results,
}: {
  results: AiReviewPreviousFindingResult[];
}) {
  const labels: Record<string, string> = {
    fixed: "Fixed",
    still_present: "Still present",
    cannot_verify: "Cannot verify",
  };
  return (
    <section className="rounded-lg border bg-card/45 p-3">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
        Previous findings
      </div>
      <div className="space-y-2">
        {results.map((result) => (
          <div
            key={result.finding_id}
            className="rounded-md border border-border/60 bg-background/45 px-3 py-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                  result.status === "fixed" &&
                    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                  result.status === "still_present" &&
                    "border-destructive/30 bg-destructive/10 text-destructive",
                  result.status === "cannot_verify" &&
                    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
                )}
              >
                {labels[result.status] ?? result.status}
              </span>
              <span className="text-xs font-medium">
                {result.title || result.finding_id}
              </span>
              {result.path && (
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {result.path}{result.line ? `:${result.line}` : ""}
                </span>
              )}
            </div>
            {result.explanation && (
              <p className="mt-1.5 text-xs leading-relaxed text-foreground/80">
                {result.explanation}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ClarificationThread({
  turns,
  canAsk,
  asking,
  error,
  onAsk,
}: {
  turns: AiReviewClarificationTurn[];
  canAsk: boolean;
  asking: boolean;
  error: string | null;
  onAsk: (question: string) => Promise<void>;
}) {
  const [question, setQuestion] = useState("");
  const submit = async () => {
    const trimmed = question.trim();
    if (!trimmed || asking || !canAsk) return;
    try {
      await onAsk(trimmed);
      setQuestion("");
    } catch {
      // Keep the question intact for retry; the parent supplies the error.
    }
  };

  return (
    <section className="rounded-lg border bg-card/45 p-3">
      <div className="mb-3 flex items-center gap-2">
        <MessageSquareText className="size-3.5 text-blue-500" />
        <div>
          <div className="text-xs font-semibold">Ask about this review</div>
          <div className="text-[10px] text-muted-foreground">
            Continue the original review session without running another full review.
          </div>
        </div>
      </div>
      {turns.length > 0 && (
        <div className="mb-3 space-y-3">
          {turns.map((turn) => (
            <div key={turn.id} className="space-y-2">
              <div className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-xs leading-relaxed text-primary-foreground">
                {turn.question}
              </div>
              <div className="max-w-[92%] whitespace-pre-wrap rounded-lg border bg-background/70 px-3 py-2 text-xs leading-relaxed text-foreground/85">
                {turn.answer}
              </div>
            </div>
          ))}
        </div>
      )}
      {asking && (
        <div className="mb-3 space-y-2">
          {question.trim() && (
            <div className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-xs leading-relaxed text-primary-foreground">
              {question.trim()}
            </div>
          )}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Investigating…
          </div>
        </div>
      )}
      {error && (
        <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}
      {canAsk ? (
        <div className="flex items-end gap-2">
          <textarea
            rows={2}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
              }
            }}
            disabled={asking}
            placeholder="Ask a clarifying question… (⌘+Enter to send)"
            className="min-h-16 flex-1 resize-y rounded-md border bg-background px-3 py-2 text-xs outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/30"
          />
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={asking || question.trim().length === 0}
          >
            {asking ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
            Ask
          </Button>
        </div>
      ) : (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Follow-up questions are unavailable for reviews created before session support.
        </div>
      )}
    </section>
  );
}

function groupBySeverity(
  findings: AiReviewFinding[],
): Map<SeverityBucket, AiReviewFinding[]> {
  const out = new Map<SeverityBucket, AiReviewFinding[]>();
  for (const sev of SEVERITY_ORDER) out.set(sev, []);
  for (const f of findings) {
    const key = (
      ["critical", "high", "medium", "low"].includes(
        (f.severity ?? "").toLowerCase(),
      )
        ? (f.severity as SeverityBucket).toLowerCase()
        : "low"
    ) as SeverityBucket;
    out.get(key)!.push(f);
  }
  return out;
}

function severityHeadingColor(sev: SeverityBucket): string {
  switch (sev) {
    case "critical":
      return "text-red-600 dark:text-red-400";
    case "high":
      return "text-amber-600 dark:text-amber-400";
    case "medium":
      return "text-blue-600 dark:text-blue-400";
    case "low":
      return "text-emerald-600 dark:text-emerald-400";
  }
}

function severityChipClass(sev: SeverityBucket): string {
  switch (sev) {
    case "critical":
      return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400";
    case "high":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "medium":
      return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400";
    case "low":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  }
}

function historyStatusColor(status: string): string {
  switch (status) {
    case "done":
      return "text-emerald-600 dark:text-emerald-400";
    case "running":
    case "starting":
      return "text-blue-600 dark:text-blue-400";
    case "error":
      return "text-red-600 dark:text-red-400";
    case "cancelled":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-muted-foreground";
  }
}

function fmtCost(usd: number | null): string {
  if (usd == null) return "—";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
