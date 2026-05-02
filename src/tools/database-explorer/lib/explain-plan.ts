/**
 * Unified plan model + parsers for Postgres EXPLAIN-JSON and MSSQL
 * ShowPlanXML.
 *
 * Both dialects feed into a single `PlanRoot { topNode, … }` shape
 * so the visualizer doesn't have to branch per source. Postgres
 * carries actual per-node timing + buffer stats; MSSQL XML
 * showplan only has estimates + costs + (when STATISTICS XML
 * executed) actual row counts. The flame view falls back to cost
 * when timing is absent — the visualizer headers explicitly tell
 * the user which mode they're in.
 *
 * Parsing happens entirely on the front-end. The backend ships the
 * raw payload; we keep it for the "Raw" view and walk it into the
 * `PlanNode` tree for the "Plan" + "Flame" views.
 */

import type { DbExplainFormat } from "./tauri";

export type DialectKind = "postgres" | "mssql";

export interface BufferStats {
  sharedHit: number;
  sharedRead: number;
  sharedDirtied: number;
  sharedWritten: number;
  localHit: number;
  localRead: number;
  /** `sharedHit / (sharedHit + sharedRead)`, in [0,1]. `0` when both
   * counts are zero (e.g., DDL with no buffer activity). */
  hitRatio: number;
}

export interface PlanNode {
  /** Synthetic id, stable per parse. */
  id: string;
  /** "Seq Scan" / "Index Scan" / "Hash Join" / "Sort" / "Aggregate"
   *  / etc. — driver's catalogue label. */
  nodeType: string;
  /** Table or index this node operates on (when applicable). */
  relation?: string;
  alias?: string;
  /** Postgres `Total Cost`, or MSSQL `EstimatedTotalSubtreeCost`. */
  totalCost?: number;
  estimatedRows: number;
  /** Postgres `Actual Rows`; MSSQL `ActualRows` when STATISTICS XML
   * executed. `undefined` for estimate-only plans. */
  actualRows?: number;
  /** Postgres `Actual Total Time` (ms). MSSQL XML showplan has no
   * per-node time — left undefined; the flame view falls back to
   * cost in that case. */
  totalTimeMs?: number;
  /** `totalTimeMs - sum(child.totalTimeMs)`. The fraction this node
   * itself spent — i.e., excluding children. */
  selfTimeMs?: number;
  loops?: number;
  /** Postgres only. */
  buffers?: BufferStats;
  /** Raw catalogue fields, surfaced verbatim in the per-node detail
   * tooltip so power users can see everything the planner shipped. */
  details: Record<string, unknown>;
  children: PlanNode[];
}

export interface PlanRoot {
  source: DialectKind;
  topNode: PlanNode;
  /** Postgres only. */
  planningTimeMs?: number;
  executionTimeMs?: number;
  /** `planningTime + executionTime` for Postgres; otherwise the
   * top node's total time when present. `undefined` when neither
   * source provides one. */
  totalTimeMs?: number;
  /** Original user query, captured from `ExplainResult.statement`. */
  statement: string;
  /** Raw plan payload — JSON or XML — for the Raw tab. */
  raw: string;
}

/** Parser dispatch — `format` comes straight from the backend. */
export function parseExplain(
  format: DbExplainFormat,
  raw: string,
  statement: string,
): PlanRoot {
  if (format === "json") return parsePostgresExplain(raw, statement);
  return parseMssqlShowplan(raw, statement);
}

// ─── Postgres ───────────────────────────────────────────────────────

interface PgPlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Alias?: string;
  "Total Cost"?: number;
  "Plan Rows"?: number;
  "Actual Rows"?: number;
  "Actual Total Time"?: number;
  "Actual Loops"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Shared Dirtied Blocks"?: number;
  "Shared Written Blocks"?: number;
  "Local Hit Blocks"?: number;
  "Local Read Blocks"?: number;
  Plans?: PgPlanNode[];
  [extra: string]: unknown;
}

interface PgRoot {
  Plan: PgPlanNode;
  "Planning Time"?: number;
  "Execution Time"?: number;
  [extra: string]: unknown;
}

export function parsePostgresExplain(json: string, statement: string): PlanRoot {
  let parsed: PgRoot[];
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `Postgres EXPLAIN payload not valid JSON: ${(e as Error).message}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Postgres EXPLAIN payload is not a non-empty array");
  }
  const root = parsed[0];
  let counter = 0;
  const mintId = () => `pg-${counter++}`;

  const walk = (n: PgPlanNode): PlanNode => {
    const children = (n.Plans ?? []).map(walk);
    const totalTimeMs = numOrUndef(n["Actual Total Time"]);
    const childTotal = children.reduce(
      (sum, c) => sum + (c.totalTimeMs ?? 0),
      0,
    );
    const selfTimeMs =
      totalTimeMs !== undefined
        ? Math.max(0, totalTimeMs - childTotal)
        : undefined;

    const buffers = readBuffers(n);

    return {
      id: mintId(),
      nodeType: n["Node Type"] ?? "Unknown",
      relation: n["Relation Name"],
      alias: n.Alias,
      totalCost: numOrUndef(n["Total Cost"]),
      estimatedRows: numOrUndef(n["Plan Rows"]) ?? 0,
      actualRows: numOrUndef(n["Actual Rows"]),
      totalTimeMs,
      selfTimeMs,
      loops: numOrUndef(n["Actual Loops"]),
      buffers,
      details: n as Record<string, unknown>,
      children,
    };
  };

  const topNode = walk(root.Plan);
  const planningTimeMs = numOrUndef(root["Planning Time"]);
  const executionTimeMs = numOrUndef(root["Execution Time"]);
  const totalTimeMs =
    planningTimeMs !== undefined && executionTimeMs !== undefined
      ? planningTimeMs + executionTimeMs
      : executionTimeMs ?? topNode.totalTimeMs;

  return {
    source: "postgres",
    topNode,
    planningTimeMs,
    executionTimeMs,
    totalTimeMs,
    statement,
    raw: json,
  };
}

function readBuffers(n: PgPlanNode): BufferStats | undefined {
  const sharedHit = numOrUndef(n["Shared Hit Blocks"]);
  const sharedRead = numOrUndef(n["Shared Read Blocks"]);
  if (sharedHit === undefined && sharedRead === undefined) return undefined;
  const hit = sharedHit ?? 0;
  const read = sharedRead ?? 0;
  const total = hit + read;
  return {
    sharedHit: hit,
    sharedRead: read,
    sharedDirtied: numOrUndef(n["Shared Dirtied Blocks"]) ?? 0,
    sharedWritten: numOrUndef(n["Shared Written Blocks"]) ?? 0,
    localHit: numOrUndef(n["Local Hit Blocks"]) ?? 0,
    localRead: numOrUndef(n["Local Read Blocks"]) ?? 0,
    hitRatio: total > 0 ? hit / total : 0,
  };
}

// ─── MSSQL ──────────────────────────────────────────────────────────

export function parseMssqlShowplan(xml: string, statement: string): PlanRoot {
  if (typeof DOMParser === "undefined") {
    throw new Error("DOMParser unavailable; cannot parse MSSQL ShowPlanXML");
  }
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) {
    throw new Error(
      `MSSQL ShowPlanXML parse error: ${err.textContent ?? "unknown"}`,
    );
  }

  // Find the first `<RelOp>` — MSSQL nests them N-deep through
  // ShowPlanXML > BatchSequence > Batch > Statements > StmtSimple
  // > QueryPlan > RelOp.
  const root = doc.querySelector("RelOp");
  if (!root) {
    throw new Error("MSSQL ShowPlanXML has no <RelOp> root node");
  }

  let counter = 0;
  const mintId = () => `mssql-${counter++}`;

  const walk = (el: Element): PlanNode => {
    const physicalOp = el.getAttribute("PhysicalOp") ?? "Unknown";
    const estRows = parseFloat(el.getAttribute("EstimateRows") ?? "");
    const actRows = parseFloat(el.getAttribute("ActualRows") ?? "");
    const subtreeCost = parseFloat(
      el.getAttribute("EstimatedTotalSubtreeCost") ?? "",
    );

    // Find the relation/object — MSSQL nests it in
    // <Object Database="..." Schema="..." Table="..." Index="..."/>
    // a few levels in. Pick the *first* descendant Object whose
    // direct ancestor is THIS RelOp's body (not a child RelOp's).
    const obj = directDescendantObject(el);
    const relation = obj
      ? [obj.getAttribute("Schema"), obj.getAttribute("Table") ?? obj.getAttribute("Index")]
          .filter(Boolean)
          .map((s) => trimBrackets(s!))
          .join(".")
      : undefined;
    const alias = obj?.getAttribute("Alias")
      ? trimBrackets(obj.getAttribute("Alias")!)
      : undefined;

    // Children: every RelOp that is a descendant of this one but
    // not nested inside another RelOp first. Standard MSSQL
    // showplan structure: each operator wraps its children inside
    // its specific operator type element (e.g. `<Hash><RelOp/>…</Hash>`),
    // so the immediate-grandchild-RelOps are this node's children.
    const children = directChildRelOps(el).map(walk);

    // Pull the full `<Object>` attribute set into the details map
    // under `Object.*` keys so the user can see Database / Schema /
    // Table / Index / IndexKind / Storage at a glance. Without this,
    // the parser threw away everything except the schema/table pair
    // it concatenated into `relation`.
    const objectAttrs: Record<string, unknown> = {};
    if (obj) {
      for (const attr of Array.from(obj.attributes)) {
        objectAttrs[`Object.${attr.name}`] = attr.value;
      }
    }

    // `collectAttrs` previously also stamped a lowercase
    // `logicalOp` onto the details map, which produced a duplicate
    // alongside the existing `LogicalOp` key from the XML — the
    // dialog rendered both rows for the same value. The lowercase
    // alias served no purpose other than that duplicate, so we drop
    // the synthetic `extra` parameter entirely.
    return {
      id: mintId(),
      nodeType: physicalOp,
      relation,
      alias,
      totalCost: Number.isFinite(subtreeCost) ? subtreeCost : undefined,
      estimatedRows: Number.isFinite(estRows) ? estRows : 0,
      actualRows: Number.isFinite(actRows) ? actRows : undefined,
      totalTimeMs: undefined,
      selfTimeMs: undefined,
      loops: undefined,
      buffers: undefined,
      details: { ...collectAttrs(el, {}), ...objectAttrs },
      children,
    };
  };

  const topNode = walk(root);
  return {
    source: "mssql",
    topNode,
    statement,
    raw: xml,
  };
}

function directChildRelOps(parent: Element): Element[] {
  // Walk the DOM tree in BFS, but stop descending into a node the
  // moment we hit a RelOp — that nested RelOp is a child, and its
  // descendants belong to it, not to `parent`.
  const out: Element[] = [];
  const stack: Element[] = Array.from(parent.children);
  while (stack.length) {
    const el = stack.shift()!;
    if (el.tagName === "RelOp") {
      out.push(el);
      continue; // don't descend
    }
    stack.push(...Array.from(el.children));
  }
  return out;
}

function directDescendantObject(parent: Element): Element | null {
  // First Object element that's a descendant of `parent` *without*
  // crossing a nested RelOp boundary. Without that boundary check
  // we'd pick up the inner-most RelOp's Object instead of our own.
  const stack: Element[] = Array.from(parent.children);
  while (stack.length) {
    const el = stack.shift()!;
    if (el.tagName === "RelOp") continue;
    if (el.tagName === "Object") return el;
    stack.push(...Array.from(el.children));
  }
  return null;
}

function trimBrackets(s: string): string {
  // MSSQL identifiers come quoted as `[name]`. Strip the
  // brackets for human readability.
  if (s.startsWith("[") && s.endsWith("]")) return s.slice(1, -1);
  return s;
}

function collectAttrs(
  el: Element,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...extra };
  for (const attr of Array.from(el.attributes)) {
    out[attr.name] = attr.value;
  }
  return out;
}

// ─── Helpers ────────────────────────────────────────────────────────

function numOrUndef(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v;
}

/** Walk the tree post-order and return every node — handy for
 * "top 5 by self-time" / "every node with skew" computations. */
export function flattenPlan(root: PlanNode): PlanNode[] {
  const out: PlanNode[] = [];
  const visit = (n: PlanNode) => {
    for (const c of n.children) visit(c);
    out.push(n);
  };
  visit(root);
  return out;
}

/** Top-N nodes by self-time (Postgres) or by cost (MSSQL fallback).
 * The visualizer uses this for the "Slow nodes" summary chip strip. */
export function topNodesBySelfTime(root: PlanNode, n = 5): PlanNode[] {
  const all = flattenPlan(root);
  return all
    .filter((node) => (node.selfTimeMs ?? node.totalCost ?? 0) > 0)
    .sort((a, b) => {
      const av = a.selfTimeMs ?? a.totalCost ?? 0;
      const bv = b.selfTimeMs ?? b.totalCost ?? 0;
      return bv - av;
    })
    .slice(0, n);
}

/** Cardinality skew — `|actual - estimated| / max(estimated, 1)`.
 * `>= 10` is the conventional planner-misled threshold. */
export function cardinalitySkew(node: PlanNode): number | undefined {
  if (node.actualRows === undefined) return undefined;
  return (
    Math.abs(node.actualRows - node.estimatedRows) /
    Math.max(node.estimatedRows, 1)
  );
}

/** Aggregate buffer stats across the whole plan tree. Postgres only;
 * returns `undefined` when no node carries buffer info. */
export function aggregateBuffers(root: PlanNode): BufferStats | undefined {
  const acc: BufferStats = {
    sharedHit: 0,
    sharedRead: 0,
    sharedDirtied: 0,
    sharedWritten: 0,
    localHit: 0,
    localRead: 0,
    hitRatio: 0,
  };
  let any = false;
  for (const n of flattenPlan(root)) {
    if (!n.buffers) continue;
    any = true;
    acc.sharedHit += n.buffers.sharedHit;
    acc.sharedRead += n.buffers.sharedRead;
    acc.sharedDirtied += n.buffers.sharedDirtied;
    acc.sharedWritten += n.buffers.sharedWritten;
    acc.localHit += n.buffers.localHit;
    acc.localRead += n.buffers.localRead;
  }
  if (!any) return undefined;
  const total = acc.sharedHit + acc.sharedRead;
  acc.hitRatio = total > 0 ? acc.sharedHit / total : 0;
  return acc;
}

/**
 * Total buffer pages this node touched, hits + reads. Used by the
 * flame view's "buffers" width-metric so big I/O nodes blow up
 * proportionally to how many pages they touched, not how long they
 * took.
 */
export function bufferTotalFor(node: PlanNode): number {
  if (!node.buffers) return 0;
  return node.buffers.sharedHit + node.buffers.sharedRead;
}

/**
 * Single-source "rows this node produced." Falls back to estimated
 * when the plan didn't execute (estimate-only EXPLAIN). The flame
 * view's rows-metric uses this so a plan-only render still has a
 * sensible width allocation (estimates are all we have to go on).
 */
export function actualOrEstimatedRows(node: PlanNode): number {
  return node.actualRows ?? node.estimatedRows;
}

/**
 * Color palette for plan nodes by NodeType. Goals:
 *
 *   1. **Red is reserved for danger.** The skew-overlay pattern
 *      uses `--destructive` to mean "the planner was wrong"; cells
 *      themselves never carry red just because they're an
 *      "aggregate" or "compute scalar" operator. The previous
 *      mapping made every Compute Scalar / Stream Aggregate look
 *      alarming via `--chart-5` (which is `--destructive` in dark
 *      mode), which trained the eye to ignore the *real* skew
 *      stripes when they appeared.
 *
 *   2. **Mode-stable.** OKLCH literals at L≈0.6-0.72, C≈0.05-0.16
 *      give us colours that are readable on both light and dark
 *      backgrounds without per-mode swapping (which the chart-N
 *      vars do, swapping hue in dark mode). The previous palette
 *      flipped Sort from violet (light) to yellow (dark), which
 *      meant cross-mode screenshots were unrecognisable.
 *
 *   3. **MSSQL coverage.** The old chain had a fallthrough to grey
 *      for `Nested Loops`, `Filter`, `Table Spool`,
 *      `Clustered Index Scan`, `Compute Scalar` — half the common
 *      MSSQL operators. The new chain maps every one we've seen
 *      in real plans.
 *
 * Hue groups:
 *   blue       → relation reads (Seq Scan, Table Scan, Clustered
 *                Index Scan, CTE Scan, Subquery, Values, Function)
 *   teal       → indexed reads (Index Scan, Index Seek, Index-Only,
 *                Bitmap Heap/Index Scan)
 *   green      → equi-joins that build a hash (Hash Join / Hash Match)
 *   moss       → sorted-input joins (Merge Join)
 *   purple     → row-by-row joins (Nested Loop / Nested Loops)
 *   amber      → ordering ops (Sort)
 *   orange     → grouping ops (Aggregate / Hash Aggregate / Stream
 *                Aggregate, Group, Window functions)
 *   slate      → bookkeeping (Filter, Compute Scalar, Projection)
 *   smoke-blue → memoisation (Materialize, Spool variants)
 *   sand       → row-flow control (Limit, Top, Append, Result, Union)
 *   default    → mid-grey, anything we haven't catalogued
 */
export function colorVarForNodeType(nodeType: string): string {
  const lower = nodeType.toLowerCase();

  // Indexed reads — teal.
  if (
    /(?:^|\s)(?:index\s+(?:scan|seek|only)|bitmap\s+(?:heap|index)\s+scan)/.test(
      lower,
    )
  )
    return "oklch(0.7 0.1 195)";

  // Sequential / heap / clustered-as-table reads — blue.
  if (
    /(?:^|\s)(?:seq\s+scan|table\s+scan|clustered\s+index\s+scan|tid\s+scan|sample\s+scan|heap\s+scan)/.test(
      lower,
    )
  )
    return "oklch(0.65 0.12 235)";

  // Synthetic / virtual reads — muted blue.
  if (
    /(?:cte\s+scan|subquery\s+scan|values\s+scan|function\s+scan|named\s+tuplestore|workfile)/.test(
      lower,
    )
  )
    return "oklch(0.66 0.08 225)";

  // Joins — split by family so two adjacent join types read
  // distinctly (huge for plan diffing).
  if (/hash\s+(?:join|match)/.test(lower)) return "oklch(0.66 0.13 150)"; // green
  if (/merge\s+join/.test(lower)) return "oklch(0.68 0.12 130)"; // moss
  if (/nested\s+loops?/.test(lower)) return "oklch(0.62 0.13 295)"; // purple

  // Ordering / grouping / windowing — amber & orange.
  if (/sort/.test(lower)) return "oklch(0.74 0.13 85)"; // amber
  if (/aggregate|grouping|partial\s+aggregate|group/.test(lower))
    return "oklch(0.7 0.14 55)"; // orange
  if (/window|sequence|cumulative/.test(lower)) return "oklch(0.72 0.13 65)"; // amber-orange

  // Set ops — sand.
  if (/append|union|intersect|except|concatenat|setop/.test(lower))
    return "oklch(0.74 0.09 90)";

  // Memoisation — smoke blue. Spool family is huge in MSSQL plans.
  if (/spool|materialize|memoize|recursive\s+union/.test(lower))
    return "oklch(0.66 0.04 235)";

  // Restriction / projection — slate. Bookkeeping ops; visually
  // recede so the eye lands on scans / joins / aggregates first.
  if (
    /^filter|compute\s+scalar|projection|gather|finalize|result(?!\s+set)|materialize/.test(
      lower,
    )
  )
    return "oklch(0.55 0.03 240)";

  // Row-flow control — sand.
  if (/limit|top\s|^top$|skip|page/.test(lower))
    return "oklch(0.72 0.08 75)";

  // Catch-all — neutral so unknown ops are obvious without
  // accidentally signalling "danger".
  return "oklch(0.55 0.04 240)";
}
