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
  ChevronDown,
  ChevronUp,
  Code2,
  FileSearch,
  History,
  ListChecks,
  ScrollText,
  Sparkles,
} from "lucide-react";
import type { AiReviewFinding, AiReviewRunSummary } from "../../lib/tauri";
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
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;
type SeverityBucket = (typeof SEVERITY_ORDER)[number];

export function AiReviewReportView(props: Props) {
  const grouped = useMemo(() => groupBySeverity(props.findings), [
    props.findings,
  ]);
  const totalCount = props.findings.length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      <ReportHeader
        overallSummary={props.overallSummary}
        changeSummary={props.changeSummary}
        model={props.model}
        costUsd={props.costUsd}
        finishedAtMs={props.finishedAtMs}
        headSha={props.headSha}
        totalCount={totalCount}
        prompt={props.prompt}
        legacyHtml={props.legacyHtml}
        history={props.history}
        currentRunId={props.currentRunId}
        onSelectRun={props.onSelectRun}
        onSelectRunLog={props.onSelectRunLog}
        onShowLog={props.onShowLog}
      />
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {totalCount === 0 ? (
          <EmptyFindings overallSummary={props.overallSummary} />
        ) : (
          <div className="flex flex-col gap-3">
            {SEVERITY_ORDER.map((sev) => {
              const items = grouped.get(sev);
              if (!items || items.length === 0) return null;
              return (
                <SeveritySection key={sev} severity={sev} count={items.length}>
                  <div className="flex flex-col gap-1.5">
                    {items.map((f) => (
                      <AiReviewFindingCard
                        key={f.id}
                        finding={f}
                        onPost={props.onPostFinding}
                        onLoadDraft={props.onLoadFindingDraft}
                        posting={props.postingIds.has(f.id)}
                        posted={props.postedIds.has(f.id)}
                      />
                    ))}
                  </div>
                </SeveritySection>
              );
            })}
          </div>
        )}
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
  totalCount,
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
  totalCount: number;
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
  const togglePanel = (next: "history" | "prompt" | "raw") =>
    setOpenPanel((prev) => (prev === next ? null : next));

  return (
    <header className="shrink-0 rounded-md border bg-card/40 px-2.5 py-1.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {overallSummary && (
            <p className="text-[12px] font-medium leading-snug text-foreground">
              <Sparkles className="mr-1 inline-block size-3 align-[-2px] text-blue-500" />
              {overallSummary}
            </p>
          )}
          {changeSummary.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] leading-snug text-muted-foreground">
              {changeSummary.map((item, i) => (
                <li key={`${i}-${item}`}>{item}</li>
              ))}
            </ul>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
            <span className="font-mono">head {headSha.slice(0, 12)}</span>
            <span>·</span>
            <span>
              {totalCount} finding{totalCount === 1 ? "" : "s"}
            </span>
            <span>·</span>
            <span className="font-mono">{model}</span>
            {costUsd != null && (
              <>
                <span>·</span>
                <span>{fmtCost(costUsd)}</span>
              </>
            )}
            {finishedAtMs && (
              <>
                <span>·</span>
                <span>{fmtTime(finishedAtMs)}</span>
              </>
            )}
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
      {openPanel === "history" && (
        <HistoryPanel
          history={history}
          currentRunId={currentRunId}
          onSelectReport={onSelectRun}
          onSelectLog={onSelectRunLog}
        />
      )}
      {openPanel === "prompt" && <PromptPanel prompt={prompt} />}
      {openPanel === "raw" && legacyHtml && <RawHtmlPanel html={legacyHtml} />}
    </header>
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
  onSelectReport,
  onSelectLog,
}: {
  history: AiReviewRunSummary[];
  currentRunId: string | null;
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
                  {run.head_sha.slice(0, 8)}
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
          "mb-1.5 flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-[0.14em]",
          severityHeadingColor(severity),
        )}
      >
        <span>{severity}</span>
        <span className="rounded-full bg-muted px-1.5 py-px text-[9px] font-mono text-muted-foreground">
          {count}
        </span>
      </h2>
      {children}
    </section>
  );
}

function EmptyFindings({ overallSummary }: { overallSummary: string }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center">
      <div className="grid max-w-md gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-5 text-center">
        <Sparkles className="mx-auto size-5 text-emerald-500" />
        <div className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
          No findings
        </div>
        <p className="text-[11px] text-muted-foreground">
          {overallSummary || "Claude reviewed the diff and didn't surface anything actionable."}
        </p>
      </div>
    </div>
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
