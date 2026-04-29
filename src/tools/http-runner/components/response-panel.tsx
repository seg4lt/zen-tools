import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useHttpRunner } from "../store/http-runner-store";
import { HeadersTable } from "./headers-table";
import { DependencyChain } from "./dependency-chain";
import { ResponseBody } from "./response-body";
import { RunHistoryPanel } from "./run-history-panel";
import { resolveUrl } from "../lib/resolve-url";
import type { HttpRequest } from "../lib/tauri";

type Tab = "sent" | "body" | "headers" | "history" | "chain";

export interface ResponsePanelProps {
  envVars?: Record<string, string>;
  extractedVars?: Record<string, string>;
}

/**
 * Bottom-of-the-editor panel showing the latest response for the active
 * request. Tabs: Body / Headers / Dependency Chain. The active tab
 * auto-switches to Dependency Chain when a multi-step chain starts and
 * back to Body once it completes, so "Run with deps" is visibly
 * different from a plain run.
 */
export function ResponsePanel({ envVars, extractedVars }: ResponsePanelProps) {
  const { state, dispatch } = useHttpRunner();
  const id = state.selectedRequestId;
  const result = id ? state.results[id] : undefined;
  const status = result?.status;
  const chainSteps = state.chainSteps;

  // Look up the request behind the active id. For chain steps from the
  // open file this resolves directly; cross-file chain steps (e.g.
  // `Login` from `auth.http` while `users.http` is open) still get their
  // Body / Response Headers via `state.results[id]`, but the Sent tab's
  // detailed preview needs the parsed request — which only the open
  // file currently provides.
  const selectedRequest: HttpRequest | undefined =
    state.selectedFile?.requests.find(
      (r) => `${state.selectedFile?.path}:${r.name ?? r.id}` === id,
    );
  const previewUrl = selectedRequest
    ? resolveUrl(
        selectedRequest.url,
        envVars,
        extractedVars,
        state.selectedFile?.localVariables,
      )
    : null;

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

  // The leaf is the last step of the planned chain — i.e. the request
  // the user originally triggered "Run with deps" on. When the viewer
  // has navigated *away* from it (by clicking another card in the
  // chain tab) we offer a one-click way back.
  const leafStep =
    chainSteps.length > 0 ? chainSteps[chainSteps.length - 1] : null;
  const viewingNonLeaf =
    leafStep != null && id != null && id !== leafStep.id;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {viewingNonLeaf && leafStep && (
        <button
          type="button"
          onClick={() => {
            dispatch({ type: "selectRequest", id: leafStep.id });
            userPickedRef.current = true;
            setTab("body");
          }}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1.5 border-b bg-primary/10 px-3 text-left text-xs",
            "text-primary hover:bg-primary/15",
          )}
          title={`Back to ${leafStep.name}`}
        >
          <ArrowLeft className="size-3" />
          <span className="font-medium">Back to</span>
          <span className="font-mono">{leafStep.name}</span>
        </button>
      )}
      <StatusBar
        previewMethod={selectedRequest?.method ?? null}
        previewUrl={previewUrl}
      />
      <Tabs
        value={tab}
        onValueChange={onTabChange}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="h-8 shrink-0 rounded-none border-b bg-transparent px-2">
          <TabsTrigger value="sent" className="h-7 text-xs">
            Sent
          </TabsTrigger>
          <TabsTrigger value="body" className="h-7 text-xs">
            Body
          </TabsTrigger>
          <TabsTrigger value="headers" className="h-7 text-xs">
            Response Headers
          </TabsTrigger>
          <TabsTrigger value="history" className="h-7 text-xs">
            History
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
        <TabsContent value="sent" className="min-h-0 flex-1 overflow-y-auto">
          {selectedRequest ? (
            <SentPreview
              method={selectedRequest.method}
              url={previewUrl ?? selectedRequest.url}
              headers={selectedRequest.headers}
              body={selectedRequest.body}
              envVars={envVars}
              extractedVars={extractedVars}
              localVars={state.selectedFile?.localVariables}
            />
          ) : id ? (
            <EmptyHint>
              This step is in a different file — open it from the tree to
              inspect the sent payload.
            </EmptyHint>
          ) : (
            <EmptyHint>Select a request.</EmptyHint>
          )}
        </TabsContent>
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
        <TabsContent
          value="history"
          className="min-h-0 flex-1 overflow-hidden"
        >
          <RunHistoryPanel requestId={id} />
        </TabsContent>
        <TabsContent value="chain" className="min-h-0 flex-1 overflow-y-auto">
          <DependencyChain
            steps={chainSteps}
            results={state.results}
            selectedId={id}
            onSelect={(stepId) => {
              // Switching the active request flips Body / Sent / Response
              // Headers to that step's data via the existing selection-
              // driven plumbing.
              dispatch({ type: "selectRequest", id: stepId });
              userPickedRef.current = true;
              setTab("body");
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatusBar({
  previewMethod,
  previewUrl,
}: {
  previewMethod: string | null;
  previewUrl: string | null;
}) {
  const { state } = useHttpRunner();
  const id = state.selectedRequestId;
  const result = id ? state.results[id] : undefined;
  const status = result?.status;

  if (!status || status.type === "idle") {
    if (previewUrl) {
      const stillUnresolved = previewUrl.includes("{{");
      return (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b bg-card/40 px-3 text-xs">
          <span className="text-muted-foreground">Will hit:</span>
          <span
            className={cn(
              "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-bold",
              "bg-muted",
            )}
          >
            {previewMethod}
          </span>
          <span
            className={cn(
              "truncate font-mono text-[11px]",
              stillUnresolved ? "text-amber-500" : "text-foreground",
            )}
            title={previewUrl}
          >
            {previewUrl}
          </span>
        </div>
      );
    }
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

function pickContentType(
  headers: ReadonlyArray<readonly [string, string]>,
): string | undefined {
  const found = headers.find(([k]) => k.toLowerCase() === "content-type");
  return found?.[1];
}

/**
 * "Sent" preview — shows the user exactly what will go on the wire,
 * with all `{{vars}}` resolved. The Headers panel only displays the
 * server's *response* headers, so without this view there was no way
 * to verify that, e.g., `Authorization: Bearer {{token}}` had its
 * token substituted before sending.
 */
function SentPreview({
  method,
  url,
  headers,
  body,
  envVars,
  extractedVars,
  localVars,
}: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  envVars: Record<string, string> | undefined;
  extractedVars: Record<string, string> | undefined;
  localVars: Record<string, string> | undefined;
}) {
  const headerEntries = Object.entries(headers).map<[string, string]>(
    ([k, v]) => [k, resolveUrl(v, envVars, extractedVars, localVars)],
  );
  const resolvedBody = body
    ? resolveUrl(body, envVars, extractedVars, localVars)
    : null;
  return (
    <div className="flex h-full flex-col font-mono text-[11px]">
      <div className="border-b bg-card/40 px-3 py-1.5">
        <span className="font-bold">{method}</span>{" "}
        <span
          className={cn(
            url.includes("{{") ? "text-amber-500" : "text-foreground",
          )}
        >
          {url}
        </span>
      </div>
      {headerEntries.length > 0 ? (
        <ul className="divide-y">
          {headerEntries.map(([k, v], idx) => {
            const unresolved = v.includes("{{");
            return (
              <li
                key={`${k}-${idx}`}
                className={cn(
                  "grid grid-cols-[max-content_1fr] gap-3 px-3 py-1.5",
                  idx % 2 === 1 && "bg-muted/30",
                )}
              >
                <span className="font-semibold text-muted-foreground">
                  {k}
                </span>
                <span
                  className={cn(
                    "break-all",
                    unresolved && "text-amber-500",
                  )}
                  title={unresolved ? "Unresolved variable" : undefined}
                >
                  {v}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="p-3 text-muted-foreground">No request headers.</div>
      )}
      {resolvedBody && (
        <div className="border-t">
          <div className="bg-muted/30 px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Body
          </div>
          <pre className="whitespace-pre-wrap break-all px-3 py-2">
            {resolvedBody}
          </pre>
        </div>
      )}
    </div>
  );
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
