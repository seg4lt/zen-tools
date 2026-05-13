// state.rs — Tauri-managed state holding the singleton GhosttyApp and
// the active tab/surface tree.
//
// Surfaces are owned by ghostty_app via the platform NSView pointer; we
// hold `View` here only to keep the safe wrapper alive AND so Drop
// (= ghostty_surface_free) fires on tab close. The map keyed by
// SurfaceId is intentionally per-surface (not per-tab) because splits
// add multiple surfaces to a single tab — we look up by surface id
// when freeing.

use ghostty_rs::{App, View};
use parking_lot::Mutex;
use std::collections::HashMap;

pub type SurfaceId = u64;
pub type TabId = i32; // matches NSView.tag on the ObjC side.

pub struct TabState {
    pub id: TabId,
    /// Surface ids that live under this tab's pane tree.
    pub surfaces: Vec<SurfaceId>,
    /// Last-known title pushed via SET_TITLE.
    pub title: String,
    /// Last-known absolute cwd pushed via OSC 7 / PWD action.
    pub cwd: Option<String>,
    /// Directory this tab was launched in (or inherited from the
    /// focused tab when the user created a sibling tab).
    pub launch_directory: Option<String>,
}

#[derive(Default)]
pub struct PluginState {
    pub inner: Mutex<Inner>,
}

#[derive(Default)]
pub struct Inner {
    pub app: Option<App>,
    /// All surfaces ever spawned, by id. Removed (and dropped) on tab
    /// close.
    pub surfaces: HashMap<SurfaceId, View>,
    pub next_surface_id: SurfaceId,
    pub tabs: Vec<TabState>,
    /// Behaviour flag — when the user hits Cmd+W on the last remaining
    /// tab, do we close the window? Default true (matches macOS).
    /// Settable by an embedding host via `terminal_set_close_window_on_last_tab`.
    pub close_window_on_last_tab: bool,
}

impl Inner {
    pub fn new_surface_id(&mut self) -> SurfaceId {
        self.next_surface_id += 1;
        self.next_surface_id
    }

    pub fn tab_index(&self, id: TabId) -> Option<usize> {
        self.tabs.iter().position(|t| t.id == id)
    }
}
