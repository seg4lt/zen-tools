/**
 * Shared trailing-edge debounced auto-save for any editor surface.
 *
 * Every keystroke arms a timer; only the LAST snapshot inside the
 * quiet window writes to disk. Switching documents (`key` change)
 * and unmount both force-flush the pending payload before the new
 * one starts accruing — losing seconds of edits because the user
 * clicked the next file is the kind of bug that makes people stop
 * trusting auto-save.
 *
 * The hook is deliberately agnostic about *what* a key is and *how*
 * the save happens — both are caller-supplied. That lets the same
 * hook back the SQL editor (key = file path), the markdown tool
 * (key = file path or tab id), and any future editor without
 * conditionals here.
 *
 * Default debounce: 1 s. Same value used by VS Code, IntelliJ etc.
 */

import { useCallback, useEffect, useRef } from "react";

export interface UseAutoSaveOptions<K> {
  /**
   * Stable identifier for the document. `null` disables auto-save.
   * When this changes the hook flushes the *previous* key's pending
   * payload before re-arming for the new one.
   */
  key: K | null;
  /** Latest in-memory content. Re-arms the timer on every change. */
  content: string;
  /**
   * Whether `content` differs from disk. When `false` the hook
   * cancels any pending write and stops scheduling — there's nothing
   * to save.
   */
  dirty: boolean;
  /**
   * Writes `content` for `key`. Errors are caught and logged but
   * not rethrown — the caller's reducer doesn't need an error path
   * for routine save failures (network blips, fs flake) since the
   * `dirty` flag stays on and the next keystroke will re-arm.
   */
  save: (key: K, content: string) => Promise<void>;
  /** Default 1000 ms. */
  debounceMs?: number;
}

export interface UseAutoSaveResult {
  /**
   * Force-flush any pending write right now and await completion.
   * Useful for manual save buttons / Mod-S handlers that want to
   * collapse the debounce. Safe to call when nothing is pending.
   */
  flush: () => Promise<void>;
  /**
   * Drop any pending write without saving — e.g. when the document
   * is being deleted under us. Rare; included for completeness.
   */
  cancel: () => void;
}

export function useAutoSave<K>({
  key,
  content,
  dirty,
  save,
  debounceMs = 1000,
}: UseAutoSaveOptions<K>): UseAutoSaveResult {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ key: K; content: string } | null>(null);
  // Hold latest save callback in a ref so we don't re-arm the timer
  // (or invalidate the flush identity) on every parent re-render.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    clearTimer();
    pendingRef.current = null;
  }, [clearTimer]);

  const flush = useCallback(async () => {
    clearTimer();
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    try {
      await saveRef.current(pending.key, pending.content);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("auto-save failed", err);
    }
  }, [clearTimer]);

  // Track the key the last invocation handled so we can detect a
  // transition and force-flush before re-arming for the new key.
  const lastKeyRef = useRef<K | null>(null);

  useEffect(() => {
    const prev = lastKeyRef.current;
    // Different document — flush any pending write for the previous
    // key first (synchronously kicks off the write; the await happens
    // off the React render path).
    if (prev !== null && prev !== key && pendingRef.current) {
      void flush();
    }
    lastKeyRef.current = key;

    // No document → nothing to save.
    if (key === null) {
      cancel();
      return;
    }
    // Buffer matches disk → drop any stale pending and don't schedule.
    if (!dirty) {
      cancel();
      return;
    }

    // Re-arm with the freshest payload. The timer's setTimeout closure
    // never reads `key`/`content` directly — it always goes through
    // `pendingRef`, so we can't write a stale snapshot.
    pendingRef.current = { key, content };
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, debounceMs);

    return clearTimer;
  }, [key, content, dirty, debounceMs, clearTimer, cancel, flush]);

  // Unmount → flush whatever's pending. Effect-with-empty-deps so it
  // only runs at mount/unmount; `flush` is stable.
  useEffect(() => {
    return () => {
      void flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { flush, cancel };
}
