// view.rs — wraps `ghostty_surface_t` (a single terminal surface bound
// to a host NSView). Created via `View::new(&app, ns_view, cfg)`. The
// caller (the Tauri plugin) owns the NSView lifetime; this wrapper just
// holds a non-owning reference.

use crate::{app::App, error::{Error, Result}};
use ghostty_sys::*;
use std::ffi::c_void;

#[derive(Debug, Clone, Copy, Default)]
pub enum SurfaceContext {
    #[default]
    Window,
    Tab,
    Split,
}

impl SurfaceContext {
    fn as_c(self) -> ghostty_surface_context_e {
        match self {
            Self::Window => ghostty_surface_context_e_GHOSTTY_SURFACE_CONTEXT_WINDOW,
            Self::Tab => ghostty_surface_context_e_GHOSTTY_SURFACE_CONTEXT_TAB,
            Self::Split => ghostty_surface_context_e_GHOSTTY_SURFACE_CONTEXT_SPLIT,
        }
    }
}

/// Configuration the host passes when creating a view. The lifetime of
/// any borrowed strings ends when `View::new` returns — ghostty copies
/// what it needs internally.
#[derive(Debug, Clone, Default)]
pub struct SurfaceConfig {
    pub scale_factor: f64,
    pub font_size: f32,
    pub working_directory: Option<String>,
    pub command: Option<String>,
    pub initial_input: Option<String>,
    pub wait_after_command: bool,
    pub context: SurfaceContext,
}

pub struct View {
    inner: ghostty_surface_t,
    // We keep these C-strings alive for the duration of `ghostty_surface_new`'s
    // call. Ghostty copies what it needs internally so they can drop after.
    // For now, retain via Self in case ghostty surprises us.
    _wd: Option<std::ffi::CString>,
    _cmd: Option<std::ffi::CString>,
    _init: Option<std::ffi::CString>,
}

impl View {
    /// Create a new surface bound to `ns_view`. The pointer must outlive
    /// this `View` and must be a valid `NSView *`.
    ///
    /// # Safety
    /// `ns_view` must be a non-null `NSView *`. Caller is responsible
    /// for ensuring it is alive for the lifetime of the returned `View`.
    pub unsafe fn new(
        app: &App,
        ns_view: *mut c_void,
        cfg: SurfaceConfig,
    ) -> Result<Self> {
        if ns_view.is_null() {
            return Err(Error::InvalidArgument("ns_view is null"));
        }

        let wd = cfg.working_directory.map(cstr);
        let cmd = cfg.command.map(cstr);
        let init = cfg.initial_input.map(cstr);

        let mut sc: ghostty_surface_config_s = ghostty_surface_config_new();
        sc.platform_tag = ghostty_platform_e_GHOSTTY_PLATFORM_MACOS;
        sc.platform.macos = ghostty_platform_macos_s { nsview: ns_view };
        sc.userdata = std::ptr::null_mut();
        sc.scale_factor = if cfg.scale_factor > 0.0 { cfg.scale_factor } else { 1.0 };
        sc.font_size = cfg.font_size;
        sc.working_directory = wd
            .as_ref()
            .map(|s| s.as_ptr())
            .unwrap_or(std::ptr::null());
        sc.command = cmd.as_ref().map(|s| s.as_ptr()).unwrap_or(std::ptr::null());
        sc.env_vars = std::ptr::null_mut();
        sc.env_var_count = 0;
        sc.initial_input = init
            .as_ref()
            .map(|s| s.as_ptr())
            .unwrap_or(std::ptr::null());
        sc.wait_after_command = cfg.wait_after_command;
        sc.context = cfg.context.as_c();

        let inner = ghostty_surface_new(app.raw(), &sc);
        if inner.is_null() {
            return Err(Error::SurfaceCreateFailed);
        }
        // Register the surface for clipboard ops (Cmd+C / Cmd+V route
        // through the runtime read/write_clipboard cbs which need a
        // surface handle to call `complete_clipboard_request` against).
        crate::callbacks::GhosttyRegisterSurfaceForClipboard(inner as *mut std::ffi::c_void);
        Ok(Self {
            inner,
            _wd: wd,
            _cmd: cmd,
            _init: init,
        })
    }

    pub fn raw(&self) -> ghostty_surface_t {
        self.inner
    }

    pub fn set_size(&self, width: u32, height: u32) {
        unsafe { ghostty_surface_set_size(self.inner, width, height) };
    }

    pub fn set_content_scale(&self, x: f64, y: f64) {
        unsafe { ghostty_surface_set_content_scale(self.inner, x, y) };
    }

    pub fn set_focus(&self, focused: bool) {
        unsafe { ghostty_surface_set_focus(self.inner, focused) };
    }

    /// Push a color-scheme change to this surface. Each surface
    /// independently tracks its `config_conditional_state.theme`,
    /// and ghostty re-derives the palette from the user's
    /// conditional-themed config when this is called. The App-level
    /// `App::set_color_scheme` only updates the app's own conditional
    /// state and doesn't cascade to surfaces — so this per-surface
    /// call is the one that actually changes the visible colors.
    ///
    /// Internally calls `ghostty_surface_set_color_scheme`, which
    /// fires a per-surface `RELOAD_CONFIG` action. If the apprt
    /// handles that action by calling `App::update_config`, surfaces
    /// re-derive with their (just-updated) conditional state and
    /// repaint.
    pub fn set_color_scheme(&self, dark: bool) {
        let mode = if dark {
            ghostty_color_scheme_e_GHOSTTY_COLOR_SCHEME_DARK
        } else {
            ghostty_color_scheme_e_GHOSTTY_COLOR_SCHEME_LIGHT
        };
        unsafe { ghostty_surface_set_color_scheme(self.inner, mode) };
    }

    /// Update whether the surface is visible to the user. Ghostty's
    /// embedded API takes a `visible` boolean here and uses it to pause
    /// background rendering when the surface is not on screen.
    pub fn set_visible(&self, visible: bool) {
        unsafe { ghostty_surface_set_occlusion(self.inner, visible) };
    }

    pub fn refresh(&self) {
        unsafe { ghostty_surface_refresh(self.inner) };
    }

    pub fn draw(&self) {
        unsafe { ghostty_surface_draw(self.inner) };
    }

    /// Tell libghostty which display the surface is currently on.
    /// Used so ghostty can pick the right Metal device + ProMotion
    /// refresh rate when the window moves between monitors.
    pub fn set_display_id(&self, id: u32) {
        unsafe { ghostty_surface_set_display_id(self.inner, id) };
    }

    /// Forward a force-touch / trackpad pressure event.
    pub fn mouse_pressure(&self, stage: u32, pressure: f64) {
        unsafe { ghostty_surface_mouse_pressure(self.inner, stage, pressure) };
    }

    /// Quick-look word-under-cursor lookup. Returns `Some((text, font))`
    /// when ghostty resolved a word; the host displays the QuickLook
    /// panel using NSAttributedString.
    pub fn quicklook_word(&self) -> Option<String> {
        let mut text: ghostty_sys::ghostty_text_s = unsafe { std::mem::zeroed() };
        let ok = unsafe { ghostty_sys::ghostty_surface_quicklook_word(self.inner, &mut text) };
        if !ok || text.text.is_null() || text.text_len == 0 {
            return None;
        }
        let s = unsafe {
            std::slice::from_raw_parts(text.text as *const u8, text.text_len)
        };
        let owned = String::from_utf8_lossy(s).into_owned();
        unsafe { ghostty_sys::ghostty_surface_free_text(self.inner, &mut text) };
        Some(owned)
    }

    /// Split this surface in the given direction. New surface is
    /// created internally by ghostty; rendering of multiple panes
    /// requires the host to create additional GhosttyHostViews — v1
    /// just dispatches the call. No visual split until v2.
    pub fn split(&self, direction: SplitDirection) {
        unsafe { ghostty_sys::ghostty_surface_split(self.inner, direction.as_c()) };
    }

    /// Move focus between splits (left / right / up / down or previous /
    /// next). v1 only meaningful once we have multiple views.
    pub fn split_focus(&self, dir: GotoSplit) {
        unsafe { ghostty_sys::ghostty_surface_split_focus(self.inner, dir.as_c()) };
    }
}

#[derive(Debug, Clone, Copy)]
pub enum SplitDirection { Right, Down, Left, Up }
impl SplitDirection {
    fn as_c(self) -> ghostty_sys::ghostty_action_split_direction_e {
        use ghostty_sys::*;
        match self {
            Self::Right => ghostty_action_split_direction_e_GHOSTTY_SPLIT_DIRECTION_RIGHT,
            Self::Down  => ghostty_action_split_direction_e_GHOSTTY_SPLIT_DIRECTION_DOWN,
            Self::Left  => ghostty_action_split_direction_e_GHOSTTY_SPLIT_DIRECTION_LEFT,
            Self::Up    => ghostty_action_split_direction_e_GHOSTTY_SPLIT_DIRECTION_UP,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum GotoSplit { Previous, Next, Up, Down, Left, Right }
impl GotoSplit {
    fn as_c(self) -> ghostty_sys::ghostty_action_goto_split_e {
        use ghostty_sys::*;
        match self {
            Self::Previous => ghostty_action_goto_split_e_GHOSTTY_GOTO_SPLIT_PREVIOUS,
            Self::Next     => ghostty_action_goto_split_e_GHOSTTY_GOTO_SPLIT_NEXT,
            Self::Up       => ghostty_action_goto_split_e_GHOSTTY_GOTO_SPLIT_UP,
            Self::Down     => ghostty_action_goto_split_e_GHOSTTY_GOTO_SPLIT_DOWN,
            Self::Left     => ghostty_action_goto_split_e_GHOSTTY_GOTO_SPLIT_LEFT,
            Self::Right    => ghostty_action_goto_split_e_GHOSTTY_GOTO_SPLIT_RIGHT,
        }
    }
}

// Safety: see App impl. Main-thread-only by host contract.
unsafe impl Send for View {}
unsafe impl Sync for View {}

impl Drop for View {
    fn drop(&mut self) {
        if !self.inner.is_null() {
            unsafe {
                // Unregister BEFORE freeing so any in-flight clipboard
                // callback sees null and skips the surface call.
                crate::callbacks::GhosttyRegisterSurfaceForClipboard(std::ptr::null_mut());
                ghostty_surface_free(self.inner);
            }
        }
    }
}

fn cstr(s: String) -> std::ffi::CString {
    std::ffi::CString::new(s).unwrap_or_default()
}
