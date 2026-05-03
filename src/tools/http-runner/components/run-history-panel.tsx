/**
 * Per-request run history viewer.
 *
 * Backed by the on-disk `runs.json` ring buffer (last 10 entries per
 * request id). Lets the user:
 *
 * - Inspect any past run's response body (with the same JSON-pretty
 *   toggle as the Body tab).
 * - Diff a past run against the most-recent run, line-by-line, with
 *   colour-coded inserted / removed lines.
 *
 * The panel only renders when a request is selected and at least one
 * historical run exists for it.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, GitCompare, Trash2, XCircle } from "lucide-react";
import { diffLines } from "diff";
import { Button } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { tauri, type RunHistoryEntry } from "../lib/tauri";
import { ResponseBody } from "./response-body";

interface RunHistoryPanelProps {
  /** Stable id of the currently-selected request. */
  requestId: string;
}

type View = { kind: "list" } | { kind: "view"; index: number } | {
  kind: "diff";
  aIdx: number;
  bIdx: number;
};

export function RunHistoryPanel({ requestId }: RunHistoryPanelProps) {
  const queryClient = useQueryClient();
  const { data: history = [], isLoading } = useQuery({
    queryKey: ["run-history", requestId],
    queryFn: () => tauri.getRunHistory(requestId),
  });

  // Newest first for the user's mental model — most recent runs at
  // the top of the list, paired indices in `history` follow the
  // chronological order the backend stores.
  const orderedNewestFirst = useMemo(() => [...history].reverse(), [history]);
  const indexMap = useMemo(
    () =>
      orderedNewestFirst.map((_, i) => history.length - 1 - i) as number[],
    [orderedNewestFirst, history.length],
  );

  const [view, setView] = useState<View>({ kind: "list" });

  if (isLoading) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        Loading history…
      </div>
    );
  }
  if (history.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        No history yet — run this request and it'll appear here.
      </div>
    );
  }

  if (view.kind === "view") {
    const entry = history[view.index];
    const latestIdx = history.length - 1;
    return (
      <RunDetail
        entry={entry}
        isLatest={view.index === latestIdx}
        onBack={() => setView({ kind: "list" })}
        onDiffLatest={() =>
          setView({ kind: "diff", aIdx: view.index, bIdx: latestIdx })
        }
      />
    );
  }

  if (view.kind === "diff") {
    return (
      <DiffView
        a={history[view.aIdx]}
        b={history[view.bIdx]}
        onBack={() => setView({ kind: "list" })}
      />
    );
  }

  const onClear = async () => {
    await tauri.clearRunHistory(requestId);
    await queryClient.invalidateQueries({
      queryKey: ["run-history", requestId],
    });
  };

  const latestIdx = history.length - 1;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center justify-between border-b px-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>{history.length} of 10 max</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          onClick={() => void onClear()}
          title="Clear history"
          aria-label="Clear history"
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
      <ul className="flex-1 overflow-y-auto py-1 text-xs">
        {orderedNewestFirst.map((entry, listIdx) => {
          const realIdx = indexMap[listIdx];
          const isLatest = realIdx === latestIdx;
          return (
            <li key={`${entry.timestamp}-${realIdx}`}>
              <div
                className={cn(
                  "group flex items-center gap-2 px-2 py-1.5",
                  "hover:bg-muted/50",
                )}
              >
                <button
                  type="button"
                  onClick={() => setView({ kind: "view", index: realIdx })}
                  className="flex flex-1 items-center gap-2 text-left"
                >
                  <OutcomeIcon entry={entry} />
                  <div className="flex flex-1 flex-col gap-0.5 overflow-hidden">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium">
                        {entry.statusCode ?? "—"}
                      </span>
                      <span className="text-muted-foreground">
                        {entry.statusText ?? entry.errorMessage ?? ""}
                      </span>
                      {isLatest && (
                        <span className="ml-auto rounded bg-primary/15 px-1 text-[9px] uppercase tracking-wide text-primary">
                          latest
                        </span>
                      )}
                    </div>
                    <div className="flex items-baseline gap-2 font-mono text-[10px] text-muted-foreground">
                      <span>{formatTime(entry.timestamp)}</span>
                      {entry.durationMs != null && (
                        <span>· {Math.round(entry.durationMs)}ms</span>
                      )}
                      {entry.sizeBytes != null && (
                        <span>· {formatBytes(entry.sizeBytes)}</span>
                      )}
                    </div>
                  </div>
                </button>
                {!isLatest && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                    onClick={() =>
                      setView({
                        kind: "diff",
                        aIdx: realIdx,
                        bIdx: latestIdx,
                      })
                    }
                    title="Diff against latest"
                    aria-label="Diff against latest"
                  >
                    <GitCompare className="size-3" />
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function OutcomeIcon({ entry }: { entry: RunHistoryEntry }) {
  if (entry.outcome === "error") {
    return <XCircle className="size-4 shrink-0 text-destructive" />;
  }
  const code = entry.statusCode ?? 0;
  if (code >= 500)
    return <XCircle className="size-4 shrink-0 text-destructive" />;
  if (code >= 400)
    return <XCircle className="size-4 shrink-0 text-amber-500" />;
  return <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />;
}

function RunDetail({
  entry,
  isLatest,
  onBack,
  onDiffLatest,
}: {
  entry: RunHistoryEntry;
  isLatest: boolean;
  onBack: () => void;
  onDiffLatest: () => void;
}) {
  const contentType = entry.headers.find(
    ([k]) => k.toLowerCase() === "content-type",
  )?.[1];

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={onBack}
        >
          ← Back
        </Button>
        <span className="text-muted-foreground">
          {formatTime(entry.timestamp)}
        </span>
        <span className="font-mono">
          {entry.statusCode ?? "—"} {entry.statusText ?? ""}
        </span>
        {entry.bodyTruncated && (
          <span
            className="rounded bg-amber-500/15 px-1 text-[9px] uppercase tracking-wide text-amber-500"
            title="Body was truncated to fit history; diff may be incomplete"
          >
            truncated
          </span>
        )}
        {!isLatest && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 gap-1 px-2 text-[10px]"
            onClick={onDiffLatest}
          >
            <GitCompare className="size-3" /> Diff vs latest
          </Button>
        )}
      </div>
      {entry.outcome === "error" ? (
        <div className="p-4 font-mono text-xs text-destructive">
          {entry.errorMessage ?? "Unknown error"}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <ResponseBody body={entry.body} contentType={contentType} />
        </div>
      )}
    </div>
  );
}

function DiffView({
  a,
  b,
  onBack,
}: {
  a: RunHistoryEntry;
  b: RunHistoryEntry;
  onBack: () => void;
}) {
  // Pretty-print JSON bodies before diffing so a re-ordered key
  // doesn't visually masquerade as a content change.
  const aPretty = prettifyIfJson(a);
  const bPretty = prettifyIfJson(b);

  const parts = useMemo(() => diffLines(aPretty, bPretty), [aPretty, bPretty]);
  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const p of parts) {
      const lines = p.value.split("\n").length - 1 || 1;
      if (p.added) added += lines;
      else if (p.removed) removed += lines;
    }
    return { added, removed };
  }, [parts]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={onBack}
        >
          ← Back
        </Button>
        <span className="text-muted-foreground">
          {formatTime(a.timestamp)}
        </span>
        <span className="text-muted-foreground">→</span>
        <span className="text-muted-foreground">
          {formatTime(b.timestamp)}{" "}
          <span className="text-foreground">(latest)</span>
        </span>
        <span className="ml-auto font-mono text-[10px]">
          <span className="text-emerald-500">+{stats.added}</span>
          <span className="mx-1 text-muted-foreground">/</span>
          <span className="text-destructive">-{stats.removed}</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-card/30 p-2 font-mono text-[11px] leading-relaxed">
        {parts.map((part, idx) => (
          <pre
            key={idx}
            className={cn(
              "whitespace-pre-wrap break-all px-1",
              part.added && "bg-emerald-500/15 text-emerald-200",
              part.removed && "bg-destructive/15 text-destructive",
              !part.added && !part.removed && "text-muted-foreground",
            )}
          >
            {part.value
              .split("\n")
              .filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ""))
              .map((line) => `${part.added ? "+" : part.removed ? "-" : " "} ${line}`)
              .join("\n")}
          </pre>
        ))}
      </div>
    </div>
  );
}

function prettifyIfJson(entry: RunHistoryEntry): string {
  if (entry.outcome !== "success") return entry.errorMessage ?? "";
  const ct = entry.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1];
  if (ct && (ct.includes("application/json") || ct.includes("+json"))) {
    try {
      return JSON.stringify(JSON.parse(entry.body), null, 2);
    } catch {
      // fall through
    }
  }
  return entry.body;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
