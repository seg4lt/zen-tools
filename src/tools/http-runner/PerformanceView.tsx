/**
 * Placeholder for the Performance sub-view. Phase 13 replaces this with
 * the file tree + dashboard.
 */
export function PerformanceView() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-xl font-semibold">HTTP Runner — Performance</h2>
        <p className="text-sm text-muted-foreground">
          Sparklines, latency histogram, and live counters land later.
        </p>
      </div>
    </div>
  );
}
