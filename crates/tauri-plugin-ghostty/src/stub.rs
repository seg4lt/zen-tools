// Non-macOS stub — keeps the plugin's command surface present so the JS
// side compiles + fails fast at runtime when the plugin is dropped into
// a non-macOS Tauri app.

#[tauri::command]
pub fn unsupported() -> Result<(), String> {
    Err("tauri-plugin-ghostty is currently macOS-only".into())
}
