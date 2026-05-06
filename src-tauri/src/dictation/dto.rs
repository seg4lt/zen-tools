//! Wire DTOs for the dictation Tauri commands.
//!
//! Each carries a `#[derive(TS)]` so `cargo test export_bindings`
//! emits the matching `.ts` file under `packages/types/src/generated/`.
//! The frontend imports from `@zen-tools/types/generated`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One entry in the model dropdown.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ModelDto {
    /// Wire id (kebab-case): `tiny`, `base`, `small`, …
    pub id: String,
    /// Human-friendly label (`Whisper Base`, …).
    pub label: String,
    /// Approximate on-disk size, formatted (`~150 MB`).
    pub size_label: String,
    /// One-line subtitle for the dropdown.
    pub description: String,
    /// `true` for the recommended default (Base).
    pub is_default: bool,
    /// `true` when the `.bin` is on disk.
    pub is_downloaded: bool,
}

/// Snapshot of the dictation feature's UI-visible state.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DictationStateDto {
    /// Wire id of the currently-selected provider
    /// (`"apple-speech" | "whisper"`).
    pub provider: String,
    /// Wire id of the currently-selected Whisper model. Only
    /// meaningful when `provider == "whisper"`; for Apple Speech the
    /// frontend ignores this field.
    pub selected_model: String,
    /// All Whisper models, fast → slow.
    pub models: Vec<ModelDto>,
    /// `true` while a recording is in flight.
    pub is_recording: bool,
    /// Apple Speech availability + locale install state. Lets the UI
    /// decide whether to render the provider radio at all (when
    /// `apple_speech.supported == false` we hide it entirely).
    pub apple_speech: AppleSpeechStateDto,
    /// Screen-vocabulary feature: bias the recogniser using OCR'd
    /// text from the current screen. The frontend renders this as a
    /// single Switch under the provider picker; defaults to OFF for
    /// privacy. Same `supported` / `enabled` shape as the Apple
    /// Speech panel so the UI gating mirrors the existing pattern.
    pub screen_vocab: ScreenVocabStateDto,
}

/// Apple Speech availability snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AppleSpeechStateDto {
    /// `true` when the Swift bridge was compiled into this build AND
    /// the running OS is macOS 26+. Frontend hides the provider option
    /// when `false`.
    pub supported: bool,
    /// BCP-47 locale the manager will use when transcribing
    /// (e.g. `"en-US"`). Today this is hard-coded to
    /// `zen_apple_speech::DEFAULT_LOCALE`.
    pub locale: String,
    /// `true` when `AssetInventory` reports the on-device speech
    /// model for `locale` is installed. Frontend shows the
    /// "Install language model" button when `false`.
    pub installed: bool,
}

/// Screen-vocabulary availability + opt-in state.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScreenVocabStateDto {
    /// `true` when the Swift bridge for screen capture + OCR was
    /// compiled into this build AND the running OS supports it.
    /// Frontend hides the toggle entirely when `false`.
    pub supported: bool,
    /// User-facing on/off. Defaults to `false`; flipping it to `true`
    /// triggers the macOS Screen Recording TCC prompt the next time
    /// dictation starts a recording.
    pub enabled: bool,
}

/// Progress tick fired during a model download.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DownloadProgressDto {
    /// Wire id of the model being downloaded.
    pub model_id: String,
    /// Bytes received so far.
    pub downloaded: u64,
    /// Total bytes (if `Content-Length` was present).
    pub total: Option<u64>,
}

/// On-disk paths surfaced in the Settings page.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PathsDto {
    /// `<app_data_dir>/`.
    pub app_data_dir: String,
    /// `<app_data_dir>/logs/`.
    pub logs_dir: String,
    /// `<app_data_dir>/models/`.
    pub models_dir: String,
}
