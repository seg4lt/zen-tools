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

#[tauri::command]
pub fn terminal_new(
    window: Window<Wry>,
    app_handle: AppHandle<Wry>,
    state: State<'_, PluginState>,
    config: Option<TerminalNewConfig>,
) -> Result<TerminalNewResult, String> {
    let config = config.unwrap_or_default();

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
        working_directory: config.working_directory,
        command: config.command,
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
    state: State<'_, PluginState>,
    dark: bool,
) -> Result<(), String> {
    let inner = state.inner.lock();
    if let Some(app) = inner.app.as_ref() {
        app.set_color_scheme(dark);
    }
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
) -> Result<TerminalNewTabResult, String> {
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
        spawn_tab_native(&app_handle_for_main, container, scale)
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
    let mut config = Config::new()?;
    config.load_default_files();
    config.finalize();

    // v1 callbacks: ghostty's wakeup is a no-op for now (we'll wire it
    // through `app_handle.run_on_main_thread` once the first shell
    // renders and we can observe what tick latency looks like).
    let callbacks = RuntimeCallbacks::no_op();

    App::new(config, callbacks)
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
) -> Result<TabId, String> {
    let frame = unsafe { container_bounds(container) };
    let host_view = unsafe { macos::create_host_view(frame) };
    if host_view.is_null() {
        return Err("create_host_view returned null".into());
    }

    let state = app_handle.state::<PluginState>();
    let mut inner = state.inner.lock();
    let app = inner
        .app
        .as_ref()
        .ok_or_else(|| "ghostty app missing".to_string())?;

    let surface_cfg = SurfaceConfig {
        scale_factor: scale,
        font_size: 0.0,
        working_directory: None,
        command: None,
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
}

extern "C" fn tab_event_trampoline(kind: i32, tab_id: i32, title: *const c_char) {
    let app = match APP_HANDLE_FOR_TABS.get() {
        Some(a) => a,
        None => return,
    };
    let title_str = if title.is_null() {
        None
    } else {
        Some(unsafe { CStr::from_ptr(title) }.to_string_lossy().into_owned())
    };
    let event = match crate::macos::TabEventKind::from_i32(kind) {
        Some(crate::macos::TabEventKind::Created) => "tab:created",
        Some(crate::macos::TabEventKind::Focused) => "tab:focused",
        Some(crate::macos::TabEventKind::Closed) => "tab:closed",
        Some(crate::macos::TabEventKind::Title) => {
            // Update title in PluginState as well.
            let state = app.state::<PluginState>();
            let mut inner = state.inner.lock();
            if let Some(t) = title_str.as_ref() {
                if let Some(tab) = inner.tabs.iter_mut().find(|x| x.id == tab_id) {
                    tab.title = t.clone();
                }
            }
            "tab:title-changed"
        }
        None => return,
    };
    let payload = TabEventPayload {
        id: tab_id,
        title: title_str.as_deref(),
    };
    let _ = app.emit(event, payload);
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
            let _ = spawn_tab_native(app, container, scale);
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
