/**
 * Database-tree search.
 *
 * Parses a small query DSL and walks the cached schema state to
 * decide which nodes in the tree should remain visible. The DSL is
 * deliberately tiny — anything fancier and the input box becomes a
 * SQL editor:
 *
 *   `name`              — substring match against any node name.
 *   `name*`             — prefix match (anchored).
 *   `*tail`             — suffix match (anchored).
 *   `head*tail`         — glob; `*` is the only wildcard.
 *   `kind > query`      — restrict to one node kind:
 *
 *       table > name
 *       column > name
 *       fk > name
 *       key > name           (PRIMARY + UNIQUE under "Keys")
 *       index > name
 *       check > name
 *       trigger > name
 *       proc > name          (stored procedures only)
 *       fn > name            (functions only)
 *       routine > name       (either kind)
 *       schema > name
 *
 * `>` is the separator. Leading/trailing whitespace is ignored.
 * Common short forms are accepted (`procs`, `functions`, `fks`, …).
 *
 * Without `*` the pattern matches as a substring (case-insensitive).
 * With at least one `*` the pattern is anchored at both ends — so
 * `users*` matches `users_archive` but not `archive_users`. This
 * mirrors how shell globs feel: `*` only opens up explicitly.
 */

import type {
  DbColumnDescription,
  DbCheckDescription,
  DbForeignKeyDescription,
  DbIndexDescription,
  DbKeyDescription,
  DbRoutineDescription,
  DbTableDescription,
  DbTriggerDescription,
} from "./tauri";

export type SearchKind =
  | "any"
  | "schema"
  | "table"
  | "column"
  | "key"
  | "fk"
  | "index"
  | "check"
  | "trigger"
  | "proc"
  | "fn"
  | "routine";

export type TableSubfolder =
  | "columns"
  | "keys"
  | "fks"
  | "indexes"
  | "checks"
  | "triggers";

export interface ParsedQuery {
  kind: SearchKind;
  pattern: RegExp;
  /** The raw user input — kept for the placeholder / debug. */
  raw: string;
}

/** Empty-input → no filter. Callers should treat `null` as "show
 * everything, no expansion forced". */
export function parseQuery(input: string): ParsedQuery | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let kind: SearchKind = "any";
  let pattern = trimmed;

  const arrow = trimmed.indexOf(">");
  if (arrow > 0) {
    const lhs = trimmed.slice(0, arrow).trim().toLowerCase();
    const rhs = trimmed.slice(arrow + 1).trim();
    const mapped = mapKind(lhs);
    if (mapped) {
      kind = mapped;
      pattern = rhs;
    }
  }
  if (!pattern) return null;

  return {
    kind,
    pattern: globToRegExp(pattern),
    raw: trimmed,
  };
}

/** Maps a kind keyword (case-insensitive) to a `SearchKind`.
 * Returns `null` if the keyword isn't recognised — the caller then
 * treats the whole string (including the `>`) as a substring match,
 * which is the friendlier failure mode. */
function mapKind(s: string): SearchKind | null {
  switch (s) {
    case "schema":
    case "schemas":
      return "schema";
    case "table":
    case "tables":
    case "tbl":
      return "table";
    case "column":
    case "columns":
    case "col":
    case "cols":
      return "column";
    case "key":
    case "keys":
    case "pk":
    case "uk":
      return "key";
    case "fk":
    case "fks":
    case "foreign key":
    case "foreign keys":
      return "fk";
    case "index":
    case "indexes":
    case "indices":
    case "idx":
      return "index";
    case "check":
    case "checks":
      return "check";
    case "trigger":
    case "triggers":
    case "trg":
      return "trigger";
    case "proc":
    case "procs":
    case "procedure":
    case "procedures":
    case "sp":
      return "proc";
    case "fn":
    case "func":
    case "function":
    case "functions":
      return "fn";
    case "routine":
    case "routines":
      return "routine";
    default:
      return null;
  }
}

function globToRegExp(glob: string): RegExp {
  // Escape regex specials EXCEPT `*`.
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const re = escaped.replace(/\*/g, ".*");
  // Anchored if the user used a `*`; substring match otherwise. Same
  // distinction shells make: `*foo*` opts in, plain `foo` is "anywhere".
  if (glob.includes("*")) {
    return new RegExp("^" + re + "$", "i");
  }
  return new RegExp(re, "i");
}

// ─── Evaluator ───────────────────────────────────────────────────────

export interface SearchSnapshot {
  /** Connection-scoped schemas, indexed by database name. */
  schemasByDb: Record<string, string[]>;
  /** Tables indexed by `<database>/<schema>`. */
  tablesBySchema: Record<string, string[]>;
  /** Routines indexed by `<database>/<schema>`. */
  routinesBySchema: Record<string, DbRoutineDescription[]>;
  /** Every cached `TableDescription` for this connection (any
   * schema). The mirror in `schema-cache.ts` already holds these
   * keyed by table — we just feed them in. */
  cachedTables: DbTableDescription[];
}

export interface SearchResult {
  /** True iff a non-empty query is active. When `false`, callers
   * should render the tree unfiltered. */
  active: boolean;
  /** `<database>` */
  visibleDatabases: Set<string>;
  /** `<database>/<schema>` */
  visibleSchemas: Set<string>;
  /** `<database>/<schema>/<table>` */
  visibleTables: Set<string>;
  /** `<database>/<schema>/<routine>` */
  visibleRoutines: Set<string>;
  /** Tables that should render WITHOUT child filtering — the table's
   * own name was a direct match, or its parent schema matched. */
  fullExpandTables: Set<string>;
  /** Schemas that should render WITHOUT child filtering. */
  fullExpandSchemas: Set<string>;
  /** Sub-folders under each table that contain at least one visible
   * leaf. Keyed by `<db>/<schema>/<table>`. */
  tableSubfolderVisible: Map<string, Set<TableSubfolder>>;
  /** `<db>/<schema>/<table>/<column-name>` */
  visibleColumns: Set<string>;
  visibleKeys: Set<string>;
  visibleFks: Set<string>;
  visibleIndexes: Set<string>;
  visibleChecks: Set<string>;
  visibleTriggers: Set<string>;
  /** Total leaf-level matches (used for the "N matches" hint in the
   * search box). */
  totalMatches: number;
}

const EMPTY_RESULT: SearchResult = {
  active: false,
  visibleDatabases: new Set(),
  visibleSchemas: new Set(),
  visibleTables: new Set(),
  visibleRoutines: new Set(),
  fullExpandTables: new Set(),
  fullExpandSchemas: new Set(),
  tableSubfolderVisible: new Map(),
  visibleColumns: new Set(),
  visibleKeys: new Set(),
  visibleFks: new Set(),
  visibleIndexes: new Set(),
  visibleChecks: new Set(),
  visibleTriggers: new Set(),
  totalMatches: 0,
};

/** Snapshot-time inactive sentinel. Components check `result.active`
 * to skip the visible-set checks entirely. */
export function emptyResult(): SearchResult {
  return EMPTY_RESULT;
}

export function evaluateQuery(
  query: ParsedQuery | null,
  snapshot: SearchSnapshot,
): SearchResult {
  if (!query) return EMPTY_RESULT;

  const r: SearchResult = {
    active: true,
    visibleDatabases: new Set(),
    visibleSchemas: new Set(),
    visibleTables: new Set(),
    visibleRoutines: new Set(),
    fullExpandTables: new Set(),
    fullExpandSchemas: new Set(),
    tableSubfolderVisible: new Map(),
    visibleColumns: new Set(),
    visibleKeys: new Set(),
    visibleFks: new Set(),
    visibleIndexes: new Set(),
    visibleChecks: new Set(),
    visibleTriggers: new Set(),
    totalMatches: 0,
  };

  const allow = (k: SearchKind) => query.kind === "any" || query.kind === k;
  const test = (s: string) => query.pattern.test(s);

  // Index cached descriptions by `<db>/<schema>/<table>` for O(1)
  // lookup when iterating the tree below.
  const cachedByKey = new Map<string, DbTableDescription>();
  for (const desc of snapshot.cachedTables) {
    cachedByKey.set(`${desc.database}/${desc.schema}/${desc.name}`, desc);
  }

  // Iterate every (db, schema) we know about. The set comes from
  // `schemasByDb` so a schema with no tables/routines still gets a
  // chance to match its own name.
  for (const [db, schemas] of Object.entries(snapshot.schemasByDb)) {
    for (const schema of schemas) {
      const schemaId = `${db}/${schema}`;
      const schemaSelfMatch = allow("schema") && test(schema);

      const tableNames = snapshot.tablesBySchema[schemaId] ?? [];
      const routines = snapshot.routinesBySchema[schemaId] ?? [];

      let schemaHasChildHits = false;

      // ── Tables ────────────────────────────────────────────────────
      for (const tableName of tableNames) {
        const tableId = `${schemaId}/${tableName}`;
        const tableSelfMatch = allow("table") && test(tableName);
        const tableFullExpand = tableSelfMatch || schemaSelfMatch;

        const desc = cachedByKey.get(tableId);
        let tableSubHits: Set<TableSubfolder> | null = null;
        let leafHits = 0;

        // Helper closure to record a leaf match under one subfolder.
        const noteLeaf = (
          sub: TableSubfolder,
          set: Set<string>,
          name: string,
        ) => {
          set.add(`${tableId}/${name}`);
          if (!tableSubHits) tableSubHits = new Set();
          tableSubHits.add(sub);
          leafHits += 1;
          r.totalMatches += 1;
        };

        if (desc) {
          // Columns
          if (tableFullExpand) {
            // fullExpand: every leaf is visible. We still record into
            // the visible-* sets so leaf renderers have a single
            // predicate to check.
            for (const c of desc.columns) {
              r.visibleColumns.add(`${tableId}/${c.name}`);
            }
            for (const k of desc.keys) {
              r.visibleKeys.add(`${tableId}/${k.name}`);
            }
            for (const fk of desc.foreignKeys) {
              r.visibleFks.add(`${tableId}/${fk.name}`);
            }
            for (const ix of desc.indexes) {
              r.visibleIndexes.add(`${tableId}/${ix.name}`);
            }
            for (const ch of desc.checks) {
              r.visibleChecks.add(`${tableId}/${ch.name}`);
            }
            for (const tr of desc.triggers) {
              r.visibleTriggers.add(`${tableId}/${tr.name}`);
            }
          } else {
            // Filtered descent — only matching leaves bubble up.
            for (const c of desc.columns as DbColumnDescription[]) {
              if (allow("column") && test(c.name)) {
                noteLeaf("columns", r.visibleColumns, c.name);
              }
            }
            for (const k of desc.keys as DbKeyDescription[]) {
              if (allow("key") && test(k.name)) {
                noteLeaf("keys", r.visibleKeys, k.name);
              }
            }
            for (const fk of desc.foreignKeys as DbForeignKeyDescription[]) {
              if (allow("fk") && test(fk.name)) {
                noteLeaf("fks", r.visibleFks, fk.name);
              }
            }
            for (const ix of desc.indexes as DbIndexDescription[]) {
              if (allow("index") && test(ix.name)) {
                noteLeaf("indexes", r.visibleIndexes, ix.name);
              }
            }
            for (const ch of desc.checks as DbCheckDescription[]) {
              if (allow("check") && test(ch.name)) {
                noteLeaf("checks", r.visibleChecks, ch.name);
              }
            }
            for (const tr of desc.triggers as DbTriggerDescription[]) {
              if (allow("trigger") && test(tr.name)) {
                noteLeaf("triggers", r.visibleTriggers, tr.name);
              }
            }
          }
        }

        const tableHits = tableFullExpand || leafHits > 0;
        if (tableHits) {
          r.visibleTables.add(tableId);
          if (tableFullExpand) {
            r.fullExpandTables.add(tableId);
            r.totalMatches += tableSelfMatch ? 1 : 0;
          }
          if (tableSubHits) {
            r.tableSubfolderVisible.set(tableId, tableSubHits);
          }
          schemaHasChildHits = true;
        }
      }

      // ── Routines ──────────────────────────────────────────────────
      for (const routine of routines as DbRoutineDescription[]) {
        const routineId = `${schemaId}/${routine.name}`;
        const kindAllowed =
          query.kind === "any" ||
          query.kind === "routine" ||
          (query.kind === "fn" && routine.kind === "function") ||
          (query.kind === "proc" && routine.kind === "procedure");
        const routineSelfMatch = kindAllowed && test(routine.name);
        if (routineSelfMatch || schemaSelfMatch) {
          r.visibleRoutines.add(routineId);
          if (routineSelfMatch) r.totalMatches += 1;
          schemaHasChildHits = true;
        }
      }

      // ── Roll up to schema / database visibility ───────────────────
      if (schemaSelfMatch) {
        r.fullExpandSchemas.add(schemaId);
        r.visibleSchemas.add(schemaId);
        r.visibleDatabases.add(db);
        r.totalMatches += 1;
        // fullExpand every contained table (counts already attributed
        // above where we did the leaf-add).
        for (const tableName of tableNames) {
          r.visibleTables.add(`${schemaId}/${tableName}`);
        }
        for (const routine of routines as DbRoutineDescription[]) {
          r.visibleRoutines.add(`${schemaId}/${routine.name}`);
        }
      } else if (schemaHasChildHits) {
        r.visibleSchemas.add(schemaId);
        r.visibleDatabases.add(db);
      }
    }
  }

  return r;
}
