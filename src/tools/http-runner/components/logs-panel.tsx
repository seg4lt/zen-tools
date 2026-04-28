import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
          <SheetTitle className="flex items-center gap-2 text-sm">
            Logs
            <ClearLogsButton />
          </SheetTitle>
        </SheetHeader>
        <LogList />
      </SheetContent>
    </Sheet>
  );
}

function ClearLogsButton() {
  const { state, dispatch } = useHttpRunner();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="ml-auto h-6 px-2 text-xs"
      onClick={() => dispatch({ type: "clearLogs" })}
      disabled={state.logs.length === 0}
    >
      <Trash2 className="size-3" /> Clear
    </Button>
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
            <span>{entry.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
