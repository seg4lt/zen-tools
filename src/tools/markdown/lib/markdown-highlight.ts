/**
 * Markdown-specific syntax highlight palette.
 *
 * The shared `cm-theme` (used by http-runner) maps a small set of
 * tags to HTTP-method colours, which is fine for `.http` files but
 * leaves real code mostly uncoloured (no function/type/operator
 * rules).  This style supplements that one — `syntaxHighlighting`
 * stacks, with later definitions winning conflicts.
 *
 * We bind to the most-used Lezer tags so most languages
 * (`@codemirror/lang-*`) get a usable colour out of the box:
 *
 *   - `function` / `definition(variableName)` for callable names
 *   - `typeName` / `className` for type-side identifiers
 *   - `controlKeyword` / `modifier` for `if`, `pub`, …
 *   - `operator` / `punctuation` for `=`, `;`, `:`, brackets
 *   - `regexp` / `escape` for in-string tokens
 *   - `heading*` / `link` / `emphasis` / `strong` / `strikethrough`
 *     for the markdown body itself (so headers, bold, etc. inherit
 *     a consistent colour with the live-preview decorations).
 */

import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const markdownHighlightStyle = HighlightStyle.define([
  // ── Identifiers ──────────────────────────────────────────────
  {
    tag: t.function(t.variableName),
    color: "var(--color-primary)",
    fontWeight: "600",
  },
  { tag: t.function(t.propertyName), color: "var(--color-primary)" },
  {
    tag: t.definition(t.variableName),
    color: "var(--color-primary)",
    fontWeight: "600",
  },
  { tag: t.definition(t.propertyName), color: "var(--color-primary)" },
  { tag: t.typeName, color: "var(--color-method-put)" },
  { tag: t.className, color: "var(--color-method-put)" },
  { tag: t.namespace, color: "var(--color-method-patch)" },
  { tag: t.labelName, color: "var(--color-method-patch)" },
  // ── Keywords ─────────────────────────────────────────────────
  {
    tag: t.controlKeyword,
    color: "var(--color-method-post)",
    fontWeight: "600",
  },
  {
    tag: t.modifier,
    color: "var(--color-method-post)",
    fontWeight: "600",
  },
  { tag: t.operatorKeyword, color: "var(--color-method-post)" },
  // ── Operators / punctuation ──────────────────────────────────
  { tag: t.operator, color: "var(--color-foreground)" },
  { tag: t.punctuation, color: "var(--color-muted-foreground)" },
  { tag: t.bracket, color: "var(--color-muted-foreground)" },
  { tag: t.angleBracket, color: "var(--color-muted-foreground)" },
  { tag: t.squareBracket, color: "var(--color-muted-foreground)" },
  { tag: t.brace, color: "var(--color-muted-foreground)" },
  { tag: t.separator, color: "var(--color-muted-foreground)" },
  // ── Literals ─────────────────────────────────────────────────
  { tag: t.regexp, color: "var(--color-method-get)" },
  { tag: t.escape, color: "var(--color-method-put)" },
  { tag: t.atom, color: "var(--color-method-put)" },
  { tag: t.special(t.string), color: "var(--color-method-put)" },
  { tag: t.special(t.variableName), color: "var(--color-method-delete)" },
  // ── Markdown body ────────────────────────────────────────────
  // (Live-Preview decorations apply visual sizing via line classes;
  // these tag rules give the heading/link/emphasis text *inside*
  // the live-preview decorations a consistent foreground colour.)
  {
    tag: t.heading,
    color: "var(--color-foreground)",
    fontWeight: "700",
  },
  { tag: t.link, color: "var(--color-primary)" },
  { tag: t.url, color: "var(--color-primary)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  {
    tag: t.strikethrough,
    textDecoration: "line-through",
    color: "var(--color-muted-foreground)",
  },
  // ── Misc ─────────────────────────────────────────────────────
  { tag: t.processingInstruction, color: "var(--color-method-delete)" },
  { tag: t.invalid, color: "var(--color-destructive)" },
]);
