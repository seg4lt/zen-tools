/**
 * Theme-reactive widget for embedded `*.excalidraw.svg` images.
 *
 * Background: when the user saves an excalidraw drawing, the
 * resulting SVG has its colours **baked in** at the theme that was
 * active in the editor pane at that moment.  Browsers viewing the
 * SVG see those exact colours; that's by design — it lets the file
 * round-trip through any image viewer.
 *
 * The cost is that a markdown embed `![](foo.excalidraw.svg)` shows
 * a frozen-theme image: switch the app to dark mode and the
 * embedded picture stays light (or vice versa), even though the
 * drawing pane itself reflows correctly.
 *
 * This widget fixes that for the live-preview pane only:
 *
 *   1. On mount, paint the static `<img>` from disk immediately —
 *      the user sees *something* before the heavy excalidraw module
 *      finishes loading.  This is also the fallback when the file
 *      isn't actually an excalidraw SVG (no embedded scene).
 *   2. Lazy-`import("@excalidraw/excalidraw")`.  Same chunk the
 *      drawing pane already pulls in — re-uses Vite's split, no
 *      bundle cost on first encounter beyond the parse.
 *   3. `loadFromBlob` extracts the embedded scene; `exportToSvg`
 *      re-emits the SVG with `theme: "light" | "dark"` matching
 *      what the app is showing right now.
 *   4. Replace the fallback `<img>` with the freshly-themed `<svg>`.
 *
 * The widget's `eq` returns `false` when the *theme* changes, which
 * triggers CodeMirror to re-mount the widget on a theme toggle.
 * That re-mount runs the async render again with the new theme.
 *
 * We intentionally don't cache the parsed scene across widget
 * instances yet — the file might have been saved out from under us
 * by the editor pane, and stale-cache handling would need a
 * file-watcher dance we don't want here.  Re-fetch is cheap (asset
 * protocol → local fs) and only runs when the user toggles theme or
 * opens a doc with the embed.
 */

import { WidgetType } from "@codemirror/view";
import { assetUrl } from "../tauri";

export class ExcalidrawImageWidget extends WidgetType {
  /**
   * @param src    Absolute filesystem path to the `*.excalidraw.svg`.
   * @param alt    Markdown alt-text — used by the fallback `<img>`.
   * @param theme  Current app theme — re-export target.
   */
  constructor(
    private readonly src: string,
    private readonly alt: string,
    private readonly theme: "light" | "dark",
  ) {
    super();
  }

  eq(other: ExcalidrawImageWidget): boolean {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.theme === this.theme
    );
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-image-block cm-md-excalidraw-block";

    // Paint the on-disk SVG immediately so the user sees the diagram
    // before excalidraw's chunk loads + re-themes.  Also the
    // permanent fallback when re-render fails (e.g. a plain SVG
    // saved without `exportEmbedScene`).
    const fallback = document.createElement("img");
    fallback.src = assetUrl(this.src);
    fallback.alt = this.alt;
    fallback.loading = "lazy";
    fallback.draggable = false;
    fallback.onerror = () => {
      const fb = document.createElement("span");
      fb.className = "cm-md-image-fallback";
      fb.textContent = `⚠️ image not found: ${this.alt || this.src}`;
      wrapper.replaceChildren(fb);
    };
    wrapper.appendChild(fallback);

    void this.renderThemed(wrapper);
    return wrapper;
  }

  /**
   * Replace `wrapper`'s contents with a `<svg>` re-exported at the
   * current `theme`.  Works for both `*.excalidraw.svg` and
   * `*.excalidraw.png` — `loadFromBlob` reads either format, and we
   * always re-export to SVG (lighter, scalable, theme-friendly)
   * regardless of which extension the on-disk file carries.
   *
   * Silently bails (leaving the static `<img>` in place) on any
   * error — that's the right answer for plain images that happen to
   * carry the trigger extension.
   */
  private async renderThemed(wrapper: HTMLElement): Promise<void> {
    try {
      const res = await fetch(assetUrl(this.src));
      if (!res.ok) return;
      // Always go through `Blob` rather than `text()` — PNG bytes
      // would corrupt under text decoding.  loadFromBlob inspects
      // the MIME type / magic bytes itself.
      const blob = await res.blob();
      // Same chunk the drawing pane uses — Vite reuses it.
      const { loadFromBlob, exportToSvg } = await import(
        "@excalidraw/excalidraw"
      );
      const restored = await loadFromBlob(blob, null, null);
      const svgEl = await exportToSvg({
        elements: restored.elements,
        appState: {
          ...restored.appState,
          theme: this.theme,
          // Don't re-embed the scene on the re-themed export — the
          // canonical copy with the scene already lives on disk;
          // this in-memory render is just for display.
          exportEmbedScene: false,
        },
        files: restored.files,
      });
      // Mark the freshly-rendered svg so users can spot whether the
      // re-theme path took or whether the fallback is showing.
      svgEl.classList.add("cm-md-excalidraw-svg");
      wrapper.replaceChildren(svgEl);
    } catch (err) {
      // Plain images without an embedded scene reach here
      // (`loadFromBlob` throws).  Keep the static `<img>` in place;
      // it's the right answer for those.
      console.debug(
        "[markdown] excalidraw re-theme skipped; using static image",
        err,
      );
    }
  }

  ignoreEvent(): boolean {
    return false;
  }
}
