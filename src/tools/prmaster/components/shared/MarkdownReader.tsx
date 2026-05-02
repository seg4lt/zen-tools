/**
 * Tiny read-only Markdown renderer — local to PRMaster.
 *
 * Built specifically for AI Summary cards. The summary prompt
 * constrains the model to a known subset:
 *
 *   `## heading`, `### heading`
 *   `**bold**`, `*italic*`, `` `inline code` ``
 *   `- bullet` / `* bullet`
 *   plain paragraphs, blank lines as paragraph breaks
 *   ``` ```fenced code blocks``` ``` (rare — diff fences in commit
 *     summaries; we render them as monospace pre)
 *
 * The renderer produces real React elements (no `dangerouslySetInner-
 * HTML`) so even a model that goes off-prompt can't inject script
 * tags. Anything that doesn't match a recognised pattern falls back
 * to plain escaped text.
 */
import { useMemo } from "react";
import { cn } from "@/lib/utils";

type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string };

type Block =
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "p"; text: string };

const HEADING_RE = /^(#{2,3})\s+(.*)$/;
const BULLET_RE = /^[-*]\s+(.*)$/;
const CODE_FENCE_RE = /^```(.*)$/;

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // Skip blank lines.
    if (trimmed.length === 0) {
      i += 1;
      continue;
    }

    // Fenced code block: ```lang … ``` — accumulate until the closer.
    const fence = CODE_FENCE_RE.exec(trimmed);
    if (fence) {
      const lang = fence[1].trim() || null;
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !CODE_FENCE_RE.test(lines[i] ?? "")) {
        buf.push(lines[i] ?? "");
        i += 1;
      }
      // Skip the closing fence (or end-of-file).
      if (i < lines.length) i += 1;
      blocks.push({ kind: "code", lang, text: buf.join("\n") });
      continue;
    }

    // Heading.
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push({
        kind: level === 2 ? "h2" : "h3",
        text: heading[2].trim(),
      });
      i += 1;
      continue;
    }

    // Bullet list — accumulate consecutive bullets.
    if (BULLET_RE.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const m = BULLET_RE.exec(l.trim());
        if (!m) break;
        items.push(m[1].trim());
        i += 1;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    // Paragraph — accumulate non-blank, non-special lines.
    const paraLines: string[] = [trimmed];
    i += 1;
    while (i < lines.length) {
      const l = lines[i] ?? "";
      const t = l.trim();
      if (
        t.length === 0 ||
        HEADING_RE.test(l) ||
        BULLET_RE.test(t) ||
        CODE_FENCE_RE.test(t)
      ) {
        break;
      }
      paraLines.push(t);
      i += 1;
    }
    blocks.push({ kind: "p", text: paraLines.join(" ") });
  }
  return blocks;
}

/** Tokenise a single line into inline nodes — `**bold**`, `*italic*`,
 *  `` `code` ``, plain text. The patterns are non-overlapping and
 *  greedy-shortest so they stop at the first closing marker. */
function parseInline(text: string): InlineNode[] {
  const out: InlineNode[] = [];
  // Combined regex finds the next styled span; whatever sits before
  // it is a plain text node.
  const styled = /\*\*([^*]+?)\*\*|\*([^*\s][^*]*?)\*|`([^`]+?)`/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = styled.exec(text)) !== null) {
    if (m.index > lastIndex) {
      out.push({ kind: "text", text: text.slice(lastIndex, m.index) });
    }
    if (m[1] !== undefined) out.push({ kind: "strong", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "em", text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "code", text: m[3] });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    out.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return out;
}

function renderInline(nodes: InlineNode[]): React.ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case "strong":
        return (
          <strong key={i} className="font-semibold">
            {node.text}
          </strong>
        );
      case "em":
        return (
          <em key={i} className="italic">
            {node.text}
          </em>
        );
      case "code":
        return (
          <code
            key={i}
            className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
          >
            {node.text}
          </code>
        );
      default:
        return <span key={i}>{node.text}</span>;
    }
  });
}

export function MarkdownReader({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const blocks = useMemo(() => parseBlocks(source), [source]);

  return (
    <div
      className={cn(
        // Base typography mirrors the rest of the AI tab: small body
        // text with comfortable line-height, just enough vertical
        // rhythm between blocks to make the bullets readable.
        "space-y-2 px-2 py-2 text-sm leading-relaxed",
        className,
      )}
    >
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "h2":
            return (
              <h2
                key={i}
                className="text-sm font-semibold tracking-tight first:mt-0"
              >
                {renderInline(parseInline(block.text))}
              </h2>
            );
          case "h3":
            return (
              <h3
                key={i}
                className="text-xs font-semibold uppercase tracking-wide text-muted-foreground first:mt-0"
              >
                {renderInline(parseInline(block.text))}
              </h3>
            );
          case "ul":
            return (
              <ul key={i} className="ml-4 list-disc space-y-1 marker:text-muted-foreground">
                {block.items.map((item, j) => (
                  <li key={j}>{renderInline(parseInline(item))}</li>
                ))}
              </ul>
            );
          case "code":
            return (
              <pre
                key={i}
                className="overflow-x-auto rounded border bg-muted/50 p-2 font-mono text-xs"
                data-lang={block.lang ?? undefined}
              >
                {block.text}
              </pre>
            );
          case "p":
            return (
              <p key={i} className="text-sm">
                {renderInline(parseInline(block.text))}
              </p>
            );
        }
      })}
    </div>
  );
}
