/**
 * Updates section for the Settings page.
 *
 * Shows the current app version, the result of the most recent
 * update check, and two actions:
 *   • "Check for updates" — runs `recheck()` from the updater store.
 *   • "Download and install" — only enabled when an update is
 *     available; runs `installAndRelaunch()`. While downloading the
 *     button morphs into a progress indicator.
 *
 * All state is read from the singleton `useUpdater` context, so the
 * yellow dot on the title-bar Settings icon and the banner above the
 * router stay in sync with what the user sees here.
 */

import { useUpdater } from "@/lib/updater/use-updater";

export function UpdateSection() {
  const { state, recheck, installAndRelaunch } = useUpdater();

  const checking = state.status === "checking";
  const downloading = state.status === "downloading";
  const installing = state.status === "installing";
  const available = state.status === "available";
  const upToDate = state.status === "up-to-date";
  const error = state.status === "error";

  const pct = bytesToPercent(state.downloaded, state.contentLength);

  return (
    <div className="flex flex-col gap-3">
      {/* Version + status line */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5 text-xs">
          <div>
            <span className="text-muted-foreground">Current version: </span>
            <span className="font-medium tabular-nums">
              {state.currentVersion ?? "—"}
            </span>
          </div>
          <StatusLine
            available={available}
            checking={checking}
            downloading={downloading}
            installing={installing}
            upToDate={upToDate}
            error={error}
            errorMsg={state.error}
            availableVersion={state.info?.version}
            pct={pct}
            lastCheckedAt={state.lastCheckedAt}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void recheck()}
            disabled={checking || downloading || installing}
            className="rounded-md border border-border/60 bg-card px-2.5 py-1 text-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:hover:bg-card disabled:hover:text-foreground"
          >
            {checking ? "Checking…" : "Check for updates"}
          </button>
          {available && (
            <button
              type="button"
              onClick={() => void installAndRelaunch()}
              disabled={downloading || installing}
              className="flex items-center gap-1 rounded-md border border-amber-500/50 bg-amber-500/15 px-2.5 py-1 text-xs font-medium hover:bg-amber-500/25 disabled:opacity-60"
            >
              <span className="inline-block size-1.5 rounded-full bg-amber-400" />
              Download and install
            </button>
          )}
          {(downloading || installing) && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {installing
                ? "Installing…"
                : pct != null
                  ? `${pct}%`
                  : "Downloading…"}
            </span>
          )}
        </div>
      </div>

      {/* Release notes for the available version (if the server set
          a `notes` field on latest.json). Tauri exposes this as `body`
          on the `Update` object — we surface the first 600 chars to
          keep the section compact. */}
      {available && state.info?.notes && (
        <div className="rounded-md border border-border/60 bg-background/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide">
            Release notes
          </div>
          <div className="whitespace-pre-wrap break-words">
            {truncate(state.info.notes, 600)}
          </div>
        </div>
      )}
    </div>
  );
}

interface StatusLineProps {
  available: boolean;
  checking: boolean;
  downloading: boolean;
  installing: boolean;
  upToDate: boolean;
  error: boolean;
  errorMsg: string | null;
  availableVersion: string | undefined;
  pct: number | null;
  lastCheckedAt: number | null;
}

function StatusLine(p: StatusLineProps) {
  if (p.checking) {
    return <span className="text-muted-foreground">Checking…</span>;
  }
  if (p.installing) {
    return (
      <span className="text-amber-500">
        Installing — the app will relaunch shortly.
      </span>
    );
  }
  if (p.downloading) {
    return (
      <span className="text-amber-500">
        Downloading {p.availableVersion}
        {p.pct != null ? ` · ${p.pct}%` : "…"}
      </span>
    );
  }
  if (p.available) {
    return (
      <span className="flex items-center gap-1 text-amber-500">
        <span className="inline-block size-1.5 rounded-full bg-amber-400" />
        Update available: {p.availableVersion}
      </span>
    );
  }
  if (p.upToDate) {
    return (
      <span className="text-emerald-500">
        Up to date{p.lastCheckedAt ? ` · checked ${fmtAgo(p.lastCheckedAt)}` : ""}
      </span>
    );
  }
  if (p.error) {
    return (
      <span className="text-red-500" title={p.errorMsg ?? undefined}>
        Check failed: {truncate(p.errorMsg ?? "unknown error", 120)}
      </span>
    );
  }
  return <span className="text-muted-foreground">Not yet checked.</span>;
}

function bytesToPercent(downloaded: number, total: number | null): number | null {
  if (total == null || total <= 0) return null;
  return Math.min(100, Math.floor((downloaded / total) * 100));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function fmtAgo(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}
