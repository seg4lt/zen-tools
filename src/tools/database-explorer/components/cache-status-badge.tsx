/**
 * Always-on cache-status badge for the run toolbar.
 *
 * The floating progress chip (`SchemaProgressIndicator`) is great when
 * something is happening, but it disappears the moment work ends —
 * which leaves the user wondering whether anything is being indexed at
 * all. This badge is the opposite: it's **always visible** while a DB
 * connection is live, and it shows three pieces of information at a
 * glance:
 *
 *   - **Catalog size** — how many relations the editor knows about
 *     (from `db_list_all_tables`).
 *   - **Indexed count** — how many of them have full column
 *     descriptions cached.
 *   - **Active job** — when a `schema-cache-progress` job is in
 *     flight, the badge expands inline to show "Indexing 5/50
 *     public.metrics" with a thin progress bar.
 *
 * Mounted in `RunToolbar`, so it's pinned at the top of the editor
 * area regardless of viewport size or whether other panels are
 * collapsed.
 */

import { useEffect, useMemo, useState } from "react";
import { Database, Loader2 } from "lucide-react";
import {
  countCachedTables,
  readCatalog,
  subscribe as subscribeSchemaCache,
  subscribeCatalog,
} from "../lib/schema-cache";
import {
  awaitProgressSubscribed,
  readJobs,
  subscribeProgress,
} from "../lib/schema-progress";
import { useDbExplorerStore } from "../store/db-explorer-store";
import type { SchemaCacheProgressEvent } from "../lib/tauri";

export function CacheStatusBadge() {
  const { state } = useDbExplorerStore();
  const id = state.activeConnectionId;
  const status = id ? state.status[id] : undefined;
  const isConnected = status === "connected";

  // Active database resolves the same way the editor does: prefer the
  // user-selected DB, otherwise fall back to the connection's
  // configured one.
  const connection = useMemo(
    () => (id ? state.connections.find((c) => c.id === id) ?? null : null),
    [id, state.connections],
  );
  const database = id
    ? state.activeDbByConnection[id] ?? connection?.database ?? null
    : null;

  // Keep our local view of the catalog + cache + jobs in sync with the
  // module-scope stores. Three subscriptions; one render path.
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [, setCacheVersion] = useState(0);
  const [jobs, setJobs] = useState<SchemaCacheProgressEvent[]>(() => readJobs());

  useEffect(() => {
    void awaitProgressSubscribed();
    const unsubCatalog = subscribeCatalog(() => setCatalogVersion((v) => v + 1));
    const unsubCache = subscribeSchemaCache(() => setCacheVersion((v) => v + 1));
    const unsubJobs = subscribeProgress(() => setJobs(readJobs()));
    return () => {
      unsubCatalog();
      unsubCache();
      unsubJobs();
    };
  }, []);

  // Suppress the unused-variable warning while still triggering
  // re-renders on cache changes. The `cached/total` count below is
  // recomputed on every render via `state.schemaIndexedAt`, which the
  // tree-view freshness effect populates.
  void catalogVersion;

  if (!isConnected || !id || !database) return null;

  const catalog = readCatalog(id, database);
  const total = catalog.length;
  // Session-mirror count: number of tables whose columns we've
  // pulled in this session. Updates on every `schema-cache-updated`
  // event via the `setCacheVersion` re-render trigger above.
  const cached = countCachedTables(id, database);

  // The most relevant active job: prefer foreground (`describe`),
  // then catalog load, then background. Lets the badge focus on the
  // single most useful line when several jobs run in parallel.
  const activeJob = pickPrimaryJob(jobs.filter((j) => j.connectionId === id));

  // When the cache is fully warm we still want a visible heartbeat,
  // so render a thin progress bar that fills as `cached → total`.
  // During an active job the bar tracks `current/total` of the job
  // instead, so the user sees forward motion at a glance.
  const showJob = !!activeJob && activeJob.state !== "done";
  const fillPct = showJob
    ? activeJob!.total > 0
      ? Math.min(100, (activeJob!.current / activeJob!.total) * 100)
      : 0
    : total > 0
      ? Math.min(100, (cached / total) * 100)
      : 0;

  return (
    <div
      className="flex w-full flex-col gap-1 text-xs text-muted-foreground"
      title={
        activeJob
          ? `${labelFor(activeJob)} — see floating chip for details`
          : `Schema cache for ${database}`
      }
    >
      <div className="flex items-center gap-1.5">
        {showJob ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
        ) : (
          <Database className="size-3 shrink-0" />
        )}
        {showJob ? (
          <span className="truncate">
            {labelFor(activeJob!)}
            {activeJob!.total > 1 ? (
              <>
                {" "}
                <span className="tabular-nums text-foreground">
                  {Math.min(activeJob!.current, activeJob!.total)}/
                  {activeJob!.total}
                </span>
              </>
            ) : null}
          </span>
        ) : total > 0 ? (
          <span className="truncate">
            <span className="tabular-nums text-foreground">{cached}</span>
            /<span className="tabular-nums">{total}</span> tables cached
          </span>
        ) : (
          <span className="truncate">loading catalog…</span>
        )}
      </div>
      <div className="h-0.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={
            "h-full transition-[width] duration-150 " +
            (showJob ? "bg-primary" : "bg-emerald-500/60")
          }
          style={{ width: `${fillPct}%` }}
        />
      </div>
    </div>
  );
}

function pickPrimaryJob(
  jobs: SchemaCacheProgressEvent[],
): SchemaCacheProgressEvent | null {
  const order = ["describe", "catalog", "background"] as const;
  for (const kind of order) {
    const j = jobs.find((x) => x.kind === kind && x.state !== "done");
    if (j) return j;
  }
  // No live job — but a `done` event might still be in its
  // visible-tail window. Surface those briefly too so the badge ticks
  // to "✓" before settling back to the static count.
  return jobs.find((x) => x.state === "done") ?? null;
}

function labelFor(job: SchemaCacheProgressEvent): string {
  switch (job.kind) {
    case "catalog":
      return job.state === "done" ? "catalog ready" : "loading catalog";
    case "describe":
      return job.currentItem
        ? `indexing ${job.currentItem}`
        : "indexing schema";
    case "background":
      return job.currentItem
        ? `caching ${job.currentItem}`
        : "refreshing cache";
  }
}
