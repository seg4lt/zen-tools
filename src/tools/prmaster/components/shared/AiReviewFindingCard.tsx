/**
 * Single finding card.
 *
 * Visual model: a soft severity-tinted **radial gradient** glows from
 * the upper-left of an otherwise dark, rounded card — same aesthetic
 * as the "Vim Mode" hero on the marketing page. Severity is encoded
 * twice: in the top-left icon plate (a small accent square holding a
 * lucide icon) and in the gradient tint, so you can scan the page at
 * a glance and the risk level still pops without reading the badge
 * text.
 *
 * Body sections (Current / Suggested / Why) flow vertically inside
 * the card with a generous gap so each block reads on its own. Code
 * snippets get a per-line gutter, syntax highlighting via the inline
 * `highlight()` tokenizer, and a copy button. The file:line chip in
 * the header also copies on click.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@zen-tools/ui";
import {
  AlertOctagon,
  AlertTriangle,
  Check,
  Copy,
  Info,
  Loader2,
  MessageSquarePlus,
  ShieldAlert,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { highlight, type Token } from "../../lib/highlight";
import type { AiReviewFinding } from "../../lib/tauri";

interface Props {
  finding: AiReviewFinding;
  /** Submit the (possibly edited) body to the backend. */
  onPost: (findingId: string, body: string) => Promise<void> | void;
  /** Fetch the default formatted body so the editor can pre-fill it.
   *  Returns the canonical Rust-side rendering of the finding so the
   *  frontend never has to mirror the formatter. */
  onLoadDraft: (findingId: string) => Promise<string>;
  /** True while a post is in flight for this finding. */
  posting?: boolean;
  /** True after a successful post; flips the button to a confirmation. */
  posted?: boolean;
}

export function AiReviewFindingCard({
  finding,
  onPost,
  onLoadDraft,
  posting,
  posted,
}: Props) {
  const sev = severityKey(finding.severity);
  const accent = SEVERITY_ACCENT[sev];

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-xl border border-border/40 shadow-sm transition-shadow hover:shadow-md",
      )}
      style={{
        // Two-layer background:
        //   1. A soft severity-tinted radial glow anchored upper-left,
        //      large radius so the colour fades gracefully into the
        //      card body (no hard edge).
        //   2. The base card colour underneath. We use `var(--card)`
        //      so the card still sits cleanly inside light themes.
        backgroundImage: `radial-gradient(circle at 12% 8%, ${accent.gradient} 0%, transparent 60%)`,
        backgroundColor: "var(--card)",
      }}
    >
      <div className="relative z-10 flex flex-col gap-2.5 px-3.5 py-3">
        <CardHeader finding={finding} sev={sev} />
        <Snippet
          label="Current"
          code={finding.current}
          language={finding.language}
          startLine={
            finding.snippet_start_line && finding.snippet_start_line > 0
              ? finding.snippet_start_line
              : finding.start_line
          }
          highlightLines={[finding.start_line, finding.end_line]}
          accent="current"
        />
        {finding.suggested && finding.suggested.trim() !== "" && (
          <Snippet
            label="Suggested"
            code={finding.suggested}
            language={finding.language}
            startLine={
              finding.snippet_start_line && finding.snippet_start_line > 0
                ? finding.snippet_start_line
                : finding.start_line
            }
            accent="suggested"
          />
        )}
        {finding.rationale && (
          <p className="whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/85">
            <span className="mr-1.5 align-baseline text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Why
            </span>
            {finding.rationale}
          </p>
        )}
        <CommentAction
          finding={finding}
          onPost={onPost}
          onLoadDraft={onLoadDraft}
          posting={posting}
          posted={posted}
        />
      </div>
    </article>
  );
}

function CardHeader({
  finding,
  sev,
}: {
  finding: AiReviewFinding;
  sev: SeverityKey;
}) {
  const accent = SEVERITY_ACCENT[sev];
  const Icon = accent.icon;
  return (
    <header className="flex items-start gap-2.5">
      {/* Severity icon plate — matches the small dark squares in the
          Vim Mode card from the marketing site. The plate has its
          own subtle border + a faint tint that picks up the severity
          colour, so the icon reads even when the gradient behind it
          is dim. */}
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/40 backdrop-blur-sm",
          accent.iconPlateBg,
        )}
      >
        <Icon className={cn("size-3.5", accent.iconColor)} aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-[12.5px] font-semibold leading-tight tracking-tight text-foreground">
          {finding.title}
        </h3>
        <FilePathChip
          path={finding.path}
          startLine={finding.start_line}
          endLine={finding.end_line}
        />
      </div>
      <SeverityPill sev={sev} />
    </header>
  );
}

function SeverityPill({ sev }: { sev: SeverityKey }) {
  const accent = SEVERITY_ACCENT[sev];
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider leading-none",
        accent.pillBg,
        accent.pillText,
      )}
    >
      {sev}
    </span>
  );
}

/** Click-to-copy `path:line` chip. */
function FilePathChip({
  path,
  startLine,
  endLine,
}: {
  path: string;
  startLine: number;
  endLine: number;
}) {
  const [copied, setCopied] = useState(false);
  const display =
    startLine === endLine
      ? `${path}:${startLine}`
      : `${path}:${startLine}-${endLine}`;
  const onCopy = useCallback(async () => {
    try {
      await writeText(display);
    } catch {
      try {
        await navigator.clipboard.writeText(display);
      } catch {
        return;
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [display]);

  return (
    <button
      type="button"
      onClick={onCopy}
      className="mt-0.5 inline-flex max-w-full items-center gap-1 rounded border border-transparent px-1 py-px font-mono text-[10px] leading-tight text-muted-foreground transition-colors hover:border-border/60 hover:bg-background/40 hover:text-foreground"
      title={copied ? "Copied!" : "Copy path"}
    >
      <span className="truncate">{display}</span>
      {copied ? (
        <Check className="size-2.5 shrink-0 text-emerald-500" />
      ) : (
        <Copy className="size-2.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}

interface SnippetProps {
  label: string;
  code: string;
  language?: string;
  startLine: number;
  highlightLines?: [number, number];
  accent: "current" | "suggested";
}

function Snippet({
  label,
  code,
  language,
  startLine,
  highlightLines,
  accent,
}: SnippetProps) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await writeText(code);
    } catch {
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        return;
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [code]);

  const lines = code.split("\n");

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <div
          className={cn(
            "text-[9px] font-semibold uppercase tracking-[0.14em]",
            accent === "current"
              ? "text-muted-foreground"
              : "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {label}
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1 rounded px-1 py-px text-[9px] text-muted-foreground transition-colors hover:bg-background/40 hover:text-foreground"
          title="Copy snippet"
        >
          {copied ? (
            <Check className="size-2.5 text-emerald-500" />
          ) : (
            <Copy className="size-2.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        className={cn(
          "ai-review-snippet overflow-x-auto rounded-md border py-1.5 font-mono text-[11px] leading-[1.5]",
          accent === "current"
            ? "border-border/40 bg-background/60 dark:bg-[#0a0c10]/80"
            : "border-emerald-500/30 bg-emerald-500/[0.04]",
        )}
      >
        {lines.map((line, i) => {
          const lineNum = startLine + i;
          const inHighlight =
            highlightLines &&
            lineNum >= highlightLines[0] &&
            lineNum <= highlightLines[1];
          const tokens = highlight(line, language);
          return (
            <div
              key={i}
              className={cn(
                "grid grid-cols-[2.75rem_1fr] items-baseline",
                inHighlight && "bg-amber-500/10",
              )}
            >
              <span className="select-none pr-2.5 text-right text-[9.5px] text-muted-foreground/70">
                {lineNum}
              </span>
              <code className="pr-2.5">
                {tokens.length === 0 ||
                (tokens.length === 1 && tokens[0].text === "") ? (
                  <span>&nbsp;</span>
                ) : (
                  tokens.map((tok, j) => <TokenSpan key={j} tok={tok} />)
                )}
              </code>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function TokenSpan({ tok }: { tok: Token }) {
  if (!tok.cls) return <span>{tok.text}</span>;
  return <span className={tokClass(tok.cls)}>{tok.text}</span>;
}

function tokClass(cls: string): string {
  switch (cls) {
    case "kw":
      return "text-violet-500 dark:text-violet-400 font-medium";
    case "typ":
      return "text-amber-600 dark:text-amber-400";
    case "str":
      return "text-emerald-600 dark:text-emerald-400";
    case "num":
      return "text-rose-500 dark:text-rose-400";
    case "com":
      return "text-muted-foreground italic";
    case "pun":
      return "text-foreground/60";
    case "fn":
      return "text-sky-600 dark:text-sky-400";
    default:
      return "";
  }
}

/** The trigger / inline editor for posting a finding as a real
 *  GitHub inline review comment.
 *
 *  States:
 *
 *    1. **Idle**     — single button "Post inline comment".
 *    2. **Editing**  — clicking the button expands this region into
 *                      an editable textarea pre-filled with the
 *                      backend's default body. The user can rewrite,
 *                      append, or trim anything they want; the body
 *                      that finally clicks **Post** is the body we
 *                      send to GitHub. A small note clarifies that
 *                      GitHub Markdown (including the
 *                      ```` ```suggestion ```` block) is supported.
 *    3. **Posting**  — Post button shows a spinner; both buttons
 *                      disabled.
 *    4. **Posted**   — the header row collapses back to a green
 *                      "Posted" badge.
 *
 *  We never auto-post on Enter — the user must click Post explicitly.
 *  Cancel reverts to Idle and discards the draft (next open re-fetches
 *  the default to make sure the user always starts from a clean
 *  reference).
 */
function CommentAction({
  finding,
  onPost,
  onLoadDraft,
  posting,
  posted,
}: {
  finding: AiReviewFinding;
  onPost: (findingId: string, body: string) => Promise<void> | void;
  onLoadDraft: (findingId: string) => Promise<string>;
  posting?: boolean;
  posted?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const open = useCallback(async () => {
    setEditing(true);
    setLoadError(null);
    setPostError(null);
    setLoadingDraft(true);
    try {
      const body = await onLoadDraft(finding.id);
      setDraft(body);
    } catch (e) {
      setLoadError(formatErr(e));
      setDraft("");
    } finally {
      setLoadingDraft(false);
    }
  }, [finding.id, onLoadDraft]);

  const cancel = useCallback(() => {
    setEditing(false);
    setDraft("");
    setLoadError(null);
    setPostError(null);
  }, []);

  const submit = useCallback(async () => {
    if (posting) return;
    const trimmed = draft.trim();
    if (!trimmed) return;
    setPostError(null);
    try {
      await onPost(finding.id, trimmed);
      // Parent flips `posted` once the call resolves; collapse the
      // editor so only the success-confirmation badge is left.
      setEditing(false);
    } catch (e) {
      // Keep the editor open with the user's draft intact so they
      // don't lose their edits when the GitHub call fails (e.g.
      // network blip, head SHA outdated, missing perms).
      setPostError(formatErr(e));
    }
  }, [draft, finding.id, onPost, posting]);

  // Auto-focus the textarea (and place the cursor at the end) when
  // the draft becomes available so the user can start typing
  // immediately without an extra click.
  useEffect(() => {
    if (editing && !loadingDraft && textareaRef.current) {
      const el = textareaRef.current;
      el.focus();
      // Place the caret at the end so the user can append a note
      // without first navigating past the prefilled body.
      const len = el.value.length;
      try {
        el.setSelectionRange(len, len);
      } catch {
        /* unsupported on some webview builds; non-fatal */
      }
    }
  }, [editing, loadingDraft]);

  if (posted) {
    return (
      <div className="flex items-center justify-end">
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium leading-none text-emerald-700 dark:text-emerald-400">
          <Check className="size-2.5" />
          Posted
        </span>
      </div>
    );
  }

  if (!editing) {
    return (
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => void open()}
          className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-background/40 px-2 py-1 text-[10.5px] font-medium text-foreground transition-colors hover:bg-accent"
        >
          <MessageSquarePlus className="size-2.5" />
          Post inline comment
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 rounded-md border border-border/50 bg-background/40 p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Comment body
        </div>
        <div className="font-mono text-[9.5px] text-muted-foreground">
          posts to{" "}
          <span className="text-foreground/80">
            {finding.path}:{finding.end_line}
          </span>
        </div>
      </div>
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={
          loadingDraft ? "Loading default body…" : "Write something thoughtful…"
        }
        rows={5}
        spellCheck
        disabled={loadingDraft}
        className={cn(
          "block w-full min-h-[100px] resize-y rounded border bg-background/60 px-2 py-1.5 font-mono text-[11.5px] leading-snug shadow-xs outline-none transition-[color,box-shadow]",
          "placeholder:text-muted-foreground",
          "focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/50",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "dark:bg-input/30",
        )}
      />
      {loadError && (
        <div className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
          Couldn't load default body: {loadError}.
        </div>
      )}
      {postError && (
        <div className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
          Posting failed: {postError}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9.5px] text-muted-foreground">
          GitHub Markdown · use{" "}
          <code className="rounded bg-muted px-1 font-mono text-[9px]">
            ```suggestion
          </code>{" "}
          for one-click apply
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={cancel}
            disabled={posting}
            className="rounded-md px-2 py-1 text-[10.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={posting || loadingDraft || draft.trim().length === 0}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[10.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {posting ? (
              <>
                <Loader2 className="size-2.5 animate-spin" />
                Posting…
              </>
            ) : (
              <>
                <MessageSquarePlus className="size-2.5" />
                Post
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatErr(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

type SeverityKey = "critical" | "high" | "medium" | "low";

interface SeverityAccent {
  /** Radial-gradient stop colour. Use a low-alpha rgba so the tint
   *  shows up softly against the dark base without overwhelming the
   *  surface. Tuned per-severity so red/amber don't drown out the
   *  green or blue alternatives. */
  gradient: string;
  /** Background of the small icon plate in the header. */
  iconPlateBg: string;
  /** Foreground colour of the icon inside the plate. */
  iconColor: string;
  /** Background of the severity pill (top-right of the header). */
  pillBg: string;
  /** Text colour of the severity pill. */
  pillText: string;
  /** lucide icon component the plate renders. */
  icon: typeof AlertOctagon;
}

const SEVERITY_ACCENT: Record<SeverityKey, SeverityAccent> = {
  critical: {
    gradient: "rgba(239, 68, 68, 0.22)",
    iconPlateBg: "bg-red-500/10",
    iconColor: "text-red-500",
    pillBg: "bg-red-500/15",
    pillText: "text-red-700 dark:text-red-400",
    icon: AlertOctagon,
  },
  high: {
    gradient: "rgba(245, 158, 11, 0.22)",
    iconPlateBg: "bg-amber-500/10",
    iconColor: "text-amber-500",
    pillBg: "bg-amber-500/15",
    pillText: "text-amber-700 dark:text-amber-400",
    icon: AlertTriangle,
  },
  medium: {
    gradient: "rgba(59, 130, 246, 0.22)",
    iconPlateBg: "bg-blue-500/10",
    iconColor: "text-blue-500",
    pillBg: "bg-blue-500/15",
    pillText: "text-blue-700 dark:text-blue-400",
    icon: ShieldAlert,
  },
  low: {
    gradient: "rgba(16, 185, 129, 0.20)",
    iconPlateBg: "bg-emerald-500/10",
    iconColor: "text-emerald-500",
    pillBg: "bg-emerald-500/15",
    pillText: "text-emerald-700 dark:text-emerald-400",
    icon: Info,
  },
};

function severityKey(input: string): SeverityKey {
  const s = (input ?? "").toLowerCase();
  if (s === "critical" || s === "high" || s === "medium" || s === "low") {
    return s;
  }
  if (s === "crit") return "critical";
  if (s === "med") return "medium";
  return "low";
}

export { severityKey as _severityKeyForTests };
export type { Token, SnippetProps };
