// commands.rs — Tauri command surface.
//
// AppKit & libghostty are main-thread-only. Tauri commands run on a
// thread pool, so any code that touches NSWindow / NSView / ghostty
// surface APIs MUST hop onto the main thread first via
// `window.run_on_main_thread(...)`. We use a `std::sync::mpsc::channel`
// to plumb results back synchronously.

use crate::{
    macos,
    state::{PluginState, SurfaceId, TabId, TabState},
};
use ghostty_rs::{App, Config, RuntimeCallbacks, SurfaceConfig, View};
use serde::{Deserialize, Serialize};
use std::ffi::{c_char, c_void, CStr};
use std::sync::mpsc;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager, State, Window, Wry};

#[derive(Debug, Default, Deserialize)]
pub struct TerminalNewConfig {
    pub working_directory: Option<String>,
    pub command: Option<String>,
    pub font_size: Option<f32>,
}

#[derive(Debug, Serialize)]
pub struct TerminalNewResult {
    pub surface_id: SurfaceId,
    pub tab_id: TabId,
}

const TERMINAL_STATUS_EVENT: &str = "terminal:status";

#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
enum TerminalProgressStateWire {
    Remove,
    Set,
    Error,
    Indeterminate,
    Pause,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum TerminalStatusPayload {
    Progress {
        id: TabId,
        state: TerminalProgressStateWire,
        progress: Option<i8>,
    },
    CommandFinished {
        id: TabId,
        exit_code: Option<i16>,
        duration_ns: u64,
    },
    Bell {
        id: TabId,
    },
    Interaction {
        id: TabId,
    },
    DesktopNotification {
        id: TabId,
        title: Option<String>,
        body: Option<String>,
    },
    ChildExited {
        id: TabId,
        exit_code: u32,
        runtime_ms: u64,
    },
    RendererHealth {
        id: TabId,
        healthy: bool,
    },
}

#[tauri::command]
pub fn terminal_new(
    window: Window<Wry>,
    app_handle: AppHandle<Wry>,
    state: State<'_, PluginState>,
    config: Option<TerminalNewConfig>,
) -> Result<TerminalNewResult, String> {
    let config = config.unwrap_or_default();
    let launch_directory = config.working_directory.clone();

    // Lazy-init the GhosttyApp on the main thread. (Even ghostty_app_new
    // can fire AppKit-style notifications during init.)
    {
        let mut inner = state.inner.lock();
        if inner.app.is_none() {
            let app = run_on_main(&window, |_| create_app())
                .map_err(|e| format!("create_app: {e}"))?
                .map_err(|e| e.to_string())?;
            inner.app = Some(app);
            // Default — close window when user closes the last tab.
            // Embedders override via terminal_set_close_window_on_last_tab.
            inner.close_window_on_last_tab = true;
        }
    }

    let scale = window
        .scale_factor()
        .map_err(|e| format!("scale_factor: {e}"))?;

    let surface_cfg = SurfaceConfig {
        scale_factor: scale,
        // 0.0 means "use ghostty's config default" — keeps every pane
        // and every tab spawned later at the same starting font size.
        font_size: config.font_size.unwrap_or(0.0),
        working_directory: launch_directory.clone(),
        command: config.command.clone(),
        initial_input: None,
        wait_after_command: false,
        context: ghostty_rs::SurfaceContext::Window,
    };

    let app_handle_for_main = app_handle.clone();
    let app_handle_for_setup = app_handle.clone();
    let result = run_on_main(&window, move |w| {
        let ns_window = w.ns_window().map_err(|e| format!("ns_window: {e}"))?;
        if ns_window.is_null() {
            return Err("ns_window returned null".into());
        }
        // Disarm tao/wry's panic-prone Cmd-key paths on macOS 26.
        unsafe { macos::disarm_wry_parent_key_down() };
        unsafe { macos::disarm_tao_send_event() };

        // Make sure the tab container is mounted on the window.
        let container = unsafe { macos::ensure_tab_container(ns_window) };
        if container.is_null() {
            return Err("ensure_tab_container returned null".into());
        }

        // Install the tab event + action callbacks once. They live for
        // the process lifetime; the Tauri AppHandle is captured in a
        // OnceLock so the C trampolines can find their way back.
        APP_HANDLE_FOR_TABS.set(app_handle_for_setup.clone()).ok();
        unsafe {
            macos::register_tab_event_callback(tab_event_trampoline);
            macos::register_tab_action_callback(tab_action_trampoline);
            macos::register_host_key_hook_callback(host_key_hook_trampoline);
            macos::register_reload_config_callback(reload_config_trampoline);
            macos::register_terminal_status_event_callback(terminal_status_event_trampoline);
        }

        // Allocate the first GhosttyHostView for this terminal.
        let frame = unsafe { container_bounds(container) };
        let host_view = unsafe { macos::create_host_view(frame) };
        if host_view.is_null() {
            return Err("create_host_view returned null".into());
        }

        let state = app_handle_for_main.state::<PluginState>();
        let mut inner = state.inner.lock();
        let app = inner.app.as_ref().ok_or_else(|| "ghostty app missing".to_string())?;
        let view = unsafe { View::new(app, host_view, surface_cfg) }
            .map_err(|e| format!("ghostty_surface_new: {e}"))?;
        unsafe { macos::set_surface(host_view, view.raw() as *mut c_void) };

        // Mount the host_view as a new tab. ObjC emits TAB_EVENT_CREATED +
        // TAB_EVENT_FOCUSED via our trampoline.
        let tab_id = unsafe { macos::tab_add(host_view) };

        // Bookkeeping in Rust.
        let surface_id = inner.new_surface_id();
        inner.surfaces.insert(surface_id, view);
        inner.tabs.push(TabState {
            id: tab_id,
            surfaces: vec![surface_id],
            title: String::new(),
            cwd: launch_directory.clone(),
            launch_directory: launch_directory.clone(),
        });

        // Install the application-level Cmd-key monitor (idempotent).
        unsafe {
            macos::install_event_monitor(
                inner.surfaces.get(&surface_id).unwrap().raw() as *mut c_void,
            )
        };

        Ok::<_, String>((surface_id, tab_id))
    })
    .map_err(|e| format!("run_on_main: {e}"))??;

    let (surface_id, tab_id) = result;
    Ok(TerminalNewResult { surface_id, tab_id })
}

#[tauri::command]
pub fn terminal_set_color_scheme(
    window: tauri::Window<Wry>,
    state: State<'_, PluginState>,
    dark: bool,
) -> Result<(), String> {
    // Two layers of internal state need to flip in lockstep, or
    // either existing-pane or future-pane rendering goes stale:
    //
    // 1. **App.config_conditional_state.theme** — read by
    //    `ghostty_surface_new` (Surface.zig:606,
    //    `.config_conditional_state = app.config_conditional_state`)
    //    when allocating a fresh surface. If this is wrong, every
    //    newly spawned tab / split starts in the boot-time theme
    //    regardless of what the user has toggled to since.
    //    Updated via `ghostty_app_set_color_scheme`.
    //
    // 2. **Surface.config_conditional_state.theme** — applied by
    //    `Surface.updateConfig` to derive the actual palette. The
    //    App-level call does NOT cascade here (`App.updateConfig`
    //    hands each surface the original config and asks the surface
    //    to apply its own state). If this is stale, currently-open
    //    panes never visibly re-theme even after a config reload.
    //    Updated via per-surface `ghostty_surface_set_color_scheme`.
    //
    // For (2) we MUST NOT iterate `inner.surfaces` — that map only
    // tracks surfaces created via `terminal_new` /
    // `terminal_new_tab` (the Rust path that wraps each surface in
    // a `View`). Splits are created entirely on the C side from
    // `perform_new_split` in `GhosttyHostView.m` and are not
    // round-tripped through Rust state. Iterating only Rust-tracked
    // surfaces would miss every split pane.
    //
    // The fix: hand off to the C-side `GhosttySetColorSchemeAll`
    // which walks the actual NSView tree (every `GhosttyHostView`
    // under the tab container) and calls
    // `ghostty_surface_set_color_scheme` on each live surface.
    //
    // Both the app-level call and the tree-walking surface call
    // fire `RELOAD_CONFIG` apprt actions; the trampoline at
    // `reload_config_trampoline` defers each via
    // `run_on_main_thread`, rebuilds the Config, and calls
    // `App::update_config` which propagates to all surfaces.
    //
    // Re-entrancy hazard: ghostty fires `RELOAD_CONFIG` synchronously
    // on the calling thread. We must NOT hold `PluginState.inner`
    // when invoking either FFI (the trampoline tries to lock the
    // same mutex). Snapshot the App pointer as `usize` (Send-safe
    // for the queued closure), drop the lock, then dispatch.
    let app_ptr_usize: Option<usize> = {
        let inner = state.inner.lock();
        inner.app.as_ref().map(|a| a.raw() as usize)
    };

    if app_ptr_usize.is_none() {
        // ghostty_app hasn't been allocated yet (terminal_new
        // hasn't run). Not an error — the React `[bootstrapped]`
        // effect will re-fire immediately after bootstrap, calling
        // us again with a non-null app.
        return Ok(());
    }

    let mode_dark = dark;
    window
        .run_on_main_thread(move || {
            let mode = if mode_dark {
                ghostty_sys::ghostty_color_scheme_e_GHOSTTY_COLOR_SCHEME_DARK
            } else {
                ghostty_sys::ghostty_color_scheme_e_GHOSTTY_COLOR_SCHEME_LIGHT
            };

            // (1) App-level: updates App.config_conditional_state
            // so future ghostty_surface_new calls inherit the right
            // theme. Fires app-scope RELOAD_CONFIG (handled by the
            // trampoline → main-thread-deferred App::update_config).
            if let Some(app_ptr) = app_ptr_usize {
                let app = app_ptr as *mut std::ffi::c_void;
                unsafe { ghostty_sys::ghostty_app_set_color_scheme(app, mode) };
            }

            // (2) Walk every live GhosttyHostView under the tab
            // container and call set_color_scheme on its surface.
            // Catches split-created panes that aren't tracked in
            // Rust state. Returns the count for diagnostics.
            let n = unsafe { macos::set_color_scheme_all(mode_dark) };
            tracing::debug!(panes = n, dark = mode_dark, "ghostty: pushed color scheme to all live panes");
        })
        .map_err(|e| format!("run_on_main: {e}"))?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SplitDirection {
    Right,
    Down,
    Left,
    Up,
}

impl From<SplitDirection> for ghostty_rs::SplitDirection {
    fn from(d: SplitDirection) -> Self {
        match d {
            SplitDirection::Right => ghostty_rs::SplitDirection::Right,
            SplitDirection::Down => ghostty_rs::SplitDirection::Down,
            SplitDirection::Left => ghostty_rs::SplitDirection::Left,
            SplitDirection::Up => ghostty_rs::SplitDirection::Up,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GotoSplit {
    Previous,
    Next,
    Up,
    Down,
    Left,
    Right,
}

impl From<GotoSplit> for ghostty_rs::GotoSplit {
    fn from(d: GotoSplit) -> Self {
        match d {
            GotoSplit::Previous => ghostty_rs::GotoSplit::Previous,
            GotoSplit::Next => ghostty_rs::GotoSplit::Next,
            GotoSplit::Up => ghostty_rs::GotoSplit::Up,
            GotoSplit::Down => ghostty_rs::GotoSplit::Down,
            GotoSplit::Left => ghostty_rs::GotoSplit::Left,
            GotoSplit::Right => ghostty_rs::GotoSplit::Right,
        }
    }
}

#[tauri::command]
pub fn terminal_split(
    state: State<'_, PluginState>,
    surface_id: SurfaceId,
    direction: SplitDirection,
) -> Result<(), String> {
    let inner = state.inner.lock();
    let view = inner
        .surfaces
        .get(&surface_id)
        .ok_or_else(|| format!("unknown surface_id {}", surface_id))?;
    view.split(direction.into());
    Ok(())
}

#[tauri::command]
pub fn terminal_focus_split(
    state: State<'_, PluginState>,
    surface_id: SurfaceId,
    direction: GotoSplit,
) -> Result<(), String> {
    let inner = state.inner.lock();
    let view = inner
        .surfaces
        .get(&surface_id)
        .ok_or_else(|| format!("unknown surface_id {}", surface_id))?;
    view.split_focus(direction.into());
    Ok(())
}

// ---- Tabs ---------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct TabInfo {
    pub id: TabId,
    pub title: String,
    pub active: bool,
    pub cwd_absolute_path: Option<String>,
    pub launch_directory: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TerminalNewTabResult {
    pub tab_id: TabId,
}

/// Spawn a brand-new tab. Inherits cwd/env from the focused surface
/// (if any), otherwise uses ghostty's defaults.
#[tauri::command]
pub fn terminal_new_tab(
    window: Window<Wry>,
    app_handle: AppHandle<Wry>,
    config: Option<TerminalNewConfig>,
) -> Result<TerminalNewTabResult, String> {
    let config = config.unwrap_or_default();
    let scale = window
        .scale_factor()
        .map_err(|e| format!("scale_factor: {e}"))?;

    let app_handle_for_main = app_handle.clone();
    let tab_id = run_on_main(&window, move |w| {
        let ns_window = w.ns_window().map_err(|e| format!("ns_window: {e}"))?;
        if ns_window.is_null() {
            return Err("ns_window returned null".into());
        }
        let container = unsafe { macos::ensure_tab_container(ns_window) };
        spawn_tab_native(&app_handle_for_main, container, scale, config)
    })
    .map_err(|e| format!("run_on_main: {e}"))??;

    Ok(TerminalNewTabResult { tab_id })
}

#[tauri::command]
pub fn terminal_focus_tab(
    window: Window<Wry>,
    tab_id: TabId,
) -> Result<bool, String> {
    let ok = run_on_main(&window, move |_| unsafe { macos::tab_focus(tab_id) })
        .map_err(|e| format!("run_on_main: {e}"))?;
    Ok(ok)
}

#[tauri::command]
pub fn terminal_close_tab(
    window: Window<Wry>,
    app_handle: AppHandle<Wry>,
    tab_id: TabId,
) -> Result<bool, String> {
    let app_handle_for_main = app_handle.clone();
    let r = run_on_main(&window, move |_| {
        close_tab_native(&app_handle_for_main, tab_id)
    })
    .map_err(|e| format!("run_on_main: {e}"))??;
    Ok(r)
}

#[tauri::command]
pub fn terminal_list_tabs(state: State<'_, PluginState>) -> Result<Vec<TabInfo>, String> {
    let active = unsafe { macos::tab_active_id() };
    let inner = state.inner.lock();
    let infos = inner
        .tabs
        .iter()
        .map(|t| TabInfo {
            id: t.id,
            title: t.title.clone(),
            active: t.id == active,
            cwd_absolute_path: t.cwd.clone(),
            launch_directory: t.launch_directory.clone(),
        })
        .collect();
    Ok(infos)
}

/// Set the chrome insets — called by the HTML layer whenever the tab
/// bar's measured dimensions change. Units are CSS points.
#[tauri::command]
pub fn terminal_set_chrome_inset(
    window: Window<Wry>,
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
) -> Result<(), String> {
    run_on_main(&window, move |_| unsafe {
        macos::tab_container_set_chrome_inset(top, right, bottom, left);
    })
    .map_err(|e| format!("run_on_main: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn terminal_set_close_window_on_last_tab(
    state: State<'_, PluginState>,
    enabled: bool,
) -> Result<(), String> {
    let mut inner = state.inner.lock();
    inner.close_window_on_last_tab = enabled;
    Ok(())
}

/// Hide or show the macOS standard window buttons (close / minimize /
/// zoom). Used by the React `/terminal` route to enter true
/// distraction-free mode where even the AppKit-painted controls
/// disappear. Toggling back un-hides them.
#[tauri::command]
pub fn terminal_set_traffic_lights_hidden(
    window: Window<Wry>,
    hidden: bool,
) -> Result<(), String> {
    run_on_main(&window, move |w| {
        if let Ok(ns_window) = w.ns_window() {
            if !ns_window.is_null() {
                unsafe { macos::set_traffic_lights_hidden(ns_window, hidden) };
            }
        }
    })
    .map_err(|e| format!("run_on_main: {e}"))?;
    Ok(())
}

// ---- Internals ----------------------------------------------------------

fn create_app() -> ghostty_rs::Result<App> {
    // Point ghostty at its resource bundle (themes, terminfo, shell integration)
    // BEFORE calling any config API. `ghostty_config_finalize` resolves
    // named themes (e.g. `theme = dark:Cursor Dark,light:CLRS`) by looking in
    // the resources directory — if the env var is unset the lookup silently
    // fails and the user's config settings are discarded.
    //
    // We set this once per process via OnceLock. Priority:
    //   1. GHOSTTY_RESOURCES_DIR already set by the user/environment → keep it.
    //   2. Native Ghostty.app bundle (user probably installed Ghostty already).
    //   3. A dev-build install path recorded at compile time by ghostty-sys.
    ensure_ghostty_resources_dir();

    let mut config = Config::new()?;
    config.load_default_files();
    apply_zen_tools_overrides(&mut config);
    config.finalize();

    // v1 callbacks: ghostty's wakeup is a no-op for now (we'll wire it
    // through `app_handle.run_on_main_thread` once the first shell
    // renders and we can observe what tick latency looks like).
    let callbacks = RuntimeCallbacks::no_op();

    App::new(config, callbacks)
}

/// Write a small overrides file to a temp path and load it AFTER
/// `load_default_files`, so the override values win in ghostty's
/// last-write-wins parser.
///
/// We override:
///
///   * `window-padding-balance = true` — by default ghostty dumps
///     all sub-cell residual into the bottom-and-right padding,
///     producing a visible strip of background pixels at the bottom
///     edge of the cell grid that's especially noticeable on
///     non-integer-multiple window heights. Balancing splits the
///     residual evenly across all four sides so the gap shrinks
///     in half AND lands where the eye expects breathing room
///     (top + bottom equally) rather than as an asymmetric strip
///     at the bottom alone.
///
///   * `window-padding-y = 0` — removes ghostty's default 2-px
///     vertical padding. With balance on the residual already gives
///     us breathing room; the explicit padding is redundant in our
///     embedded layout where the React title bar already provides
///     the visual gutter at the top.
///
///   * `scrollback-limit = 2000000` — cap scrollback at 2 MB per
///     terminal surface. Upstream's default is 10 MB per surface,
///     which adds up quickly when multiple tabs or split panes stay
///     alive in the background for long-running tasks.
///
///   * `image-storage-limit = 64000000` — cap Kitty graphics/image
///     storage at 64 MB per screen instead of the 320 MB upstream
///     default. This significantly reduces worst-case resident
///     memory when tools emit image-heavy terminal output.
///
///   * `notify-on-command-finish = always` plus
///     `notify-on-command-finish-action = no-bell,notify` and
///     `notify-on-command-finish-after = 0s` — make command-finish
///     notifications available for every completed command in the
///     embedded terminal without relying on the user's external
///     Ghostty config, while avoiding an audible bell spam.
///
/// Failure modes are non-fatal: if the temp file can't be written,
/// or `load_file` fails, the user just keeps ghostty's defaults.
/// This is purely a polish step and we don't want to block the app
/// from starting on a bad I/O day.
fn apply_zen_tools_overrides(config: &mut Config) {
    let body = "window-padding-balance = true\n\
window-padding-y = 0\n\
scrollback-limit = 2000000\n\
image-storage-limit = 64000000\n\
notify-on-command-finish = always\n\
notify-on-command-finish-action = no-bell,notify\n\
notify-on-command-finish-after = 0s\n";
    let dir = std::env::temp_dir();
    // Bundle-id-namespaced filename so multiple installs / dev
    // builds don't collide on the same file.
    let path = dir.join("zen-tools-ghostty-overrides.conf");
    if let Err(e) = std::fs::write(&path, body) {
        tracing::warn!(
            error = %e,
            path = %path.display(),
            "ghostty: failed to write padding override file; using defaults"
        );
        return;
    }
    if let Err(e) = config.load_file(&path) {
        tracing::warn!(
            error = ?e,
            path = %path.display(),
            "ghostty: failed to load padding override file; using defaults"
        );
    }
}

/// Set `GHOSTTY_RESOURCES_DIR` once per process so ghostty can resolve
/// built-in themes, shell-integration scripts, and terminfo at runtime.
///
/// Only runs when the env var is not already set. Candidates are tried in
/// order; the first one whose directory actually exists wins:
///
///   1. `/Applications/Ghostty.app/Contents/Resources/ghostty`
///      (native Ghostty app installed by the user — has themes, terminfo, etc.)
///   2. `GHOSTTY_RESOURCES_DIR_BUILDTIME` (compile-time const embedded by
///      `ghostty-sys/build.rs` pointing at the zig-build install output).
///      Valid for `cargo tauri dev` only; the path doesn't exist in a
///      production .app bundle.
///   3. `~/Applications/Ghostty.app/Contents/Resources/ghostty`
///      (user-local install location on some macOS setups).
pub fn ensure_ghostty_resources_dir() {
    use std::sync::OnceLock;
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        // If the caller already set it, leave it alone.
        if std::env::var_os("GHOSTTY_RESOURCES_DIR").is_some() {
            return;
        }

        let candidates: &[&str] = &[
            "/Applications/Ghostty.app/Contents/Resources/ghostty",
            // Compile-time path from ghostty-sys build.rs (dev builds only).
            option_env!("GHOSTTY_RESOURCES_DIR_BUILDTIME").unwrap_or(""),
        ];

        // Also check ~/Applications/Ghostty.app (user-scoped installs).
        let home_candidate: Option<String> = std::env::var("HOME").ok().map(|h| {
            format!("{h}/Applications/Ghostty.app/Contents/Resources/ghostty")
        });

        for candidate in candidates
            .iter()
            .map(|s| s.to_string())
            .chain(home_candidate)
        {
            if candidate.is_empty() {
                continue;
            }
            if std::path::Path::new(&candidate).is_dir() {
                tracing::info!(path = %candidate, "ghostty: using resources dir");
                // SAFETY: single-threaded at this point (ghostty_app_new hasn't
                // been called yet). OnceLock ensures we only write once.
                #[allow(unused_unsafe)]
                unsafe {
                    std::env::set_var("GHOSTTY_RESOURCES_DIR", &candidate);
                }
                return;
            }
        }

        tracing::warn!(
            "ghostty: no resources dir found; named themes (e.g. `theme = dark:Cursor Dark`) \
             will not load. Install Ghostty.app or set GHOSTTY_RESOURCES_DIR."
        );
    });
}

fn run_on_main<F, T>(window: &Window<Wry>, f: F) -> tauri::Result<T>
where
    F: FnOnce(&Window<Wry>) -> T + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = mpsc::sync_channel::<T>(1);
    let win = window.clone();
    window.run_on_main_thread(move || {
        let r = f(&win);
        let _ = tx.send(r);
    })?;
    Ok(rx.recv().expect("main-thread closure dropped without sending"))
}

unsafe fn container_bounds(container: *mut c_void) -> objc2_foundation::NSRect {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let v = container as *mut AnyObject;
    msg_send![v, bounds]
}

/// Allocate a GhosttyHostView + ghostty_surface_t and mount as a new
/// tab. `container` is the NSView returned by `ensure_tab_container`.
/// MUST run on main.
fn spawn_tab_native(
    app_handle: &AppHandle<Wry>,
    container: *mut c_void,
    scale: f64,
    config: TerminalNewConfig,
) -> Result<TabId, String> {
    let frame = unsafe { container_bounds(container) };
    let host_view = unsafe { macos::create_host_view(frame) };
    if host_view.is_null() {
        return Err("create_host_view returned null".into());
    }

    let state = app_handle.state::<PluginState>();
    let mut inner = state.inner.lock();
    let working_directory = config.working_directory.clone().or_else(|| {
        let active_tab = unsafe { macos::tab_active_id() };
        inner
            .tabs
            .iter()
            .find(|tab| tab.id == active_tab)
            .and_then(|tab| tab.cwd.clone().or_else(|| tab.launch_directory.clone()))
    });
    let app = inner
        .app
        .as_ref()
        .ok_or_else(|| "ghostty app missing".to_string())?;

    let surface_cfg = SurfaceConfig {
        scale_factor: scale,
        font_size: config.font_size.unwrap_or(0.0),
        working_directory: working_directory.clone(),
        command: config.command,
        initial_input: None,
        wait_after_command: false,
        context: ghostty_rs::SurfaceContext::Tab,
    };
    let view = unsafe { View::new(app, host_view, surface_cfg) }
        .map_err(|e| format!("ghostty_surface_new: {e}"))?;
    unsafe { macos::set_surface(host_view, view.raw() as *mut c_void) };

    let tab_id = unsafe { macos::tab_add(host_view) };
    let surface_id = inner.new_surface_id();
    inner.surfaces.insert(surface_id, view);
    inner.tabs.push(TabState {
        id: tab_id,
        surfaces: vec![surface_id],
        title: String::new(),
        cwd: working_directory.clone(),
        launch_directory: working_directory,
    });
    Ok(tab_id)
}

/// Close the given tab. Drops every `View` owned by the tab (which
/// triggers `ghostty_surface_free`) before unmounting via tab_close.
/// If `close_window_on_last_tab` is set and this is the last tab,
/// the window is closed instead. MUST run on main.
fn close_tab_native(
    app_handle: &AppHandle<Wry>,
    tab_id: TabId,
) -> Result<bool, String> {
    let state = app_handle.state::<PluginState>();
    let mut inner = state.inner.lock();

    let close_window_on_last = inner.close_window_on_last_tab;
    if inner.tabs.len() <= 1 && close_window_on_last {
        for tab in inner.tabs.drain(..).collect::<Vec<_>>() {
            for sid in tab.surfaces {
                inner.surfaces.remove(&sid);
            }
        }
        // Close the main window via AppHandle.
        if let Some(win) = app_handle.get_webview_window("main") {
            let _ = win.close();
        }
        return Ok(true);
    }

    let idx = match inner.tab_index(tab_id) {
        Some(i) => i,
        None => return Ok(false),
    };
    let removed = inner.tabs.remove(idx);
    // Drop the Views first → ghostty_surface_free fires; the
    // GhosttyHostView's stored surface pointer is now stale, but its
    // setSurface(NULL) was NOT called because we don't have direct
    // access to the host view from here. AppKit events go through
    // GhosttyHostView's _surface pointer; if it's freed, ghostty will
    // crash. To prevent that, we do the unmount FIRST (which
    // detaches the view from the responder chain so no more keyDown:
    // arrive) and only then drop the View.
    let (_ok, _was_last) = unsafe { macos::tab_close(tab_id) };
    for sid in removed.surfaces {
        inner.surfaces.remove(&sid);
    }
    Ok(true)
}

// ---- C trampolines ------------------------------------------------------

// Capture the AppHandle so trampolines can emit Tauri events / queue
// state mutations. Runtime-monomorphised to `Wry` because the C ABI
// can't carry generics.
static APP_HANDLE_FOR_TABS: OnceLock<AppHandle<Wry>> = OnceLock::new();

#[derive(Debug, Serialize, Clone)]
struct TabEventPayload<'a> {
    id: TabId,
    title: Option<&'a str>,
    cwd_absolute_path: Option<&'a str>,
    launch_directory: Option<&'a str>,
}

extern "C" fn tab_event_trampoline(kind: i32, tab_id: i32, value: *const c_char) {
    let app = match APP_HANDLE_FOR_TABS.get() {
        Some(a) => a,
        None => return,
    };
    let value_str = if value.is_null() {
        None
    } else {
        Some(unsafe { CStr::from_ptr(value) }.to_string_lossy().into_owned())
    };
    let mut title = None::<String>;
    let mut cwd_absolute_path = None::<String>;
    let mut launch_directory = None::<String>;
    let event = match crate::macos::TabEventKind::from_i32(kind) {
        Some(crate::macos::TabEventKind::Created) => "tab:created",
        Some(crate::macos::TabEventKind::Focused) => "tab:focused",
        Some(crate::macos::TabEventKind::Closed) => "tab:closed",
        Some(crate::macos::TabEventKind::Title) => {
            // Update title in PluginState as well.
            let state = app.state::<PluginState>();
            let mut inner = state.inner.lock();
            if let Some(t) = value_str.as_ref() {
                if let Some(tab) = inner.tabs.iter_mut().find(|x| x.id == tab_id) {
                    tab.title = t.clone();
                    title = Some(tab.title.clone());
                    cwd_absolute_path = tab.cwd.clone();
                    launch_directory = tab.launch_directory.clone();
                }
            }
            "tab:title-changed"
        }
        Some(crate::macos::TabEventKind::Pwd) => {
            let state = app.state::<PluginState>();
            let mut inner = state.inner.lock();
            if let Some(tab) = inner.tabs.iter_mut().find(|x| x.id == tab_id) {
                tab.cwd = value_str.clone();
                title = Some(tab.title.clone());
                cwd_absolute_path = tab.cwd.clone();
                launch_directory = tab.launch_directory.clone();
            }
            "tab:pwd-changed"
        }
        None => return,
    };
    let payload = TabEventPayload {
        id: tab_id,
        title: title.as_deref(),
        cwd_absolute_path: cwd_absolute_path.as_deref(),
        launch_directory: launch_directory.as_deref(),
    };
    let _ = app.emit(event, payload);
}

extern "C" fn terminal_status_event_trampoline(
    kind: i32,
    tab_id: i32,
    arg0: i64,
    arg1: i64,
    text0: *const c_char,
    text1: *const c_char,
) {
    let app = match APP_HANDLE_FOR_TABS.get() {
        Some(a) => a,
        None => return,
    };

    let read_cstr = |ptr: *const c_char| -> Option<String> {
        if ptr.is_null() {
            None
        } else {
            Some(unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned())
        }
    };

    let payload = match crate::macos::TerminalStatusEventKind::from_i32(kind) {
        Some(crate::macos::TerminalStatusEventKind::Progress) => {
            let state = match arg0 {
                0 => TerminalProgressStateWire::Remove,
                1 => TerminalProgressStateWire::Set,
                2 => TerminalProgressStateWire::Error,
                3 => TerminalProgressStateWire::Indeterminate,
                4 => TerminalProgressStateWire::Pause,
                _ => return,
            };
            TerminalStatusPayload::Progress {
                id: tab_id,
                state,
                progress: if arg1 < 0 || arg1 > i8::MAX as i64 {
                    None
                } else {
                    Some(arg1 as i8)
                },
            }
        }
        Some(crate::macos::TerminalStatusEventKind::CommandFinished) => {
            TerminalStatusPayload::CommandFinished {
                id: tab_id,
                exit_code: if arg0 < 0 || arg0 > i16::MAX as i64 {
                    None
                } else {
                    Some(arg0 as i16)
                },
                duration_ns: arg1.max(0) as u64,
            }
        }
        Some(crate::macos::TerminalStatusEventKind::Bell) => {
            TerminalStatusPayload::Bell { id: tab_id }
        }
        Some(crate::macos::TerminalStatusEventKind::Interaction) => {
            TerminalStatusPayload::Interaction { id: tab_id }
        }
        Some(crate::macos::TerminalStatusEventKind::DesktopNotification) => {
            TerminalStatusPayload::DesktopNotification {
                id: tab_id,
                title: read_cstr(text0),
                body: read_cstr(text1),
            }
        }
        Some(crate::macos::TerminalStatusEventKind::ChildExited) => {
            TerminalStatusPayload::ChildExited {
                id: tab_id,
                exit_code: arg0.max(0) as u32,
                runtime_ms: arg1.max(0) as u64,
            }
        }
        Some(crate::macos::TerminalStatusEventKind::RendererHealth) => {
            TerminalStatusPayload::RendererHealth {
                id: tab_id,
                healthy: arg0 != 0,
            }
        }
        None => return,
    };

    let _ = app.emit(TERMINAL_STATUS_EVENT, payload);
}

extern "C" fn tab_action_trampoline(kind: i32, arg: i64) {
    let app = match APP_HANDLE_FOR_TABS.get() {
        Some(a) => a,
        None => return,
    };
    let action = match crate::macos::TabActionKind::from_i32(kind) {
        Some(k) => k,
        None => return,
    };
    match action {
        crate::macos::TabActionKind::New => {
            // Spawn synchronously — we're on the main thread already.
            let win = match app.get_webview_window("main") {
                Some(w) => w,
                None => return,
            };
            let scale = win.scale_factor().unwrap_or(2.0);
            let ns_window = match win.ns_window() {
                Ok(p) if !p.is_null() => p,
                _ => return,
            };
            let container = unsafe { macos::ensure_tab_container(ns_window) };
            let _ = spawn_tab_native(app, container, scale, TerminalNewConfig::default());
        }
        crate::macos::TabActionKind::Close => {
            let target_tab = if arg == 0 {
                unsafe { macos::tab_active_id() }
            } else {
                arg as TabId
            };
            if target_tab == 0 {
                return;
            }
            let _ = close_tab_native(app, target_tab);
        }
        crate::macos::TabActionKind::Goto => {
            let active = unsafe { macos::tab_active_id() };
            // Translate ghostty's GotoTab enum: positive = 1-based, neg = enum.
            let tab_ids = unsafe { macos::tab_list() };
            if tab_ids.is_empty() {
                return;
            }
            let n = tab_ids.len() as i64;
            let active_idx = tab_ids
                .iter()
                .position(|&id| id == active)
                .map(|i| i as i64)
                .unwrap_or(0);
            let pick_idx: i64 = if arg > 0 {
                (arg - 1).clamp(0, n - 1)
            } else if arg == -1 {
                (active_idx + n - 1) % n
            } else if arg == -2 {
                (active_idx + 1) % n
            } else if arg == -3 {
                n - 1
            } else {
                return;
            };
            let target = tab_ids[pick_idx as usize];
            unsafe { macos::tab_focus(target) };
        }
    }
}

/// Embedding-host passthrough trampoline. Fired by the NSEvent monitor
/// (see `GhosttyHostView.m::g_host_key_hook_fn`) when it sees a chord
/// the host wants to handle instead of forwarding to ghostty.
///
/// Currently the only chord is `cmd-opt-f`, used by zen-tools to
/// toggle distraction-free mode (hides the TitleBar so the terminal
/// fills the whole window). The Tauri event name is namespaced under
/// `terminal:host-key-hook:` so future chords get a stable channel
/// each (`terminal:host-key-hook:cmd-opt-f`,
/// `terminal:host-key-hook:cmd-shift-x`, …) without overloading
/// payload parsing.
extern "C" fn host_key_hook_trampoline(chord: *const c_char) {
    let app = match APP_HANDLE_FOR_TABS.get() {
        Some(a) => a,
        None => return,
    };
    if chord.is_null() {
        return;
    }
    let chord_str = unsafe { std::ffi::CStr::from_ptr(chord) }.to_string_lossy();
    let event_name = format!("terminal:host-key-hook:{chord_str}");
    let _ = app.emit(&event_name, ());
}

/// Reload-config trampoline. Fired by ObjC's `GhosttyHandleAction`
/// when ghostty dispatches `GHOSTTY_ACTION_RELOAD_CONFIG` (most
/// importantly after `ghostty_app_set_color_scheme()` updates the
/// internal conditional theme state). Without this handler, the
/// scheme switch is a visual no-op — ghostty has updated its
/// `config_conditional_state.theme` but never re-derives colors
/// because the apprt (us) hasn't pushed a fresh config.
///
/// **Re-entrancy hazard.** `terminal_set_color_scheme` holds
/// `PluginState.inner.lock()` while it calls
/// `App::set_color_scheme()`, and ghostty fires the
/// `RELOAD_CONFIG` action **synchronously on the same thread**
/// before the FFI call returns. If we tried to re-acquire the lock
/// here we'd deadlock instantly. The fix: queue the rebuild onto
/// the next main-thread tick via `run_on_main_thread`. By the time
/// the closure runs, `terminal_set_color_scheme` has returned and
/// the lock is free. The visual delay is one frame at most —
/// imperceptible.
///
/// Inside the deferred closure we build a fresh Config (re-reads
/// `~/.config/ghostty/config`, runs finalize so conditional state
/// branches resolve), then call `App::update_config`.
///
/// Currently always rebuilds from scratch regardless of `_soft`.
/// The `soft` flag exists for cases where ghostty knows the config
/// file hasn't changed (e.g. just a theme flip) and a cheaper
/// "re-derive from current Config + new conditional state" would
/// suffice. Optimisation for later — full rebuild is correct, just
/// slightly slower (one config-file parse per OS-theme toggle).
extern "C" fn reload_config_trampoline(_app_ptr: *mut std::ffi::c_void, _soft: bool) {
    let app_handle = match APP_HANDLE_FOR_TABS.get() {
        Some(a) => a.clone(),
        None => return,
    };
    let _ = app_handle.clone().run_on_main_thread(move || {
        let state = app_handle.state::<PluginState>();
        let inner = state.inner.lock();
        let app = match inner.app.as_ref() {
            Some(a) => a,
            None => {
                tracing::warn!(
                    "ghostty: reload_config fired before app was initialised; ignoring"
                );
                return;
            }
        };

        let mut config = match Config::new() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(?e, "ghostty: reload_config: Config::new failed");
                return;
            }
        };
        config.load_default_files();
        config.finalize();
        app.update_config(&config);
        // `config` drops here, freeing the underlying ghostty_config_t.
        // ghostty has already read what it needs.
    });
}
