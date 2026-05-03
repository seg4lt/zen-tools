/**
 * Single source of truth for "which Tauri window am I rendering in?".
 *
 * The app has three webview windows defined in `tauri.conf.json`:
 *
 *   - **main**             — the full app window with router + tools
 *   - **pm-popover**       — the menu-bar Process-Monitor popover
 *                            (loads `index.html?window=pm-popover` so
 *                             `main.tsx` mounts `<MiniMonitorApp />`
 *                             instead of the full `<App />`)
 *   - **prmaster-popover** — the menu-bar PRMaster popover (loads `/`
 *                            with the Tauri window label set to
 *                            `prmaster-popover`; the router redirects
 *                            it to `/prmaster` and trims the title bar)
 *
 * Two different mechanisms historically detected these — `?window=`
 * query string for the PM popover (because `MiniMonitorApp` is a
 * separate React tree booted in `main.tsx` before any Tauri import is
 * available), and the Tauri window label for the PRMaster popover
 * (because by the time the router runs the bundle has loaded
 * `__TAURI_INTERNALS__`). This module unifies both behind one helper.
 *
 * Returns `"main"` for any non-Tauri host (e.g. Vite preview running
 * in a normal browser tab) so callers can treat that as the default.
 */

export type WindowKind = "main" | "pm-popover" | "prmaster-popover";

export function getWindowKind(): WindowKind {
  if (typeof window === "undefined") return "main";

  // 1. Process-Monitor popover: signalled via `?window=pm-popover`
  //    on the index URL. Cheap to read; works before Tauri's IPC
  //    bridge has injected `__TAURI_INTERNALS__`.
  try {
    const param = new URLSearchParams(window.location.search).get("window");
    if (param === "pm-popover") return "pm-popover";
  } catch {
    // `URLSearchParams` constructor can throw on really exotic URLs;
    // fall through to the Tauri-label probe.
  }

  // 2. PRMaster popover: signalled via the Tauri window label
  //    (`prmaster-popover`, declared in `tauri.conf.json`). The
  //    label sits on `__TAURI_INTERNALS__.metadata.currentWindow`
  //    once the Tauri runtime initialises the window.
  const label = (
    window as unknown as {
      __TAURI_INTERNALS__?: {
        metadata?: { currentWindow?: { label?: string } };
      };
    }
  ).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
  if (label === "prmaster-popover") return "prmaster-popover";

  return "main";
}

/** Convenience predicates for the call-sites that just want a boolean. */
export const isPmPopover = (): boolean => getWindowKind() === "pm-popover";
export const isPrmasterPopover = (): boolean =>
  getWindowKind() === "prmaster-popover";
/** True for either popover — used by the title bar to skip its chrome. */
export const isPopover = (): boolean => getWindowKind() !== "main";
