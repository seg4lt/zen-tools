/**
 * CodeMirror 6 base theme matching the OKLCH design tokens. We build the
 * theme dynamically each render so theme switching takes effect without
 * remounting the editor.
 */

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/** Returns the editor theme + highlight extensions. */
export function makeEditorTheme(isDark: boolean): Extension[] {
  const baseTheme = EditorView.theme(
    {
      "&": {
        backgroundColor: "transparent",
        color: "var(--color-foreground)",
        fontSize: "13px",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        height: "100%",
      },
      ".cm-scroller": {
        fontFamily: "inherit",
        lineHeight: "1.55",
      },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: "var(--color-muted-foreground)",
        border: "none",
      },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in oklch, var(--color-muted) 50%, transparent)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "color-mix(in oklch, var(--color-muted) 50%, transparent)",
        color: "var(--color-foreground)",
      },
      ".cm-cursor": {
        borderLeftColor: "var(--color-primary)",
        borderLeftWidth: "2px",
      },
      "&.cm-focused .cm-selectionBackground, ::selection, .cm-selectionBackground":
        {
          backgroundColor:
            "color-mix(in oklch, var(--color-primary) 25%, transparent) !important",
        },
      ".cm-tooltip": {
        backgroundColor: "var(--color-popover)",
        color: "var(--color-popover-foreground)",
        border: "1px solid var(--color-border)",
        borderRadius: "6px",
      },
      ".cm-panels": {
        backgroundColor: "var(--color-card)",
        color: "var(--color-foreground)",
      },
      // Vim mode panel
      ".cm-vim-panel": {
        backgroundColor: "var(--color-card)",
        color: "var(--color-foreground)",
        borderTop: "1px solid var(--color-border)",
        padding: "2px 6px",
        fontFamily: "inherit",
      },
      ".cm-fat-cursor": {
        backgroundColor: "var(--color-primary) !important",
        color: "var(--color-primary-foreground) !important",
        opacity: "0.6 !important",
      },
    },
    { dark: isDark },
  );

  const highlightStyle = HighlightStyle.define([
    { tag: t.keyword, color: "var(--color-method-post)", fontWeight: "600" },
    { tag: t.string, color: "var(--color-method-get)" },
    { tag: t.propertyName, color: "var(--color-primary)" },
    { tag: t.variableName, color: "var(--color-method-patch)" },
    { tag: t.comment, color: "var(--color-muted-foreground)", fontStyle: "italic" },
    { tag: t.meta, color: "var(--color-method-delete)", fontWeight: "600" },
    { tag: t.number, color: "var(--color-method-put)" },
    { tag: t.bool, color: "var(--color-method-put)" },
    { tag: t.null, color: "var(--color-muted-foreground)" },
  ]);

  return [baseTheme, syntaxHighlighting(highlightStyle)];
}
