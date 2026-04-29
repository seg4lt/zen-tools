/**
 * Poll-interval settings for the Process Monitor.
 *
 * The sampler clamps values to `[100, 60_000]` ms backend-side, so the UI
 * just exposes the common presets. Custom value entry is intentionally
 * omitted — sub-100 ms intervals are noisy and over a minute is rarely
 * what someone wants from a live dashboard.
 */

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pmTauri } from "../lib/tauri";
import { useProcessMonitorStore } from "../store/process-monitor-store";

const PRESETS = [
  { ms: 250, label: "250 ms" },
  { ms: 500, label: "500 ms" },
  { ms: 1000, label: "1 s" },
  { ms: 2000, label: "2 s" },
  { ms: 5000, label: "5 s" },
];

export function Settings() {
  const { state, dispatch } = useProcessMonitorStore();

  const set = async (ms: number) => {
    try {
      await pmTauri.setPollInterval(ms);
      dispatch({ type: "setPollMs", ms });
    } catch (err) {
      console.error("[settings] set_poll_interval failed", err);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="mb-1 text-sm font-medium">Poll interval</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          How often to sample the monitored processes.
        </p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.ms}
              size="sm"
              variant={state.pollMs === p.ms ? "default" : "outline"}
              onClick={() => set(p.ms)}
              className={cn(state.pollMs === p.ms && "shadow-sm")}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
