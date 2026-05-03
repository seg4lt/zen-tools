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

interface HudLayout {
  content_height: number;
  menu_bar_height: number;
}

export function DictationHudApp() {
  const [status, setStatus] = useState<HudStatus>("recording");
  // The Rust side knows the live menu-bar height (varies between
  // notched ~37 pt and non-notched ~24 pt MacBooks) and the visible
  // content area we want at the bottom of the pill. It pushes both
  // down via `dictation:hud-layout` immediately after window
  // creation; until that arrives we use sensible defaults so the
  // first paint isn't broken.
  const [layout, setLayout] = useState<HudLayout>({
    content_height: 40,
    menu_bar_height: 24,
  });

  useEffect(() => {
    let unlistenStatus: UnlistenFn | undefined;
    let unlistenLayout: UnlistenFn | undefined;
    listen<HudStatus>("dictation:hud-status", (e) => {
      setStatus(e.payload);
    }).then((fn) => {
      unlistenStatus = fn;
    });
    listen<HudLayout>("dictation:hud-layout", (e) => {
      setLayout(e.payload);
    }).then((fn) => {
      unlistenLayout = fn;
    });
    return () => {
      unlistenStatus?.();
      unlistenLayout?.();
    };
  }, []);

  // Note: we render even on `idle` for the brief tick between the
  // status flip and the window destroy; a flicker is uglier than
  // showing the previous label for ~16 ms.
  const label = status === "transcribing" ? "Transcribing…" : "Listening…";

  // Push the live layout to CSS as custom properties so the
  // stylesheet can size the content row + menu-bar overlap without
  // hard-coding pixel values it'd never actually know.
  const cssVars = {
    "--hud-content-height": `${layout.content_height}px`,
    "--hud-menu-bar-height": `${layout.menu_bar_height}px`,
  } as React.CSSProperties;

  return (
    <div
      className="dictation-hud"
      data-status={status}
      role="status"
      aria-live="polite"
      style={cssVars}
    >
      <div className="dictation-hud__pill">
        {/*
         * Empty top section that overlaps the menu bar — pure black
         * fill matching the rest of the pill, so visually the HUD
         * "comes from the top" rather than hovering below.
         */}
        <div className="dictation-hud__menu-bar-overlap" aria-hidden="true" />
        <div className="dictation-hud__content">
          {/*
           * 5-bar audio waveform. Each bar runs its own phase-shifted
           * keyframe so the group reads as a rolling wave instead of
           * a single in-sync pulse. CSS keys off `data-status` to
           * swap the keyframe between "listening" (red, fast) and
           * "transcribing" (amber, slower shimmer).
           */}
          <div className="dictation-hud__wave" aria-hidden="true">
            <span className="dictation-hud__wave-bar" />
            <span className="dictation-hud__wave-bar" />
            <span className="dictation-hud__wave-bar" />
            <span className="dictation-hud__wave-bar" />
            <span className="dictation-hud__wave-bar" />
          </div>
          <span className="dictation-hud__label">{label}</span>
        </div>
      </div>
    </div>
  );
}
