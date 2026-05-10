/**
 * Global, app-singleton store for the **AI Review** tab on the PR
 * Master review page.
 *
 * Why a module-scoped store instead of `useReducer` inside the
 * `<PrAiReviewView>` component:
 *
 * 1. The user can switch tabs (Files / Comments / AI review) mid-run
 *    and we want the streaming events to keep accumulating in the
 *    background — i.e. the state has to outlive the component.
 * 2. Tauri events arrive globally; subscribing once at app boot and
 *    demuxing by `run_id` is cheaper than per-component subscribers.
 * 3. The cached "previous review for this head SHA" lookup needs to
 *    be cross-referenced from anywhere on the review page (e.g. the
 *    files diff view could surface a "AI flagged 3 issues here" hint
 *    in a future iteration).
 *
 * State is keyed by `prKey = "owner/repo#number"`. Each per-PR slot
 * holds the live run id (if any), the buffered events, and the latest
 * known status. Components subscribe via `useAiReviewState(prKey)`
 * which is a thin `useSyncExternalStore` hook.
 */

import { useSyncExternalStore } from "react";
import {
  listenAiReviewEvent,
  parseAiReviewEvent,
  type AiReviewEvent,
  type AiReviewEventPayload,
  type AiReviewRunSummary,
  type AiReviewStatusKind,
} from "../lib/tauri";

/** Per-PR slot held by the store. */
export interface PrReviewSlot {
  /** Live run id, or `null` if no run is in flight for this PR. */
  liveRunId: string | null;
  /** Live status (echoes the registry's view). */
  status: AiReviewStatusKind | "idle";
  /** Buffered events for the live run; replaced when a new run starts. */
  events: AiReviewEvent[];
  /** Persisted-runs index (newest-first); refreshed by `aiReviewListRuns`. */
  runs: AiReviewRunSummary[];
  /** Path to the persisted HTML report for the most-recent done run. */
  reportPath: string | null;
  /** Cost reported by the live or most-recent run, in USD. */
  costUsd: number | null;
  /** Wall-clock duration in ms (mirrors backend's `duration_ms`). */
  durationMs: number | null;
}

/** Build a stable key for `(owner, repo, number)`. Same shape the
 *  backend persists under (`ai_review:index:<slug>`). */
export function prKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

const emptySlot: PrReviewSlot = {
  liveRunId: null,
  status: "idle",
  events: [],
  runs: [],
  reportPath: null,
  costUsd: null,
  durationMs: null,
};

type Listener = () => void;

interface InternalState {
  slots: Map<string, PrReviewSlot>;
  /** Reverse index: live run_id → prKey, so an incoming event can be
   *  routed to the correct slot without iterating every slot. */
  runIdToPrKey: Map<string, string>;
}

let state: InternalState = {
  slots: new Map(),
  runIdToPrKey: new Map(),
};
const listeners = new Set<Listener>();

function notify(): void {
  for (const cb of listeners) cb();
}

/** Imperative mutation helpers. The store is intentionally tiny —
 *  every component reads via `useAiReviewState` and dispatches by
 *  calling these directly; no reducer indirection. */
export const aiReviewStore = {
  getSlot(key: string): PrReviewSlot {
    return state.slots.get(key) ?? emptySlot;
  },

  /** Replace (or seed) the per-PR runs index. Called on tab open. */
  setRuns(key: string, runs: AiReviewRunSummary[]): void {
    const slot = state.slots.get(key) ?? emptySlot;
    state.slots.set(key, { ...slot, runs });
    notify();
  },

  /** Mark a new live run, replacing any prior live state. */
  startRun(key: string, runId: string): void {
    const slot = state.slots.get(key) ?? emptySlot;
    state.slots.set(key, {
      ...slot,
      liveRunId: runId,
      status: "starting",
      events: [],
      reportPath: null,
      costUsd: null,
      durationMs: null,
    });
    state.runIdToPrKey.set(runId, key);
    notify();
  },

  /** Replay (or seed) buffered events from `aiReviewStatus`. */
  replayStatus(
    key: string,
    runId: string,
    status: AiReviewStatusKind,
    events: AiReviewEvent[],
    reportPath: string | null,
  ): void {
    const slot = state.slots.get(key) ?? emptySlot;
    state.slots.set(key, {
      ...slot,
      liveRunId: status === "running" || status === "starting" ? runId : null,
      status,
      events: [...events],
      reportPath,
    });
    state.runIdToPrKey.set(runId, key);
    notify();
  },

  /** Append an event to a live run's buffer. */
  appendEvent(runId: string, event: AiReviewEvent): void {
    const key = state.runIdToPrKey.get(runId);
    if (!key) return;
    const slot = state.slots.get(key) ?? emptySlot;
    const next: PrReviewSlot = {
      ...slot,
      events: [...slot.events, event],
    };
    if (slot.status === "starting") next.status = "running";
    if (event.kind === "done") {
      next.status = "done";
      next.liveRunId = null;
      next.reportPath = event.report_path;
      next.costUsd = event.cost_usd;
      next.durationMs = event.duration_ms;
    } else if (event.kind === "error") {
      next.status = "error";
      next.liveRunId = null;
    }
    state.slots.set(key, next);
    notify();
  },

  /** Mark a run cancelled (driven by the cancel command's success). */
  markCancelled(runId: string): void {
    const key = state.runIdToPrKey.get(runId);
    if (!key) return;
    const slot = state.slots.get(key) ?? emptySlot;
    state.slots.set(key, { ...slot, status: "cancelled", liveRunId: null });
    notify();
  },

  /** Drop everything we know about a PR (e.g. on merged-PR cleanup). */
  clear(key: string): void {
    const slot = state.slots.get(key);
    if (!slot) return;
    state.slots.delete(key);
    if (slot.liveRunId) state.runIdToPrKey.delete(slot.liveRunId);
    notify();
  },

  subscribe(cb: Listener): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

let bootstrapped = false;
let unlistenFn: (() => void) | null = null;

/** Subscribe once to the global `prmaster:ai-review:event` channel.
 *  Idempotent — every component that needs events calls this on mount;
 *  only the first call wires a listener. */
export async function ensureAiReviewSubscription(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;
  const handler = (payload: AiReviewEventPayload) => {
    aiReviewStore.appendEvent(payload.run_id, parseAiReviewEvent(payload));
  };
  const fn = await listenAiReviewEvent(handler);
  unlistenFn = fn;
}

/** Test-only / hot-reload helper: tear down the global subscription. */
export function teardownAiReviewSubscription(): void {
  if (unlistenFn) {
    unlistenFn();
    unlistenFn = null;
  }
  bootstrapped = false;
  state = { slots: new Map(), runIdToPrKey: new Map() };
}

/** React hook: subscribe a component to the slot for `prKey`. */
export function useAiReviewState(key: string): PrReviewSlot {
  return useSyncExternalStore(
    (cb) => aiReviewStore.subscribe(cb),
    () => aiReviewStore.getSlot(key),
    () => aiReviewStore.getSlot(key),
  );
}
