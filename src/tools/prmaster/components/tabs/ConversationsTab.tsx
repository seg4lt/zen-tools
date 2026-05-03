/**
 * Conversations tab — unresolved review threads + @mentions on PRs you're
 * involved in, grouped by PR. Built on shadcn Card + Badge so the visual
 * idiom matches every other PRMaster tab.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { Badge } from "@zen-tools/ui";
import { Button } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { Panel, PanelContent } from "../shared/density";
import {
  loadConversations,
  usePrMasterStore,
} from "../../store/prmaster-store";
import type {
  ConversationGroup,
  ConversationItem,
} from "../../lib/tauri";

export function ConversationsTab() {
  const { state, dispatch } = usePrMasterStore();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (
      state.conversations.length === 0 &&
      !state.loading.conversations &&
      !state.errors.conversations
    ) {
      void loadConversations(dispatch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = useMemo(
    () => state.conversations.reduce((sum, g) => sum + g.conversations.length, 0),
    [state.conversations],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center justify-between border-b bg-card/40 px-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">Conversations</h2>
          <span className="text-xs text-muted-foreground">
            {total} on {state.conversations.length} PRs
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={state.loading.conversations}
          onClick={() => void loadConversations(dispatch)}
        >
          {state.loading.conversations ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Refresh
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        {state.errors.conversations && (
          <Panel className="mb-2 border-destructive/40 bg-destructive/5">
            <PanelContent className="p-2 text-xs text-destructive">
              {state.errors.conversations}
            </PanelContent>
          </Panel>
        )}

        {state.conversations.length === 0 &&
          !state.loading.conversations &&
          !state.errors.conversations && (
            <div className="my-12 text-center text-xs text-muted-foreground">
              No active conversations on PRs you're involved in.
            </div>
          )}

        <div className="flex flex-col gap-1.5">
          {state.conversations.map((group) => (
            <ConversationGroupRow
              key={group.prId}
              group={group}
              expanded={!!expanded[group.prId]}
              onToggle={() =>
                setExpanded((prev) => ({
                  ...prev,
                  [group.prId]: !prev[group.prId],
                }))
              }
              currentUser={state.currentUser}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ConversationGroupRow({
  group,
  expanded,
  onToggle,
  currentUser,
}: {
  group: ConversationGroup;
  expanded: boolean;
  onToggle: () => void;
  currentUser: string | null;
}) {
  const needsReply = group.conversations.filter((c) =>
    needsUserReply(c, currentUser),
  );
  const others = group.conversations.filter(
    (c) => !needsUserReply(c, currentUser),
  );

  return (
    <Panel>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-t-md px-2.5 py-1.5 text-left transition-colors hover:bg-accent/50"
      >
        {expanded ? (
          <ChevronDown className="size-4 shrink-0" />
        ) : (
          <ChevronRight className="size-4 shrink-0" />
        )}
        <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
        <span className="line-clamp-1 flex-1 text-sm font-medium">
          {group.prTitle}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {group.repoNameWithOwner}#{group.prNumber}
        </span>
        {needsReply.length > 0 && (
          <Badge variant="destructive">
            {needsReply.length} needs reply
          </Badge>
        )}
        <Badge variant="outline">{group.conversations.length}</Badge>
        <Button
          asChild
          size="icon-sm"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            void openUrl(group.prUrl);
          }}
          aria-label="Open PR"
        >
          <span>
            <ExternalLink className="size-3.5" />
          </span>
        </Button>
      </button>

      {expanded && (
        <PanelContent className="border-t p-2.5">
          {needsReply.length > 0 && (
            <Section label="Needs your reply" emphasis items={needsReply} />
          )}
          {others.length > 0 && (
            <Section label="Other threads" items={others} />
          )}
        </PanelContent>
      )}
    </Panel>
  );
}

function Section({
  label,
  items,
  emphasis = false,
}: {
  label: string;
  items: ConversationItem[];
  emphasis?: boolean;
}) {
  return (
    <div className="grid gap-2 py-1">
      <div
        className={cn(
          "text-xs font-semibold tracking-wide uppercase",
          emphasis ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {label}
      </div>
      {items.map((item) => (
        <ThreadRow key={item.id} item={item} />
      ))}
    </div>
  );
}

function ThreadRow({ item }: { item: ConversationItem }) {
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
 * Mirrors the Swift `hasRepliesToCurrentUser` getter.
 */
function needsUserReply(
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
