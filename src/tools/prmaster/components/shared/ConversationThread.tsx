/**
 * Shared conversation-thread row + helpers, used by both the
 * Conversations tab (firehose of every unread thread across all
 * PRs) and the PrDetailPanel (filtered to just this PR).
 *
 * Pulled out of `tabs/ConversationsTab.tsx` so the detail-panel
 * inlining doesn't duplicate the rendering logic — small enough
 * to host in one shared file alongside the other PR detail bits.
 */

import { useState } from "react";
import { ExternalLink, MessageSquare } from "lucide-react";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { Badge } from "@zen-tools/ui";
import { Button } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import type { ConversationItem } from "../../lib/tauri";

/**
 * One collapsible conversation thread with author, file:line, body
 * preview, and on expand the full message history. Visual matches
 * the Conversations tab pixel-for-pixel so the same thread looks
 * the same regardless of where the user encounters it.
 */
export function ConversationThreadRow({ item }: { item: ConversationItem }) {
  const [open, setOpen] = useState(false);
  const lastMessage = item.messages[item.messages.length - 1];
  const preview = lastMessage?.body
    ?.replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .trim();
  const truncated =
    preview && preview.length > 90 ? `${preview.slice(0, 87)}...` : preview;
  // Reply count = total messages minus the original opening comment.
  // Mirrors `ConversationListView.swift:285–293` which renders a
  // bubble + count when there's at least one reply.
  const replyCount = Math.max(0, item.messages.length - 1);
  return (
    <div className="rounded-md border bg-background">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-accent/40"
      >
        <Badge
          variant={item.kind === "review_thread" ? "secondary" : "outline"}
          className="shrink-0"
        >
          {item.kind === "review_thread" ? "Thread" : "Mention"}
        </Badge>
        <div className="flex-1 overflow-hidden">
          <div className="font-medium">
            {lastMessage?.authorLogin
              ? `@${lastMessage.authorLogin}`
              : "Unknown"}
          </div>
          {item.filePath && (
            <div className="font-mono text-xs text-muted-foreground">
              {item.filePath}
              {item.lineNumber ? `:${item.lineNumber}` : ""}
            </div>
          )}
          {truncated && (
            <div className="line-clamp-2 text-xs text-muted-foreground">
              {truncated}
            </div>
          )}
        </div>
        {replyCount > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
            title={`${replyCount} ${replyCount === 1 ? "reply" : "replies"}`}
          >
            <MessageSquare className="size-3" />
            {replyCount}
          </span>
        )}
        <Button
          asChild
          size="icon-sm"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            void openUrl(item.exactUrl);
          }}
          aria-label="Open thread"
        >
          <span>
            <ExternalLink className="size-3.5" />
          </span>
        </Button>
      </button>

      {open && (
        <div className="grid gap-2 border-t bg-card p-3">
          {item.messages.map((m) => (
            <div
              key={m.id}
              className="rounded-md border bg-muted/40 px-3 py-2 text-xs"
            >
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium">
                  {m.authorLogin ? `@${m.authorLogin}` : "Unknown"}
                </span>
                <span>{new Date(m.createdAt).toLocaleString()}</span>
              </div>
              <div className="whitespace-pre-wrap">{m.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Whether the thread is waiting on a reply from the current user.
 * Mirrors `ConversationListView.swift::hasRepliesToCurrentUser`:
 *
 *   - `mention_comment` always counts (it's an explicit @-mention).
 *   - `review_thread` counts when, walking back from the most
 *     recent message, the most recent author who is NOT the
 *     current user is more recent than the current user's last
 *     message in the thread.
 */
export function conversationNeedsUserReply(
  item: ConversationItem,
  currentUser: string | null,
): boolean {
  if (item.kind === "mention_comment") return true;
  if (!currentUser) return false;
  const lower = currentUser.toLowerCase();
  let lastUserIdx = -1;
  for (let i = item.messages.length - 1; i >= 0; i--) {
    if (item.messages[i].authorLogin?.toLowerCase() === lower) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return false;
  return item.messages
    .slice(lastUserIdx)
    .some((m) => m.authorLogin?.toLowerCase() !== lower);
}

/**
 * Section header used by both the firehose view and the detail-panel
 * inline view. Two visual modes via `emphasis` — the
 * "Needs your reply" subsection lights up in destructive red so
 * the user can pick it out at a glance.
 */
export function ConversationSection({
  label,
  items,
  emphasis = false,
}: {
  label: string;
  items: ConversationItem[];
  emphasis?: boolean;
}) {
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
