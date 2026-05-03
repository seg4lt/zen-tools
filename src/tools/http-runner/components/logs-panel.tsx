import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@zen-tools/ui";
import { Button } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { useHttpRunner } from "../store/http-runner-store";

/** Bottom slide-up sheet showing the rolling log buffer. */
export function LogsPanel({ children }: { children: React.ReactNode }) {
  return (
    <Sheet>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent
        side="bottom"
        className="h-[40vh] sm:max-w-none p-0 flex flex-col"
      >
        <SheetHeader className="border-b px-4 py-2">
          {/* Right-side close button (X) is rendered automatically by
              SheetContent. Keep this row to its title only so the two
              don't collide. */}
          <SheetTitle className="text-sm">Logs</SheetTitle>
        </SheetHeader>
        <ToolBar />
        <LogList />
      </SheetContent>
    </Sheet>
  );
}

function ToolBar() {
  const { state, dispatch } = useHttpRunner();
  return (
    <div className="flex h-8 shrink-0 items-center border-b px-3 text-xs">
      <span className="text-muted-foreground">
        {state.logs.length}{" "}
        {state.logs.length === 1 ? "entry" : "entries"}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto h-6 gap-1 px-2 text-xs"
        onClick={() => dispatch({ type: "clearLogs" })}
        disabled={state.logs.length === 0}
      >
        <Trash2 className="size-3" />
        Clear
      </Button>
    </div>
  );
}

function LogList() {
  const { state } = useHttpRunner();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom unless the user has scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.logs.length]);

  if (state.logs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        No log entries.
      </div>
    );
  }
  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto font-mono text-xs">
      <ul className="divide-y">
        {state.logs.map((entry, idx) => (
          <li
            key={`${entry.ts}-${idx}`}
            className={cn(
              "grid grid-cols-[max-content_max-content_1fr] gap-3 px-3 py-1",
              entry.level === "error" && "text-destructive",
              entry.level === "warn" && "text-amber-500",
            )}
          >
            <span className="text-muted-foreground">
              {entry.ts.slice(11, 19)}
            </span>
            <span className="font-semibold uppercase">{entry.level}</span>
            <span className="break-words">{entry.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
