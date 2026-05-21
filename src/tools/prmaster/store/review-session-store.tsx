/**
 * Per-PR review page session state.
 *
 * The dedicated review route (`/prmaster/review/...`) unmounts when
 * the user switches to another tool in the title bar. Without a
 * hoisted store the tab choice, selected file, tree visibility, and
 * AI-review view mode all reset on remount — exactly the "I switched
 * apps and lost my place" bug.
 *
 * State is keyed by `owner/repo#number` and persisted to
 * `localStorage` so it also survives an app restart mid-review.
 */

import { useSyncExternalStore } from "react";

export type ReviewTab = "files" | "comments" | "ai-review";
export type AiReviewViewMode = "log" | "report";

export interface ReviewSession {
  tab: ReviewTab;
  selectedPath: string | null;
  treeOpen: boolean;
  aiViewMode: AiReviewViewMode;
  /** Run id currently loaded in the AI Review tab, if any. */
  loadedRunId: string | null;
}

const STORAGE_KEY = "prmaster.reviewSessions.v1";

/** Stable empty snapshot — `useSyncExternalStore` requires referential
 *  equality when nothing has changed. Never return a fresh object from
 *  `getSlot` for unmapped keys or React will re-render forever. */
const EMPTY_SESSION: ReviewSession = {
  tab: "files",
  selectedPath: null,
  treeOpen: true,
  aiViewMode: "log",
  loadedRunId: null,
};

function createSession(partial?: Partial<ReviewSession>): ReviewSession {
  return { ...EMPTY_SESSION, ...partial };
}

type Listener = () => void;

let slots = loadFromStorage();
const listeners = new Set<Listener>();

function notify(): void {
  for (const cb of listeners) cb();
}

function loadFromStorage(): Map<string, ReviewSession> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, Partial<ReviewSession>>;
    const out = new Map<string, ReviewSession>();
    for (const [key, partial] of Object.entries(parsed)) {
      out.set(key, createSession(partial));
    }
    return out;
  } catch {
    return new Map();
  }
}

function saveToStorage(): void {
  try {
    const obj: Record<string, ReviewSession> = {};
    for (const [key, session] of slots) {
      obj[key] = session;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // private browsing / quota — in-memory state still works.
  }
}

export const reviewSessionStore = {
  getSlot(key: string): ReviewSession {
    return slots.get(key) ?? EMPTY_SESSION;
  },

  patch(key: string, patch: Partial<ReviewSession>): void {
    const current = slots.get(key) ?? EMPTY_SESSION;
    let changed = false;
    for (const field of Object.keys(patch) as (keyof ReviewSession)[]) {
      if (current[field] !== patch[field]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const next = { ...current, ...patch };
    slots.set(key, next);
    saveToStorage();
    notify();
  },

  subscribe(cb: Listener): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

export function useReviewSession(key: string): ReviewSession {
  return useSyncExternalStore(
    (cb) => reviewSessionStore.subscribe(cb),
    () => reviewSessionStore.getSlot(key),
    () => reviewSessionStore.getSlot(key),
  );
}
