/**
 * Single source of truth for "which Tauri window am I rendering in?".
 *
 * Three webview windows can be alive at once:
 *
 *   - **main**             — the full app window with router + tools.
 *                            Declared in `tauri.conf.json`.
 *   - **pm-popover**       — the menu-bar Process-Monitor popover, lazy-
 *                            built by `tray.rs::build_popover` on tray
 *                            click and destroyed on dismiss/blur. Loads
 *                            `index.html?window=pm-popover` so
 *                            `main.tsx` mounts `<MiniMonitorApp />`
 *                            instead of the full `<App />`.
 *
 * The popovers are NOT pre-declared in `tauri.conf.json` — pre-declared
 * windows leak their WKWebView's `WebContent` subprocess for the app's
 * lifetime once summoned. Lazy build + destroy on dismiss frees the
 * subprocess every time the user clicks away (recipe ported from
 * flowstate's popout pattern).
 *
 * Window kinds are signalled by the `?window=` query string because
 * their dedicated React trees boot before any Tauri import is available.
 *
 * Returns `"main"` for any non-Tauri host (e.g. Vite preview running
 * in a normal browser tab) so callers can treat that as the default.
 */

export type WindowKind =
  | "main"
  | "pm-popover"
  | "dictation-hud";

export function getWindowKind(): WindowKind {
  if (typeof window === "undefined") return "main";

  // 1. Process-Monitor popover: signalled via `?window=pm-popover`
  //    on the index URL. Cheap to read; works before Tauri's IPC
  //    bridge has injected `__TAURI_INTERNALS__`.
  try {
    const param = new URLSearchParams(window.location.search).get("window");
    if (param === "pm-popover") return "pm-popover";
    if (param === "dictation-hud") return "dictation-hud";
  } catch {
    // `URLSearchParams` constructor can throw on really exotic URLs;
    // fall through to the Tauri-label probe.
  }

  return "main";
}

/** Convenience predicates for the call-sites that just want a boolean. */
export const isPmPopover = (): boolean => getWindowKind() === "pm-popover";
export const isDictationHud = (): boolean =>
  getWindowKind() === "dictation-hud";
/** True for either popover — used by the title bar to skip its chrome. */
export const isPopover = (): boolean => getWindowKind() !== "main";
