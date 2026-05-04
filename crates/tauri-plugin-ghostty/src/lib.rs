// tauri-plugin-ghostty — drop-in Tauri 2 plugin that adds a libghostty
// terminal NSView to a window and exposes lifecycle commands to JS.
//
// macOS-only. On other platforms `init()` returns a no-op plugin that
// just registers the commands as errors so the JS layer fails fast.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Wry,
};

#[cfg(target_os = "macos")]
mod commands;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod state;

#[cfg(not(target_os = "macos"))]
mod stub;

/// Build the Tauri 2 plugin. Wire it into your app's builder via
/// `.plugin(tauri_plugin_ghostty::init())`.
///
/// Specialised to `Wry` because the macOS tab-event trampolines are
/// `extern "C"` and store the `AppHandle` in a `OnceLock<AppHandle<Wry>>`
/// — generics can't cross the C ABI. Tauri 2's default runtime is Wry,
/// so this matches the only configuration we ship.
pub fn init() -> TauriPlugin<Wry> {
    let mut builder = Builder::new("ghostty");

    #[cfg(target_os = "macos")]
    {
        tracing::info!("[plugin-ghostty] init_once starting");
        // libghostty's process-level state must be initialised once,
        // before any app/surface call.
        match ghostty_rs::init_once() {
            Ok(()) => tracing::info!("[plugin-ghostty] init_once ok"),
            Err(e) => tracing::error!("[plugin-ghostty] init_once failed: {e}"),
        }
        builder = builder
            .invoke_handler(tauri::generate_handler![
                commands::terminal_new,
                commands::terminal_set_color_scheme,
                commands::terminal_split,
                commands::terminal_focus_split,
                commands::terminal_new_tab,
                commands::terminal_focus_tab,
                commands::terminal_close_tab,
                commands::terminal_list_tabs,
                commands::terminal_set_chrome_inset,
                commands::terminal_set_close_window_on_last_tab,
            ])
            .setup(|app, _api| {
                tracing::info!("[plugin-ghostty] setup callback running");
                app.manage(state::PluginState::default());
                tracing::info!("[plugin-ghostty] state managed");
                Ok(())
            });
    }

    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.invoke_handler(tauri::generate_handler![stub::unsupported]);
    }

    builder.build()
}
