/**
 * API Stats tab — live view of `gh` CLI invocations.
 * Built on shadcn Card + Badge + Switch with the same header pattern as
 * every other PRMaster tab.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { prmasterTauri, type GhCall } from "../../lib/tauri";

export function ApiStatsTab() {
  const [calls, setCalls] = useState<GhCall[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchOnce() {
    try {
      const data = await prmasterTauri.getCallLog();
      setCalls(data);
    } catch (err) {
      console.warn("[api-stats] getCallLog failed:", err);
    }
  }

  useEffect(() => {
    void fetchOnce();
    if (autoRefresh) {
      intervalRef.current = setInterval(() => void fetchOnce(), 2000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [autoRefresh]);

  const totals = useMemo(() => {
    const total = calls.length;
    const failures = calls.filter((c) => !c.success).length;
    const avgMs =
      total === 0 ? 0 : calls.reduce((s, c) => s + c.duration_ms, 0) / total;
    return { total, failures, avgMs };
  }, [calls]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center justify-between border-b bg-card/40 px-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">API stats</h2>
          <span className="text-xs text-muted-foreground">
            {totals.total} calls · {totals.failures} failures · avg{" "}
            {totals.avgMs.toFixed(0)}ms
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Label
            htmlFor="auto"
            className="cursor-pointer text-xs font-normal text-muted-foreground"
          >
            <Switch
              id="auto"
              checked={autoRefresh}
              onCheckedChange={setAutoRefresh}
            />
            Auto-refresh (2s)
          </Label>
          <Button size="sm" variant="ghost" onClick={() => void fetchOnce()}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        {calls.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="my-12 flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
              <p>No `gh` calls yet.</p>
              <p className="text-xs">
                Switch to another tab and trigger a refresh — calls show up
                here in real time.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b text-left text-xs tracking-wide text-muted-foreground uppercase">
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="w-full px-3 py-2 font-medium">Command</th>
                  <th className="px-3 py-2 text-right font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {[...calls].reverse().map((call, i) => (
                  <tr
                    key={`${call.timestamp}-${i}`}
                    className="border-b last:border-b-0"
                  >
                    <td className="px-3 py-1.5">
                      {call.success ? (
                        <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <XCircle className="size-3.5 text-destructive" />
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-xs whitespace-nowrap text-muted-foreground">
                      {new Date(call.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs">
                      <span
                        className={cn(!call.success && "text-destructive")}
                      >
                        {call.command}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      <Badge
                        variant={
                          call.duration_ms > 5000
                            ? "destructive"
                            : call.duration_ms > 1500
                              ? "outline"
                              : "secondary"
                        }
                      >
                        {call.duration_ms.toFixed(0)}ms
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </div>
  );
}
