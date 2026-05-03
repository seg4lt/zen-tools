import { Play, Users, Clock, Gauge } from "lucide-react";
import { cn } from "@zen-tools/ui";
import type { PerfTestDto } from "../lib/perf-types";

interface PerfTestListProps {
  tests: PerfTestDto[];
  selectedIndex: number | null;
  isRunning: boolean;
  onSelect: (idx: number) => void;
  onRun: (idx: number) => void;
}

/** List of perf tests parsed from the loaded YAML config. */
export function PerfTestList({
  tests,
  selectedIndex,
  isRunning,
  onSelect,
  onRun,
}: PerfTestListProps) {
  if (tests.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        No tests defined in this perf config.
      </div>
    );
  }
  return (
    <ul className="overflow-y-auto py-1 text-sm">
      {tests.map((test, idx) => {
        const active = idx === selectedIndex;
        return (
          <li key={idx}>
            <div
              className={cn(
                "group flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted/50",
                active && "bg-muted",
              )}
              onClick={() => onSelect(idx)}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium text-xs">
                  {test.name}
                </span>
                <span className="truncate font-mono text-[10px] text-muted-foreground">
                  {test.request}
                </span>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-0.5">
                    <Users className="size-3" />
                    {test.maxUsers}
                  </span>
                  <span className="flex items-center gap-0.5">
                    <Clock className="size-3" />
                    {Math.round(test.totalDurationMs / 1000)}s
                  </span>
                  {test.targetRps !== null && test.targetRps !== undefined && (
                    <span className="flex items-center gap-0.5">
                      <Gauge className="size-3" />
                      {test.targetRps}/s
                    </span>
                  )}
                  <span className="rounded-sm bg-muted px-1 py-0 font-mono uppercase text-[9px]">
                    {test.testType.type}
                  </span>
                </div>
              </div>
              <button
                type="button"
                disabled={isRunning}
                className="rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-primary/15 hover:text-primary disabled:cursor-not-allowed disabled:opacity-30 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onRun(idx);
                }}
                aria-label={`Run ${test.name}`}
                title={`Run ${test.name}`}
              >
                <Play className="size-3.5" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
