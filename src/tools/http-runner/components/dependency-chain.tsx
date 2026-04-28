import { ArrowDown, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExecutionStatus, RequestResult } from "../lib/tauri";

interface DependencyChainProps {
  steps: { id: string; name: string }[];
  results: Record<string, RequestResult>;
}

/** Vertical chain of cards for the planned execution order + status per step. */
export function DependencyChain({ steps, results }: DependencyChainProps) {
  if (steps.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        No dependencies — runs as a single request.
      </div>
    );
  }
  return (
    <ol className="flex flex-col gap-1 p-3">
      {steps.map((step, idx) => {
        const result = results[step.id];
        const isLast = idx === steps.length - 1;
        return (
          <li key={step.id} className="flex flex-col items-center">
            <ChainCard step={step} status={result?.status} />
            {!isLast && (
              <ArrowDown className="size-3 my-0.5 text-muted-foreground" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ChainCard({
  step,
  status,
}: {
  step: { id: string; name: string };
  status?: ExecutionStatus;
}) {
  const tone = statusTone(status);
  return (
    <div
      className={cn(
        "flex w-full items-center gap-2 rounded-md border bg-card px-3 py-1.5",
        tone.border,
      )}
    >
      <StatusIcon status={status} />
      <span className="truncate text-sm font-medium">{step.name}</span>
      <span className="ml-auto font-mono text-[10px] text-muted-foreground">
        {statusLabel(status)}
      </span>
    </div>
  );
}

function StatusIcon({ status }: { status?: ExecutionStatus }) {
  if (!status || status.type === "idle") {
    return <span className="size-4 rounded-full border" />;
  }
  if (status.type === "running") {
    return <Loader2 className="size-4 animate-spin text-primary" />;
  }
  if (status.type === "success") {
    return <CheckCircle2 className="size-4 text-emerald-500" />;
  }
  return <XCircle className="size-4 text-destructive" />;
}

function statusLabel(status?: ExecutionStatus): string {
  if (!status || status.type === "idle") return "—";
  if (status.type === "running") return "running";
  if (status.type === "success") {
    return `${status.response.statusCode} · ${Math.round(status.response.duration)}ms`;
  }
  return "error";
}

function statusTone(status?: ExecutionStatus): { border: string } {
  if (!status || status.type === "idle") return { border: "border-border" };
  if (status.type === "running") return { border: "border-primary/40" };
  if (status.type === "success") {
    const ok = status.response.statusCode < 400;
    return { border: ok ? "border-emerald-500/40" : "border-amber-500/40" };
  }
  return { border: "border-destructive/40" };
}
