/**
 * Whole-app zoom level, persisted in `preferences.json` (`appZoom`).
 *
 * Uses Tauri's `webview.setZoom()` — the *native* WebKit / WebView2
 * zoom API, the same one Cmd-+/Cmd-- triggers in regular browsers.
 * It rescales the layout viewport itself (so `100vw` is computed
 * against the post-zoom logical width), which is what we want: every
 * `w-screen` / `w-full` container reflows naturally instead of
 * staying pinned to the device viewport like CSS `zoom` would do.
 *
 * Range is clamped to `0.5 … 2.0` in `0.1` steps so the UI never
 * shrinks past usability or grows past most laptop viewports.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { tauri } from "@/tools/http-runner/lib/tauri";

const PREFERENCES_KEY = ["preferences"] as const;
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_DEFAULT = 1.0;

/** Snap to the nearest 0.05 to avoid float drift after many ±0.1 ops. */
function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return ZOOM_DEFAULT;
  const rounded = Math.round(z * 20) / 20;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, rounded));
}

interface UseAppZoomResult {
  zoom: number;
  isLoaded: boolean;
  setZoom: (next: number) => Promise<void>;
  zoomIn: () => Promise<void>;
  zoomOut: () => Promise<void>;
  reset: () => Promise<void>;
}

export function useAppZoom(): UseAppZoomResult {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: PREFERENCES_KEY,
    queryFn: () => tauri.getPreferences(),
    staleTime: Infinity,
  });

  const zoom = clampZoom(data?.appZoom ?? ZOOM_DEFAULT);

  // Apply at the webview level on every change. Native zoom rescales
  // both font and layout (viewport-relative units like `100vw`
  // recompute), which is exactly browser zoom semantics. The CSS
  // `zoom` property on the document only scales painted content
  // without resizing the layout viewport, so wide content stays
  // clipped to the original device width — not what we want.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const wv = getCurrentWebview();
        if (cancelled) return;
        await wv.setZoom(zoom);
      } catch (err) {
        // Outside Tauri (e.g. running plain Vite), `getCurrentWebview`
        // throws. Fall back to CSS `zoom` so a browser preview still
        // sees something change.
        // eslint-disable-next-line no-console
        console.warn("setZoom unavailable, using CSS fallback", err);
        document.documentElement.style.zoom = String(zoom);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [zoom]);

  const setZoom = useCallback(
    async (next: number) => {
      const clamped = clampZoom(next);
      // Read-modify-write so we don't drop other tools' prefs.
      const current = await tauri.getPreferences();
      await tauri.savePreferences({ ...current, appZoom: clamped });
      await queryClient.invalidateQueries({ queryKey: PREFERENCES_KEY });
    },
    [queryClient],
  );

  const zoomIn = useCallback(() => setZoom(zoom + ZOOM_STEP), [setZoom, zoom]);
  const zoomOut = useCallback(
    () => setZoom(zoom - ZOOM_STEP),
    [setZoom, zoom],
  );
  const reset = useCallback(() => setZoom(ZOOM_DEFAULT), [setZoom]);

  return {
    zoom,
    isLoaded: !isLoading,
    setZoom,
    zoomIn,
    zoomOut,
    reset,
  };
}

export const APP_ZOOM_LIMITS = {
  step: ZOOM_STEP,
  min: ZOOM_MIN,
  max: ZOOM_MAX,
  default: ZOOM_DEFAULT,
} as const;
