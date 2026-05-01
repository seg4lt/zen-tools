/**
 * Schema-cache progress tracker.
 *
 * The backend streams `schema-cache-progress` events for three kinds
 * of cache work:
 *
 *   - `catalog`    — listing every relation in a database (single
 *                    query, ~ms).
 *   - `describe`   — user-triggered per-table reindex (Opt+Enter,
 *                    right-click). The user expects clear feedback.
 *   - `background` — typing-triggered or stale auto-refresh that
 *                    runs out-of-band. Subtle indicator only.
 *
 * Each job goes through `started → progress* → done|error`. We hold
 * the latest snapshot per `jobId` in a module-scope `Map` and notify
 * subscribers on every change. Terminal states (`done`, `error`) are
 * kept around briefly so the UI can show a quick "✓ done" flash, then
 * the entry expires via `gcTimer` below.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  SCHEMA_CACHE_PROGRESS_EVENT,
  type SchemaCacheProgressEvent,
} from "./tauri";

/**
 * How long after a job ends (`done` or `error`) we keep its entry
 * around. Long enough for the user to actually notice — for fast
 * catalog loads (~50 ms total) the chip would otherwise flash by
 * before the eye registers anything.
 */
const TERMINAL_VISIBLE_MS = 2_500;

/**
 * Minimum total time a job is visible from `started` to disappearing,
 * even if the backend reports `done` immediately. Prevents a "did
 * something just happen?" flash on sub-100 ms operations.
 */
const MIN_TOTAL_VISIBLE_MS = 600;

const jobs: Map<string, SchemaCacheProgressEvent> = new Map();
const listeners: Set<() => void> = new Set();
const gcTimers: Map<string, number> = new Map();
const startedAt: Map<string, number> = new Map();

let unlistenPromise: Promise<UnlistenFn> | null = null;

/**
 * Lazy-subscribe to the Tauri event the first time anyone reads.
 * Returns the in-flight listen() promise so callers that need to
 * guarantee the subscription is wired (before firing a fast backend
 * command that emits progress) can await it.
 */
function ensureSubscribed(): Promise<UnlistenFn> {
  if (unlistenPromise) return unlistenPromise;
  unlistenPromise = listen<SchemaCacheProgressEvent>(
    SCHEMA_CACHE_PROGRESS_EVENT,
    (msg) => apply(msg.payload),
  );
  return unlistenPromise;
}

/**
 * Public hook for callers (e.g. the schema-cache façade) that want to
 * make sure the listener is registered *before* they invoke a backend
 * command that emits progress. Fast jobs (catalog load on a small
 * Postgres) can complete in tens of ms — well inside the time
 * `listen()` takes to wire the subscription. Awaiting this avoids
 * losing those events.
 */
export function awaitProgressSubscribed(): Promise<unknown> {
  return ensureSubscribed();
}

function apply(ev: SchemaCacheProgressEvent): void {
  jobs.set(ev.jobId, ev);
  if (ev.state === "started") {
    startedAt.set(ev.jobId, Date.now());
  }

  // Schedule garbage-collection for terminal states. Cancel any
  // earlier timer (e.g. an `error` arriving after `done` would be a
  // backend bug, but we still don't want to leak a timer).
  const existing = gcTimers.get(ev.jobId);
  if (existing) {
    window.clearTimeout(existing);
    gcTimers.delete(ev.jobId);
  }
  if (ev.state === "done" || ev.state === "error") {
    // Two timers stack into one: keep the chip visible for at least
    // MIN_TOTAL_VISIBLE_MS from start, then for TERMINAL_VISIBLE_MS
    // after the terminal state. Whichever is longer wins.
    const start = startedAt.get(ev.jobId) ?? Date.now();
    const elapsed = Date.now() - start;
    const remainingMin = Math.max(0, MIN_TOTAL_VISIBLE_MS - elapsed);
    const timeout = Math.max(TERMINAL_VISIBLE_MS, remainingMin);
    const handle = window.setTimeout(() => {
      jobs.delete(ev.jobId);
      gcTimers.delete(ev.jobId);
      startedAt.delete(ev.jobId);
      notify();
    }, timeout);
    gcTimers.set(ev.jobId, handle);
  }

  notify();
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // Subscriber crashes shouldn't break other subscribers.
    }
  }
}

/** Synchronous snapshot of every active (or recently-finished) job. */
export function readJobs(): SchemaCacheProgressEvent[] {
  ensureSubscribed();
  return [...jobs.values()];
}

/** Subscribe to job-store changes. Returns an unsubscribe function. */
export function subscribeProgress(listener: () => void): () => void {
  ensureSubscribed();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Diagnostic: drop everything (mainly for tests). */
export function _reset(): void {
  jobs.clear();
  for (const handle of gcTimers.values()) window.clearTimeout(handle);
  gcTimers.clear();
  startedAt.clear();
}
