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
    const logicalOp = el.getAttribute("LogicalOp");
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
      details: collectAttrs(el, { logicalOp }),
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

/** Color palette for plan nodes by NodeType, mapped to the same
 * `--chart-N` CSS variables the http-runner perf dashboard uses
 * so the flame view honours light/dark mode automatically. */
export function colorVarForNodeType(nodeType: string): string {
  const lower = nodeType.toLowerCase();
  if (lower.includes("index") && lower.includes("scan")) return "var(--chart-2)";
  if (lower.includes("seq") || lower.includes("scan")) return "var(--chart-1)";
  if (lower.includes("join") || lower.includes("hash") || lower.includes("merge"))
    return "var(--chart-3)";
  if (lower.includes("sort")) return "var(--chart-4)";
  if (
    lower.includes("aggregate") ||
    lower.includes("group") ||
    lower.includes("compute")
  )
    return "var(--chart-5)";
  if (lower.includes("limit") || lower.includes("cte") || lower.includes("subquery"))
    return "var(--chart-2)";
  return "var(--muted-foreground)";
}
