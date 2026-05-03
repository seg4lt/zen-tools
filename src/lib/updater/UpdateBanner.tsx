/**
 * Slim banner shown above the router whenever an update is available
 * and the user hasn't dismissed it for that exact version. Sits below
 * the title bar so it doesn't push the traffic-light region down.
 *
 * Two interactions:
 *   • "Install now" — kicks off `installAndRelaunch`. While downloading
 *     the banner stays mounted and shows live progress; when the install
 *     finishes Tauri relaunches the binary so this component goes with it.
 *   • "Dismiss" — hides the banner for the current version only; a newer
 *     version will surface again. Persisted via localStorage in the
 *     updater store so a hot-reload (or full app reopen) keeps it hidden.
 */

import { X } from "lucide-react";
import { useUpdater } from "./use-updater";

export function UpdateBanner() {
  const { state, installAndRelaunch, dismiss } = useUpdater();

  // Only render when there's something actionable to show. "available"
  // is the normal case; "downloading"/"installing" keep the banner up
  // so the user sees progress feedback inline.
  const showing =
    (state.status === "available" && !state.dismissed) ||
    state.status === "downloading" ||
    state.status === "installing";
  if (!showing || !state.info) return null;

  const pct = bytesToPercent(state.downloaded, state.contentLength);

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs">
      <span className="inline-block size-2 shrink-0 rounded-full bg-amber-400" />

      <div className="min-w-0 flex-1 truncate">
        {state.status === "available" && (
          <>
            <span className="font-medium">
              Update {state.info.version} available
            </span>
            {state.currentVersion ? (
              <span className="text-muted-foreground">
                {" "}
                · you have {state.currentVersion}
              </span>
            ) : null}
          </>
        )}
        {state.status === "downloading" && (
          <span className="font-medium">
            Downloading {state.info.version}
            {pct != null ? ` · ${pct}%` : "…"}
          </span>
        )}
        {state.status === "installing" && (
          <span className="font-medium">
            Installing {state.info.version}… app will relaunch
          </span>
        )}
      </div>

      {state.status === "available" && (
        <>
          <button
            type="button"
            onClick={() => void installAndRelaunch()}
            className="rounded-md border border-amber-500/50 bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium hover:bg-amber-500/30"
          >
            Install now
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss update notification"
            title="Dismiss until next release"
            className="rounded-md p-0.5 text-muted-foreground hover:bg-amber-500/20 hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

function bytesToPercent(downloaded: number, total: number | null): number | null {
  if (total == null || total <= 0) return null;
  return Math.min(100, Math.floor((downloaded / total) * 100));
}
