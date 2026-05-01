/**
 * Mermaid diagram widget.
 *
 * A `Decoration.replace` decoration with `block: true` swaps the
 * source of a ```` ```mermaid ```` fenced block for a rendered SVG
 * whenever the cursor isn't inside the block.  Putting the cursor on
 * any line of the block returns the raw markdown so the user can
 * edit.
 *
 * The mermaid library is heavy (~few MB) so we lazy-load it on first
 * use through a dynamic `import()`.  Vite splits this into its own
 * chunk; users with no mermaid blocks pay zero bundle cost.
 *
 * Renders are cached by source-string so re-rendering an unchanged
 * doc (CodeMirror's view-plugin runs on every selection change) is
 * a Map lookup, not an svg recompute.
 */

import { WidgetType } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

// ────────────────────────────────────────────────────────────────────────
// Lazy-loaded mermaid module + per-source render cache
// ────────────────────────────────────────────────────────────────────────

type MermaidLib = typeof import("mermaid")["default"];

let mermaidPromise: Promise<MermaidLib> | null = null;

function loadMermaid(): Promise<MermaidLib> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = import("mermaid").then((m) => {
    const lib = m.default;
    // Auto-pick a theme based on the document's `dark` class — the
    // Markdown editor and the rest of zen-tools toggle this on the
    // <html> element via the existing theme switcher.
    const isDark = document.documentElement.classList.contains("dark");
    lib.initialize({
      startOnLoad: false,
      theme: isDark ? "dark" : "default",
      securityLevel: "strict",
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      // Render labels as native SVG `<text>` instead of HTML inside
      // `<foreignObject>`.  resvg (Rust SVG renderer used for "Copy
      // as PNG") can't render foreignObject content, which left
      // class/flowchart diagrams as empty boxes when exported.
      // Visual delta on-screen is minimal — mermaid's text-mode
      // labels look almost identical to the HTML mode.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      class: { htmlLabels: false },
      state: { htmlLabels: false },
      // Mermaid 11 added the `treemap` diagram type and destructures
      // `config.treemap.tile` during global init — even when the doc
      // contains no treemap.  Without seeding the slot, that init
      // throws `Cannot destructure property 'tile' from null` and
      // breaks every other diagram type too.  These values match
      // mermaid's documented treemap defaults.
      treemap: {
        useMaxWidth: true,
        padding: 1,
        diagramPadding: 8,
        showValues: true,
        valueFontSize: 11,
        labelFontSize: 12,
        valueFormat: ",",
        tile: "squarify",
      },
      // Same defensive treatment for newer 11.x diagram types so a
      // patch release that adds another such destructure doesn't
      // surprise us.
      kanban: { useMaxWidth: true },
      architecture: { useMaxWidth: true },
    } as Parameters<MermaidLib["initialize"]>[0]);
    return lib;
  });
  return mermaidPromise;
}

const renderCache = new Map<string, string>();
const RENDER_CACHE_LIMIT = 32;

let counter = 0;
function uniqueId(): string {
  counter += 1;
  return `cm-md-mermaid-${counter}`;
}

/**
 * Render `source` into an SVG string, caching by source.  Throws if
 * the diagram doesn't parse — caller should display the error text.
 */
async function renderMermaid(source: string): Promise<string> {
  const cached = renderCache.get(source);
  if (cached !== undefined) return cached;
  const lib = await loadMermaid();
  const { svg } = await lib.render(uniqueId(), source);
  renderCache.set(source, svg);
  if (renderCache.size > RENDER_CACHE_LIMIT) {
    // FIFO eviction — drop the oldest entry.
    const first = renderCache.keys().next().value;
    if (first !== undefined) renderCache.delete(first);
  }
  return svg;
}

// ────────────────────────────────────────────────────────────────────────
// Copy toolbar
// ────────────────────────────────────────────────────────────────────────

/**
 * Tiny copy-icon SVG (lucide `copy`).  Inlined so the widget DOM
 * doesn't need to ship a React tree just to render an icon.
 */
const COPY_ICON_SVG = `
<svg viewBox="0 0 24 24" width="12" height="12" fill="none"
     stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
</svg>`;

/** Build the hover-only toolbar with SVG + PNG copy buttons. */
function makeToolbar(wrapper: HTMLElement): HTMLElement {
  const toolbar = document.createElement("div");
  toolbar.className = "cm-md-mermaid-toolbar";
  // Mark the subtree so `ignoreEvent` on the widget can recognise
  // events that originated here and tell CodeMirror to leave them
  // alone — without this, mousedown gets handled by CM's selection
  // machinery and collapses the widget back to its source range
  // before our click listener ever fires.
  toolbar.dataset.cmMermaidToolbar = "true";

  // CodeMirror's selection-on-mousedown means by the time `click`
  // fires the widget has already been replaced by raw markdown and
  // our button is gone.  Swallow the pointer events at the earliest
  // possible point.
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  toolbar.addEventListener("pointerdown", swallow);
  toolbar.addEventListener("mousedown", swallow);

  toolbar.appendChild(
    makeCopyButton({
      label: "SVG",
      title: "Copy as SVG (vector)",
      onClick: () => copyAsSvg(wrapper),
    }),
  );
  toolbar.appendChild(
    makeCopyButton({
      label: "PNG",
      title: "Copy as PNG (raster, 2× scale)",
      onClick: () => copyAsPng(wrapper),
    }),
  );
  return toolbar;
}

interface CopyButtonOpts {
  label: string;
  title: string;
  /** Returns `true` on success — drives the brief "Copied" flash. */
  onClick: () => Promise<boolean>;
}

function makeCopyButton(opts: CopyButtonOpts): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cm-md-mermaid-copy";
  btn.title = opts.title;
  btn.innerHTML = `${COPY_ICON_SVG}<span>${opts.label}</span>`;
  btn.addEventListener("click", (e) => {
    // Don't let the click bubble up to CodeMirror — without this it
    // can attempt to place the caret inside the (replaced) range.
    e.preventDefault();
    e.stopPropagation();
    void opts.onClick().then((ok) => {
      // Surface failure too — silent buttons make "did the clipboard
      // even change?" debugging miserable.
      flashLabel(btn, ok ? "Copied" : "Failed");
    });
  });
  return btn;
}

/** Briefly swap the button label for `text`, then restore. */
function flashLabel(btn: HTMLButtonElement, text: string): void {
  const original = btn.innerHTML;
  btn.innerHTML = `${COPY_ICON_SVG}<span>${text}</span>`;
  btn.classList.add("cm-md-mermaid-copy-flashing");
  window.setTimeout(() => {
    btn.innerHTML = original;
    btn.classList.remove("cm-md-mermaid-copy-flashing");
  }, 1200);
}

/** Find the `<svg>` element inside the widget, if any. */
function findSvg(wrapper: HTMLElement): SVGSVGElement | null {
  return wrapper.querySelector<SVGSVGElement>(".cm-md-mermaid-svg svg");
}

/**
 * Serialise the rendered SVG and copy it as plain text via Tauri's
 * clipboard plugin.  We deliberately route through the native plugin
 * rather than `navigator.clipboard` — the WKWebView clipboard API is
 * gated by user-activation + secure-context heuristics that don't
 * always fire from a synthetic widget click, and silently fails when
 * they don't.  Most apps (Obsidian, Notion, Slack, …) accept SVG XML
 * pasted as text.
 */
async function copyAsSvg(wrapper: HTMLElement): Promise<boolean> {
  const svg = findSvg(wrapper);
  if (!svg) return false;
  try {
    const xml = new XMLSerializer().serializeToString(svg);
    await writeText(xml);
    return true;
  } catch (err) {
    console.warn("[mermaid] copy SVG failed", err);
    return false;
  }
}

/**
 * Rasterise the rendered SVG to a 2×-scaled PNG on the **Rust** side
 * and put the bitmap on the native clipboard.
 *
 * Why not canvas?  WKWebView refuses to give us pixels back from any
 * canvas an SVG `<img>` was drawn into — `getImageData` /  `toBlob`
 * both throw `SecurityError: tainted canvas`.  This is enforced in
 * Safari / WebKit regardless of whether the SVG is self-contained or
 * loaded via blob URL, and there's no opt-out.
 *
 * Rust has no such hang-up: `resvg` parses the SVG and renders to
 * raw RGBA via `tiny_skia`, and the clipboard plugin pushes those
 * bytes straight into the OS clipboard.  All we ship over IPC is the
 * SVG XML string and a scale factor.
 */
async function copyAsPng(wrapper: HTMLElement): Promise<boolean> {
  const svg = findSvg(wrapper);
  if (!svg) return false;
  try {
    // Serialise *without* the surrounding `<div>` chrome so resvg
    // doesn't need to parse anything but the diagram itself.
    const xml = new XMLSerializer().serializeToString(svg);
    await invoke("markdown_copy_svg_as_png", { svg: xml, scale: 2 });
    return true;
  } catch (err) {
    console.warn("[mermaid] copy PNG failed", err);
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Widget
// ────────────────────────────────────────────────────────────────────────

export class MermaidWidget extends WidgetType {
  constructor(private readonly source: string) {
    super();
  }

  // CodeMirror reuses our DOM when eq returns true — skips the async
  // render entirely on selection-only updates.
  eq(other: MermaidWidget): boolean {
    return other.source === this.source;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-mermaid";

    // Hover-only copy toolbar (rendered before the diagram so it
    // sits above it in the stacking context — CSS handles the
    // absolute positioning + fade-in).
    const toolbar = makeToolbar(wrapper);
    wrapper.appendChild(toolbar);

    const status = document.createElement("div");
    status.className = "cm-md-mermaid-status";
    status.textContent = "rendering diagram…";
    wrapper.appendChild(status);

    void renderMermaid(this.source.trim())
      .then((svg) => {
        // Replace status with the rendered SVG, but preserve the
        // toolbar so hovering still surfaces the copy buttons.
        status.remove();
        const div = document.createElement("div");
        div.className = "cm-md-mermaid-svg";
        div.innerHTML = svg;
        wrapper.appendChild(div);
      })
      .catch((err: unknown) => {
        status.remove();
        const errBox = document.createElement("pre");
        errBox.className = "cm-md-mermaid-error";
        const message = err instanceof Error ? err.message : String(err);
        errBox.textContent = `mermaid error\n${message}`;
        wrapper.appendChild(errBox);
        // Hide the toolbar — there's nothing to copy from a parse
        // failure.
        toolbar.style.display = "none";
      });

    return wrapper;
  }

  // Default: hand events back to CodeMirror so a click on the
  // diagram still moves the caret into the source.  EXCEPTION:
  // events that originate inside the floating copy toolbar — those
  // are ours and CM should not get a chance to react to them (else
  // mousedown collapses the widget before our click handler runs).
  ignoreEvent(event: Event): boolean {
    const target = event.target;
    if (target instanceof Element) {
      if (target.closest("[data-cm-mermaid-toolbar='true']")) return true;
    }
    return false;
  }
}
