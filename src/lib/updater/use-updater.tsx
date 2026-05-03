/**
 * App-wide auto-updater store.
 *
 * Wraps `@tauri-apps/plugin-updater` so the rest of the UI can read
 * a single normalised state shape (`status`, `info`, `progress`,
 * `error`, `dismissed`, `currentVersion`) and trigger the two
 * actions a user actually cares about: re-check now, and download
 * + install + relaunch.
 *
 * Behaviour
 * ─────────
 *  • Auto-check fires once on mount (after a 3 s settle so the rest
 *    of the app is interactive first) and then every 6 hours.
 *  • The banner remembers a per-version dismissal in localStorage.
 *    Dismissing v0.2.0 hides the banner for that exact version only;
 *    when v0.3.0 lands the banner returns. This matches every native
 *    app's behaviour and avoids the "I dismissed it once and now I
 *    never get told about updates" footgun.
 *  • Network or plugin errors set `status: "error"` with the message;
 *    they don't throw or crash the app. The Settings page surfaces
 *    them so the user can see why a check failed.
 *  • `installAndRelaunch` downloads with a progress callback, then
 *    calls `relaunch()` from `@tauri-apps/plugin-process`. Tauri's
 *    updater handles the file swap + signature check transparently.
 *
 * The store is mounted once at app root inside `<AppProviders>` so
 * the banner above the router and the Settings page below it share
 * the same state.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FIRST_CHECK_DELAY_MS = 3_000;
const DISMISS_STORAGE_KEY = "zen-tools.update.dismissed-version";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export interface UpdateInfo {
  version: string;
  date?: string;
  notes?: string;
}

export interface UpdaterState {
  status: UpdateStatus;
  /** The available update's metadata. Set when status === "available" / "downloading" / "installing". */
  info: UpdateInfo | null;
  /** Bytes downloaded so far + total, when known. */
  downloaded: number;
  contentLength: number | null;
  /** Last error message (network failure, signature mismatch, …). */
  error: string | null;
  /** The user dismissed the banner for this exact version. */
  dismissed: boolean;
  /** App version pulled from `getVersion()`. `null` until resolved. */
  currentVersion: string | null;
  /** Wall-clock ms of the most recent check (success OR failure). */
  lastCheckedAt: number | null;
}

type Action =
  | { type: "currentVersion"; v: string }
  | { type: "checkStart" }
  | { type: "checkUpToDate"; at: number }
  | { type: "checkAvailable"; info: UpdateInfo; at: number; dismissed: boolean }
  | { type: "checkError"; error: string; at: number }
  | { type: "downloadStart"; contentLength: number | null }
  | { type: "downloadProgress"; chunk: number }
  | { type: "installing" }
  | { type: "dismiss" }
  | { type: "undismiss" };

const initialState: UpdaterState = {
  status: "idle",
  info: null,
  downloaded: 0,
  contentLength: null,
  error: null,
  dismissed: false,
  currentVersion: null,
  lastCheckedAt: null,
};

function reducer(s: UpdaterState, a: Action): UpdaterState {
  switch (a.type) {
    case "currentVersion":
      return { ...s, currentVersion: a.v };
    case "checkStart":
      return { ...s, status: "checking", error: null };
    case "checkUpToDate":
      return {
        ...s,
        status: "up-to-date",
        info: null,
        error: null,
        lastCheckedAt: a.at,
      };
    case "checkAvailable":
      return {
        ...s,
        status: "available",
        info: a.info,
        error: null,
        dismissed: a.dismissed,
        lastCheckedAt: a.at,
      };
    case "checkError":
      return {
        ...s,
        status: "error",
        error: a.error,
        lastCheckedAt: a.at,
      };
    case "downloadStart":
      return {
        ...s,
        status: "downloading",
        downloaded: 0,
        contentLength: a.contentLength,
        error: null,
      };
    case "downloadProgress":
      return { ...s, downloaded: s.downloaded + a.chunk };
    case "installing":
      return { ...s, status: "installing" };
    case "dismiss":
      return { ...s, dismissed: true };
    case "undismiss":
      return { ...s, dismissed: false };
  }
}

interface UpdaterApi {
  state: UpdaterState;
  /** Force a fresh check now. Safe to call repeatedly. */
  recheck: () => Promise<void>;
  /** Download + install + relaunch. No-op when no update is available. */
  installAndRelaunch: () => Promise<void>;
  /** Hide the banner for the currently-available version. */
  dismiss: () => void;
}

const Ctx = createContext<UpdaterApi | null>(null);

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Hold the live `Update` handle returned by `check()` so
  // installAndRelaunch can call `.downloadAndInstall(...)` without
  // a redundant network round-trip.
  const updateRef = useRef<Update | null>(null);

  const recheck = useCallback(async () => {
    dispatch({ type: "checkStart" });
    try {
      const u = await check();
      const at = Date.now();
      if (u && u.available) {
        updateRef.current = u;
        const dismissedFor = readDismissedVersion();
        const dismissed = dismissedFor === u.version;
        dispatch({
          type: "checkAvailable",
          info: { version: u.version, date: u.date, notes: u.body },
          at,
          dismissed,
        });
      } else {
        updateRef.current = null;
        dispatch({ type: "checkUpToDate", at });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: "checkError", error: msg, at: Date.now() });
    }
  }, []);

  const installAndRelaunch = useCallback(async () => {
    const u = updateRef.current;
    if (!u) return;
    let total: number | null = null;
    try {
      await u.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            dispatch({ type: "downloadStart", contentLength: total });
            break;
          case "Progress":
            dispatch({
              type: "downloadProgress",
              chunk: event.data.chunkLength ?? 0,
            });
            break;
          case "Finished":
            dispatch({ type: "installing" });
            break;
        }
      });
      // Restart so the freshly-installed binary takes over.
      await relaunch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: "checkError", error: msg, at: Date.now() });
    }
  }, []);

  const dismiss = useCallback(() => {
    if (!state.info) return;
    writeDismissedVersion(state.info.version);
    dispatch({ type: "dismiss" });
  }, [state.info]);

  // Bootstrap: load current app version + run the first check after a
  // small delay so we don't compete with the rest of app startup.
  useEffect(() => {
    let cancelled = false;
    getVersion()
      .then((v) => {
        if (!cancelled) dispatch({ type: "currentVersion", v });
      })
      .catch((err) => console.warn("[updater] getVersion failed", err));

    const initial = window.setTimeout(() => {
      if (!cancelled) void recheck();
    }, FIRST_CHECK_DELAY_MS);

    const interval = window.setInterval(() => {
      if (!cancelled) void recheck();
    }, RECHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [recheck]);

  const value = useMemo<UpdaterApi>(
    () => ({ state, recheck, installAndRelaunch, dismiss }),
    [state, recheck, installAndRelaunch, dismiss],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUpdater(): UpdaterApi {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useUpdater must be used inside <UpdaterProvider>");
  }
  return ctx;
}

function readDismissedVersion(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeDismissedVersion(v: string) {
  try {
    window.localStorage.setItem(DISMISS_STORAGE_KEY, v);
  } catch {
    /* private mode / quota — silently ignore */
  }
}
