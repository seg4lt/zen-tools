/**
 * Streaming log pane for an in-flight AI review.
 *
 * Renders one row per event with a coloured gutter:
 *
 *   * thought      → muted italic
 *   * tool_use     → blue, monospace tool name + truncated input
 *   * tool_result  → green (or red for `is_error`) + truncated output
 *   * text         → default
 *   * stdout       → muted monospace fallback
 *   * error        → red
 *
 * Auto-scrolls to the bottom on every new event unless the user has
 * scrolled up — in which case we hold their position and surface a
 * small "jump to live" anchor at the bottom right.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, cn } from "@zen-tools/ui";
import { ChevronDown, AlertTriangle, MessageSquare, Wrench, FileText, BrainCog } from "lucide-react";
import type { AiReviewEvent } from "../../lib/tauri";

interface Props {
  events: AiReviewEvent[];
}

/** Distance (in px) from the bottom we treat as "still tracking the
 *  live tail". Beyond it we stop auto-scrolling. */
const STICK_TO_BOTTOM_PX = 64;

export function AiReviewLogPane({ events }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(true);

  // Re-stick to bottom whenever a new event arrives.
  useEffect(() => {
    if (!stuck) return;
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events, stuck]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    setStuck(distanceFromBottom < STICK_TO_BOTTOM_PX);
  };

  const items = useMemo(
    () => events.map((event, idx) => ({ event, idx })),
    [events],
  );

  return (
    <div className="relative h-full min-h-0 overflow-hidden rounded-md border bg-card/30">
      <div
        ref={ref}
        onScroll={onScroll}
        className="h-full min-h-0 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-snug"
      >
        {items.length === 0 ? (
          <div className="text-muted-foreground">
            Waiting for the first event…
          </div>
        ) : (
          items.map(({ event, idx }) => (
            <LogRow key={idx} event={event} />
          ))
        )}
      </div>
      {!stuck && (
        <Button
          size="xs"
          variant="outline"
          className="absolute bottom-2 right-2 gap-1 text-[10px]"
          onClick={() => {
            setStuck(true);
            ref.current?.scrollTo({ top: ref.current.scrollHeight });
          }}
        >
          <ChevronDown className="size-3" />
          Jump to live
        </Button>
      )}
    </div>
  );
}

function LogRow({ event }: { event: AiReviewEvent }) {
  switch (event.kind) {
    case "thought":
      return (
        <Row icon={<BrainCog className="size-3 text-purple-500" />} accent="purple">
          <span className="italic text-muted-foreground">{event.text}</span>
        </Row>
      );
    case "tool_use":
      return (
        <Row icon={<Wrench className="size-3 text-blue-500" />} accent="blue">
          <span className="font-semibold text-blue-700 dark:text-blue-400">
            {event.name}
          </span>
          {event.input_preview && (
            <span className="text-muted-foreground"> · {event.input_preview}</span>
          )}
        </Row>
      );
    case "tool_result":
      return (
        <Row
          icon={
            event.is_error ? (
              <AlertTriangle className="size-3 text-red-500" />
            ) : (
              <FileText className="size-3 text-emerald-500" />
            )
          }
          accent={event.is_error ? "red" : "green"}
        >
          <span
            className={cn(
              "whitespace-pre-wrap break-words",
              event.is_error
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground",
            )}
          >
            {event.output_preview}
          </span>
        </Row>
      );
    case "text":
      return (
        <Row icon={<MessageSquare className="size-3 text-foreground" />} accent="default">
          <span className="whitespace-pre-wrap break-words">{event.text}</span>
        </Row>
      );
    case "done":
      return (
        <Row icon={<MessageSquare className="size-3 text-emerald-500" />} accent="green">
          <span className="text-emerald-600 dark:text-emerald-400">
            Review finished{" "}
            {event.findings_count != null
              ? `(${event.findings_count} finding${event.findings_count === 1 ? "" : "s"})`
              : ""}
            {event.cost_usd != null ? ` · cost $${event.cost_usd.toFixed(4)}` : ""}
          </span>
        </Row>
      );
    case "error":
      return (
        <Row icon={<AlertTriangle className="size-3 text-red-500" />} accent="red">
          <span className="text-red-600 dark:text-red-400">{event.message}</span>
        </Row>
      );
    case "stdout":
    default:
      return (
        <Row icon={<FileText className="size-3 text-muted-foreground" />} accent="default">
          <span className="text-muted-foreground">{event.line}</span>
        </Row>
      );
  }
}

function Row({
  icon,
  accent,
  children,
}: {
  icon: React.ReactNode;
  accent: "default" | "blue" | "green" | "red" | "purple";
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[16px_1fr] items-start gap-2 py-0.5">
      <span className="mt-0.5">{icon}</span>
      <div className={cn("min-w-0", accentClass(accent))}>{children}</div>
    </div>
  );
}

function accentClass(accent: string): string {
  switch (accent) {
    case "blue":
      return "border-l border-blue-500/30 pl-2";
    case "green":
      return "border-l border-emerald-500/30 pl-2";
    case "red":
      return "border-l border-red-500/30 pl-2";
    case "purple":
      return "border-l border-purple-500/30 pl-2";
    default:
      return "";
  }
}
