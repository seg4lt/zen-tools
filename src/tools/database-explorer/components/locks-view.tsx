/**
 * Per-query lock telemetry visualizer.
 *
 * Renders the `DbLockSummary` attached to a `DbQueryResult` by the
 * "Run with locks" button. The backend opened a sidecar observer
 * connection during execution, polled `pg_locks` /
 * `sys.dm_tran_locks` at a fixed interval, and aggregated the
 * samples into per-granularity / per-mode / per-object rollups.
 *
 * Surfaces:
 *   • Header chips     — sample interval, sample count, blocked time,
 *                        primary blocker SPID/PID.
 *   • Granularity bar  — stacked counts row vs page vs table vs … so
 *                        the user can see the lock pyramid at a glance.
 *   • Mode table       — engine-native modes (S, X, IX, AccessShareLock)
 *                        with shared-vs-exclusive colour coding.
 *   • Objects list     — per-relation rollup, sorted by peak lock count.
 *   • Timeline strip   — sparkline of lock count over query lifetime.
 *
 * When `summary.error` is set, the sampler couldn't run (permissions,
 * sidecar connect failure, …); we render a single "unavailable"
 * notice with the reason instead of misleading empty rollups.
 */

import { useMemo } from "react";
import {
  AlertOctagon,
  Clock,
  Database as DatabaseIcon,
  Layers,
  Lock,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@zen-tools/ui";
import type {
  DbLockGranularity,
  DbLockSummary,
  DbObjectLockRow,
} from "../lib/tauri";

interface LocksViewProps {
  summary: DbLockSummary;
  /** Total wall-clock the user statement took, for context in the
   * "blocked X / total Y" header chip. */
  durationMs: number;
}

/**
 * Display order for granularity chips. Pyramid: most-granular at the
 * left so the user reads "row → page → table" naturally.
 */
const GRANULARITY_ORDER: DbLockGranularity[] = [
  "row",
  "page",
  "table",
  "transaction",
  "advisory",
  "metadata",
  "database",
  "other",
];

/**
 * Tailwind background tokens per granularity. Slightly different
 * hues so the stacked bar reads as distinct segments without
 * leaning on opacity alone.
 */
const GRANULARITY_COLOR: Record<DbLockGranularity, string> = {
  row: "bg-emerald-500",
  page: "bg-sky-500",
  table: "bg-amber-500",
  transaction: "bg-violet-500",
  advisory: "bg-fuchsia-500",
  metadata: "bg-slate-500",
  database: "bg-rose-500",
  other: "bg-zinc-400",
};

export function LocksView({ summary, durationMs }: LocksViewProps) {
  if (summary.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
        <AlertOctagon className="size-5 text-amber-500" />
        <div className="font-semibold text-foreground">
          Lock capture unavailable
        </div>
        <div className="max-w-md text-[11px] leading-5">{summary.error}</div>
        <div className="mt-2 max-w-md text-[10px] text-muted-foreground/80">
          Postgres needs the executing role to read{" "}
          <code className="rounded bg-muted px-1">pg_stat_activity</code>;
          MSSQL needs <code className="rounded bg-muted px-1">VIEW SERVER STATE</code>.
        </div>
      </div>
    );
  }

  const granularityRows = useMemo(() => {
    const rows: { kind: DbLockGranularity; count: number }[] = [];
    for (const kind of GRANULARITY_ORDER) {
      const count = summary.peakByGranularity[kind] ?? 0;
      if (count > 0) rows.push({ kind, count });
    }
    return rows;
  }, [summary.peakByGranularity]);

  const totalPeak = granularityRows.reduce((acc, r) => acc + r.count, 0);

  /**
   * Detect the "all you saw was the implicit per-connection
   * shared lock" case. **Both** engines do this:
   *
   *   - Postgres takes a `database`-granularity `AccessShareLock`
   *     on every backend.
   *   - MSSQL holds a `DATABASE`-resource shared lock on every
   *     session bound to that database.
   *
   * So a query that doesn't touch any user objects (e.g.
   * `SELECT 1`) still shows up here as one database-level lock.
   * Without an explainer this looks alarming. The banner copy
   * stays engine-agnostic because the user's connection driver
   * isn't plumbed into this component — the explanation is true
   * for both anyway.
   */
  const onlyImplicitDbLock =
    granularityRows.length === 1 &&
    granularityRows[0].kind === "database" &&
    summary.objects.length === 0 &&
    summary.blockedMs === 0;

  /**
   * Detect the "every lock is TABLE granularity / RowExclusiveLock,
   * why don't I see ROW like I expected?" case. This is the most
   * common point of confusion for Postgres users: a single-row
   * `UPDATE shop.customers WHERE id = 1` produces a fan-out of
   * `RowExclusiveLock` entries on the table itself, every index on
   * it, and any tables touched by triggers (audit_log, …) — all
   * at TABLE granularity. The actual row-level serialization in
   * Postgres happens via the *transaction-id* lock (visible in
   * the same summary as `transaction` granularity), and the
   * short-lived tuple lock that's released within microseconds
   * of the row write — usually too brief for our 25 ms sampler
   * to catch.
   *
   * When this pattern shows up we surface a one-paragraph
   * explainer above the granularity bar so the user doesn't read
   * "TABLE × 7" as "I locked the whole table" — they didn't.
   */
  const isPgRelationFanout =
    granularityRows.length > 0 &&
    granularityRows.every(
      (r) => r.kind === "table" || r.kind === "transaction" || r.kind === "database",
    ) &&
    Object.keys(summary.peakByMode).every((m) =>
      m === "AccessShareLock" ||
      m === "RowShareLock" ||
      m === "RowExclusiveLock" ||
      m === "ExclusiveLock" ||
      m === "ShareUpdateExclusiveLock",
    ) &&
    !onlyImplicitDbLock &&
    summary.objects.length > 0;

  const modeRows = useMemo(() => {
    const entries = Object.entries(summary.peakByMode);
    entries.sort((a, b) => b[1] - a[1]);
    return entries;
  }, [summary.peakByMode]);

  const blockedPct =
    durationMs > 0
      ? Math.min(100, Math.round((summary.blockedMs / durationMs) * 100))
      : 0;

  const blockerSummary =
    summary.blockers.length > 0
      ? `${summary.blockers
          .slice(0, 3)
          .map((b) => `pid ${b.pid}`)
          .join(", ")}${
          summary.blockers.length > 3
            ? ` +${summary.blockers.length - 3} more`
            : ""
        }`
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header chips. Pinned at the top — the rest of the panel
          scrolls. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-[11px]">
        <Chip
          icon={<Clock className="size-3" />}
          label={`${summary.sampleIntervalMs} ms / sample`}
          title={`Lock catalogue polled every ${summary.sampleIntervalMs} ms via a sidecar connection. Samples shorter than this can escape observation.`}
        />
        <Chip
          icon={<Layers className="size-3" />}
          label={`${summary.sampleCount} sample${summary.sampleCount === 1 ? "" : "s"}`}
          title="Total polling ticks completed during the statement."
        />
        {summary.blockedMs > 0 && (
          <Chip
            icon={<ShieldAlert className="size-3" />}
            label={`Blocked ${summary.blockedMs} ms (${blockedPct}%)`}
            tone="warn"
            title={`This session was waiting on a lock for an estimated ${summary.blockedMs} ms (${blockedPct}% of statement time).`}
          />
        )}
        {blockerSummary && (
          <Chip
            icon={<Lock className="size-3" />}
            label={`Blocker: ${blockerSummary}`}
            tone="warn"
            title="Sessions that held the lock we were waiting on."
          />
        )}
        {totalPeak === 0 && summary.sampleCount > 0 && (
          <Chip
            icon={<Lock className="size-3" />}
            label="No locks observed"
            title="The sampler ran successfully but never caught a held lock — the statement either ran faster than the sampling interval, or only acquired locks shorter-lived than one tick."
          />
        )}
      </div>

      {/* Body — scrollable. */}
      <div className="min-h-0 flex-1 overflow-auto px-3 py-3 text-xs">
        {onlyImplicitDbLock && (
          <div className="mb-3 rounded border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[11px] text-muted-foreground">
            <span className="font-semibold text-foreground">
              No user-object locks observed.
            </span>{" "}
            The single <span className="font-mono">database</span> lock
            shown below is the implicit shared lock the engine takes
            on every connection bound to a database — it does{" "}
            <em>not</em> mean your query locked the whole database.
            Try a query that touches a table to see row / page /
            table-level locks.
          </div>
        )}

        {isPgRelationFanout && (
          <div className="mb-3 rounded border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
            <div className="mb-1 font-semibold text-foreground">
              Why is everything <span className="font-mono">TABLE</span>{" "}
              granularity? (Postgres naming gotcha)
            </div>
            <div>
              Postgres lock <em>modes</em> like{" "}
              <span className="font-mono">RowExclusiveLock</span> and{" "}
              <span className="font-mono">RowShareLock</span> are{" "}
              <strong>TABLE-level locks</strong> despite their names —
              the "Row" refers to what kind of work they permit, not
              the granularity. A single-row{" "}
              <span className="font-mono">UPDATE</span> takes:
              <ul className="ml-4 mt-1 list-disc space-y-0.5">
                <li>
                  <span className="font-mono">RowExclusiveLock</span>{" "}
                  on the table (compatible with itself — other writers
                  don't block) plus one on each index and any
                  trigger-touched tables (the fan-out you see)
                </li>
                <li>
                  A <span className="font-mono">transactionid</span>{" "}
                  lock (look for it under{" "}
                  <span className="font-mono">transaction</span>{" "}
                  granularity) — this is the actual row-modification
                  serializer, held until COMMIT/ROLLBACK
                </li>
                <li>
                  A short-lived <span className="font-mono">tuple</span>{" "}
                  lock during the row write itself, usually too brief
                  for the {summary.sampleIntervalMs} ms sampler to
                  catch
                </li>
              </ul>
              For an actual table-blocking lock you'd see mode{" "}
              <span className="font-mono">AccessExclusiveLock</span>{" "}
              (DDL) or <span className="font-mono">ExclusiveLock</span>{" "}
              instead.
            </div>
          </div>
        )}

        {/* Granularity bar. */}
        {granularityRows.length > 0 && (
          <Section title="Lock granularity (peak)">
            <div className="flex h-5 w-full overflow-hidden rounded border border-border/60">
              {granularityRows.map((r) => (
                <div
                  key={r.kind}
                  className={cn(
                    "flex items-center justify-center gap-1.5 text-[10px] font-mono text-white",
                    GRANULARITY_COLOR[r.kind],
                  )}
                  style={{ width: `${(r.count / totalPeak) * 100}%` }}
                  title={`${r.kind}: ${r.count} lock${r.count === 1 ? "" : "s"} at peak`}
                >
                  {r.count > 0 && r.count / totalPeak > 0.08 ? (
                    <>
                      <span>{r.kind}</span>
                      <span className="rounded bg-black/25 px-1 leading-none">
                        ×{r.count}
                      </span>
                    </>
                  ) : null}
                </div>
              ))}
            </div>
            {/* Legend row — surfaces the small slices the bar
                couldn't fit text into. */}
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
              {granularityRows.map((r) => (
                <span
                  key={r.kind}
                  className="inline-flex items-center gap-1.5"
                  title={granularityHint(r.kind)}
                >
                  <span
                    className={cn("size-2 rounded-sm", GRANULARITY_COLOR[r.kind])}
                  />
                  <span className="font-mono">{r.kind}</span>
                  <span className="rounded bg-muted px-1 font-mono text-foreground/80">
                    ×{r.count}
                  </span>
                </span>
              ))}
            </div>
          </Section>
        )}

        {/* Mode table. */}
        {modeRows.length > 0 && (
          <Section title="Lock modes (peak)">
            <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              {modeRows.map(([mode, count]) => (
                <ModeRow key={mode} mode={mode} count={count} />
              ))}
            </div>
          </Section>
        )}

        {/* Per-object rollup. */}
        {summary.objects.length > 0 && (
          <Section title={`Objects locked (${summary.objects.length})`}>
            <div className="overflow-hidden rounded border border-border/60">
              <table className="w-full text-[11px]">
                <thead className="bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 font-medium">Object</th>
                    <th className="px-2 py-1 font-medium">Granularity</th>
                    <th className="px-2 py-1 font-medium">Modes</th>
                    <th className="px-2 py-1 text-right font-medium">Peak</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.objects.map((obj) => (
                    <ObjectRow key={obj.object} obj={obj} />
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* Blockers (if any). */}
        {summary.blockers.length > 0 && (
          <Section title="Blockers">
            <ul className="space-y-1">
              {summary.blockers.map((b) => (
                <li
                  key={b.pid}
                  className="flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1"
                >
                  <ShieldAlert className="size-3 text-amber-600" />
                  <span className="font-mono">pid {b.pid}</span>
                  {b.reason && (
                    <span className="text-muted-foreground">— {b.reason}</span>
                  )}
                  <span className="ml-auto text-muted-foreground">
                    ~{b.waitMs} ms wait
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Timeline sparkline. */}
        {summary.samples.length > 0 && (
          <Section title="Lock count over time">
            <Sparkline summary={summary} durationMs={durationMs} />
          </Section>
        )}

        {/* Empty-state copy if literally nothing was observed. */}
        {totalPeak === 0 && summary.objects.length === 0 && (
          <div className="mt-4 rounded border border-dashed border-border/60 px-3 py-3 text-[11px] text-muted-foreground">
            <DatabaseIcon className="mr-1 inline size-3" />
            No locks were observed during this statement. Either the
            statement ran faster than {summary.sampleIntervalMs} ms (try
            a smaller interval), or it only took
            sub-sampling-interval shared locks released between ticks.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function Chip({
  icon,
  label,
  tone,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  tone?: "warn";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px]",
        tone === "warn"
          ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "border-border/60 bg-background text-muted-foreground",
      )}
    >
      {icon}
      {label}
    </span>
  );
}

/**
 * One row in the modes grid. Each mode is colour-coded by its
 * actual conflict semantics (not by what the name suggests — see
 * {@link classifyMode}) and shows a plain-English explainer on
 * hover so the user can decode jargon like `RowExclusiveLock`
 * (a TABLE lock that's compatible with itself, not actually
 * exclusive!) or `Sch-M` (the most blocking lock in MSSQL).
 */
function ModeRow({ mode, count }: { mode: string; count: number }) {
  const tone = classifyMode(mode);
  return (
    <>
      <div
        className={cn(
          "inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px]",
          tone === "exclusive" && "bg-rose-500/15 text-rose-700 dark:text-rose-300",
          tone === "shared" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
          tone === "neutral" && "bg-muted text-muted-foreground",
        )}
        title={modeExplain(mode)}
      >
        {mode}
      </div>
      <div className="text-right font-mono text-muted-foreground">{count}</div>
    </>
  );
}

/**
 * Plain-English explainer for individual lock modes. Surfaced
 * on hover in the modes grid because the names are notoriously
 * misleading — Postgres's `RowExclusiveLock` is a TABLE-level
 * lock that's compatible with itself; MSSQL's `Sch-M` is more
 * exclusive than `X`; etc. Helps the user decode the
 * granularity/mode interaction without a doc lookup.
 */
function modeExplain(mode: string): string {
  switch (mode) {
    // ── Postgres relation modes ─────────────────────────
    case "AccessShareLock":
      return "AccessShareLock — Postgres TABLE-level lock taken by SELECT. Only conflicts with AccessExclusiveLock (DDL).";
    case "RowShareLock":
      return "RowShareLock — Postgres TABLE-level lock taken by SELECT FOR UPDATE/SHARE. Compatible with other readers and writers.";
    case "RowExclusiveLock":
      return "RowExclusiveLock — Postgres TABLE-level lock taken by INSERT/UPDATE/DELETE. **Despite the name, it's a TABLE lock, not a row lock.** It's the standard DML mode and is compatible with itself: multiple writers don't block each other. Actual row serialization happens via the transactionid (xid) lock.";
    case "ShareUpdateExclusiveLock":
      return "ShareUpdateExclusiveLock — Postgres lock taken by VACUUM (non-FULL), ANALYZE, CREATE INDEX CONCURRENTLY. Allows reads, blocks DDL.";
    case "ShareLock":
      return "ShareLock — Postgres lock taken by CREATE INDEX (non-concurrent). Allows reads, blocks writes.";
    case "ShareRowExclusiveLock":
      return "ShareRowExclusiveLock — rare Postgres mode taken by CREATE TRIGGER and some ALTER TABLE forms. Blocks other writers.";
    case "ExclusiveLock":
      return "ExclusiveLock — Postgres lock that blocks all reads and writes EXCEPT plain SELECTs (which take AccessShareLock). Used by REFRESH MATERIALIZED VIEW CONCURRENTLY.";
    case "AccessExclusiveLock":
      return "AccessExclusiveLock — Postgres TABLE-level lock that blocks every other operation including SELECT. Taken by DROP, TRUNCATE, REINDEX, most ALTER TABLEs, LOCK TABLE … IN ACCESS EXCLUSIVE MODE.";
    // ── MSSQL modes ─────────────────────────────────────
    case "S":
      return "S (Shared) — MSSQL read lock. Compatible with other S locks; conflicts with X.";
    case "X":
      return "X (Exclusive) — MSSQL write lock. Conflicts with everything except Sch-S.";
    case "U":
      return "U (Update) — MSSQL upgrade-intent lock. Held while a row is being read with intent to modify; converts to X before write. Prevents the deadlock of two upgrading sessions.";
    case "IS":
      return "IS (Intent Shared) — MSSQL: signals that a finer-grained S lock will be taken below. Compatible with most things at this level.";
    case "IX":
      return "IX (Intent Exclusive) — MSSQL: signals that a finer-grained X lock will be taken below. Standard for INSERT/UPDATE/DELETE on the OBJECT level.";
    case "SIX":
      return "SIX (Shared with Intent Exclusive) — MSSQL: combines S and IX; rare.";
    case "BU":
      return "BU (Bulk Update) — MSSQL bulk-load lock taken by BULK INSERT and similar.";
    case "Sch-S":
      return "Sch-S (Schema Stability) — MSSQL: held during compilation. Compatible with everything except Sch-M.";
    case "Sch-M":
      return "Sch-M (Schema Modification) — MSSQL: the **most restrictive lock**, blocks every other access including reads. Taken by DDL.";
    default:
      return mode;
  }
}

/**
 * Plain-English explainer for each granularity, surfaced on hover
 * over the legend chip. Helps the user tell "this is a real lock"
 * from "this is the implicit per-connection lock you can ignore".
 */
function granularityHint(g: DbLockGranularity): string {
  switch (g) {
    case "row":
      return "Row-level lock (Postgres tuple, MSSQL KEY/RID). Held while a row is being read or modified.";
    case "page":
      return "Page-level lock (Postgres page, MSSQL PAGE). Coarser than row, finer than table.";
    case "table":
      return "Table-level lock (Postgres relation, MSSQL OBJECT). Held by SELECT/INSERT/UPDATE/DELETE in shared mode, by DDL in exclusive mode.";
    case "transaction":
      return "Transaction ID lock (Postgres transactionid/virtualxid, MSSQL XACT). Used internally to wait on another transaction.";
    case "advisory":
      return "Application advisory lock (Postgres pg_advisory_lock). User code uses these for cross-session coordination.";
    case "metadata":
      return "Schema/metadata lock — extends, frozen-id, allocation-unit, etc. Usually background bookkeeping.";
    case "database":
      return "Database-level shared lock. Postgres takes one of these on every connection automatically; usually safe to ignore.";
    case "other":
      return "Driver-native lock type that doesn't map to our standard vocabulary. Inspect the per-object table for raw kind.";
  }
}

/**
 * Classify a lock mode by its **actual conflict semantics**, not
 * by what its name suggests. This is non-trivial because Postgres
 * names lie:
 *   - `RowExclusiveLock` / `RowShareLock` — the word "Row" is
 *     misleading (they're TABLE-level locks), and the
 *     "Exclusive" in `RowExclusiveLock` is also misleading: it's
 *     compatible with itself, so two concurrent UPDATEs on the
 *     same table don't block each other. We classify these as
 *     "neutral" (yellow) because they're neither plain reads
 *     nor blocking-everyone exclusives.
 *   - `AccessExclusiveLock` is the *real* table-blocking
 *     exclusive — that one stays red.
 *
 * MSSQL is straighforward except for `Sch-M` which is more
 * exclusive than `X`; we return "exclusive" for it explicitly.
 */
function classifyMode(mode: string): "exclusive" | "shared" | "neutral" {
  // Postgres-specific overrides, since substring matching on the
  // mode string is wrong for these (see doc comment).
  switch (mode) {
    case "AccessExclusiveLock":
    case "ExclusiveLock":
    case "ShareRowExclusiveLock":
    case "ShareLock":
      return "exclusive"; // these actually block writers
    case "RowExclusiveLock":
    case "RowShareLock":
    case "ShareUpdateExclusiveLock":
      // Compatible with themselves (multiple writers / vacuumers
      // don't block each other). Not exclusive in the
      // user-meaningful sense. Render neutral so the UI doesn't
      // alarm on every UPDATE.
      return "neutral";
    case "AccessShareLock":
      return "shared";
    // MSSQL Sch-M — explicit because the dash makes substring
    // matching unreliable.
    case "Sch-M":
      return "exclusive";
    case "Sch-S":
      return "shared";
  }

  const m = mode.toUpperCase();
  // MSSQL: X, IX, SIX, U, BU.
  if (m === "X" || m === "IX" || m === "SIX" || m === "U" || m === "BU") {
    return "exclusive";
  }
  // MSSQL: S, IS.
  if (m === "S" || m === "IS") {
    return "shared";
  }
  return "neutral";
}

/**
 * Best-effort classification of a locked object's role, for
 * visual de-emphasis in the Objects table. The user clicked
 * `UPDATE shop.customers WHERE id = 1`; they care about
 * `shop.customers`. The 4 indexes on it, the sequence behind a
 * SERIAL column, and the audit_log table the trigger cascades
 * into are all real locks but are derivative — listing them at
 * full weight buries the primary table.
 *
 * Heuristic-only; matches Postgres / MSSQL naming conventions
 * but won't catch every project's bespoke names. If unmatched
 * we return `"primary"` (no de-emphasis) so we never hide
 * something the user might actually care about.
 */
function classifyObject(
  object: string,
): "primary" | "index" | "sequence" | "trigger" {
  // Strip an optional schema prefix and the surrounding `[…]`
  // brackets MSSQL adds, so the suffix tests work uniformly.
  const last = object.split(".").pop() ?? object;
  const bare = last.replace(/^\[|\]$/g, "").toLowerCase();
  // Postgres convention: `_pkey`, `_key` (UNIQUE), `_idx`.
  // MSSQL convention: `pk_`, `ix_`, `uq_` prefixes are common
  //   but not universal — be conservative and only match
  //   suffixes here.
  if (bare.endsWith("_pkey") || bare.endsWith("_key") || bare.endsWith("_idx") || bare.endsWith("_index")) {
    return "index";
  }
  if (bare.endsWith("_seq") || bare.endsWith("_sequence")) {
    return "sequence";
  }
  // Tables commonly written by triggers cascade-locked from the
  // user-facing table. `audit_log` is the canonical example in
  // this codebase's seed schema; this won't match every project
  // but it's a well-known pattern.
  if (bare === "audit_log" || bare.startsWith("audit_") || bare.endsWith("_audit")) {
    return "trigger";
  }
  return "primary";
}

function secondaryHint(kind: "index" | "sequence" | "trigger"): string {
  switch (kind) {
    case "index":
      return "Index — lock cascaded automatically when the parent table is locked. The lock fate is identical to the parent.";
    case "sequence":
      return "Sequence — locked when a SERIAL/IDENTITY column is bumped. Usually a trivial side-effect of the parent insert.";
    case "trigger":
      return "Likely written by a trigger on another table — its lock is cascaded from the trigger's parent. Not directly named by your query.";
  }
}

function ObjectRow({ obj }: { obj: DbObjectLockRow }) {
  const kind = classifyObject(obj.object);
  const isSecondary = kind !== "primary";
  return (
    <tr
      className={cn(
        "border-t border-border/40",
        obj.waited && "bg-amber-500/5",
        // De-emphasize secondary objects (indexes / sequences /
        // typical trigger-cascade tables). They share the lock
        // fate of the primary table they hang off, so listing
        // them at the same visual weight as the primary table
        // turns "I locked one row in customers" into a wall of
        // 7+ identical-looking rows. Greying them lets the user's
        // eye land on the primary first.
        isSecondary && "opacity-60",
      )}
      title={isSecondary ? secondaryHint(kind) : undefined}
    >
      <td className="px-2 py-1 font-mono">
        {obj.waited && (
          <ShieldAlert
            className="mr-1 inline size-3 text-amber-600"
            aria-label="Session waited on this object"
          />
        )}
        {obj.object}
        {isSecondary && (
          <span className="ml-1.5 rounded bg-muted px-1 font-sans text-[9px] uppercase tracking-wide text-muted-foreground">
            {kind}
          </span>
        )}
      </td>
      <td className="px-2 py-1">
        <div className="flex flex-wrap gap-1">
          {obj.granularities.map((g) => (
            <span
              key={g}
              className={cn(
                "rounded px-1 py-0.5 font-mono text-[9px] uppercase text-white",
                GRANULARITY_COLOR[g],
              )}
            >
              {g}
            </span>
          ))}
        </div>
      </td>
      <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground">
        {obj.modes.join(", ")}
      </td>
      <td className="px-2 py-1 text-right font-mono">{obj.peakLocks}</td>
    </tr>
  );
}

/**
 * Tiny SVG sparkline of lock-row count per sample window over query
 * lifetime. Bucketed to ~80 buckets so a 60-second query with 2400
 * samples still renders in a fixed width.
 */
function Sparkline({
  summary,
  durationMs,
}: {
  summary: DbLockSummary;
  durationMs: number;
}) {
  const buckets = useMemo(() => {
    const N = 80;
    const span = Math.max(durationMs, 1);
    const widthMs = span / N;
    // Group samples by sample-tick (samples carry the same atMs for
    // every row in one poll).
    const perTick = new Map<number, number>();
    for (const s of summary.samples) {
      perTick.set(s.atMs, (perTick.get(s.atMs) ?? 0) + 1);
    }
    const sorted = [...perTick.entries()].sort((a, b) => a[0] - b[0]);
    const out: number[] = new Array(N).fill(0);
    let max = 0;
    for (const [atMs, count] of sorted) {
      const idx = Math.min(N - 1, Math.floor(atMs / widthMs));
      // Use the per-tick count directly — buckets that have multiple
      // ticks take the max so we don't smear peaks.
      if (count > out[idx]) out[idx] = count;
      if (count > max) max = count;
    }
    return { buckets: out, max };
  }, [summary.samples, durationMs]);

  if (buckets.max === 0) {
    return (
      <div className="text-[10px] text-muted-foreground">
        No samples to plot.
      </div>
    );
  }

  const W = 480;
  const H = 40;
  const dx = W / buckets.buckets.length;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-10 w-full text-emerald-500"
      preserveAspectRatio="none"
    >
      {buckets.buckets.map((v, i) => {
        const h = (v / buckets.max) * (H - 2);
        return (
          <rect
            key={i}
            x={i * dx}
            y={H - h}
            width={Math.max(1, dx - 1)}
            height={h}
            fill="currentColor"
            opacity={v === 0 ? 0 : 0.7}
          />
        );
      })}
    </svg>
  );
}
