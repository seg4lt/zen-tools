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

    const status = document.createElement("div");
    status.className = "cm-md-mermaid-status";
    status.textContent = "rendering diagram…";
    wrapper.appendChild(status);

    void renderMermaid(this.source.trim())
      .then((svg) => {
        wrapper.innerHTML = svg;
      })
      .catch((err: unknown) => {
        wrapper.innerHTML = "";
        const errBox = document.createElement("pre");
        errBox.className = "cm-md-mermaid-error";
        const message = err instanceof Error ? err.message : String(err);
        errBox.textContent = `mermaid error\n${message}`;
        wrapper.appendChild(errBox);
      });

    return wrapper;
  }

  // Block widget — eats the entire range, no inline cursor positions
  // inside.  Clicking on the diagram should still place the caret on
  // the surrounding text rather than do nothing.
  ignoreEvent(): boolean {
    return false;
  }
}
