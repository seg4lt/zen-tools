import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Square, Download } from "lucide-react";
import { DragHandle } from "@/components/drag-handle";
import { Button } from "@/components/ui/button";
import { onPerfUpdate, tauri } from "./lib/tauri";
import type { MetricsSnapshot } from "./lib/perf-types";
import { useHttpRunner } from "./store/http-runner-store";
import { PerfFileTree } from "./components/perf-file-tree";
import { PerfTestList } from "./components/perf-test-list";
import { PerfCounters } from "./components/perf-counters";
import { PerfSparkline } from "./components/perf-sparkline";
import { LatencyHistogram } from "./components/latency-histogram";

/**
 * Two-pane layout: perf YAML tree on the left, test list + dashboard on
 * the right. Streams `perf:update` events into local state with a
 * requestAnimationFrame batcher so we don't re-render on every sample.
 */
export function PerformanceView() {
  const { dispatch } = useHttpRunner();
  const queryClient = useQueryClient();
  const [treeWidth, setTreeWidth] = useState(240);
  // Persist the selected perf config across tab switches and restarts so
  // mutating Cmd+1/Cmd+2 doesn't lose the user's place.
  const [selectedConfig, setSelectedConfigState] = useState<string | null>(() =>
    typeof window !== "undefined"
      ? window.localStorage.getItem("zen-tools.perf-config")
      : null,
  );
  const setSelectedConfig = (path: string | null) => {
    setSelectedConfigState(path);
    if (typeof window === "undefined") return;
    if (path) window.localStorage.setItem("zen-tools.perf-config", path);
    else window.localStorage.removeItem("zen-tools.perf-config");
  };
  const [selectedTest, setSelectedTest] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [currentUsers, setCurrentUsers] = useState<number | undefined>(
    undefined,
  );
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [exportToast, setExportToast] = useState<string | null>(null);

  const { data: config } = useQuery({
    queryKey: ["perf-config", selectedConfig],
    queryFn: () => tauri.loadPerfConfig(selectedConfig!),
    enabled: selectedConfig !== null,
  });

  // Hydrate the latest metrics snapshot once on mount.
  useEffect(() => {
    void tauri.getPerfMetrics().then((m) => {
      if (m) setMetrics(m);
    });
  }, []);

  // Subscribe to perf events with rAF batching.
  useEffect(() => {
    let pending: MetricsSnapshot | null = null;
    let pendingUsers: number | undefined;
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      if (pending) setMetrics(pending);
      if (pendingUsers !== undefined) setCurrentUsers(pendingUsers);
      pending = null;
      pendingUsers = undefined;
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(flush);
    };

    const promise = onPerfUpdate((update) => {
      switch (update.type) {
        case "started":
          setRunning(true);
          dispatch({
            type: "log",
            message: `Perf test started: ${update.testName}`,
          });
          break;
        case "progress":
          pending = update.metrics;
          pendingUsers = update.currentUsers;
          schedule();
          break;
        case "completed":
          setRunning(false);
          pending = update.finalMetrics;
          schedule();
          dispatch({
            type: "log",
            message: `Perf test completed: ${update.testName}`,
          });
          break;
        case "stopped":
          setRunning(false);
          pending = update.finalMetrics;
          schedule();
          dispatch({
            type: "log",
            level: "warn",
            message: `Perf test stopped: ${update.testName}`,
          });
          break;
        case "error":
          setRunning(false);
          dispatch({
            type: "log",
            level: "error",
            message: `Perf error (${update.testName}): ${update.message}`,
          });
          break;
      }
    });

    return () => {
      promise.then((fn) => fn()).catch(() => {});
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [dispatch]);

  const tests = useMemo(() => config?.tests ?? [], [config]);

  const onRun = async (idx: number) => {
    try {
      await tauri.runPerfTest(idx);
    } catch (err) {
      dispatch({
        type: "log",
        level: "error",
        message: `Run perf failed: ${(err as { message?: string }).message ?? err}`,
      });
    }
  };

  const onStop = async () => {
    try {
      await tauri.stopPerfTest();
    } catch (err) {
      dispatch({
        type: "log",
        level: "error",
        message: `Stop perf failed: ${(err as { message?: string }).message ?? err}`,
      });
    }
  };

  const onExport = async () => {
    try {
      const path = await tauri.exportPerfResults();
      setExportToast(path);
      window.setTimeout(() => setExportToast(null), 4000);
      dispatch({ type: "log", message: `Exported perf results: ${path}` });
    } catch (err) {
      dispatch({
        type: "log",
        level: "error",
        message: `Export failed: ${(err as { message?: string }).message ?? err}`,
      });
    }
  };

  return (
    <div className="flex h-full w-full min-h-0">
      {/* Left pane: perf file tree */}
      <div
        className="flex h-full min-h-0 flex-col border-r"
        style={{ width: `${treeWidth}px` }}
      >
        <PaneHeader
          title="Perf configs"
          right={
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() =>
                queryClient.invalidateQueries({ queryKey: ["perf-files"] })
              }
            >
              Refresh
            </Button>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PerfFileTree
            selectedPath={selectedConfig}
            onSelect={(item) => setSelectedConfig(item.path)}
          />
        </div>
      </div>

      <DragHandle
        direction="x"
        initial={treeWidth}
        min={200}
        max={420}
        onResize={setTreeWidth}
      />

      {/* Right pane: test list + dashboard */}
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <PaneHeader
          title={config ? `${tests.length} tests` : "Tests"}
          right={
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                disabled={selectedTest === null || running}
                onClick={() => selectedTest !== null && onRun(selectedTest)}
              >
                <Play className="size-3" /> Run
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                disabled={!running}
                onClick={onStop}
              >
                <Square className="size-3" /> Stop
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                disabled={!metrics}
                onClick={onExport}
              >
                <Download className="size-3" /> Export
              </Button>
            </div>
          }
        />

        <div className="flex min-h-0 flex-1">
          <div
            className="flex h-full min-h-0 flex-col border-r"
            style={{ width: 320 }}
          >
            <PerfTestList
              tests={tests}
              selectedIndex={selectedTest}
              isRunning={running}
              onSelect={setSelectedTest}
              onRun={(idx) => onRun(idx)}
            />
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
            {metrics ? (
              <>
                <PerfCounters metrics={metrics} currentUsers={currentUsers} />
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <PerfSparkline
                    title="Throughput (req/s)"
                    series={metrics.throughputHistory}
                    color="var(--color-method-get)"
                  />
                  <PerfSparkline
                    title="Latency avg (ms)"
                    series={metrics.latencyHistory}
                    color="var(--color-primary)"
                  />
                </div>
                <LatencyHistogram buckets={metrics.latencyBuckets} />
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                Pick a perf config and run a test to see live metrics.
              </div>
            )}
          </div>
        </div>

        {exportToast && (
          <div className="absolute bottom-4 right-4 max-w-sm rounded-md border bg-card px-3 py-2 text-xs shadow-lg">
            <div className="font-medium">Exported</div>
            <div className="break-all font-mono text-[10px] text-muted-foreground">
              {exportToast}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PaneHeader({
  title,
  right,
}: {
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-card/40 px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      <span className="truncate">{title}</span>
      <div className="ml-auto">{right}</div>
    </div>
  );
}
