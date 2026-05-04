/**
 * Terminal route view.
 *
 * The terminal *content* is rendered by a native macOS NSView
 * (GhosttyHostView, owned by `tauri-plugin-ghostty`). That NSView is
 * attached as a subview of the Tauri window's `contentView`, sitting
 * **below** the WKWebView in the compositor stack. The WKWebView paints
 * a transparent overlay with the inner pane-tab strip; clicks fall
 * through to the NSView via `pointer-events: none` (scoped to this
 * route only — see `terminal.css` and the `<body>` class toggle below).
 *
 * Responsibilities of this React component:
 *
 *   1. Trigger the one-time plugin bootstrap on first visit.
 *   2. Push the chrome inset (top/right/bottom/left distances from
 *      window edges, in CSS points) to native side via a
 *      `ResizeObserver`. The plugin uses this to size the NSView's
 *      tab container so it doesn't render under the title bar or
 *      pane-tab strip.
 *   3. On unmount (user navigates to another tool), push a
 *      "collapse-to-empty" inset so the NSView is invisible behind
 *      the next tab's HTML. The PTY keeps running in the background
 *      — switching back is instant.
 *   4. Render the inner pane-tab strip + "+" button + pane close
 *      buttons. These are the only HTML elements that need clicks,
 *      so they get `pointer-events: auto` via the
 *      `.terminal-chrome` carve-out.
 */

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useDistractionFree } from "./store/distraction-free";
import { useTerminalStore } from "./store/terminal-store";
import {
  terminalCloseTab,
  terminalFocusTab,
  terminalNewTab,
  terminalSetChromeInset,
  type ChromeInset,
} from "./lib/tauri";
import "./terminal.css";

const HIDDEN_INSET: ChromeInset = {
  // Push the top edge past the bottom of any conceivable window so
  // the resulting tab-container rect has zero height. The plugin
  // clamps negatives but happily accepts oversized values.
  top: 99_999,
  right: 0,
  bottom: 0,
  left: 0,
};

export function TerminalView() {
  const { panes, activeId, ensureBootstrapped } = useTerminalStore();
  const { enabled: dfEnabled, toggle: toggleDF } = useDistractionFree();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tabBarRef = useRef<HTMLDivElement | null>(null);
  // The "growth area" div BELOW the tab bar — its top edge is where
  // the NSView should start. We measure THIS, not the route container,
  // because the route container's top doesn't change when the tab bar
  // appears inside it (the bar is a flex child) — but we DO want the
  // NSView to be pushed down by the bar's height when it shows.
  // Measuring the growth area gets that for free.
  const growthRef = useRef<HTMLDivElement | null>(null);
  const lastInset = useRef<ChromeInset>({ top: -1, right: -1, bottom: -1, left: -1 });

  // ── Bootstrap on first mount ──────────────────────────────────────
  useEffect(() => {
    void ensureBootstrapped();
  }, [ensureBootstrapped]);

  // ── Distraction-free toggle (cmd+opt+f) ──────────────────────────
  // The plugin's NSEvent monitor catches the chord on the native side
  // (works regardless of WKWebView vs NSView focus) and emits the
  // `terminal:host-key-hook:cmd-opt-f` Tauri event. We toggle on
  // every event — the plugin guarantees one event per press.
  //
  // Subscribed in TerminalView (not at app shell) because there's no
  // good reason to react to the chord while the user isn't on the
  // /terminal route — and the listener naturally torn down on unmount
  // means switching away unbinds.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const u = await listen("terminal:host-key-hook:cmd-opt-f", () => {
        toggleDF();
      });
      if (cancelled) u();
      else unlisten = u;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [toggleDF]);

  // ── Hand focus to the GhosttyHostView ────────────────────────────
  // Without this, when the user navigates from another tool to
  // /terminal, the WKWebView stays first responder — every keystroke
  // (including ghostty's `cmd+t` "new tab" shortcut) goes to wry/tao
  // and never reaches ghostty's keybind dispatcher. The native side
  // makes the host view first responder inside `GhosttyTabFocus`
  // (`GhosttyHostView.m:947`), so we just route through there.
  //
  // The original tauri-terminal app sidestepped this entirely because
  // `body { pointer-events: none }` was global from app start — the
  // very first click anywhere in the window went straight to the
  // NSView and made it first responder. zen-tools has clickable HTML
  // in every other route, so we only enable click-through on
  // /terminal — and the user arrives here via clicking a pill in the
  // title bar (focus stays on the webview), not by clicking the
  // terminal area first. The explicit focus call closes that gap.
  //
  // Re-runs whenever `activeId` changes (a new pane was just spawned
  // or the user focused a different one) so focus follows the active
  // pane.
  useEffect(() => {
    if (activeId == null) return;
    void terminalFocusTab(activeId).catch((e) =>
      console.error("[terminal] focus_tab failed:", e),
    );
  }, [activeId]);

  // ── pointer-events scoping ────────────────────────────────────────
  // We can't apply `pointer-events: none` globally — every other tool
  // tab needs HTML clicks. Toggle a body class on mount so the CSS
  // rule in terminal.css only takes effect while this route is alive.
  useEffect(() => {
    document.body.classList.add("terminal-route-active");
    return () => {
      document.body.classList.remove("terminal-route-active");
    };
  }, []);

  // ── Chrome-inset feedback loop ────────────────────────────────────
  // Measure the route container's distance from each window edge in
  // CSS points (1:1 with AppKit points on macOS), and push it to the
  // plugin whenever it changes. The plugin's
  // `commands::terminal_set_chrome_inset` re-frames the native tab
  // container to fit inside `contentView.bounds` minus the inset.
  //
  // `push` is captured into a ref so the distraction-free effect
  // below can trigger a fresh measurement when DF toggles (the
  // ResizeObserver only catches *element* size changes; toggling
  // DF removes the TitleBar from the DOM which moves the growth
  // area's top edge — but the growth element's own size may not
  // change in a way the observer notices until the layout settles).
  const pushInsetRef = useRef<() => void>(() => {});
  useEffect(() => {
    const push = () => {
      // Measure the GROWTH AREA (the div below the tab bar), not the
      // route container. When the tab bar appears, the growth area's
      // top edge moves down by the bar's height — which is exactly
      // where the NSView should start. The original tauri-terminal
      // app uses the same trick (`bar.getBoundingClientRect().height`
      // as the top inset; HTML below the bar = NSView area).
      //
      // Falls back to the route container if the growth ref isn't
      // mounted yet (shouldn't happen after first paint).
      const el = growthRef.current ?? containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const inset: ChromeInset = {
        top: Math.max(0, Math.round(rect.top)),
        left: Math.max(0, Math.round(rect.left)),
        right: Math.max(0, Math.round(window.innerWidth - rect.right)),
        bottom: Math.max(0, Math.round(window.innerHeight - rect.bottom)),
      };
      // Skip duplicate pushes — `getBoundingClientRect` fires on every
      // ResizeObserver tick but the value rarely changes.
      const last = lastInset.current;
      if (
        inset.top === last.top &&
        inset.left === last.left &&
        inset.right === last.right &&
        inset.bottom === last.bottom
      ) {
        return;
      }
      lastInset.current = inset;
      void terminalSetChromeInset(inset).catch((e) =>
        console.error("[terminal] set_chrome_inset failed:", e),
      );
    };
    pushInsetRef.current = push;

    push();
    // Watch BOTH the growth area (its top moves when the tab bar
    // appears or disappears — that's the trigger for an inset update)
    // AND the route container (catches window resize, DPI change,
    // outer chrome changes). Plus the window for fullscreen / global
    // layout shifts.
    const ro = new ResizeObserver(push);
    if (growthRef.current) ro.observe(growthRef.current);
    if (containerRef.current) ro.observe(containerRef.current);
    if (tabBarRef.current) ro.observe(tabBarRef.current);
    window.addEventListener("resize", push);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", push);
      pushInsetRef.current = () => {};
      // Hide the NSView when the user navigates away. Reset the
      // dedupe cache so the next mount always re-pushes.
      lastInset.current = { top: -1, right: -1, bottom: -1, left: -1 };
      void terminalSetChromeInset(HIDDEN_INSET).catch((e) =>
        console.error("[terminal] set_chrome_inset (hide) failed:", e),
      );
    };
  }, []);

  // ── DF-triggered inset re-push ───────────────────────────────────
  // Toggling DF mounts/unmounts the host TitleBar, which moves the
  // growth area's top edge by ~50pt but doesn't necessarily resize
  // the growth element itself in a way the ResizeObserver above
  // catches in the same tick. requestAnimationFrame defers the
  // measurement to after React has flushed the new layout — by that
  // point `getBoundingClientRect().top` reflects the post-toggle
  // position and the inset push lines the NSView up correctly.
  useEffect(() => {
    const id = requestAnimationFrame(() => pushInsetRef.current());
    return () => cancelAnimationFrame(id);
  }, [dfEnabled]);

  // The pane-tab strip is hidden when there's only one pane — matches
  // the prototype's behaviour exactly (see
  // `tauri-terminal/packages/ui/src/main.ts` line 80-83). With a
  // single shell open, no HTML chrome is needed; new panes get
  // spawned via ghostty's built-in keyboard shortcut (cmd+T by
  // default), and the bar slides back in as soon as the second
  // pane appears.
  const showTabBar = panes.length > 1;

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 w-full flex-col"
      // The container itself must NOT receive clicks — clicks on the
      // empty area need to reach the NSView below. The pane-tab strip
      // re-enables pointer events via `.terminal-chrome` (see
      // terminal.css).
    >
      {showTabBar && (
        <div
          ref={tabBarRef}
          className="terminal-chrome terminal-tab-bar"
          role="tablist"
          aria-label="Terminal panes"
        >
          <div className="terminal-tab-list">
            {panes.map((pane) => (
              <button
                key={pane.id}
                type="button"
                role="tab"
                aria-selected={pane.id === activeId}
                onClick={() => {
                  void terminalFocusTab(pane.id);
                }}
                className={`terminal-tab${pane.id === activeId ? " is-active" : ""}`}
              >
                <span className="terminal-tab__label">
                  {pane.title || "shell"}
                </span>
                <span
                  role="button"
                  aria-label="Close pane"
                  title="Close pane"
                  className="terminal-tab__close"
                  onClick={(e) => {
                    e.stopPropagation();
                    void terminalCloseTab(pane.id);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="New pane"
            title="New pane"
            className="terminal-tab-add"
            onClick={() => {
              void terminalNewTab();
            }}
          >
            +
          </button>
        </div>
      )}

      {/* Empty growth area — the NSView paints behind it. We do NOT
          render any visible HTML here; that would block the GPU
          surface. The element exists only so the ResizeObserver has
          something to measure (its top edge = where the NSView
          should start; its bottom = where the NSView should end). */}
      <div ref={growthRef} className="flex-1" aria-hidden />
    </div>
  );
}
