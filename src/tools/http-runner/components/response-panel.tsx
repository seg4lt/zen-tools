import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useHttpRunner } from "../store/http-runner-store";
import { HeadersTable } from "./headers-table";
import { DependencyChain } from "./dependency-chain";
import { ResponseBody } from "./response-body";

type Tab = "body" | "headers" | "chain";

/**
 * Bottom-of-the-editor panel showing the latest response for the active
 * request. Tabs: Body / Headers / Dependency Chain. The active tab
 * auto-switches to Dependency Chain when a multi-step chain starts and
 * back to Body once it completes, so "Run with deps" is visibly
 * different from a plain run.
 */
export function ResponsePanel() {
  const { state } = useHttpRunner();
  const id = state.selectedRequestId;
  const result = id ? state.results[id] : undefined;
  const status = result?.status;
  const chainSteps = state.chainSteps;

  const [tab, setTab] = useState<Tab>("body");
  const userPickedRef = useRef(false);
  const lastChainSize = useRef(0);

  // Selecting a different request resets the user-picked flag and the
  // chain memory, so the auto-switching logic below treats the new
  // request as a clean slate.
  useEffect(() => {
    userPickedRef.current = false;
    lastChainSize.current = 0;
    setTab("body");
  }, [id]);

  // Auto-switch to the chain tab when a chain (>1 step) appears, so the
  // user sees the dependency execution play out instead of staring at
  // the body tab.
  useEffect(() => {
    if (chainSteps.length > 1 && lastChainSize.current === 0) {
      setTab("chain");
    }
    lastChainSize.current = chainSteps.length;
  }, [chainSteps.length]);

  // Once the final step of a chain completes successfully, drop back to
  // the Body tab — that's where the user expects to see the actual
  // response. Only do it if the user hasn't manually changed tabs.
  useEffect(() => {
    if (
      !userPickedRef.current &&
      chainSteps.length > 1 &&
      status?.type === "success"
    ) {
      setTab("body");
    }
  }, [status, chainSteps.length]);

  const onTabChange = (next: string) => {
    userPickedRef.current = true;
    setTab(next as Tab);
  };

  if (!id) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
        Select a request to see its response.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StatusBar />
      <Tabs
        value={tab}
        onValueChange={onTabChange}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="h-8 shrink-0 rounded-none border-b bg-transparent px-2">
          <TabsTrigger value="body" className="h-7 text-xs">
            Body
          </TabsTrigger>
          <TabsTrigger value="headers" className="h-7 text-xs">
            Headers
          </TabsTrigger>
          <TabsTrigger value="chain" className="h-7 text-xs">
            Dependency Chain
            {chainSteps.length > 1 && (
              <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[10px]">
                {chainSteps.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="body" className="min-h-0 flex-1 overflow-hidden">
          {status?.type === "success" ? (
            <ResponseBody
              body={status.response.body}
              contentType={pickContentType(status.response.headers)}
            />
          ) : status?.type === "error" ? (
            <div className="p-4 font-mono text-xs text-destructive">
              {status.message}
            </div>
          ) : status?.type === "running" ? (
            <RunningPlaceholder message={status.message} />
          ) : (
            <EmptyHint>Run the request to see its body.</EmptyHint>
          )}
        </TabsContent>
        <TabsContent
          value="headers"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {status?.type === "success" ? (
            <HeadersTable headers={status.response.headers} />
          ) : (
            <EmptyHint>No headers yet.</EmptyHint>
          )}
        </TabsContent>
        <TabsContent value="chain" className="min-h-0 flex-1 overflow-y-auto">
          <DependencyChain steps={chainSteps} results={state.results} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatusBar() {
  const { state } = useHttpRunner();
  const id = state.selectedRequestId;
  const result = id ? state.results[id] : undefined;
  const status = result?.status;

  if (!status || status.type === "idle") {
    return (
      <div className="flex h-7 shrink-0 items-center gap-2 border-b bg-card/40 px-3 text-xs text-muted-foreground">
        Idle
      </div>
    );
  }
  if (status.type === "running") {
    return (
      <div className="flex h-7 shrink-0 items-center gap-2 border-b bg-card/40 px-3 text-xs">
        <Loader2 className="size-3 animate-spin text-primary" />
        <span>{status.message ?? "Running…"}</span>
      </div>
    );
  }
  if (status.type === "error") {
    return (
      <div className="flex h-7 shrink-0 items-center gap-2 border-b bg-card/40 px-3 text-xs text-destructive">
        Error
      </div>
    );
  }
  const r = status.response;
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-b bg-card/40 px-3 text-xs">
      <span
        className={cn(
          "rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold",
          statusClass(r.statusCode),
        )}
      >
        {r.statusCode} {r.statusText}
      </span>
      <span className="text-muted-foreground">
        {Math.round(r.duration)}ms · {formatBytes(r.sizeBytes)}
      </span>
    </div>
  );
}

function RunningPlaceholder({ message }: { message: string | null }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-3 animate-spin" />
      {message ?? "Running…"}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function pickContentType(headers: Record<string, string>): string | undefined {
  const key = Object.keys(headers).find(
    (k) => k.toLowerCase() === "content-type",
  );
  return key ? headers[key] : undefined;
}

function statusClass(code: number): string {
  if (code < 300) return "bg-emerald-500/15 text-emerald-500";
  if (code < 400) return "bg-sky-500/15 text-sky-500";
  if (code < 500) return "bg-amber-500/15 text-amber-500";
  return "bg-destructive/15 text-destructive";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
