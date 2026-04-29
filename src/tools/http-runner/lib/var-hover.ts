/**
 * CodeMirror hover-tooltip extension that resolves `{{var}}` tokens
 * to their values under the cursor.
 *
 * The extension takes a stable getter (read once per build) and a
 * `Compartment`-driven render: callers pass `varHoverTooltip(() => …)`
 * and call `editor.dispatch({ effects: compartment.reconfigure(...) })`
 * when their var maps change. To keep the API simple here we just take
 * a *ref* (a `{ current }` object) so the extension always sees the
 * latest values without reconfiguration.
 */
import { hoverTooltip, type Tooltip } from "@codemirror/view";

export interface VarContext {
  /** Already-extracted vars (highest priority — overrides everything). */
  extracted?: Record<string, string>;
  /** File-local `@name = value` declarations. */
  local?: Record<string, string>;
  /** Active environment vars from the env file. */
  env?: Record<string, string>;
}

/** Source label so the tooltip can say where the value came from. */
type Source = "extracted" | "local" | "env" | null;

function resolve(
  name: string,
  ctx: VarContext,
): { value: string; source: Source } {
  if (ctx.extracted && ctx.extracted[name] !== undefined) {
    return { value: ctx.extracted[name], source: "extracted" };
  }
  if (ctx.local && ctx.local[name] !== undefined) {
    return { value: ctx.local[name], source: "local" };
  }
  if (ctx.env && ctx.env[name] !== undefined) {
    return { value: ctx.env[name], source: "env" };
  }
  return { value: "", source: null };
}

/**
 * Single-pass token expansion (no recursion). Mirrors what the
 * front-end's `resolveUrl` does for previews so the hover value
 * matches what's shown elsewhere.
 */
function expandOnce(value: string, ctx: VarContext): string {
  return value.replace(/\{\{([^}]+)\}\}/g, (_, raw) => {
    const r = resolve((raw as string).trim(), ctx);
    return r.source ? r.value : `{{${(raw as string).trim()}}}`;
  });
}

const VAR_RE = /\{\{\s*([^}\s][^}]*?)\s*\}\}/g;

/**
 * Build the hover-tooltip extension. `ctxRef.current` is read at
 * hover time so callers don't need to reconfigure on every var
 * change — just keep the ref's value fresh.
 */
export function varHoverTooltip(ctxRef: { current: VarContext }) {
  return hoverTooltip(
    (view, pos): Tooltip | null => {
      const line = view.state.doc.lineAt(pos);
      const col = pos - line.from;
      // Find a `{{...}}` whose span covers the hover column. Scan
      // the whole line — perf is fine because lines are short and
      // this only runs on hover.
      VAR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = VAR_RE.exec(line.text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (col >= start && col <= end) {
          const name = m[1].trim();
          const ctx = ctxRef.current;
          const { value: rawValue, source } = resolve(name, ctx);
          // If the value itself contains placeholders (e.g.
          // `@baseUrl = {{host}}/api`), expand once so the tooltip
          // shows the user-visible string.
          const value =
            source && rawValue ? expandOnce(rawValue, ctx) : rawValue;

          return {
            pos: line.from + start,
            end: line.from + end,
            above: true,
            create: () => ({ dom: renderTooltip(name, value, source) }),
          };
        }
      }
      return null;
    },
    { hoverTime: 200 },
  );
}

function renderTooltip(
  name: string,
  value: string,
  source: Source,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "zen-var-tip";
  // Inline-style the host so we don't depend on Tailwind class
  // generation for content rendered by CodeMirror.
  Object.assign(root.style, {
    background: "var(--color-popover)",
    color: "var(--color-popover-foreground)",
    border: "1px solid var(--color-border)",
    borderRadius: "6px",
    padding: "6px 8px",
    fontSize: "11px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
    minWidth: "180px",
    maxWidth: "420px",
    lineHeight: "1.4",
  } as Partial<CSSStyleDeclaration>);

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.gap = "6px";
  header.style.marginBottom = "4px";

  const nameEl = document.createElement("span");
  nameEl.textContent = name;
  nameEl.style.fontWeight = "600";

  const sourceEl = document.createElement("span");
  sourceEl.textContent = source ?? "unresolved";
  Object.assign(sourceEl.style, {
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    padding: "1px 5px",
    borderRadius: "3px",
    background:
      source === "extracted"
        ? "var(--color-chart-1)"
        : source === "local"
          ? "var(--color-chart-3)"
          : source === "env"
            ? "var(--color-chart-2)"
            : "var(--color-destructive)",
    color: "var(--color-background)",
    opacity: "0.95",
  } as Partial<CSSStyleDeclaration>);

  header.appendChild(nameEl);
  header.appendChild(sourceEl);
  root.appendChild(header);

  const body = document.createElement("div");
  body.style.whiteSpace = "pre-wrap";
  body.style.wordBreak = "break-all";
  if (source) {
    body.textContent = value || "(empty string)";
    if (!value) body.style.opacity = "0.7";
  } else {
    body.textContent = "Variable not defined.";
    body.style.opacity = "0.7";
  }
  root.appendChild(body);

  return root;
}
