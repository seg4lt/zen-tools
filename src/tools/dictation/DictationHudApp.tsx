/**
 * Dynamic Island-style overlay rendered inside the
 * `dictation-hud` Tauri window.
 *
 * Loaded by `main.tsx` when `?window=dictation-hud` is present in the
 * URL. The window itself is built by `src-tauri/src/dictation/hud.rs`
 * (frameless, transparent, always-on-top, top-centre of the primary
 * display).
 *
 * The HUD subscribes to the `dictation:hud-status` event so the Rust
 * side can drive the visible state machine (Idle / Recording /
 * Transcribing). On unmount the listener is unwired — but the host
 * window is destroyed via `window.destroy()` immediately after we hit
 * the Hidden state, so unmount is the dominant teardown path.
 */
import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type HudStatus = "idle" | "recording" | "transcribing";

export function DictationHudApp() {
  const [status, setStatus] = useState<HudStatus>("recording");

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<HudStatus>("dictation:hud-status", (e) => {
      setStatus(e.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Note: we render even on `idle` for the brief tick between the
  // status flip and the window destroy; a flicker is uglier than
  // showing the previous label for ~16 ms.
  const label = status === "transcribing" ? "Transcribing…" : "Listening…";

  return (
    <div
      className="dictation-hud"
      data-status={status}
      role="status"
      aria-live="polite"
    >
      <span className="dictation-hud__pulse" aria-hidden="true" />
      <span className="dictation-hud__label">{label}</span>
    </div>
  );
}
