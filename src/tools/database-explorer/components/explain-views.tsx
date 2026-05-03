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
import { Button } from "@zen-tools/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@zen-tools/ui";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import {
  actualOrEstimatedRows,
  aggregateBuffers,
  bufferTotalFor,
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
          always knows what they're looking at.

          Whether the query *executed* and whether per-node *timing*
          was captured are two separate questions:
            - Postgres ANALYZE ⇒ executed + timing.
            - Postgres EXPLAIN  ⇒ neither.
            - MSSQL STATISTICS  ⇒ executed but NO per-node time.
            - MSSQL SHOWPLAN     ⇒ neither.

          So the "estimates only" badge keys off `actualRows` on the
          top node (universal "did it run?" signal), and we surface
          timing separately when it's available. For MSSQL with
          actuals, we fall back to the wall-clock `explain.durationMs`
          since per-node times don't exist in showplan XML. */}
      <div className="flex flex-1 items-center gap-3 text-muted-foreground">
        <span className="rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono uppercase">
          {explain.format}
        </span>
        {plan && plan.topNode.actualRows === undefined ? (
          <span
            className="rounded border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
            title="The query was not actually executed — these are planner estimates only. Toggle 'actuals' in the toolbar to run EXPLAIN ANALYZE (Postgres) / SET STATISTICS XML ON (MSSQL)."
          >
            estimates only
          </span>
        ) : null}
        {plan?.totalTimeMs !== undefined ? (
          <span className="flex items-center gap-1">
            <Clock className="size-3" />
            {plan.totalTimeMs.toFixed(2)} ms
          </span>
        ) : plan && plan.topNode.actualRows !== undefined ? (
          // Executed but no per-node timing (MSSQL STATISTICS XML).
          // Surface the wall-clock duration so the user has *some*
          // timing to work with; tooltip explains the caveat.
          <span
            className="flex items-center gap-1"
            title="Wall-clock for the explain round-trip — MSSQL ShowPlanXML doesn't carry per-node Actual Total Time, so this is what you get."
          >
            <Clock className="size-3" />
            {explain.durationMs} ms
            <span className="text-[10px] opacity-70">(wall-clock)</span>
          </span>
        ) : null}
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
/** Below this percentage of the parent's allocated width, sibling
 * cells fold into a synthetic `+N more` cell. Plans with 12-way
 * GROUP BYs become unreadable strips of slivers without this. */
const REST_THRESHOLD_PCT = 0.02;

/** Width-allocation metric. Drives `metricFor()` + the "width by X"
 * chips in the header. */
type WidthMode = "time" | "cost" | "rows" | "buffers";

/** Whether each cell's width is its full subtree metric (`total`,
 * the standard flame-graph layout) or the node's own contribution
 * minus children (`self` — surfaces the actual bottleneck node
 * instead of letting parents inflate). */
type WidthBasis = "total" | "self";

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

  // Path of nodes from the plan root down through every zoom level
  // — drives the breadcrumb. Each entry is `{ id, label }`.
  const zoomPath = useMemo(() => {
    const out: { id: string | null; label: string }[] = [
      { id: null, label: planRootLabel(plan.topNode) },
    ];
    let cur: PlanNode = plan.topNode;
    for (const id of zoomStack) {
      const next = findNode(cur, id);
      if (!next) break;
      out.push({ id: next.id, label: nodeShortLabel(next) });
      cur = next;
    }
    return out;
  }, [plan, zoomStack]);

  // Default width-metric. Auto-pick the strongest signal the data
  // supports: time when ANALYZE ran, cost otherwise. The user can
  // override via the chip strip.
  const defaultMode: WidthMode =
    zoomedNode.totalTimeMs !== undefined ? "time" : "cost";
  const [widthMode, setWidthMode] = useState<WidthMode>(defaultMode);
  const [widthBasis, setWidthBasis] = useState<WidthBasis>("total");
  const [sortDescending, setSortDescending] = useState(false);
  const [filter, setFilter] = useState("");
  const [expandedRest, setExpandedRest] = useState<Set<string>>(new Set());
  // Node id whose full-detail dialog is open. Triggered by
  // Alt-clicking a flame cell — for users who want every field the
  // tooltip can't fit (full `details` map, raw JSON, longer
  // expressions, query-context with all matches).
  const [detailsNodeId, setDetailsNodeId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const detailsNode = useMemo(
    () =>
      detailsNodeId
        ? findNode(plan.topNode, detailsNodeId) ?? null
        : null,
    [plan.topNode, detailsNodeId],
  );

  const availability = useMemo(
    () => modeAvailability(zoomedNode),
    [zoomedNode],
  );
  // If the user picked a mode and the underlying data isn't
  // available (e.g. switched plans, or zoomed into a subtree without
  // buffers), fall back to the default.
  const effectiveMode: WidthMode = availability[widthMode]
    ? widthMode
    : defaultMode;

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 p-2">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-muted-foreground">
        {/* Breadcrumb — clickable Plan › Limit › Sort › … */}
        <Breadcrumb
          path={zoomPath}
          onPop={(idx) => setZoomStack(zoomStack.slice(0, idx))}
        />

        <ToolbarSep />

        {/* Width-metric chips. Disabled chips have no underlying
            data in the current plan / zoom. */}
        <MetricChips
          mode={effectiveMode}
          basis={widthBasis}
          availability={availability}
          onModeChange={setWidthMode}
          onBasisChange={setWidthBasis}
        />

        <ToolbarSep />

        {/* Sort siblings toggle. Plan order = whatever the planner
            emitted; descending = hottest child leftmost. Compact:
            single arrow when active, dash when off. */}
        <TooltipProvider delayDuration={120}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setSortDescending((s) => !s)}
                className={cn(
                  "rounded px-1 transition",
                  sortDescending
                    ? "bg-primary/15 text-primary"
                    : "hover:bg-muted/40 hover:text-foreground",
                )}
              >
                {sortDescending ? "↓ sort" : "= sort"}
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              className="max-w-xs text-left text-[11px] leading-snug"
            >
              {sortDescending ? (
                <>
                  <div className="font-semibold">
                    Sorting siblings by metric (descending)
                  </div>
                  <p className="mt-1">
                    Within each parent, the hottest child is rendered
                    leftmost. Click to switch back to{" "}
                    <strong>plan order</strong> (the planner's
                    original output).
                  </p>
                  <p className="mt-1 opacity-80">
                    Use this view to find the dominant node fast;
                    plan order to understand execution structure.
                  </p>
                </>
              ) : (
                <>
                  <div className="font-semibold">Plan order (default)</div>
                  <p className="mt-1">
                    Children rendered in the order the planner
                    emitted them. Click to <strong>sort by the
                    current metric</strong> (hottest child leftmost).
                  </p>
                  <p className="mt-1 opacity-80">
                    Plan order preserves outer-input-vs-inner-input
                    semantics for joins; sorted order is faster for
                    spotting the heaviest sibling at a glance.
                  </p>
                </>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Search / filter. Press / to focus from inside the SVG.
            Compact width; placeholder is just "filter…" — the
            tooltip carries the full hint. */}
        <div className="ml-auto flex items-center gap-0.5">
          <input
            ref={searchInputRef}
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            title="Filter cells by node type, relation, alias, or condition. Press / to focus."
            className="h-5 w-32 rounded border border-border/60 bg-background px-1.5 text-[10px] outline-none focus:border-primary/60 focus:w-44 transition-[width]"
          />
          {filter ? (
            <button
              type="button"
              onClick={() => setFilter("")}
              className="text-muted-foreground hover:text-foreground"
              title="Clear filter"
            >
              ✕
            </button>
          ) : null}
        </div>

        {comparePlan ? (
          <span className="basis-full text-[10px]">
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
          widthMode={effectiveMode}
          widthBasis={widthBasis}
          sortDescending={sortDescending}
          filter={filter}
          expandedRest={expandedRest}
          onToggleRest={(parentId) =>
            setExpandedRest((prev) => {
              const next = new Set(prev);
              if (next.has(parentId)) next.delete(parentId);
              else next.add(parentId);
              return next;
            })
          }
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          onZoomIn={(id) => setZoomStack([...zoomStack, id])}
          onZoomOut={() =>
            setZoomStack((s) => (s.length > 0 ? s.slice(0, -1) : s))
          }
          onFocusFilter={() => searchInputRef.current?.focus()}
          onOpenDetails={(id) => setDetailsNodeId(id)}
          statement={plan.statement}
        />
      </div>
      <NodeDetailsDialog
        node={detailsNode}
        plan={plan}
        widthMode={effectiveMode}
        open={detailsNode !== null}
        onOpenChange={(open) => {
          if (!open) setDetailsNodeId(null);
        }}
      />
    </div>
  );
}

/** Header label for the un-zoomed plan in the breadcrumb. */
function planRootLabel(root: PlanNode): string {
  return `Plan · ${root.nodeType}`;
}

/** Compact "NodeType · relation" label used in the breadcrumb. */
function nodeShortLabel(node: PlanNode): string {
  return node.relation ? `${node.nodeType} · ${node.relation}` : node.nodeType;
}

/** Per-mode availability check. The chip for an unavailable mode
 * is rendered disabled with an explanatory tooltip. */
function modeAvailability(root: PlanNode): Record<WidthMode, boolean> {
  let hasTime = false;
  let hasCost = false;
  let hasBuffers = false;
  for (const n of flattenPlan(root)) {
    if (n.totalTimeMs !== undefined) hasTime = true;
    if (n.totalCost !== undefined) hasCost = true;
    if (n.buffers) hasBuffers = true;
  }
  return {
    time: hasTime,
    cost: hasCost,
    rows: true, // estimated rows always present
    buffers: hasBuffers,
  };
}

function ToolbarSep() {
  return <span aria-hidden className="mx-0.5 h-3 w-px bg-border/60" />;
}

/** Clickable breadcrumb. Each crumb is a zoom level; the rightmost
 * is the current view. Truncates at 5 levels with a `…` chip
 * standing in for the omitted middle. */
function Breadcrumb({
  path,
  onPop,
}: {
  path: { id: string | null; label: string }[];
  onPop: (idxAfterPop: number) => void;
}) {
  const visible: { id: string | null; label: string; popTo: number }[] = [];
  if (path.length <= 5) {
    for (let i = 0; i < path.length; i++) {
      visible.push({ ...path[i], popTo: i });
    }
  } else {
    visible.push({ ...path[0], popTo: 0 });
    visible.push({ id: null, label: "…", popTo: -1 });
    for (let i = path.length - 3; i < path.length; i++) {
      visible.push({ ...path[i], popTo: i });
    }
  }
  return (
    <div className="flex items-center gap-0.5">
      {visible.map((c, i) => {
        const isLast = i === visible.length - 1;
        const clickable = c.popTo >= 0 && !isLast;
        return (
          <span key={`${c.popTo}-${c.label}`} className="flex items-center gap-0.5">
            {i > 0 ? (
              <span className="text-muted-foreground/50">›</span>
            ) : null}
            {clickable ? (
              <button
                type="button"
                onClick={() => onPop(c.popTo)}
                className="rounded px-1 font-mono text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                title={`Pop zoom to ${c.label}`}
              >
                {c.label}
              </button>
            ) : (
              <span
                className={cn(
                  "px-1 font-mono text-[11px]",
                  isLast ? "text-foreground" : "text-muted-foreground/60",
                )}
              >
                {c.label}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** The width-metric + basis chip strip. Mode chips are mutually
 * exclusive, basis chip is a binary toggle. Disabled when the data
 * for that mode isn't present in the current zoom. */
function MetricChips({
  mode,
  basis,
  availability,
  onModeChange,
  onBasisChange,
}: {
  mode: WidthMode;
  basis: WidthBasis;
  availability: Record<WidthMode, boolean>;
  onModeChange: (m: WidthMode) => void;
  onBasisChange: (b: WidthBasis) => void;
}) {
  // Long-form tooltip copy. Each option gets a one-line headline +
  // a couple of bullets explaining what the value means, where it
  // comes from, and when to pick it. Shown via Radix Tooltip for
  // an instant hover popup (browser-native `title=""` had a 500 ms
  // delay that made the chips feel un-discoverable).
  const modes: {
    id: WidthMode;
    label: string;
    title: string;
    body: React.ReactNode;
  }[] = [
    {
      id: "time",
      label: "time",
      title: "Width by execution time",
      body: (
        <>
          <p>Each flame cell is sized by per-node wall-clock.</p>
          <p className="mt-1 opacity-80">
            Source: Postgres <code>Actual Total Time</code> (EXPLAIN
            ANALYZE) / MSSQL <code>ActualElapsedms</code>. Pick this
            to find <strong>where the time actually went</strong> —
            the default and usually the right answer.
          </p>
        </>
      ),
    },
    {
      id: "cost",
      label: "cost",
      title: "Width by planner cost",
      body: (
        <>
          <p>Each cell is sized by the optimizer's estimated cost.</p>
          <p className="mt-1 opacity-80">
            Source: Postgres <code>Total Cost</code> (arbitrary cost
            units; not ms) / MSSQL <code>EstimatedTotalSubtreeCost</code>.
            Pick this to see what the planner <em>thought</em> would
            be expensive — useful when comparing to <code>time</code>{" "}
            shows the planner mis-estimated.
          </p>
        </>
      ),
    },
    {
      id: "rows",
      label: "rows",
      title: "Width by row count",
      body: (
        <>
          <p>Each cell is sized by the rows flowing through that node.</p>
          <p className="mt-1 opacity-80">
            Uses actual row counts when present (ANALYZE), otherwise
            falls back to the planner's estimate. Pick this to see
            <strong> data volume</strong> per stage — wide rows on
            tiny inputs hint at row explosions or missing predicates.
          </p>
        </>
      ),
    },
    {
      id: "buffers",
      label: "buffers",
      title: "Width by I/O (Postgres only)",
      body: (
        <>
          <p>Each cell is sized by 8 KB pages touched.</p>
          <p className="mt-1 opacity-80">
            Source: Postgres <code>Shared Hit Blocks + Shared Read
            Blocks</code> (EXPLAIN BUFFERS). Pick this to find
            <strong> I/O-heavy nodes</strong> — wide cells = lots of
            pages, narrow but slow = CPU-bound. Disabled when the
            plan doesn't carry buffer counters.
          </p>
        </>
      ),
    },
  ];
  return (
    <TooltipProvider delayDuration={120}>
      <div className="flex items-center gap-0.5">
        {modes.map((m) => {
          const isOn = mode === m.id;
          const enabled = availability[m.id];
          return (
            <Tooltip key={m.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={!enabled}
                  onClick={() => onModeChange(m.id)}
                  className={cn(
                    "rounded px-1 transition",
                    !enabled
                      ? "cursor-not-allowed opacity-40"
                      : isOn
                        ? "bg-primary/15 text-primary"
                        : "hover:bg-muted/40 hover:text-foreground",
                  )}
                >
                  {m.label}
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                className="max-w-xs text-left text-[11px] leading-snug"
              >
                <div className="font-semibold">{m.title}</div>
                <div className="mt-1">{m.body}</div>
                {!enabled && (
                  <div className="mt-2 text-amber-300">
                    Not available — this plan doesn't carry the
                    needed counters.
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
        <span aria-hidden className="mx-0.5 h-3 w-px bg-border/60" />
        {(["total", "self"] as const).map((b) => (
          <Tooltip key={b}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onBasisChange(b)}
                className={cn(
                  "rounded px-1 transition",
                  basis === b
                    ? "bg-primary/15 text-primary"
                    : "hover:bg-muted/40 hover:text-foreground",
                )}
              >
                {b}
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              className="max-w-xs text-left text-[11px] leading-snug"
            >
              {b === "total" ? (
                <>
                  <div className="font-semibold">Total (subtree)</div>
                  <p className="mt-1">
                    Each cell sized by the full <em>subtree</em>{" "}
                    metric — node + all descendants. Standard flame
                    layout: parent always wider than children.
                  </p>
                  <p className="mt-1 opacity-80">
                    Best for understanding query shape and where time
                    aggregates.
                  </p>
                </>
              ) : (
                <>
                  <div className="font-semibold">Self (own contribution)</div>
                  <p className="mt-1">
                    Each cell sized by the node's <em>own</em> work,
                    excluding descendants. Children render alongside,
                    not stacked under.
                  </p>
                  <p className="mt-1 opacity-80">
                    Best for spotting the actual bottleneck node — the
                    one doing the work, not just the one summing
                    children's work.
                  </p>
                </>
              )}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
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

/**
 * One flame cell. `kind: "node"` cells map back to a `PlanNode`;
 * `kind: "rest"` cells are synthetic "+N more" placeholders that
 * absorb tiny siblings — clicking one expands into its real
 * children.
 */
type FlameRect =
  | {
      kind: "node";
      node: PlanNode;
      x: number;
      y: number;
      w: number;
      h: number;
    }
  | {
      kind: "rest";
      /** Parent node's id — clicking the rest-cell toggles the
       *  parent into `expandedRest`. */
      parentId: string;
      hiddenChildren: PlanNode[];
      x: number;
      y: number;
      w: number;
      h: number;
    };

function FlameSvg({
  root,
  comparePlan,
  widthMode,
  widthBasis,
  sortDescending,
  filter,
  expandedRest,
  onToggleRest,
  selectedNodeId,
  onSelectNode,
  onZoomIn,
  onZoomOut,
  onFocusFilter,
  onOpenDetails,
  statement,
}: {
  root: PlanNode;
  comparePlan: PlanRoot | null;
  widthMode: WidthMode;
  widthBasis: WidthBasis;
  sortDescending: boolean;
  filter: string;
  expandedRest: Set<string>;
  onToggleRest: (parentId: string) => void;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onZoomIn: (id: string) => void;
  onZoomOut: () => void;
  onFocusFilter: () => void;
  /** Open the full-detail dialog for a node — wired to Alt-click. */
  onOpenDetails: (id: string) => void;
  statement: string;
}) {
  // Width-allocate by `metricFor(node)` proportionally among
  // siblings. The metric depends on the user's chosen mode (time /
  // cost / rows / buffers). Children of nodes with zero metric
  // collapse to 0-width rectangles so they don't shift the rest of
  // the layout.
  const metricFor = (n: PlanNode): number => {
    switch (widthMode) {
      case "time":
        return widthBasis === "self"
          ? n.selfTimeMs ?? n.totalTimeMs ?? 0
          : n.totalTimeMs ?? 0;
      case "cost":
        // Cost has no per-node "self" decomposition; we approximate
        // by subtracting child costs from parent's subtree cost.
        return widthBasis === "self" ? selfCost(n) : n.totalCost ?? 0;
      case "rows":
        return actualOrEstimatedRows(n);
      case "buffers":
        return bufferTotalFor(n);
    }
  };

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

  // Build the list of child nodes to render under a parent, applying
  // the user's sort preference. Filtered to non-zero metric so we
  // don't divide by zero downstream — a node with metric 0 in this
  // mode contributes nothing to layout.
  const childrenForLayout = (parent: PlanNode): PlanNode[] => {
    const live = parent.children.filter((c) => metricFor(c) > 0);
    if (sortDescending) {
      // Slice first so we don't mutate the canonical PlanNode tree.
      return [...live].sort((a, b) => metricFor(b) - metricFor(a));
    }
    return live;
  };

  // Self-time mode draws each parent's *own* cell as a leftmost
  // slice, then its children in the remaining width — so a cell's
  // visible width on screen really is its self-contribution. In
  // total mode parents have no separate self-cell (children
  // entirely fill the parent's width), which is the standard flame
  // layout.
  const rects: FlameRect[] = [];
  const layout = (node: PlanNode, x: number, y: number, w: number): void => {
    rects.push({ kind: "node", node, x, y, w, h: FLAME_ROW_PX });
    const live = childrenForLayout(node);
    if (live.length === 0) return;

    // Decide how much horizontal space the children get.
    let childAreaX = x;
    let childAreaW = w;
    if (widthBasis === "self") {
      const selfM =
        widthMode === "time"
          ? node.selfTimeMs ?? 0
          : widthMode === "cost"
            ? selfCost(node)
            : 0;
      const childTotal = live.reduce((s, c) => s + metricFor(c), 0);
      const all = selfM + childTotal;
      if (all > 0) {
        const selfFrac = selfM / all;
        // Leave a small reserved slice on the left for the parent's
        // self portion. Children share the rest.
        childAreaX = x + w * selfFrac;
        childAreaW = w * (1 - selfFrac);
      }
    }

    // Apply the rest-collapse threshold. Anything below
    // REST_THRESHOLD_PCT of childAreaW gets folded into a "+N more"
    // cell *unless* the user explicitly expanded this parent.
    const isExpanded = expandedRest.has(node.id);
    const childTotal = live.reduce((s, c) => s + metricFor(c), 0);
    const minPx = childAreaW * REST_THRESHOLD_PCT;
    const visible: PlanNode[] = [];
    const hidden: PlanNode[] = [];
    if (isExpanded) {
      visible.push(...live);
    } else {
      for (const c of live) {
        const cw = (metricFor(c) / childTotal) * childAreaW;
        if (cw < minPx) hidden.push(c);
        else visible.push(c);
      }
    }

    const visibleTotal = visible.reduce((s, c) => s + metricFor(c), 0);
    const hiddenTotal = hidden.reduce((s, c) => s + metricFor(c), 0);
    const renderTotal = visibleTotal + hiddenTotal;
    if (renderTotal === 0) return;

    let cursor = childAreaX;
    for (const c of visible) {
      const cw = (metricFor(c) / renderTotal) * childAreaW;
      layout(c, cursor, y + FLAME_ROW_PX, cw);
      cursor += cw;
    }
    if (hidden.length > 0) {
      const cw = (hiddenTotal / renderTotal) * childAreaW;
      rects.push({
        kind: "rest",
        parentId: node.id,
        hiddenChildren: hidden,
        x: cursor,
        y: y + FLAME_ROW_PX,
        w: cw,
        h: FLAME_ROW_PX,
      });
    }
  };
  layout(root, 0, 0, 1000);

  // Compute SVG height from deepest rect.
  const totalRows = rects.reduce(
    (max, r) => Math.max(max, r.y / FLAME_ROW_PX + 1),
    1,
  );
  const svgHeight = totalRows * FLAME_ROW_PX;

  // Build a normalised lowercase haystack per node for the filter
  // — `nodeType + relation + alias + Index Name + Filter + Index
  // Cond + Hash Cond`. Computed once per render.
  const filterMatches = useMemo(() => {
    if (!filter.trim()) return null;
    const q = filter.trim().toLowerCase();
    const matched = new Set<string>();
    for (const r of rects) {
      if (r.kind !== "node") continue;
      if (matchesFilter(r.node, q)) matched.add(r.node.id);
    }
    return matched;
  }, [filter, rects]);

  // Hover state — pinned to viewport with `position: fixed` so a
  // tall, scrollable flame doesn't hide the tooltip behind its own
  // overflow. We track cursor coords (clientX/Y) and offset the
  // tooltip by a few pixels.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<{
    rect: Extract<FlameRect, { kind: "node" }>;
    clientX: number;
    clientY: number;
    comparedSelf: number | undefined;
  } | null>(null);

  // Keyboard nav. Walks parent / child / sibling relationships in
  // the source plan tree, not the visible-rect array — a hidden
  // sibling under "+N more" is still a real node, you can still
  // arrow into it (and the rest-cell auto-expands when you do).
  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "/" || (e.key === "f" && !e.metaKey && !e.ctrlKey)) {
      e.preventDefault();
      onFocusFilter();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onZoomOut();
      return;
    }
    if (e.key === "Enter") {
      if (!selectedNodeId) return;
      const target = findNode(root, selectedNodeId);
      if (target && target.children.length > 0) {
        e.preventDefault();
        onZoomIn(selectedNodeId);
      }
      return;
    }
    if (e.key === "i" && selectedNodeId && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      onOpenDetails(selectedNodeId);
      return;
    }
    if (
      e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight"
    ) {
      e.preventDefault();
      const cur = selectedNodeId
        ? findNode(root, selectedNodeId) ?? root
        : root;
      const parent = parentOf(root, cur);
      switch (e.key) {
        case "ArrowUp":
          if (parent) onSelectNode(parent.id);
          break;
        case "ArrowDown":
          if (cur.children.length > 0) onSelectNode(cur.children[0].id);
          break;
        case "ArrowLeft":
        case "ArrowRight": {
          if (!parent) return;
          const sibs = parent.children;
          const idx = sibs.indexOf(cur);
          if (idx < 0) return;
          const next =
            e.key === "ArrowLeft"
              ? sibs[Math.max(0, idx - 1)]
              : sibs[Math.min(sibs.length - 1, idx + 1)];
          if (next) onSelectNode(next.id);
          break;
        }
      }
    }
  };

  return (
    <div ref={wrapperRef} className="relative" onMouseLeave={() => setHovered(null)}>
      <svg
        ref={svgRef}
        viewBox={`0 0 1000 ${svgHeight}`}
        preserveAspectRatio="none"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="block w-full outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
        style={{ minHeight: svgHeight, height: svgHeight }}
      >
        <defs>
          {/* Diagonal-stripe pattern overlay for cells with high
              cardinality skew. The stripes are partially transparent
              so the underlying node-type colour still reads. Two
              tiers — soft for ≥10× skew, dense + bolder red for
              ≥100× — so the eye triages "noticeable" vs "alarming"
              skew without a tooltip. */}
          <pattern
            id="flame-skew-soft"
            patternUnits="userSpaceOnUse"
            width="6"
            height="6"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" fill="transparent" />
            <rect width="2" height="6" fill="var(--destructive)" opacity="0.35" />
          </pattern>
          <pattern
            id="flame-skew-bold"
            patternUnits="userSpaceOnUse"
            width="5"
            height="5"
            patternTransform="rotate(45)"
          >
            <rect width="5" height="5" fill="transparent" />
            <rect width="2.5" height="5" fill="var(--destructive)" opacity="0.6" />
          </pattern>
        </defs>

        {rects.map((r) =>
          r.kind === "rest" ? (
            <RestCell
              key={`rest-${r.parentId}`}
              rect={r}
              onClick={() => onToggleRest(r.parentId)}
            />
          ) : (
            <FlameNode
              key={r.node.id}
              rect={r}
              compareMap={compareMap}
              filterActive={filterMatches !== null}
              isFilterMatch={filterMatches?.has(r.node.id) ?? false}
              isSelected={r.node.id === selectedNodeId}
              isHovered={hovered?.rect.node.id === r.node.id}
              onMouseEnter={(e) =>
                setHovered({
                  rect: r,
                  clientX: e.clientX,
                  clientY: e.clientY,
                  comparedSelf: comparedSelfFor(compareMap, r.node),
                })
              }
              onMouseMove={(e) =>
                setHovered((h) =>
                  h && h.rect.node.id === r.node.id
                    ? { ...h, clientX: e.clientX, clientY: e.clientY }
                    : {
                        rect: r,
                        clientX: e.clientX,
                        clientY: e.clientY,
                        comparedSelf: comparedSelfFor(compareMap, r.node),
                      },
                )
              }
              onClick={(e) => {
                e.stopPropagation();
                // Alt/Option-click → open the full-detail dialog.
                // Avoids stomping the click → select / dblclick →
                // zoom shortcuts users already know.
                if (e.altKey) {
                  onOpenDetails(r.node.id);
                  return;
                }
                onSelectNode(r.node.id);
                if (e.detail === 2 && r.node.children.length > 0) {
                  onZoomIn(r.node.id);
                }
              }}
            />
          ),
        )}
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

/** A single flame cell mapped to a real PlanNode. Pulled out into
 *  its own component so the CSS transition on transform/width
 *  fires per-cell when zooming or toggling metric mode — React's
 *  shared key (the node id) is what cues the browser to interpolate
 *  position rather than re-mount. */
function FlameNode({
  rect,
  compareMap,
  filterActive,
  isFilterMatch,
  isSelected,
  isHovered,
  onMouseEnter,
  onMouseMove,
  onClick,
}: {
  rect: Extract<FlameRect, { kind: "node" }>;
  compareMap: Map<string, number> | null;
  filterActive: boolean;
  isFilterMatch: boolean;
  isSelected: boolean;
  isHovered: boolean;
  onMouseEnter: (e: React.MouseEvent) => void;
  onMouseMove: (e: React.MouseEvent) => void;
  onClick: (e: React.MouseEvent) => void;
}) {
  const node = rect.node;
  const compareKey = `${node.nodeType}|${node.relation ?? ""}`;
  const comparedSelf = compareMap?.get(compareKey);
  const delta =
    comparedSelf !== undefined && node.selfTimeMs !== undefined
      ? node.selfTimeMs - comparedSelf
      : undefined;

  const skew = cardinalitySkew(node);
  const skewTier: "none" | "soft" | "bold" =
    skew === undefined || skew < 10 ? "none" : skew >= 100 ? "bold" : "soft";

  // Stroke priority: filter match (gold) > delta (emerald/red) >
  // skew (red destructive) > border. The match outline always
  // wins so the user can find it.
  const stroke = isFilterMatch
    ? "rgb(245 158 11)" // amber-500
    : delta !== undefined
      ? delta < 0
        ? "rgb(16 185 129)"
        : delta > 0
          ? "var(--destructive)"
          : "var(--border)"
      : skewTier !== "none"
        ? "var(--destructive)"
        : "var(--border)";

  const opacity = filterActive
    ? isFilterMatch
      ? 0.95
      : 0.2
    : isHovered
      ? 1
      : isSelected
        ? 1
        : 0.85;

  // Single-line label — the previous two-line layout (rows on a
  // second line at y+18) clipped against the cell's 21-px height
  // because the descender ran past the bottom edge. One line,
  // sized by available width, never clips.
  const rowCount = actualOrEstimatedRows(node);
  const label = buildCellLabel(node, rowCount);

  return (
    <g
      onMouseEnter={onMouseEnter}
      onMouseMove={onMouseMove}
      onClick={onClick}
      // CSS transition on the rect's geometry — fires on metric/zoom
      // toggles where the node id is preserved across renders, but
      // not on a fresh plan (different ids → React mounts new
      // elements, no interpolation).
      style={{
        cursor: node.children.length > 0 ? "pointer" : "default",
        transition: "opacity 180ms ease",
      }}
    >
      <rect
        x={rect.x}
        y={rect.y}
        width={Math.max(0.5, rect.w - 1)}
        height={rect.h - 1}
        rx={2}
        ry={2}
        fill={colorVarForNodeType(node.nodeType)}
        stroke={stroke}
        strokeWidth={isSelected || isHovered || isFilterMatch ? 2 : 1}
        opacity={opacity}
        style={{
          transition:
            "x 180ms ease, y 180ms ease, width 180ms ease, opacity 180ms ease",
        }}
      />
      {/* Skew overlay — drawn on top of the fill so it doesn't
          obscure the colour but still reads as "this cell is
          suspicious". */}
      {skewTier !== "none" ? (
        <rect
          x={rect.x}
          y={rect.y}
          width={Math.max(0.5, rect.w - 1)}
          height={rect.h - 1}
          rx={2}
          ry={2}
          fill={
            skewTier === "bold" ? "url(#flame-skew-bold)" : "url(#flame-skew-soft)"
          }
          opacity={opacity}
          style={{ pointerEvents: "none" }}
        />
      ) : null}
      {rect.w > 40 ? (
        <text
          x={rect.x + 4}
          y={rect.y + 14}
          fontSize="10"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          fill="var(--foreground)"
          style={{ pointerEvents: "none" }}
        >
          {truncate(label, Math.floor(rect.w / 6))}
        </text>
      ) : null}
    </g>
  );
}

/**
 * Single-line cell label that adapts to available width. The cell
 * width determines how much detail we can fit; the label degrades
 * gracefully:
 *
 *   ≥ 200 px → NodeType · relation · alias · 39k rows
 *   ≥ 120 px → NodeType · relation · 39k rows
 *   ≥  80 px → NodeType · 39k rows
 *   ≥  40 px → NodeType
 *
 * The 40 px threshold is the same one we use to decide whether to
 * render *any* text at all. The truncate() applied later inside
 * the SVG clips at the rendered character budget.
 */
function buildCellLabel(node: PlanNode, rowCount: number): string {
  // Caller already truncates to fit; here we just produce the
  // longest plausibly-useful string and let the truncate() cap it.
  const rowsTag = `${fmtCount(rowCount)} rows`;
  if (node.relation && node.alias && node.alias !== node.relation) {
    return `${node.nodeType} · ${node.relation} ${node.alias} · ${rowsTag}`;
  }
  if (node.relation) {
    return `${node.nodeType} · ${node.relation} · ${rowsTag}`;
  }
  return `${node.nodeType} · ${rowsTag}`;
}

/** Synthetic "+N more" cell that absorbs siblings whose individual
 *  width fell below `REST_THRESHOLD_PCT`. Click to expand. */
function RestCell({
  rect,
  onClick,
}: {
  rect: Extract<FlameRect, { kind: "rest" }>;
  onClick: () => void;
}) {
  return (
    <g
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{ cursor: "pointer" }}
    >
      <rect
        x={rect.x}
        y={rect.y}
        width={Math.max(0.5, rect.w - 1)}
        height={rect.h - 1}
        rx={2}
        ry={2}
        fill="var(--muted)"
        stroke="var(--border)"
        strokeWidth={1}
        strokeDasharray="2 2"
        opacity={0.7}
      />
      {rect.w > 40 ? (
        <text
          x={rect.x + 4}
          y={rect.y + 14}
          fontSize="10"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          fill="var(--muted-foreground)"
          style={{ pointerEvents: "none" }}
        >
          + {rect.hiddenChildren.length} more
        </text>
      ) : null}
      <title>
        {rect.hiddenChildren.length} small siblings collapsed — click to expand
      </title>
    </g>
  );
}

/** Cost minus child costs — Postgres (and MSSQL) plan nodes carry
 *  a subtree total but no per-node "self cost" field. This is the
 *  best approximation for the self-basis layout in cost mode. */
function selfCost(node: PlanNode): number {
  const total = node.totalCost ?? 0;
  const childTotal = node.children.reduce(
    (s, c) => s + (c.totalCost ?? 0),
    0,
  );
  return Math.max(0, total - childTotal);
}

/** Lookup `nodeType + relation` in the compare-plan map and return
 *  the matched plan's `selfTimeMs` for delta-colouring, or
 *  undefined when no match. */
function comparedSelfFor(
  map: Map<string, number> | null,
  node: PlanNode,
): number | undefined {
  if (!map) return undefined;
  return map.get(`${node.nodeType}|${node.relation ?? ""}`);
}

/** Locate a node's parent by walking the tree. Used by keyboard
 *  navigation. O(N) in the tree size but called rarely (one
 *  arrow-key press) so the simplicity beats memoising. */
function parentOf(root: PlanNode, target: PlanNode): PlanNode | null {
  if (root === target) return null;
  const stack: PlanNode[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of cur.children) {
      if (c.id === target.id) return cur;
      stack.push(c);
    }
  }
  return null;
}

/** Filter-haystack match. Lowercased query; matches against
 *  nodeType / relation / alias / Index Name / Filter / Index Cond /
 *  Hash Cond — the spots where a user thinks "I'm looking for a
 *  scan of `events`" would actually expect to match. */
function matchesFilter(node: PlanNode, q: string): boolean {
  const parts: (string | undefined)[] = [
    node.nodeType,
    node.relation,
    node.alias,
    asString(node.details["Index Name"]),
    asString(node.details["Filter"]),
    asString(node.details["Index Cond"]),
    asString(node.details["Hash Cond"]),
    asString(node.details["Recheck Cond"]),
  ];
  return parts.some((p) => p !== undefined && p.toLowerCase().includes(q));
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
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
  widthMode: WidthMode;
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
  // Mirror the flame's own metric so % of root in the tooltip
  // matches the mode the user has selected. The four modes line up
  // with `metricFor` in `FlameSvg`.
  const metric =
    widthMode === "time"
      ? node.totalTimeMs ?? 0
      : widthMode === "cost"
        ? node.totalCost ?? 0
        : widthMode === "rows"
          ? actualOrEstimatedRows(node)
          : bufferTotalFor(node);
  const pctOfRoot = rootMetric > 0 ? (metric / rootMetric) * 100 : undefined;
  const pctLabel: Record<WidthMode, string> = {
    time: "% of root time",
    cost: "% of root cost",
    rows: "% of root rows",
    buffers: "% of root buffers",
  };
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
            label={pctLabel[widthMode]}
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
        click to select · double-click to zoom · ⌥-click for full details
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
  "LogicalOp",
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

// ─── Node-details dialog (Opt+click) ────────────────────────────────

/**
 * Full-detail expansion of the flame tooltip. Shows everything the
 * cursor-pinned tooltip can't fit:
 *
 *   - Every metric (timing, cost, row counts, skew %, % of root,
 *     loops) — same data, more space, no truncation on long
 *     numbers.
 *   - Buffer cache for Postgres (full hit/read/dirtied/written
 *     counts plus hit ratio).
 *   - Every entry in `node.details` — not the curated 8 the
 *     tooltip surfaces, but the full planner payload verbatim.
 *   - Long-form `Output` and `Filter` / `Index Cond` strings
 *     wrap freely instead of single-line truncating.
 *   - Every line of the user's SQL with the node's relations /
 *     aliases / index name highlighted (the tooltip caps at 6
 *     matched lines; the dialog shows them all).
 *   - Children summary (count + list of child node types).
 *
 * Trigger: Alt-click on a flame cell, or `i` while a cell is
 * selected (with the SVG focused).
 */
function NodeDetailsDialog({
  node,
  plan,
  widthMode,
  open,
  onOpenChange,
}: {
  node: PlanNode | null;
  plan: PlanRoot;
  widthMode: WidthMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!node) {
    // Render a closed dialog so the unmount path is always
    // available — Radix's <Dialog> wants its child tree to be
    // present even when closed for animation purposes.
    return <Dialog open={false} onOpenChange={onOpenChange} />;
  }

  const skew = cardinalitySkew(node);
  const rootMetric = (() => {
    switch (widthMode) {
      case "time":
        return plan.topNode.totalTimeMs ?? 0;
      case "cost":
        return plan.topNode.totalCost ?? 0;
      case "rows":
        return actualOrEstimatedRows(plan.topNode);
      case "buffers":
        return bufferTotalFor(plan.topNode);
    }
  })();
  const ownMetric = (() => {
    switch (widthMode) {
      case "time":
        return node.totalTimeMs ?? 0;
      case "cost":
        return node.totalCost ?? 0;
      case "rows":
        return actualOrEstimatedRows(node);
      case "buffers":
        return bufferTotalFor(node);
    }
  })();
  const pctOfRoot = rootMetric > 0 ? (ownMetric / rootMetric) * 100 : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-sm">
            <span
              className="inline-block size-3 shrink-0 rounded-sm"
              style={{ background: colorVarForNodeType(node.nodeType) }}
            />
            {node.nodeType}
            {node.relation ? (
              <span className="text-muted-foreground">
                · {node.relation}
                {node.alias && node.alias !== node.relation
                  ? ` ${node.alias}`
                  : ""}
              </span>
            ) : null}
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            Full per-node detail. Press <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">Esc</kbd> or click outside to close.
          </DialogDescription>
        </DialogHeader>

        {/* Badges row — same triage signals as the tooltip. */}
        <div className="flex flex-wrap gap-1.5">
          {skew !== undefined && skew >= 10 ? (
            <span className="rounded border border-destructive/60 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
              {skew >= 100 ? Math.round(skew) : skew.toFixed(1)}× est skew
            </span>
          ) : null}
          {node.buffers && node.buffers.sharedRead > node.buffers.sharedHit ? (
            <span className="rounded border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              uncached I/O
            </span>
          ) : null}
          {node.loops !== undefined && node.loops > 1 ? (
            <span className="rounded border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px]">
              {fmtCount(node.loops)} loops
            </span>
          ) : null}
        </div>

        {/* Metric grid — 2 cols on small dialogs, 4 cols when the
            dialog has room. */}
        <DetailSection title="Metrics">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4 font-mono text-[12px] tabular-nums">
            {node.totalTimeMs !== undefined ? (
              <DetailStat label="Total time" value={`${node.totalTimeMs.toFixed(3)} ms`} />
            ) : null}
            {node.selfTimeMs !== undefined ? (
              <DetailStat label="Self time" value={`${node.selfTimeMs.toFixed(3)} ms`} />
            ) : null}
            {node.totalCost !== undefined ? (
              <DetailStat label="Total cost" value={node.totalCost.toFixed(2)} />
            ) : null}
            <DetailStat
              label="Estimated rows"
              value={fmtCount(node.estimatedRows)}
            />
            {node.actualRows !== undefined ? (
              <DetailStat label="Actual rows" value={fmtCount(node.actualRows)} />
            ) : null}
            {skew !== undefined ? (
              <DetailStat
                label="Skew"
                value={skew >= 100 ? `${Math.round(skew)}×` : `${skew.toFixed(1)}×`}
              />
            ) : null}
            {node.loops !== undefined ? (
              <DetailStat label="Loops" value={fmtCount(node.loops)} />
            ) : null}
            {pctOfRoot !== null ? (
              <DetailStat
                label={`% of root ${widthMode}`}
                value={`${pctOfRoot.toFixed(2)}%`}
              />
            ) : null}
          </dl>
        </DetailSection>

        {/* Buffer-cache breakdown (Postgres only). */}
        {node.buffers ? (
          <DetailSection title="Buffer cache">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4 font-mono text-[12px] tabular-nums">
              <DetailStat
                label="Hit ratio"
                value={`${(node.buffers.hitRatio * 100).toFixed(1)}%`}
              />
              <DetailStat label="Shared hit" value={fmtCount(node.buffers.sharedHit)} />
              <DetailStat label="Shared read" value={fmtCount(node.buffers.sharedRead)} />
              <DetailStat label="Shared dirtied" value={fmtCount(node.buffers.sharedDirtied)} />
              <DetailStat label="Shared written" value={fmtCount(node.buffers.sharedWritten)} />
              <DetailStat label="Local hit" value={fmtCount(node.buffers.localHit)} />
              <DetailStat label="Local read" value={fmtCount(node.buffers.localRead)} />
            </dl>
          </DetailSection>
        ) : null}

        {/* Every key in `node.details` — full payload, not just the
            curated 8 we surface in the tooltip. Hot keys (Filter /
            Index Cond / Hash Cond / Sort Key / etc.) are pinned to
            the top; everything else follows alphabetically. The
            previous fixed `grid-cols-[10rem_1fr]` layout clipped
            long keys (`EstimatedTotalSubtreeCost` is 25 chars =
            ≫10rem) and they bled into the value column; the new
            layout uses flex per row so the label always fits and
            the value flows alongside or wraps cleanly below. */}
        <DetailSection title="Planner detail">
          <dl className="space-y-1.5 font-mono text-[12px]">
            {sortDetailEntries(node.details).map(([k, v]) => (
              <div
                key={k}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5"
              >
                <dt className="shrink-0 text-muted-foreground">{k}</dt>
                <dd className="min-w-0 flex-1 break-words text-foreground">
                  {formatDetailValue(v)}
                </dd>
              </div>
            ))}
          </dl>
        </DetailSection>

        {/* Children summary — count + breakdown by node type. */}
        {node.children.length > 0 ? (
          <DetailSection title={`Children (${node.children.length})`}>
            <ul className="flex flex-wrap gap-1.5 font-mono text-[11px]">
              {node.children.map((c, i) => (
                <li
                  key={c.id}
                  className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5"
                >
                  <span className="text-muted-foreground">#{i + 1} </span>
                  {c.nodeType}
                  {c.relation ? (
                    <span className="text-muted-foreground"> · {c.relation}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </DetailSection>
        ) : null}

        {/* Query context — every line of the user's SQL that
            references this node's relation / alias / index. The
            tooltip caps at 6 lines; here we show all of them. */}
        <DetailSection title="Query context">
          <FullQueryContext node={node} statement={plan.statement} />
        </DetailSection>

        {/* Raw payload — the canonical JSON dump of just this node.
            Useful when the formatted views above are missing
            something; the user can copy/paste this into a bug
            report or a follow-up query. Collapsed by default so the
            dialog stays scan-friendly. */}
        <RawNodePayload node={node} />
      </DialogContent>
    </Dialog>
  );
}

/** Collapsible "raw" section. Click to expand a `<pre>` of the
 * node's full JSON; copy button lifts it to the clipboard so the
 * user can paste it elsewhere. */
function RawNodePayload({ node }: { node: PlanNode }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const json = useMemo(() => {
    // Strip `children` (recursive PlanNode array) — those are
    // already surfaced as the Children chip list, and dumping the
    // whole subtree turns this into a Raw-tab equivalent. Keep the
    // raw `details` map (which has the original planner fields) so
    // the user sees exactly what came back from the backend.
    const safe = {
      id: node.id,
      nodeType: node.nodeType,
      relation: node.relation,
      alias: node.alias,
      totalCost: node.totalCost,
      estimatedRows: node.estimatedRows,
      actualRows: node.actualRows,
      totalTimeMs: node.totalTimeMs,
      selfTimeMs: node.selfTimeMs,
      loops: node.loops,
      buffers: node.buffers,
      details: node.details,
      childCount: node.children.length,
    };
    return JSON.stringify(safe, null, 2);
  }, [node]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // soft-fail — the <pre> is still selectable
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {open ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          Raw payload
        </button>
        {open ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onCopy}
            className="h-6 gap-1 px-2 text-[11px]"
          >
            <Copy className="size-3" />
            {copied ? "Copied" : "Copy"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <pre className="mt-1 max-h-72 overflow-auto rounded border border-border/60 bg-muted/30 p-2 font-mono text-[11px] leading-snug">
          {json}
        </pre>
      ) : null}
    </div>
  );
}

/** Section wrapper used inside the dialog. Title + thin rule. */
function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

/** One label/value cell in the metrics grid. */
function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}

/** Render a `details` value as a human-readable string. Strings
 * pass through; arrays comma-join; objects JSON.stringify. The
 * tooltip uses a similar helper but caps at 200 chars; here we
 * never truncate. */
function formatDetailValue(v: unknown): string {
  if (Array.isArray(v)) {
    return v.map((x) => formatDetailValue(x)).join(", ");
  }
  if (typeof v === "object" && v !== null) {
    return JSON.stringify(v);
  }
  return String(v);
}

/**
 * Sort `node.details` for the dialog. Pin the planner-decision
 * keys at the top so the user can read "what is this node doing?"
 * without scrolling through alphabetical noise (`Async Capable`,
 * `Parent Relationship`, `Schema`, …). Everything else follows
 * alphabetically so a specific field is still findable.
 *
 * `Plans` is excluded — it's the children array, surfaced
 * separately as a chip list. The Raw tab is the place to see the
 * full JSON dump including children.
 */
const HOT_DETAIL_KEYS: string[] = [
  // Postgres
  "Filter",
  "Index Cond",
  "Index Name",
  "Recheck Cond",
  "Hash Cond",
  "Merge Cond",
  "Join Type",
  "Join Filter",
  "Strategy",
  "Sort Key",
  "Sort Method",
  "Sort Space Used",
  "Sort Space Type",
  "Group Key",
  "Output",
  "Workers Planned",
  "Workers Launched",
  "Heap Fetches",
  "One-Time Filter",
  // MSSQL
  "LogicalOp",
  "EstimatedExecutionMode",
  "Parallel",
  "EstimatedRowsRead",
  "EstimateIO",
  "EstimateCPU",
  "AvgRowSize",
  "Object.Database",
  "Object.Schema",
  "Object.Table",
  "Object.Index",
  "Object.IndexKind",
  "Object.Storage",
  "Object.Alias",
];

function sortDetailEntries(
  details: Record<string, unknown>,
): Array<[string, unknown]> {
  const live = Object.entries(details).filter(
    ([k, v]) =>
      v !== undefined &&
      v !== null &&
      v !== "" &&
      k !== "Plans",
  );
  const hot: Array<[string, unknown]> = [];
  const rest: Array<[string, unknown]> = [];
  const hotSet = new Set(HOT_DETAIL_KEYS);
  for (const e of live) {
    if (hotSet.has(e[0])) hot.push(e);
    else rest.push(e);
  }
  // Hot in declaration order (priority); rest alphabetical.
  hot.sort(
    ([a], [b]) => HOT_DETAIL_KEYS.indexOf(a) - HOT_DETAIL_KEYS.indexOf(b),
  );
  rest.sort(([a], [b]) => a.localeCompare(b));
  return [...hot, ...rest];
}

/** Full-statement query context for the dialog. Shows every line
 * containing a token match, no 6-line cap. */
function FullQueryContext({
  node,
  statement,
}: {
  node: PlanNode;
  statement: string;
}) {
  const tokens = useMemo(() => collectQueryTokens(node), [node]);
  const lines = useMemo(() => statement.split("\n"), [statement]);
  const matches = useMemo(() => {
    if (tokens.length === 0) return [];
    const re = buildTokenRegex(tokens);
    if (!re) return [];
    const out: { idx: number; text: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) out.push({ idx: i, text: lines[i] });
      re.lastIndex = 0;
    }
    return out;
  }, [tokens, lines]);

  if (tokens.length === 0 || matches.length === 0) {
    return (
      <div className="text-[11px] text-muted-foreground">
        No matching lines in the source statement (this node may be
        synthetic or reference a CTE / function with no direct
        textual handle).
      </div>
    );
  }

  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug">
      {matches.map((m) => (
        <div key={m.idx} className="flex gap-2">
          <span className="shrink-0 select-none text-muted-foreground tabular-nums">
            {String(m.idx + 1).padStart(4, " ")}
          </span>
          <span className="min-w-0 flex-1">
            {renderHighlighted(m.text, tokens)}
          </span>
        </div>
      ))}
    </pre>
  );
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
