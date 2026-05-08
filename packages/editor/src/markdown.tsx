/**
 * `<MarkdownView>` — renders GitHub-flavoured markdown for comment
 * bodies. Used by the inline annotation cards inside the diff
 * viewer AND by the general PR comment list, so the visual is
 * consistent between the two surfaces.
 *
 * Inline styles instead of className for the same reason as the
 * rest of `diff-viewer.tsx`: the inline-annotation usage projects
 * this into Pierre's Shadow DOM via `<slot>`, and the `:host` sheet
 * sets font / color variables that override Tailwind utilities in
 * some browsers. Inline styles bypass the cascade reliably and
 * fall back to inherited color / font from the parent (so
 * dark-mode just works without any prop).
 *
 * GFM is enabled (tables, task-list checkboxes, autolinks,
 * strikethrough). Links open in the OS's default browser via
 * `@tauri-apps/plugin-shell` rather than navigating the webview;
 * checkboxes and images are read-only (rendering only).
 */

import { type CSSProperties } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { open as openUrl } from "@tauri-apps/plugin-shell";

export interface MarkdownViewProps {
  /** Markdown source — typically a comment body fresh from GitHub. */
  body: string;
  /** Wrapper style overrides (font-size, line-height, etc.). The
   *  default inherits from the parent so the comment body picks up
   *  whatever the surrounding card defined. */
  style?: CSSProperties;
}

/** Style fragments shared across multiple element overrides. Pulled
 *  out so they're easy to tweak in one place. */
const MUTED_BORDER = "rgba(120, 120, 130, 0.35)";
const SUBTLE_BG = "rgba(120, 120, 130, 0.12)";
const CODE_FONT =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

const components: Components = {
  // Tighter paragraph spacing than browser default (`<p>` defaults
  // to ~1em margins; comment bodies are short so 4px reads better).
  p: ({ children }) => (
    <p
      style={{
        margin: "4px 0",
        lineHeight: 1.5,
        overflowWrap: "anywhere",
        wordBreak: "normal",
      }}
    >
      {children}
    </p>
  ),
  // Inline code (`foo`) → boxed monospace; fenced code (```…```)
  // gets the `<pre>` wrapper handled separately below.
  code: ({ className, children, ...rest }) => {
    // Block-level code (fenced) lands inside `<pre>` and ALSO
    // passes through this component. The `<pre>` override sets
    // its own background; here we just style inline code.
    if (rest.node?.position && className?.startsWith("language-")) {
      return (
        <code
          {...rest}
          style={{
            fontFamily: CODE_FONT,
            fontSize: "0.92em",
          }}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        {...rest}
        style={{
          fontFamily: CODE_FONT,
          fontSize: "0.92em",
          padding: "1px 5px",
          borderRadius: 3,
          background: SUBTLE_BG,
        }}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre
      style={{
        margin: "6px 0",
        padding: "8px 10px",
        background: SUBTLE_BG,
        border: `1px solid ${MUTED_BORDER}`,
        borderRadius: 4,
        overflowX: "auto",
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      {children}
    </pre>
  ),
  // Open links in the OS browser — webview navigation would lose
  // the user's place in the review.
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (!href) return;
        e.preventDefault();
        e.stopPropagation();
        void openUrl(href);
      }}
      style={{
        color: "var(--primary, #3b82f6)",
        textDecoration: "underline",
        textUnderlineOffset: 2,
      }}
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul style={{ margin: "4px 0", paddingLeft: 20 }}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol style={{ margin: "4px 0", paddingLeft: 20 }}>{children}</ol>
  ),
  li: ({ children }) => (
    <li
      style={{
        margin: "2px 0",
        overflowWrap: "anywhere",
        wordBreak: "normal",
      }}
    >
      {children}
    </li>
  ),
  blockquote: ({ children }) => (
    <blockquote
      style={{
        margin: "6px 0",
        padding: "2px 10px",
        borderLeft: `3px solid ${MUTED_BORDER}`,
        opacity: 0.85,
      }}
    >
      {children}
    </blockquote>
  ),
  h1: ({ children }) => (
    <h1 style={{ fontSize: "1.25em", fontWeight: 600, margin: "8px 0 4px" }}>
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ fontSize: "1.15em", fontWeight: 600, margin: "8px 0 4px" }}>
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 style={{ fontSize: "1.05em", fontWeight: 600, margin: "6px 0 4px" }}>
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 style={{ fontSize: "1em", fontWeight: 600, margin: "6px 0 4px" }}>
      {children}
    </h4>
  ),
  hr: () => (
    <hr
      style={{
        border: 0,
        borderTop: `1px solid ${MUTED_BORDER}`,
        margin: "8px 0",
      }}
    />
  ),
  table: ({ children }) => (
    <div style={{ overflowX: "auto", margin: "6px 0" }}>
      <table
        style={{
          borderCollapse: "collapse",
          fontSize: "0.95em",
        }}
      >
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th
      style={{
        border: `1px solid ${MUTED_BORDER}`,
        padding: "4px 8px",
        textAlign: "left",
        fontWeight: 600,
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      style={{
        border: `1px solid ${MUTED_BORDER}`,
        padding: "4px 8px",
      }}
    >
      {children}
    </td>
  ),
  img: ({ src, alt }) => (
    <img
      src={src}
      alt={alt ?? ""}
      style={{
        maxWidth: "100%",
        borderRadius: 4,
        margin: "4px 0",
      }}
    />
  ),
  // GFM task-list checkbox — react-markdown renders `<input>` for
  // these. Force read-only (we don't sync state back to GitHub) and
  // remove the default cursor pointer so it doesn't look clickable.
  input: ({ type, checked, ...rest }) =>
    type === "checkbox" ? (
      <input
        {...rest}
        type="checkbox"
        checked={checked ?? false}
        readOnly
        style={{ marginRight: 6, cursor: "default" }}
      />
    ) : (
      <input {...rest} type={type} />
    ),
};

export function MarkdownView({ body, style }: MarkdownViewProps) {
  return (
    <div
      // `overflowWrap: anywhere` keeps normal prose on word
      // boundaries, but still breaks long URLs / hashes before they
      // blow out the comment card width. Inherited font/colour means the
      // surrounding card decides the base style.
      style={{
        whiteSpace: "normal",
        overflowWrap: "anywhere",
        wordBreak: "normal",
        ...style,
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}
