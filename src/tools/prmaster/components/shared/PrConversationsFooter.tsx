/**
 * PR-level comments footer for the PR Review page.
 *
 * Hangs underneath the file-tree + diff workspace and lists ONLY
 * top-level PR comments / @-mentions on the PR. **Code-anchored
 * review threads are deliberately excluded** — those render inline
 * beneath their target line in the diff editor (Pierre's
 * `renderAnnotation` slot), where the reviewer can read the comment
 * next to the actual code it's about. Surfacing review threads here
 * too would duplicate the same content in two places.
 *
 * The footer collapses on demand. The open/closed preference is
 * persisted in `localStorage` under `prmaster.reviewConversationsOpen`
 * so the user's last choice survives navigation away and back.
 * Default: open when at least one PR-level comment needs the user's
 * reply.
 *
 * The expanded body is capped at ~40vh with internal scrolling so a
 * long discussion never pushes the diff editor off-screen.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@zen-tools/ui";
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
}: Props) {
  // Filter to PR-level comments / @-mentions only. Review threads are
  // anchored to specific code lines and render inline in the diff
  // editor via Pierre's annotations — duplicating them here would
  // just be noise.
  const { needsReply, others, total } = useMemo(() => {
    const filtered = conversations.filter((c) => c.kind === "mention_comment");
    const needsReply: ConversationItem[] = [];
    const others: ConversationItem[] = [];
    for (const c of filtered) {
      if (conversationNeedsUserReply(c, currentUser)) {
        needsReply.push(c);
      } else {
        others.push(c);
      }
    }
    return { needsReply, others, total: filtered.length };
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
  // no PR-level comments at all (and we're not still loading).
  if (!loading && !error && total === 0) return null;

  return (
    <div className="grid min-h-0 shrink-0 gap-1.5">
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
        <span className="font-medium">PR Comments</span>
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
        // Cap the expanded body so a long discussion can't push the
        // diff editor off-screen — the body scrolls internally
        // instead of growing the page-level grid.
        <div className="grid max-h-[40vh] min-h-0 gap-2 overflow-y-auto px-1 pb-1.5">
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
            />
          )}
          {others.length > 0 && (
            <FooterSection label="Other comments" items={others} />
          )}
          {!loading && !error && total === 0 && (
            <div className="text-xs italic text-muted-foreground">
              No PR-level comments. Code-anchored discussion shows
              inline in the diff above.
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
}

function FooterSection({ label, items, emphasis }: SectionProps) {
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
        <ConversationThreadRow key={item.id} item={item} />
      ))}
    </div>
  );
}
