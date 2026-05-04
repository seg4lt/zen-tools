/**
 * Typed wrappers for the `tauri-plugin-ghostty` command surface.
 *
 * The plugin lives at `crates/tauri-plugin-ghostty/`. It owns a native
 * `GhosttyHostView` (NSView with a CAMetalLayer) per pane, the PTY,
 * scrollback, and the chrome-inset → window-content-frame feedback
 * loop. Frontend's job is reduced to:
 *
 *   1. Driving the lifecycle (new/focus/close pane).
 *   2. Pushing the current HTML-chrome inset whenever the layout changes
 *      so the native view is sized correctly.
 *   3. Telling the plugin not to close the host window when the last
 *      pane closes (zen-tools embeds the terminal as one tool among
 *      many — we don't want closing the last pane to kill the app).
 *
 * Every command goes through Tauri's plugin namespacing
 * (`plugin:ghostty|...`). The plugin emits four lifecycle events
 * (`tab:created`, `tab:focused`, `tab:closed`, `tab:title-changed`)
 * which the React store mirrors.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type Event as TauriEvent } from "@tauri-apps/api/event";

export interface PaneInfo {
  /** Plugin-side numeric tab id (1-based, monotonically allocated). */
  id: number;
  /** Title (typically the running command — e.g. "vim", "ssh foo"). */
  title: string;
  /** True for the pane currently visible inside the GhosttyHostView. */
  active: boolean;
}

export interface TerminalConfig {
  working_directory?: string;
  command?: string;
  font_size?: number;
}

export interface TabEventPayload {
  id: number;
  title?: string;
}

export interface ChromeInset {
  /** Distance in CSS points from the window's top edge. */
  top: number;
  /** Distance in CSS points from the window's right edge. */
  right: number;
  /** Distance in CSS points from the window's bottom edge. */
  bottom: number;
  /** Distance in CSS points from the window's left edge. */
  left: number;
}

/**
 * One-time bootstrap. Creates the GhosttyApp (process-singleton),
 * the first GhosttyHostView, attaches the first PTY-backed surface,
 * and returns the IDs. Subsequent panes go through `terminalNewTab`.
 *
 * Calling this twice is a programming error — the plugin's
 * `OnceLock<GhosttyApp>` will succeed only on the first call.
 */
export function terminalNew(config: TerminalConfig = {}) {
  return invoke<{ surface_id: number; tab_id: number }>(
    "plugin:ghostty|terminal_new",
    { config },
  );
}

/** Add a new pane to the existing tab container. */
export function terminalNewTab() {
  return invoke<{ tab_id: number }>("plugin:ghostty|terminal_new_tab");
}

/** Bring `tabId`'s NSView to the front; hides the previously active pane. */
export function terminalFocusTab(tabId: number) {
  return invoke<void>("plugin:ghostty|terminal_focus_tab", { tabId });
}

/** Free the surface for `tabId` and remove its NSView. */
export function terminalCloseTab(tabId: number) {
  return invoke<void>("plugin:ghostty|terminal_close_tab", { tabId });
}

/** Snapshot of every currently mounted pane. Used to adopt state on remount. */
export function terminalListTabs() {
  return invoke<PaneInfo[]>("plugin:ghostty|terminal_list_tabs");
}

/**
 * Push the HTML chrome insets to native side. The `top`/`right`/
 * `bottom`/`left` values are CSS-point distances from the window edges
 * — i.e. `top: 50` means "leave the top 50pt of the window to HTML;
 * the terminal NSView starts at y=50". On macOS CSS points map 1:1
 * to AppKit points, so no scaling is needed.
 *
 * Used in two ways:
 *
 *   * While the `/terminal` route is mounted: pushed continuously
 *     from a `ResizeObserver` so the NSView tracks layout changes
 *     (window resize, DPI change, tab bar appearance/disappearance).
 *
 *   * When the user navigates away from `/terminal`: a
 *     "collapse to nothing" inset is pushed so the NSView is no
 *     longer visible behind the other tab's HTML. The PTY keeps
 *     running — only the visible rect changes.
 */
export function terminalSetChromeInset(inset: ChromeInset) {
  // Spread into a plain object so the call satisfies Tauri's
  // `InvokeArgs = Record<string, unknown>` constraint without
  // forcing `[key: string]` onto `ChromeInset` itself.
  return invoke<void>("plugin:ghostty|terminal_set_chrome_inset", {
    top: inset.top,
    right: inset.right,
    bottom: inset.bottom,
    left: inset.left,
  });
}

/**
 * Embedding hosts MUST call this with `value: false` before any
 * pane is closed. Default behaviour is for the plugin to call
 * `app_handle.get_webview_window("main").close()` when the last
 * pane is closed — fine for a dedicated terminal app, fatal for
 * an embedded tab inside a multi-tool host like zen-tools.
 */
export function terminalSetCloseWindowOnLastTab(value: boolean) {
  return invoke<void>("plugin:ghostty|terminal_set_close_window_on_last_tab", {
    value,
  });
}

/**
 * Push the active color scheme to ghostty (`true` → Dark, `false` →
 * Light). Calls `ghostty_app_set_color_scheme` on the underlying
 * libghostty App, which immediately repaints every live surface in
 * the new scheme.
 *
 * libghostty reads the system appearance natively at `ghostty_app_new`
 * time, so the very first paint after `terminal_new` is correct
 * without us calling this. But:
 *
 *   1. The user may have a manual theme override in zen-tools'
 *      Settings (e.g. "Light" while macOS is in Dark Mode). Without a
 *      push at bootstrap, the terminal would render in the OS theme
 *      while the rest of zen-tools is in the user's chosen one.
 *   2. Ghostty does NOT re-read system appearance on its own, and the
 *      plugin's NSEvent monitor doesn't observe
 *      `AppleInterfaceThemeChangedNotification`. So a runtime
 *      OS-theme toggle would leave the terminal stuck on the boot-time
 *      scheme until the user relaunches.
 *
 * `TerminalStoreProvider` subscribes to `useTheme()` and calls this
 * whenever the resolved theme changes (and once on bootstrap). See
 * `store/terminal-store.tsx` for the wiring.
 */
export function terminalSetColorScheme(dark: boolean) {
  return invoke<void>("plugin:ghostty|terminal_set_color_scheme", { dark });
}

/**
 * Hide / show the macOS standard window buttons (close, minimize,
 * zoom — the traffic-light circles). Used by the terminal route
 * when entering / leaving distraction-free mode so even the
 * AppKit-painted controls disappear.
 *
 * Be careful to always pair `true` with a matching `false` —
 * leaving the buttons hidden across tool switches would strand the
 * user with no clickable affordance to close the window. The
 * `TerminalView` mount/unmount + DF-toggle effects handle this.
 *
 * Note: `cmd+W` and `cmd+Q` continue to work regardless. Hiding the
 * buttons is purely visual.
 */
export function terminalSetTrafficLightsHidden(hidden: boolean) {
  return invoke<void>("plugin:ghostty|terminal_set_traffic_lights_hidden", {
    hidden,
  });
}

// ---- Event listeners ------------------------------------------------------

/** Subscribe to a tab-lifecycle event. Returns the unlisten fn. */
export async function onTabCreated(
  handler: (p: TabEventPayload) => void,
): Promise<() => void> {
  return listen<TabEventPayload>("tab:created", (e: TauriEvent<TabEventPayload>) =>
    handler(e.payload),
  );
}

export async function onTabFocused(
  handler: (p: TabEventPayload) => void,
): Promise<() => void> {
  return listen<TabEventPayload>("tab:focused", (e: TauriEvent<TabEventPayload>) =>
    handler(e.payload),
  );
}

export async function onTabClosed(
  handler: (p: TabEventPayload) => void,
): Promise<() => void> {
  return listen<TabEventPayload>("tab:closed", (e: TauriEvent<TabEventPayload>) =>
    handler(e.payload),
  );
}

export async function onTabTitleChanged(
  handler: (p: TabEventPayload) => void,
): Promise<() => void> {
  return listen<TabEventPayload>(
    "tab:title-changed",
    (e: TauriEvent<TabEventPayload>) => handler(e.payload),
  );
}
