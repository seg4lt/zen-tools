/**
 * Conversations footer for the PR Review page.
 *
 * Hangs underneath the file-tree + diff workspace and lists every
 * unresolved review thread + top-level comment on the PR (the
 * unfiltered set, not the user-involvement-filtered set the global
 * Conversations tab shows).
 *
 * Each row reuses `ConversationThreadRow` from `ConversationThread.tsx`
 * so the visual matches the rest of the app pixel-for-pixel. On
 * review-thread rows that carry a `filePath`, an extra "Jump" pill
 * lets the reviewer click straight from the discussion to the
 * relevant file in the diff editor — the parent owns `selectedPath`,
 * so the jump is just a callback.
 *
 * The footer collapses on demand. The open/closed preference is
 * persisted in `localStorage` under `prmaster.reviewConversationsOpen`
 * so the user's last choice survives navigation away and back.
 * Default: open when at least one thread needs the user's reply.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Loader2 } from "lucide-react";
import { Button, cn } from "@zen-tools/ui";
import {
  ConversationThreadRow,
  conversationNeedsUserReply,
} from "./ConversationThread";
import type { ConversationItem } from "../../lib/tauri";

const OPEN_KEY = "prmaster.reviewConversationsOpen";

interface Props {
  conversations: ConversationItem[];
  currentUser: string | null;
  loading: boolean;
  error: string | null;
  /** Optional jump-to-file callback. When provided, every review-thread
   *  row that has a `filePath` renders a small "Jump" pill that calls
   *  this with the path so the parent can sync the diff editor. */
  onSelectPath?: (path: string) => void;
}

/** Read the persisted open/closed flag. `null` → never set. */
function readStoredOpen(): boolean | null {
  try {
    const v = localStorage.getItem(OPEN_KEY);
    if (v === "true") return true;
    if (v === "false") return false;
    return null;
  } catch {
    return null;
  }
}

export function PrConversationsFooter({
  conversations,
  currentUser,
  loading,
  error,
  onSelectPath,
}: Props) {
  const { needsReply, others, total } = useMemo(() => {
    const needsReply: ConversationItem[] = [];
    const others: ConversationItem[] = [];
    for (const c of conversations) {
      if (conversationNeedsUserReply(c, currentUser)) {
        needsReply.push(c);
      } else {
        others.push(c);
      }
    }
    return { needsReply, others, total: conversations.length };
  }, [conversations, currentUser]);

  // Lazy-init: stored choice wins; fall back to "open when something
  // needs the user's reply", else closed. We deliberately freeze this
  // at first mount — once the user has expressed a preference we
  // honour it for the rest of the session, even if the needs-reply
  // count changes.
  const [open, setOpen] = useState<boolean>(() => {
    const stored = readStoredOpen();
    if (stored !== null) return stored;
    return needsReply.length > 0;
  });

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, String(open));
    } catch {
      // private browsing / quota — non-fatal, the toggle still works
      // in-session.
    }
  }, [open]);

  const toggle = useCallback(() => setOpen((o) => !o), []);

  // Empty + happy path: don't burn screen real estate when there are
  // no conversations at all and we're not still loading.
  if (!loading && !error && total === 0) return null;

  return (
    <div className="grid shrink-0 gap-1.5">
      <button
        type="button"
        onClick={toggle}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
          "border border-border/40 bg-card/30 hover:bg-card/50",
          "transition-colors",
        )}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground" />
        )}
        <span className="font-medium">Conversations</span>
        <span className="text-muted-foreground">
          {total} total
          {needsReply.length > 0 &&
            ` · ${needsReply.length} need${
              needsReply.length === 1 ? "s" : ""
            } your reply`}
        </span>
        {loading && (
          <Loader2 className="ml-auto size-3 animate-spin text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="grid gap-2 px-1 pb-1.5">
          {error && (
            <div className="rounded border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
              {error}
            </div>
          )}
          {needsReply.length > 0 && (
            <FooterSection
              label="Needs your reply"
              emphasis
              items={needsReply}
              onSelectPath={onSelectPath}
            />
          )}
          {others.length > 0 && (
            <FooterSection
              label="Other threads"
              items={others}
              onSelectPath={onSelectPath}
            />
          )}
          {!loading && !error && total === 0 && (
            <div className="text-xs italic text-muted-foreground">
              No outstanding conversations on this PR.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface SectionProps {
  label: string;
  items: ConversationItem[];
  emphasis?: boolean;
  onSelectPath?: (path: string) => void;
}

/**
 * Like `ConversationSection` from `ConversationThread.tsx`, but with
 * an inline "Jump" pill on review-thread rows that carry a file path.
 * Implemented as a sibling component (rather than extending the
 * shared one) to avoid leaking the review-page-specific jump action
 * into the firehose view.
 */
function FooterSection({ label, items, emphasis, onSelectPath }: SectionProps) {
  if (items.length === 0) return null;
  return (
    <div className="grid gap-2 py-1">
      <div
        className={cn(
          "text-xs font-semibold uppercase tracking-wide",
          emphasis ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {label}
      </div>
      {items.map((item) => (
        <div key={item.id} className="grid gap-1">
          <ConversationThreadRow item={item} />
          {onSelectPath && item.filePath && (
            <div className="flex">
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto h-5 gap-1 px-2 text-[10px]"
                onClick={() => onSelectPath(item.filePath!)}
                title="Open this file in the diff editor"
              >
                <FileText className="size-3" />
                Jump to {item.filePath}
                {item.lineNumber ? `:${item.lineNumber}` : ""}
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
