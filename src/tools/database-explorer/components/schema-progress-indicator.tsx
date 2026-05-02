/**
 * Floating progress chip for schema-cache work.
 *
 * Subscribes to the singleton job store in `lib/schema-progress.ts`
 * and renders one row per active job. Position: bottom-right of the
 * editor area (the parent supplies layout). Hides itself entirely
 * when no jobs are active.
 *
 * Styling notes:
 *   - User-triggered (`describe`) jobs render prominently with the
 *     current table name and `n/N` counter.
 *   - Backend catalog loads (`catalog`) show a one-liner: "Loading
 *     catalog…".
 *   - Background refreshes (`background`) get a subdued row so they
 *     never dominate the screen — they fire on every keystroke if the
 *     user is exploring a stale schema.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  awaitProgressSubscribed,
  readJobs,
  subscribeProgress,
} from "../lib/schema-progress";
import type { SchemaCacheProgressEvent } from "../lib/tauri";

export function SchemaProgressIndicator() {
  const [jobs, setJobs] = useState<SchemaCacheProgressEvent[]>(() => readJobs());

  useEffect(() => {
    // Kick the listener registration as soon as the indicator mounts —
    // independent of any subsequent `subscribeProgress` call — so a
    // catalog/refresh fired in the very first frames of the editor
    // doesn't beat the listener.
    void awaitProgressSubscribed();
    const unsub = subscribeProgress(() => setJobs(readJobs()));
    return unsub;
  }, []);

  // Background-refresh jobs are explicitly "subtle by design" — they
  // fire on every stale-cache hit and aren't user-triggered, so we
  // only surface them while *actively running*. Terminal states get
  // hidden (errors are already non-fatal: the editor still has the
  // previously-cached data, and the backend logs a `tracing::warn!`).
  // We also collapse all in-flight background jobs into a single
  // aggregated chip so the user doesn't see a stack of identical
  // "Refreshing cache" rows when several schemas auto-load at once.
  const visible = useMemo(() => {
    const out: SchemaCacheProgressEvent[] = [];
    const inFlightBackground: SchemaCacheProgressEvent[] = [];
    for (const job of jobs) {
      if (job.kind === "background") {
        if (job.state === "started" || job.state === "progress") {
          inFlightBackground.push(job);
        }
        // Drop background `done`/`error` entirely — see comment above.
        continue;
      }
      out.push(job);
    }
    if (inFlightBackground.length > 0) {
      out.push(aggregateBackground(inFlightBackground));
    }
    return out;
  }, [jobs]);

  if (visible.length === 0) return null;

  return (
    <div
      // Pointer-events-none on the outer container so users can still
      // click through the (invisible) padding around the chips. Each
      // chip re-enables events on itself.
      className="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col gap-1.5"
      role="status"
      aria-live="polite"
    >
      {visible.map((job) => (
        <ProgressChip key={job.jobId} job={job} />
      ))}
    </div>
  );
}

/**
 * Fold N concurrent background jobs into a single chip whose
 * total/current sums every contributor. Carries one of the
 * job ids so React's `key` is stable enough to avoid remount churn
 * across renders.
 */
function aggregateBackground(
  jobs: SchemaCacheProgressEvent[],
): SchemaCacheProgressEvent {
  const total = jobs.reduce((s, j) => s + j.total, 0);
  const current = jobs.reduce((s, j) => s + j.current, 0);
  // Sort to keep the chosen jobId stable across renders.
  const ids = jobs.map((j) => j.jobId).sort();
  const head = jobs.find((j) => j.jobId === ids[0]) ?? jobs[0];
  const currentItem =
    jobs.length > 1 ? `${jobs.length} schemas` : head.currentItem;
  return {
    ...head,
    jobId: `background-aggregate`,
    total,
    current,
    currentItem,
  };
}

function ProgressChip({ job }: { job: SchemaCacheProgressEvent }) {
  const subdued = job.kind === "background";
  const baseClasses = subdued
    ? "border-border/40 bg-background/80 text-xs text-muted-foreground"
    : "border-border/60 bg-background text-xs text-foreground";

  return (
    <div
      className={`pointer-events-auto flex min-w-[220px] max-w-[360px] items-center gap-2 rounded-md border px-3 py-1.5 shadow-md backdrop-blur ${baseClasses}`}
    >
      <Icon job={job} subdued={subdued} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium">{title(job)}</span>
          {job.total > 1 ? (
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {Math.min(job.current, job.total)}/{job.total}
            </span>
          ) : null}
        </div>
        {job.currentItem ? (
          <div className="truncate text-muted-foreground">
            {job.currentItem}
          </div>
        ) : null}
        {job.message && job.state === "error" ? (
          <div className="truncate text-destructive">{job.message}</div>
        ) : null}
        {job.state === "progress" && job.total > 1 ? (
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-[width] duration-150"
              style={{
                width: `${Math.min(100, (job.current / job.total) * 100)}%`,
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Icon({
  job,
  subdued,
}: {
  job: SchemaCacheProgressEvent;
  subdued: boolean;
}) {
  if (job.state === "error") {
    return <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />;
  }
  if (job.state === "done") {
    return (
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
    );
  }
  return (
    <Loader2
      className={`h-3.5 w-3.5 shrink-0 animate-spin ${
        subdued ? "text-muted-foreground" : "text-primary"
      }`}
    />
  );
}

function title(job: SchemaCacheProgressEvent): string {
  switch (job.kind) {
    case "catalog":
      return job.state === "done"
        ? "Catalog loaded"
        : job.state === "error"
          ? "Catalog load failed"
          : "Loading catalog…";
    case "describe":
      return job.state === "done"
        ? "Reindex complete"
        : job.state === "error"
          ? "Reindex failed"
          : "Indexing schema";
    case "background":
      return job.state === "done"
        ? "Refresh complete"
        : job.state === "error"
          ? "Refresh failed"
          : "Refreshing cache";
  }
}
