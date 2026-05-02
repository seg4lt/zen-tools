/**
 * Performance visualizer for `db_explain_query` results.
 *
 * Renders a sub-tab strip — Raw / Plan / Flame — over a unified
 * `PlanRoot` parsed from either Postgres EXPLAIN-JSON or MSSQL
 * ShowPlanXML. The Plan tab also surfaces a slow-node summary, a
 * buffer-cache panel (Postgres only), and an estimate-vs-actual
 * skew badge on every node where the planner was off by ≥10×.
 *
 * Plan history (the last `EXPLAIN_HISTORY_MAX` plans per
 * connection) drives the **Compare with…** dropdown — pick a prior
 * plan and the visualizer renders both flames side-by-side with
 * synced hover.
 */

import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Database as DatabaseIcon,
  Flame,
  HardDrive,
  ListTree,
  Network,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  aggregateBuffers,
  cardinalitySkew,
  colorVarForNodeType,
  flattenPlan,
  parseExplain,
  topNodesBySelfTime,
  type BufferStats,
  type PlanNode,
  type PlanRoot,
} from "../lib/explain-plan";
import { useDbExplorerStore } from "../store/db-explorer-store";
import type { DbExplainResult } from "../lib/tauri";
import { ResultsGrid } from "./results-grid";

type SubTab = "raw" | "plan" | "flame";

const SUB_TAB_DEFAULT: SubTab = "plan";

/**
 * `selectedNodeId` flows top-down so Slow-Nodes-summary chips can
 * highlight a node in PlanTree without lifting state into a
 * separate context. Per-tab; resets when the user opens a different
 * Plan tab.
 */
interface ExplainViewsProps {
  connectionId: string;
  explain: DbExplainResult;
}

export function ExplainViews({ connectionId, explain }: ExplainViewsProps) {
  const [subTab, setSubTab] = useState<SubTab>(SUB_TAB_DEFAULT);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [compareIndex, setCompareIndex] = useState<number | null>(null);

  // History is pushed by `captureExplain` in DatabaseExplorerView
  // when the plan first arrives — re-rendering this component
  // (e.g. on tab switch) does NOT re-push. Earlier we double-pushed
  // here too; that filled the history with duplicates of the same
  // plan, which made the Compare dropdown useless.
  const { state } = useDbExplorerStore();
  const history = state.explainHistoryByConnection[connectionId] ?? [];
  // History[0] is the current explain (we just pushed). Compare
  // candidates are everything after.
  const compareCandidates = history.slice(1);
  const compareWith =
    compareIndex !== null ? compareCandidates[compareIndex] ?? null : null;

  let plan: PlanRoot | null = null;
  let parseError: string | null = null;
  try {
    plan = parseExplain(explain.format, explain.raw, explain.statement);
  } catch (e) {
    parseError = (e as Error).message;
  }

  const comparePlan = useMemo<PlanRoot | null>(() => {
    if (!compareWith) return null;
    try {
      return parseExplain(
        compareWith.format,
        compareWith.raw,
        compareWith.statement,
      );
    } catch {
      return null;
    }
  }, [compareWith]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <SubTabStrip
        subTab={subTab}
        onChange={setSubTab}
        plan={plan}
        compareCandidates={compareCandidates}
        compareIndex={compareIndex}
        onCompareIndexChange={setCompareIndex}
        explain={explain}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {parseError ? (
          <ParseErrorCard message={parseError} raw={explain.raw} />
        ) : !plan ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            Loading plan…
          </div>
        ) : subTab === "raw" ? (
          <RawView raw={plan.raw} />
        ) : subTab === "plan" ? (
          <PlanView
            plan={plan}
            comparePlan={comparePlan}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
          />
        ) : (
          <FlameView
            plan={plan}
            comparePlan={comparePlan}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
          />
        )}
        {explain.data ? <DataPanel data={explain.data} /> : null}
      </div>
    </div>
  );
}

// ─── Sub-tab strip ──────────────────────────────────────────────────

function SubTabStrip({
  subTab,
  onChange,
  plan,
  compareCandidates,
  compareIndex,
  onCompareIndexChange,
  explain,
}: {
  subTab: SubTab;
  onChange: (s: SubTab) => void;
  plan: PlanRoot | null;
  compareCandidates: DbExplainResult[];
  compareIndex: number | null;
  onCompareIndexChange: (i: number | null) => void;
  explain: DbExplainResult;
}) {
  const tabs: Array<{ id: SubTab; label: string; icon: React.ReactNode }> = [
    { id: "raw", label: "Raw", icon: <ListTree className="size-3" /> },
    { id: "plan", label: "Plan", icon: <Network className="size-3" /> },
    { id: "flame", label: "Flame", icon: <Flame className="size-3" /> },
  ];
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/20 px-2 py-1 text-[11px]">
      <div className="flex items-center gap-0.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-0.5 transition",
              subTab === t.id
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:bg-muted/50",
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Header summary — visible across all sub-tabs so the user
          always knows what they're looking at. The "estimates only"
          chip is the visible signal that no execution happened
          (plan-only `EXPLAIN` / `SHOWPLAN_XML`); when ANALYZE ran,
          per-node actuals/timing/buffers are populated and the
          chip is hidden. We use absence-of-totalTime as the proxy
          for "this is an estimate-only plan" — both Postgres
          (`Execution Time` only fires under ANALYZE) and MSSQL
          (no per-node timing in any flavour, so a populated top-
          node `Actual Total Time` is the giveaway) work under that
          rule. */}
      <div className="flex flex-1 items-center gap-3 text-muted-foreground">
        <span className="rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono uppercase">
          {explain.format}
        </span>
        {plan?.totalTimeMs !== undefined ? (
          <span className="flex items-center gap-1">
            <Clock className="size-3" />
            {plan.totalTimeMs.toFixed(2)} ms
          </span>
        ) : (
          <span
            className="rounded border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
            title="No execution timing in this plan — the query was not actually run. Toggle 'actuals' in the toolbar to capture EXPLAIN ANALYZE / STATISTICS XML."
          >
            estimates only
          </span>
        )}
        {plan?.planningTimeMs !== undefined && plan.executionTimeMs !== undefined ? (
          <span className="text-[10px]">
            plan {plan.planningTimeMs.toFixed(1)} · exec {plan.executionTimeMs.toFixed(1)}
          </span>
        ) : null}
      </div>

      {compareCandidates.length > 0 ? (
        <select
          value={compareIndex ?? ""}
          onChange={(e) =>
            onCompareIndexChange(
              e.target.value === "" ? null : Number(e.target.value),
            )
          }
          className="rounded border border-border/60 bg-background px-1.5 py-0.5 text-[11px]"
          title="Compare with a previous plan"
        >
          <option value="">Compare with…</option>
          {compareCandidates.map((p, idx) => (
            <option key={idx} value={idx}>
              {`#${idx + 1} · ${p.durationMs} ms`}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

// ─── Raw view ───────────────────────────────────────────────────────

function RawView({ raw }: { raw: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Soft-fail; the <pre> is selectable.
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end border-b border-border/40 bg-muted/10 px-3 py-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCopy}
          className="h-6 gap-1 px-2 text-[11px]"
        >
          <Copy className="size-3" />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre px-4 py-3 font-mono text-[11px] leading-5">
        {raw}
      </pre>
    </div>
  );
}

// ─── Plan view (tree + summary panels) ──────────────────────────────

function PlanView({
  plan,
  comparePlan,
  selectedNodeId,
  onSelectNode,
}: {
  plan: PlanRoot;
  comparePlan: PlanRoot | null;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}) {
  const slowNodes = useMemo(() => topNodesBySelfTime(plan.topNode, 5), [plan]);
  const buffers = useMemo(
    () => aggregateBuffers(plan.topNode),
    [plan],
  );
  const compareSelfTimes = useMemo(() => {
    if (!comparePlan) return null;
    const map = new Map<string, number>();
    for (const n of flattenPlan(comparePlan.topNode)) {
      // Compare keys by `nodeType + relation` because synthetic ids
      // differ across parses. Same heuristic for the flame compare.
      const key = `${n.nodeType}|${n.relation ?? ""}`;
      map.set(key, (map.get(key) ?? 0) + (n.selfTimeMs ?? 0));
    }
    return map;
  }, [comparePlan]);

  return (
    <div className="flex flex-col gap-3 p-3">
      <SlowNodesPanel nodes={slowNodes} onClick={onSelectNode} />
      {buffers ? <BuffersPanel buffers={buffers} /> : null}
      <PlanTree
        node={plan.topNode}
        depth={0}
        selectedNodeId={selectedNodeId}
        onSelectNode={onSelectNode}
        compareSelfTimes={compareSelfTimes}
      />
    </div>
  );
}

function SlowNodesPanel({
  nodes,
  onClick,
}: {
  nodes: PlanNode[];
  onClick: (id: string) => void;
}) {
  if (nodes.length === 0) return null;
  return (
    <div className="rounded border border-border/60 bg-muted/20 p-2">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium">
        <Clock className="size-3" />
        Top {nodes.length} by self-time
      </div>
      <div className="flex flex-wrap gap-1.5">
        {nodes.map((n) => {
          const value =
            n.selfTimeMs !== undefined
              ? `${n.selfTimeMs.toFixed(2)} ms`
              : `cost ${n.totalCost?.toFixed(2) ?? "?"}`;
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => onClick(n.id)}
              className="flex items-center gap-1 rounded border border-border/60 bg-background px-1.5 py-0.5 text-[11px] transition hover:border-primary"
              title={`${n.nodeType}${n.relation ? ` on ${n.relation}` : ""}`}
            >
              <span
                className="inline-block size-2 shrink-0 rounded-sm"
                style={{ background: colorVarForNodeType(n.nodeType) }}
              />
              <span className="truncate font-mono">
                {n.nodeType}
                {n.relation ? ` · ${n.relation}` : ""}
              </span>
              <span className="tabular-nums text-muted-foreground">{value}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BuffersPanel({ buffers }: { buffers: BufferStats }) {
  const ratio = buffers.hitRatio;
  const ratioPct = (ratio * 100).toFixed(1);
  const ratioCls =
    ratio >= 0.8
      ? "bg-emerald-500/80"
      : ratio >= 0.5
        ? "bg-amber-500/80"
        : "bg-destructive/80";
  return (
    <div className="rounded border border-border/60 bg-muted/20 p-2">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium">
        <HardDrive className="size-3" />
        Buffer cache
      </div>
      <div className="flex items-center gap-3 text-[11px]">
        <div className="flex flex-col items-start">
          <div className="text-muted-foreground">Hit ratio</div>
          <div className="mt-0.5 flex items-center gap-1">
            <span className="font-mono tabular-nums text-foreground">
              {ratioPct}%
            </span>
            <span
              className={`inline-block h-2 w-16 rounded-full bg-muted ${
                ratio === 0 ? "" : ""
              }`}
            >
              <span
                className={`inline-block h-2 rounded-full transition-[width] ${ratioCls}`}
                style={{ width: `${Math.min(100, ratio * 100)}%` }}
              />
            </span>
          </div>
        </div>
        <BufferTile label="hit" value={buffers.sharedHit} />
        <BufferTile label="read" value={buffers.sharedRead} />
        <BufferTile label="dirtied" value={buffers.sharedDirtied} />
        <BufferTile label="written" value={buffers.sharedWritten} />
      </div>
    </div>
  );
}

function BufferTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-start">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function PlanTree({
  node,
  depth,
  selectedNodeId,
  onSelectNode,
  compareSelfTimes,
}: {
  node: PlanNode;
  depth: number;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  compareSelfTimes: Map<string, number> | null;
}) {
  const [expanded, setExpanded] = useState(true);
  const skew = cardinalitySkew(node);
  const isSelected = node.id === selectedNodeId;

  // Δ vs compared plan, when present.
  const compareKey = `${node.nodeType}|${node.relation ?? ""}`;
  const comparedSelf = compareSelfTimes?.get(compareKey);
  const delta =
    comparedSelf !== undefined && node.selfTimeMs !== undefined
      ? node.selfTimeMs - comparedSelf
      : undefined;

  return (
    <div>
      <div
        className={cn(
          "flex items-start gap-1 rounded px-1.5 py-0.5 text-[12px] transition",
          isSelected ? "bg-primary/10 ring-1 ring-primary/30" : "hover:bg-muted/30",
        )}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        <button
          type="button"
          onClick={() => {
            if (node.children.length > 0) setExpanded(!expanded);
            onSelectNode(isSelected ? null : node.id);
          }}
          className="flex flex-1 items-start gap-1 text-left"
        >
          <span className="mt-0.5 w-3">
            {node.children.length > 0 ? (
              expanded ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )
            ) : null}
          </span>
          <span
            className="mt-1 inline-block size-2 shrink-0 rounded-sm"
            style={{ background: colorVarForNodeType(node.nodeType) }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-foreground">{node.nodeType}</span>
              {node.relation ? (
                <span className="font-mono text-muted-foreground">
                  · {node.relation}
                  {node.alias && node.alias !== node.relation
                    ? ` ${node.alias}`
                    : ""}
                </span>
              ) : null}
              {skew !== undefined && skew >= 10 ? (
                <span className="rounded border border-destructive/60 bg-destructive/10 px-1 text-[10px] font-medium text-destructive">
                  ≥10× est skew
                </span>
              ) : null}
              {node.buffers && node.buffers.sharedRead > node.buffers.sharedHit ? (
                <span className="rounded border border-amber-500/60 bg-amber-500/10 px-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                  uncached I/O
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-3 font-mono text-[10px] tabular-nums text-muted-foreground">
              <span>
                est: {fmtCount(node.estimatedRows)}
                {node.actualRows !== undefined ? (
                  <>
                    {" · actual: "}
                    <span className="text-foreground">
                      {fmtCount(node.actualRows)}
                    </span>
                  </>
                ) : null}
              </span>
              {node.totalTimeMs !== undefined ? (
                <span>total: {node.totalTimeMs.toFixed(2)} ms</span>
              ) : node.totalCost !== undefined ? (
                <span>cost: {node.totalCost.toFixed(2)}</span>
              ) : null}
              {node.selfTimeMs !== undefined ? (
                <span>self: {node.selfTimeMs.toFixed(2)} ms</span>
              ) : null}
              {node.loops !== undefined && node.loops > 1 ? (
                <span>loops: {node.loops}</span>
              ) : null}
              {delta !== undefined ? (
                <span
                  className={cn(
                    "rounded px-1",
                    delta < 0
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : delta > 0
                        ? "bg-destructive/15 text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  Δ {delta >= 0 ? "+" : ""}
                  {delta.toFixed(2)} ms
                </span>
              ) : null}
            </div>
          </div>
        </button>
      </div>
      {expanded && node.children.length > 0 ? (
        <div>
          {node.children.map((child) => (
            <PlanTree
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedNodeId={selectedNodeId}
              onSelectNode={onSelectNode}
              compareSelfTimes={compareSelfTimes}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ─── Flame view (SVG icicle) ────────────────────────────────────────

const FLAME_ROW_PX = 22;

function FlameView({
  plan,
  comparePlan,
  selectedNodeId,
  onSelectNode,
}: {
  plan: PlanRoot;
  comparePlan: PlanRoot | null;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}) {
  // Stack of breadcrumbs for zoom — each entry is a node id we've
  // descended into. Empty stack = whole plan visible.
  const [zoomStack, setZoomStack] = useState<string[]>([]);
  const zoomedNode = useMemo(() => {
    let cur: PlanNode = plan.topNode;
    for (const id of zoomStack) {
      const next = findNode(cur, id);
      if (!next) return cur;
      cur = next;
    }
    return cur;
  }, [plan, zoomStack]);

  const usingTime = zoomedNode.totalTimeMs !== undefined;
  const widthMode: "time" | "cost" = usingTime ? "time" : "cost";

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="rounded border border-border/60 bg-background px-1.5 py-0.5">
          width by {widthMode}
        </span>
        {zoomStack.length > 0 ? (
          <button
            type="button"
            onClick={() => setZoomStack(zoomStack.slice(0, -1))}
            className="rounded border border-border/60 bg-background px-1.5 py-0.5 hover:border-primary"
          >
            ← back
          </button>
        ) : null}
        {zoomStack.length > 0 ? (
          <span className="font-mono text-[10px]">
            zoomed into {zoomedNode.nodeType}
            {zoomedNode.relation ? ` · ${zoomedNode.relation}` : ""}
          </span>
        ) : null}
        {comparePlan ? (
          <span className="text-[10px]">
            (compare highlighted in{" "}
            <span className="text-emerald-600 dark:text-emerald-400">faster</span>{" "}
            /{" "}
            <span className="text-destructive">slower</span>)
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded border border-border/60 bg-muted/10">
        <FlameSvg
          root={zoomedNode}
          comparePlan={comparePlan}
          widthMode={widthMode}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          onZoomIn={(id) => setZoomStack([...zoomStack, id])}
          statement={plan.statement}
        />
      </div>
    </div>
  );
}

function findNode(root: PlanNode, id: string): PlanNode | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

interface FlameRect {
  node: PlanNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

function FlameSvg({
  root,
  comparePlan,
  widthMode,
  selectedNodeId,
  onSelectNode,
  onZoomIn,
  statement,
}: {
  root: PlanNode;
  comparePlan: PlanRoot | null;
  widthMode: "time" | "cost";
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onZoomIn: (id: string) => void;
  statement: string;
}) {
  // Width-allocate by `metricFor(node)` proportionally among
  // siblings. For "time" mode that's `Actual Total Time`; in
  // "cost" mode (MSSQL — no per-node timing) we use the subtree
  // cost. Children of nodes with zero metric collapse to 0-width
  // rectangles so they don't shift the rest of the layout.
  const metricFor = (n: PlanNode) =>
    widthMode === "time" ? n.totalTimeMs ?? 0 : n.totalCost ?? 0;

  const rootMetric = metricFor(root);

  const compareMap = useMemo(() => {
    if (!comparePlan) return null;
    const map = new Map<string, number>();
    for (const n of flattenPlan(comparePlan.topNode)) {
      const key = `${n.nodeType}|${n.relation ?? ""}`;
      map.set(key, (map.get(key) ?? 0) + (n.selfTimeMs ?? 0));
    }
    return map;
  }, [comparePlan]);

  const rects: FlameRect[] = [];
  const layout = (node: PlanNode, x: number, y: number, w: number) => {
    rects.push({ node, x, y, w, h: FLAME_ROW_PX });
    if (node.children.length === 0) return;
    const childTotal = node.children.reduce(
      (sum, c) => sum + metricFor(c),
      0,
    );
    if (childTotal === 0) return;
    let cursor = x;
    for (const c of node.children) {
      const cw = (metricFor(c) / childTotal) * w;
      layout(c, cursor, y + FLAME_ROW_PX, cw);
      cursor += cw;
    }
  };
  layout(root, 0, 0, 1000);

  // Compute SVG height from deepest rect.
  const totalRows = rects.reduce(
    (max, r) => Math.max(max, r.y / FLAME_ROW_PX + 1),
    1,
  );
  const svgHeight = totalRows * FLAME_ROW_PX;

  // Hover state — pinned to viewport with `position: fixed` so a
  // tall, scrollable flame doesn't hide the tooltip behind its own
  // overflow. We track cursor coords (clientX/Y) and offset the
  // tooltip by a few pixels.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<{
    rect: FlameRect;
    clientX: number;
    clientY: number;
    comparedSelf: number | undefined;
  } | null>(null);

  return (
    <div ref={wrapperRef} className="relative" onMouseLeave={() => setHovered(null)}>
      <svg
        viewBox={`0 0 1000 ${svgHeight}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ minHeight: svgHeight, height: svgHeight }}
      >
        {rects.map((r) => {
          const isSelected = r.node.id === selectedNodeId;
          const compareKey = `${r.node.nodeType}|${r.node.relation ?? ""}`;
          const comparedSelf = compareMap?.get(compareKey);
          const delta =
            comparedSelf !== undefined && r.node.selfTimeMs !== undefined
              ? r.node.selfTimeMs - comparedSelf
              : undefined;
          const stroke =
            delta === undefined
              ? "var(--border)"
              : delta < 0
                ? "rgb(16 185 129)" // emerald-500
                : delta > 0
                  ? "var(--destructive)"
                  : "var(--border)";
          const label = `${r.node.nodeType}${r.node.relation ? ` · ${r.node.relation}` : ""}`;
          const isHovered = hovered?.rect.node.id === r.node.id;
          return (
            <g
              key={r.node.id}
              onMouseEnter={(e) =>
                setHovered({
                  rect: r,
                  clientX: e.clientX,
                  clientY: e.clientY,
                  comparedSelf,
                })
              }
              onMouseMove={(e) =>
                setHovered((h) =>
                  h && h.rect.node.id === r.node.id
                    ? { ...h, clientX: e.clientX, clientY: e.clientY }
                    : { rect: r, clientX: e.clientX, clientY: e.clientY, comparedSelf },
                )
              }
              onClick={(e) => {
                e.stopPropagation();
                onSelectNode(r.node.id);
                if (e.detail === 2 && r.node.children.length > 0) {
                  onZoomIn(r.node.id);
                }
              }}
              style={{ cursor: r.node.children.length > 0 ? "pointer" : "default" }}
            >
              <rect
                x={r.x}
                y={r.y}
                width={Math.max(0.5, r.w - 1)}
                height={r.h - 1}
                rx={2}
                ry={2}
                fill={colorVarForNodeType(r.node.nodeType)}
                stroke={stroke}
                strokeWidth={isSelected || isHovered ? 2 : 1}
                opacity={isHovered ? 1 : isSelected ? 1 : 0.85}
              />
              {r.w > 40 ? (
                <text
                  x={r.x + 4}
                  y={r.y + 14}
                  fontSize="10"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  fill="var(--foreground)"
                  style={{ pointerEvents: "none" }}
                >
                  {truncate(label, Math.floor(r.w / 6))}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {hovered ? (
        <FlameTooltip
          node={hovered.rect.node}
          clientX={hovered.clientX}
          clientY={hovered.clientY}
          rootMetric={rootMetric}
          widthMode={widthMode}
          comparedSelf={hovered.comparedSelf}
          statement={statement}
        />
      ) : null}
    </div>
  );
}

// ─── Flame tooltip ──────────────────────────────────────────────────

/**
 * Rich, floating tooltip for flame rectangles. Uses `position: fixed`
 * pinned to the cursor (clientX/Y) so a deep, scrollable flame
 * doesn't bury the tooltip behind its own overflow.
 *
 * We surface the metrics that actually matter when reading a plan:
 *   - timing (total + self) and % of root, OR cost (MSSQL fallback)
 *   - estimated vs actual rows + skew badge when it's ≥10×
 *   - loops (when >1, since `actual_total = per_loop × loops` is
 *     the classic confused-readings trap)
 *   - buffer pages (Postgres) with hit ratio
 *   - the planner's per-node decision details — Filter / Index Cond
 *     / Hash Cond / Sort Key / Group Key / Join Type / Output —
 *     verbatim from the EXPLAIN payload
 *   - Δ-vs-compared when the user has Compare-with-… open
 */
function FlameTooltip({
  node,
  clientX,
  clientY,
  rootMetric,
  widthMode,
  comparedSelf,
  statement,
}: {
  node: PlanNode;
  clientX: number;
  clientY: number;
  rootMetric: number;
  widthMode: "time" | "cost";
  comparedSelf: number | undefined;
  statement: string;
}) {
  // Position with `right`/`bottom` for flipped cases instead of
  // computing `top` against TIP_MAX_H — that earlier approach
  // pushed the tooltip ~360px above the cursor when it flipped,
  // even for short tooltips. Anchoring the bottom-edge of the
  // tooltip to `clientY - 14` keeps it visually adjacent to the
  // cursor regardless of its actual height.
  const TIP_W = 320;
  const TIP_MAX_H = 360;
  const margin = 8;
  const overflowsRight = clientX + 14 + TIP_W > window.innerWidth - margin;
  const overflowsBottom = clientY + 14 + TIP_MAX_H > window.innerHeight - margin;
  const horizontal: React.CSSProperties = overflowsRight
    ? { right: Math.max(margin, window.innerWidth - clientX + 14) }
    : { left: clientX + 14 };
  const vertical: React.CSSProperties = overflowsBottom
    ? { bottom: Math.max(margin, window.innerHeight - clientY + 14) }
    : { top: clientY + 14 };

  const skew = cardinalitySkew(node);
  const metric =
    widthMode === "time" ? node.totalTimeMs ?? 0 : node.totalCost ?? 0;
  const pctOfRoot = rootMetric > 0 ? (metric / rootMetric) * 100 : undefined;
  const delta =
    comparedSelf !== undefined && node.selfTimeMs !== undefined
      ? node.selfTimeMs - comparedSelf
      : undefined;

  const detailEntries = pickDetailEntries(node);

  return (
    <div
      // pointer-events-none so the tooltip never steals hover from
      // the rect underneath it (otherwise moving the cursor onto
      // the tip would trigger mouseleave on the rect, blink the
      // tip out, then re-enter — i.e. a flicker loop).
      className="pointer-events-none fixed z-50 rounded-md border border-border/70 bg-popover/95 px-2.5 py-2 text-[11px] leading-tight text-popover-foreground shadow-lg backdrop-blur"
      style={{
        ...horizontal,
        ...vertical,
        width: TIP_W,
        maxHeight: TIP_MAX_H,
        overflow: "hidden",
      }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block size-2.5 shrink-0 rounded-sm"
          style={{ background: colorVarForNodeType(node.nodeType) }}
        />
        <span className="truncate font-mono font-medium">{node.nodeType}</span>
        {node.relation ? (
          <span className="truncate font-mono text-muted-foreground">
            · {node.relation}
            {node.alias && node.alias !== node.relation ? ` ${node.alias}` : ""}
          </span>
        ) : null}
      </div>

      <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono tabular-nums">
        {node.totalTimeMs !== undefined ? (
          <TipStat label="total" value={`${node.totalTimeMs.toFixed(3)} ms`} />
        ) : null}
        {node.selfTimeMs !== undefined ? (
          <TipStat label="self" value={`${node.selfTimeMs.toFixed(3)} ms`} />
        ) : null}
        {node.totalTimeMs === undefined && node.totalCost !== undefined ? (
          <TipStat label="cost" value={node.totalCost.toFixed(2)} />
        ) : null}
        {pctOfRoot !== undefined ? (
          <TipStat
            label={widthMode === "time" ? "% of root time" : "% of root cost"}
            value={`${pctOfRoot.toFixed(1)}%`}
          />
        ) : null}
        {node.loops !== undefined && node.loops > 1 ? (
          <TipStat label="loops" value={fmtCount(node.loops)} />
        ) : null}
        <TipStat label="est rows" value={fmtCount(node.estimatedRows)} />
        {node.actualRows !== undefined ? (
          <TipStat label="actual rows" value={fmtCount(node.actualRows)} />
        ) : null}
      </div>

      {/* Badges row */}
      {(skew !== undefined && skew >= 10) ||
      delta !== undefined ||
      (node.buffers && node.buffers.sharedRead > node.buffers.sharedHit) ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {skew !== undefined && skew >= 10 ? (
            <span className="rounded border border-destructive/60 bg-destructive/10 px-1 text-[10px] font-medium text-destructive">
              {`${skew >= 100 ? Math.round(skew) : skew.toFixed(1)}× est skew`}
            </span>
          ) : null}
          {node.buffers && node.buffers.sharedRead > node.buffers.sharedHit ? (
            <span className="rounded border border-amber-500/60 bg-amber-500/10 px-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              uncached I/O
            </span>
          ) : null}
          {delta !== undefined ? (
            <span
              className={cn(
                "rounded px-1 text-[10px] font-medium",
                delta < 0
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : delta > 0
                    ? "bg-destructive/15 text-destructive"
                    : "text-muted-foreground",
              )}
            >
              Δ self {delta >= 0 ? "+" : ""}
              {delta.toFixed(2)} ms
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Buffers (Postgres only) */}
      {node.buffers ? (
        <div className="mt-1.5 border-t border-border/40 pt-1.5">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            buffers
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono tabular-nums">
            <TipStat label="hit" value={fmtCount(node.buffers.sharedHit)} />
            <TipStat label="read" value={fmtCount(node.buffers.sharedRead)} />
            <TipStat label="dirtied" value={fmtCount(node.buffers.sharedDirtied)} />
            <TipStat label="written" value={fmtCount(node.buffers.sharedWritten)} />
            <TipStat
              label="hit ratio"
              value={`${(node.buffers.hitRatio * 100).toFixed(1)}%`}
            />
          </div>
        </div>
      ) : null}

      {/* Per-node planner detail (Filter / Index Cond / Sort Key / etc.) */}
      {detailEntries.length > 0 ? (
        <div className="mt-1.5 border-t border-border/40 pt-1.5">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            details
          </div>
          <dl className="space-y-0.5 font-mono">
            {detailEntries.map(([k, v]) => (
              <div key={k} className="flex gap-1.5">
                <dt className="shrink-0 text-muted-foreground">{k}:</dt>
                <dd className="min-w-0 flex-1 break-words text-foreground">
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {/* Query context — find lines of the user's SQL that mention
          this node's relation/alias/index and highlight them. Helps
          the user trace a flame rectangle back to the spot in the
          query that produced it. */}
      <QueryContext node={node} statement={statement} />

      <div className="mt-1.5 border-t border-border/40 pt-1 text-[10px] text-muted-foreground">
        click to select · double-click to zoom
      </div>
    </div>
  );
}

function TipStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-foreground">{value}</span>
    </div>
  );
}

/**
 * Pick the planner-decision keys worth showing in the tooltip.
 *
 * Postgres EXPLAIN-JSON exposes ~40 keys per node. Most ("Parent
 * Relationship", "Parallel Aware", "Async Capable", …) are noise
 * for everyday plan reading; only a handful actually answer "why
 * did the planner do this?". We surface that handful here, in the
 * order they're most useful, and skip everything else (the user
 * can hit Raw if they want the full payload).
 */
const DETAIL_KEYS_ORDERED: string[] = [
  // Postgres
  "Join Type",
  "Strategy",
  "Filter",
  "Index Cond",
  "Recheck Cond",
  "Hash Cond",
  "Merge Cond",
  "Sort Key",
  "Group Key",
  "Index Name",
  "Output",
  "Workers Planned",
  "Workers Launched",
  "Heap Fetches",
  // MSSQL
  "logicalOp",
  "EstimatedExecutionMode",
  "EstimateIO",
  "EstimateCPU",
  "Parallel",
];

function pickDetailEntries(node: PlanNode): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const k of DETAIL_KEYS_ORDERED) {
    const v = node.details[k];
    if (v === undefined || v === null || v === "") continue;
    out.push([k, formatDetail(v)]);
    if (out.length >= 8) break;
  }
  return out;
}

function formatDetail(v: unknown): string {
  if (Array.isArray(v)) {
    const joined = v.map((x) => formatDetail(x)).join(", ");
    return truncate(joined, 200);
  }
  if (typeof v === "object" && v !== null) {
    return truncate(JSON.stringify(v), 200);
  }
  return truncate(String(v), 200);
}

// ─── Query-context highlight ────────────────────────────────────────

/**
 * Show the lines of the user's SQL that mention this plan node's
 * relation, alias, or index, with the matching tokens highlighted.
 *
 * EXPLAIN payloads don't carry source-positions so we can't be
 * precise; instead we lean on the fact that the relation name is
 * almost always present verbatim somewhere in the query (the FROM
 * or JOIN clause). Surfacing that line — plus the WHERE line for
 * filter/index-cond nodes — is enough to give the eye a quick
 * "this is what that flame rect maps to".
 */
function QueryContext({
  node,
  statement,
}: {
  node: PlanNode;
  statement: string;
}) {
  const tokens = useMemo(() => collectQueryTokens(node), [node]);
  const lines = useMemo(
    () => statement.split("\n"),
    [statement],
  );
  const matches = useMemo(() => {
    if (tokens.length === 0) return [] as Array<{ idx: number; text: string }>;
    const re = buildTokenRegex(tokens);
    if (!re) return [];
    const out: Array<{ idx: number; text: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push({ idx: i, text: lines[i] });
        if (out.length >= 6) break;
      }
      // Reset lastIndex for the global regex on the next line.
      re.lastIndex = 0;
    }
    return out;
  }, [tokens, lines]);

  if (tokens.length === 0 || matches.length === 0) return null;

  return (
    <div className="mt-1.5 border-t border-border/40 pt-1.5">
      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        query
      </div>
      <pre className="overflow-hidden whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-foreground">
        {matches.map((m, i) => (
          <div key={m.idx} className="flex gap-1.5">
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {String(m.idx + 1).padStart(3, " ")}
            </span>
            <span className="min-w-0 flex-1">
              {renderHighlighted(m.text, tokens)}
            </span>
            {i < matches.length - 1 ? null : null}
          </div>
        ))}
      </pre>
    </div>
  );
}

/**
 * Build the list of tokens we'll search for in the SQL: the node's
 * relation, its alias (when distinct), and any Index Name.
 *
 * We deliberately *don't* include the node type ("Index Scan") —
 * that string never appears in the user's SQL.
 */
function collectQueryTokens(node: PlanNode): string[] {
  const out = new Set<string>();
  if (node.relation) out.add(node.relation);
  if (node.alias && node.alias !== node.relation) out.add(node.alias);
  // Postgres surfaces `Index Name`; MSSQL puts it in `Object > Index`,
  // captured by the relation already.
  const idx = node.details["Index Name"];
  if (typeof idx === "string" && idx) out.add(idx);
  // Some scan nodes carry a CTE / Subquery name we can also match.
  for (const key of ["CTE Name", "Subplan Name", "Function Name"]) {
    const v = node.details[key];
    if (typeof v === "string" && v) out.add(v);
  }
  // Strip schema prefix from relations so `metrics.events` matches
  // either `metrics.events` *or* a bare `events` later in the SQL.
  for (const t of Array.from(out)) {
    const dot = t.lastIndexOf(".");
    if (dot >= 0 && dot < t.length - 1) out.add(t.slice(dot + 1));
  }
  return Array.from(out).filter((t) => t.length > 1);
}

/**
 * Compile the tokens into a single case-insensitive word-boundary
 * regex. Returns `null` when the input is empty or every token is
 * un-escapable (defensive — shouldn't happen with real identifiers).
 */
function buildTokenRegex(tokens: string[]): RegExp | null {
  const escaped = tokens
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter(Boolean);
  if (escaped.length === 0) return null;
  // `\b` doesn't match around dots, but Postgres identifiers can
  // contain underscores and digits — use lookarounds that exclude
  // identifier characters on either side.
  return new RegExp(
    `(?<![A-Za-z0-9_])(?:${escaped.join("|")})(?![A-Za-z0-9_])`,
    "gi",
  );
}

/**
 * Split a line into spans with `<mark>` around every token match.
 * Keeps the line's original whitespace.
 */
function renderHighlighted(line: string, tokens: string[]): React.ReactNode {
  const re = buildTokenRegex(tokens);
  if (!re) return line;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > cursor) parts.push(line.slice(cursor, m.index));
    parts.push(
      <mark
        key={`${m.index}-${m[0]}`}
        className="rounded-sm bg-primary/20 px-0.5 text-foreground"
      >
        {m[0]}
      </mark>,
    );
    cursor = m.index + m[0].length;
    // Guard against zero-width match infinite loops.
    if (m[0].length === 0) re.lastIndex++;
  }
  if (cursor < line.length) parts.push(line.slice(cursor));
  return <>{parts}</>;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}

// ─── Data panel (MSSQL: actual rows shipped alongside the plan) ─────

function DataPanel({ data }: { data: NonNullable<DbExplainResult["data"]> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border/40">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1 px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/30"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <DatabaseIcon className="size-3" />
        Data ({data.rows.length} row{data.rows.length === 1 ? "" : "s"})
      </button>
      {open ? (
        <div className="relative h-64 min-h-0 overflow-hidden">
          <ResultsGrid result={data} />
        </div>
      ) : null}
    </div>
  );
}

// ─── Misc ───────────────────────────────────────────────────────────

function ParseErrorCard({
  message,
  raw,
}: {
  message: string;
  raw: string;
}) {
  return (
    <div className="flex h-full flex-col bg-destructive/5">
      <div className="flex shrink-0 items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px]">
        <AlertTriangle className="size-3 text-destructive" />
        <span className="font-medium text-destructive">Plan parse failed</span>
        <span className="text-muted-foreground">{message}</span>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre px-4 py-3 font-mono text-[11px]">
        {raw}
      </pre>
    </div>
  );
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Math.round(n).toString();
}
