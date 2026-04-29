/**
 * Perf-runner hook — owns metrics/event wiring for the unified Requests
 * view. Activated when the user opens a `.perf.yaml` file. Loads the
 * config, subscribes to streaming `perf:update` events with rAF
 * batching, and exposes run/stop/export actions.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { onPerfUpdate, tauri } from "../lib/tauri";
import type { MetricsSnapshot } from "../lib/perf-types";
import { useHttpRunner } from "../store/http-runner-store";

export interface UsePerfRunnerResult {
  config: ReturnType<typeof useQuery<Awaited<ReturnType<typeof tauri.loadPerfConfig>>>>["data"];
  /** Tests parsed from the YAML, or empty when no config is loaded. */
  tests: Awaited<ReturnType<typeof tauri.loadPerfConfig>>["tests"];
  /** Index of the highlighted test in the list. */
  selectedTest: number | null;
  setSelectedTest: (idx: number | null) => void;
  metrics: MetricsSnapshot | null;
  /** Live "users" count emitted by the running test. */
  currentUsers: number | undefined;
  isRunning: boolean;
  /** Most recent export path (toast text); cleared after a few seconds. */
  exportToast: string | null;
  run: (idx: number) => Promise<void>;
  stop: () => Promise<void>;
  exportResults: () => Promise<void>;
}

/**
 * Subscribe to perf state for the given config path. Pass `null` to
 * keep everything inert (tests empty, no listener wiring beyond the
 * one-time mount subscription).
 */
export function usePerfRunner(configPath: string | null): UsePerfRunnerResult {
  const { dispatch } = useHttpRunner();

  const config = useQuery({
    queryKey: ["perf-config", configPath],
    queryFn: () => tauri.loadPerfConfig(configPath!),
    enabled: configPath !== null,
  });

  const [selectedTest, setSelectedTest] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [currentUsers, setCurrentUsers] = useState<number | undefined>(
    undefined,
  );
  const [isRunning, setIsRunning] = useState(false);
  const [exportToast, setExportToast] = useState<string | null>(null);

  // Reset the highlighted test when the config changes — different file
  // means different test indices, so leaving the old selection in place
  // would point at a wrong (or out-of-range) row.
  useEffect(() => {
    setSelectedTest(null);
  }, [configPath]);

  // Hydrate the latest metrics snapshot once on mount so the dashboard
  // shows something after a tab/route bounce.
  useEffect(() => {
    void tauri.getPerfMetrics().then((m) => {
      if (m) setMetrics(m);
    });
  }, []);

  // High-frequency `perf:update` events get rAF-batched — otherwise we
  // re-render on every sample and the chart updates janks.
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
          setIsRunning(true);
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
          setIsRunning(false);
          pending = update.finalMetrics;
          schedule();
          dispatch({
            type: "log",
            message: `Perf test completed: ${update.testName}`,
          });
          break;
        case "stopped":
          setIsRunning(false);
          pending = update.finalMetrics;
          schedule();
          dispatch({
            type: "log",
            level: "warn",
            message: `Perf test stopped: ${update.testName}`,
          });
          break;
        case "error":
          setIsRunning(false);
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

  const tests = useMemo(() => config.data?.tests ?? [], [config.data]);

  const run = useCallback(
    async (idx: number) => {
      try {
        await tauri.runPerfTest(idx);
      } catch (err) {
        dispatch({
          type: "log",
          level: "error",
          message: `Run perf failed: ${(err as { message?: string }).message ?? err}`,
        });
      }
    },
    [dispatch],
  );

  const stop = useCallback(async () => {
    try {
      await tauri.stopPerfTest();
    } catch (err) {
      dispatch({
        type: "log",
        level: "error",
        message: `Stop perf failed: ${(err as { message?: string }).message ?? err}`,
      });
    }
  }, [dispatch]);

  const exportResults = useCallback(async () => {
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
  }, [dispatch]);

  return {
    config: config.data,
    tests,
    selectedTest,
    setSelectedTest,
    metrics,
    currentUsers,
    isRunning,
    exportToast,
    run,
    stop,
    exportResults,
  };
}
