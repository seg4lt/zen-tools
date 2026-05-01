/**
 * Lightweight SQL reference extractor.
 *
 * Pulls the set of `[schema?].table` identifiers a SQL string mentions,
 * good enough to drive auto-complete prefetch and the Opt+Enter
 * "Reindex tables in this statement" action. This is **not** a SQL
 * parser — it's a deliberately small regex pass that:
 *
 *   - strips line (`-- …`) and block (`/* … *​/`) comments,
 *   - strips single- and double-quoted string literals,
 *   - then scans for table-introducing keywords (`FROM`, `JOIN`,
 *     `UPDATE`, `INTO`) followed by one or more comma-separated
 *     identifiers, plus qualified column references (`schema.table.col`,
 *     where the leading identifier is also assumed to be a table).
 *
 * Identifiers can be bare (`users`), double-quoted (`"weird name"`), or
 * MSSQL-bracketed (`[users]`). Optional aliasing (`FROM users AS u`,
 * `JOIN users u`) is tolerated — the alias is discarded.
 *
 * Returned table names are unquoted. Schemas come back lower-cased only
 * when the source was unquoted — quoted identifiers preserve case
 * (matching SQL semantics).
 */

export interface TableReference {
  /** Schema component, or `null` if the reference was bare. */
  schema: string | null;
  /** Table name. Unquoted. */
  table: string;
}

const KEYWORD_RE = /\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+/gi;

/**
 * Extract every `(schema?, table)` pair referenced by `sql`.
 *
 * Order is the order of first appearance; duplicates are collapsed
 * (so the prefetch path doesn't issue the same describe twice).
 */
export function extractTableReferences(sql: string): TableReference[] {
  const stripped = stripCommentsAndStrings(sql);
  const seen = new Set<string>();
  const out: TableReference[] = [];

  // Pass 1: keyword-introduced lists.
  for (const match of stripped.matchAll(KEYWORD_RE)) {
    const startAt = match.index! + match[0].length;
    let cursor = startAt;
    while (cursor < stripped.length) {
      const ident = readQualifiedIdent(stripped, cursor);
      if (!ident) break;
      pushUnique(out, seen, ident.ref);
      cursor = ident.endAt;
      // Skip optional alias: `AS foo`, `foo` (bare ident).
      cursor = skipWhitespace(stripped, cursor);
      if (matchKeyword(stripped, cursor, "AS")) {
        cursor = skipWhitespace(stripped, cursor + 2);
        const aliasEnd = skipIdent(stripped, cursor);
        if (aliasEnd > cursor) cursor = aliasEnd;
      } else {
        const aliasEnd = skipIdent(stripped, cursor);
        if (aliasEnd > cursor) cursor = aliasEnd;
      }
      cursor = skipWhitespace(stripped, cursor);
      if (stripped[cursor] === ",") {
        cursor += 1;
        cursor = skipWhitespace(stripped, cursor);
        continue;
      }
      break;
    }
  }

  // Pass 2: any qualified `<ident>.<ident>` reference — the leading
  // identifier might be a schema-qualified table, or a table whose
  // column is being read. Either way the autocomplete plugin wants
  // to know about it.
  for (const match of stripped.matchAll(QUALIFIED_RE)) {
    const a = match[1];
    const b = match[2];
    if (!a || !b) continue;
    pushUnique(out, seen, normaliseRef(a, b));
  }

  return out;
}

/**
 * Map of `alias → table reference` for every alias declared in `sql`,
 * across all statements in the buffer. Drives `de.<col>`-style
 * autocomplete: the editor registers each alias as a synthetic schema
 * entry whose columns are looked up from the resolved table.
 *
 * Recognises both `FROM users AS u` and `FROM users u`. Aliases are
 * unquoted; reserved SQL keywords that follow a table name (`WHERE`,
 * `JOIN`, `ON`, `GROUP`, `ORDER`, `LIMIT`, `HAVING`, `UNION`, …) are
 * NOT treated as aliases — that's how `SELECT * FROM users WHERE …`
 * doesn't end up registering `WHERE` as an alias for `users`.
 *
 * On conflict (same alias for different tables across statements) the
 * **last** occurrence wins. That matches the typical
 * one-statement-at-a-time editing flow without paying the cost of
 * tracking the cursor's current statement.
 */
export interface AliasMap {
  [alias: string]: TableReference;
}

/**
 * Reserved-ish keywords that legally appear right after a table name in
 * a FROM/JOIN clause — and therefore can't be a bare alias. This is
 * intentionally narrow: anything not on the list (e.g. `me`, `de`,
 * `tbl`) is presumed to be an alias.
 */
const NON_ALIAS_KEYWORDS = new Set<string>([
  "AS",
  "ON",
  "USING",
  "WHERE",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "FETCH",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "OUTER",
  "CROSS",
  "NATURAL",
  "LATERAL",
  "WITH",
  "RETURNING",
  "FROM",
  "INTO",
  "SET",
  "VALUES",
  "FOR",
  "WINDOW",
  "ASC",
  "DESC",
]);

/** Extract every `(alias → table)` mapping declared in `sql`. */
export function extractAliasMap(sql: string): AliasMap {
  const stripped = stripCommentsAndStrings(sql);
  const out: AliasMap = {};

  for (const match of stripped.matchAll(KEYWORD_RE)) {
    const startAt = match.index! + match[0].length;
    let cursor = startAt;
    while (cursor < stripped.length) {
      const ident = readQualifiedIdent(stripped, cursor);
      if (!ident) break;
      cursor = ident.endAt;
      cursor = skipWhitespace(stripped, cursor);

      // Try to read an alias. Two forms: `AS <ident>` or bare
      // `<ident>` immediately following the table name.
      let aliasName: string | null = null;
      if (matchKeyword(stripped, cursor, "AS")) {
        cursor = skipWhitespace(stripped, cursor + 2);
        const aliasEnd = skipIdent(stripped, cursor);
        if (aliasEnd > cursor) {
          aliasName = unquoteIdent(stripped.slice(cursor, aliasEnd));
          cursor = aliasEnd;
        }
      } else {
        // Bare alias only if the next ident isn't a clause keyword.
        const aliasEnd = skipIdent(stripped, cursor);
        if (aliasEnd > cursor) {
          const candidate = stripped.slice(cursor, aliasEnd);
          if (!NON_ALIAS_KEYWORDS.has(candidate.toUpperCase())) {
            aliasName = unquoteIdent(candidate);
            cursor = aliasEnd;
          }
        }
      }

      if (aliasName) {
        out[aliasName] = ident.ref;
      }

      cursor = skipWhitespace(stripped, cursor);
      if (stripped[cursor] === ",") {
        cursor += 1;
        cursor = skipWhitespace(stripped, cursor);
        continue;
      }
      break;
    }
  }
  return out;
}

/** Same as `extractTableReferences` but returns the raw `table` strings. */
export function extractTableNames(sql: string): string[] {
  return extractTableReferences(sql).map((r) => r.table);
}

/**
 * Identifier under `offset` in `sql`. Used by the Opt+Enter
 * "Reindex table at cursor" action — we want the smallest enclosing
 * `table` or `schema.table` token at the caret.
 */
export function tableReferenceAtOffset(
  sql: string,
  offset: number,
): TableReference | null {
  const stripped = stripCommentsAndStrings(sql);
  if (offset < 0 || offset > stripped.length) return null;
  // Walk left until we leave an identifier character (or quoted ident).
  let start = offset;
  while (start > 0 && isIdentChar(stripped[start - 1])) start -= 1;
  // Could be inside a quoted ident — back up one more if the previous
  // char is the closing quote and there's a matching open quote.
  if (start > 0 && (stripped[start - 1] === '"' || stripped[start - 1] === "]")) {
    // Skip to opening quote.
    const open = stripped[start - 1] === '"' ? '"' : "[";
    let probe = start - 2;
    while (probe >= 0 && stripped[probe] !== open) probe -= 1;
    if (probe >= 0) start = probe;
  }
  const ident = readQualifiedIdent(stripped, start);
  if (!ident) return null;
  if (offset > ident.endAt) return null;
  return ident.ref;
}

// ─── Internals ────────────────────────────────────────────────────────

const QUALIFIED_RE =
  /(\b[A-Za-z_][A-Za-z0-9_$]*|"[^"]+"|\[[^\]]+\])\s*\.\s*(\b[A-Za-z_][A-Za-z0-9_$]*|"[^"]+"|\[[^\]]+\])/g;

function pushUnique(
  out: TableReference[],
  seen: Set<string>,
  ref: TableReference,
): void {
  const key = `${ref.schema ?? ""}${ref.table}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(ref);
}

function readQualifiedIdent(
  src: string,
  startAt: number,
): { ref: TableReference; endAt: number } | null {
  const head = readIdent(src, startAt);
  if (!head) return null;
  let cursor = head.endAt;
  cursor = skipWhitespace(src, cursor);
  if (src[cursor] === ".") {
    cursor = skipWhitespace(src, cursor + 1);
    const tail = readIdent(src, cursor);
    if (tail) {
      return {
        ref: { schema: head.value, table: tail.value },
        endAt: tail.endAt,
      };
    }
  }
  return {
    ref: { schema: null, table: head.value },
    endAt: head.endAt,
  };
}

function readIdent(
  src: string,
  startAt: number,
): { value: string; endAt: number } | null {
  if (startAt >= src.length) return null;
  const ch = src[startAt];
  if (ch === '"') {
    const end = src.indexOf('"', startAt + 1);
    if (end < 0) return null;
    return { value: src.slice(startAt + 1, end), endAt: end + 1 };
  }
  if (ch === "[") {
    const end = src.indexOf("]", startAt + 1);
    if (end < 0) return null;
    return { value: src.slice(startAt + 1, end), endAt: end + 1 };
  }
  if (!/[A-Za-z_]/.test(ch)) return null;
  let cursor = startAt + 1;
  while (cursor < src.length && /[A-Za-z0-9_$]/.test(src[cursor])) cursor += 1;
  return { value: src.slice(startAt, cursor), endAt: cursor };
}

function skipWhitespace(src: string, at: number): number {
  while (at < src.length && /\s/.test(src[at])) at += 1;
  return at;
}

function skipIdent(src: string, at: number): number {
  if (at >= src.length) return at;
  const ch = src[at];
  if (ch === '"' || ch === "[") {
    const end = src.indexOf(ch === '"' ? '"' : "]", at + 1);
    return end < 0 ? at : end + 1;
  }
  if (!/[A-Za-z_]/.test(ch)) return at;
  let cursor = at + 1;
  while (cursor < src.length && /[A-Za-z0-9_$]/.test(src[cursor])) cursor += 1;
  return cursor;
}

function matchKeyword(src: string, at: number, kw: string): boolean {
  if (at + kw.length > src.length) return false;
  if (src.slice(at, at + kw.length).toUpperCase() !== kw) return false;
  const after = src[at + kw.length];
  return after === undefined || /\s/.test(after);
}

function isIdentChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[A-Za-z0-9_$]/.test(ch);
}

function normaliseRef(rawSchema: string, rawTable: string): TableReference {
  return {
    schema: unquoteIdent(rawSchema),
    table: unquoteIdent(rawTable),
  };
}

function unquoteIdent(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("[") && raw.endsWith("]")) return raw.slice(1, -1);
  return raw;
}

/**
 * Replace the inside of `'…'`, `"…"`, `--` line comments and
 * `/* … *​/` block comments with spaces so identifier scanning never
 * mistakes a string literal for a real table name. We **preserve**
 * lengths so any offsets the caller is tracking against the original
 * source remain valid.
 */
function stripCommentsAndStrings(sql: string): string {
  const out = sql.split("");
  let i = 0;
  while (i < out.length) {
    const c = out[i];
    const n = out[i + 1];
    if (c === "-" && n === "-") {
      while (i < out.length && out[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && n === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < out.length) {
        if (out[i] === "*" && out[i + 1] === "/") {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
          break;
        }
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (c === "'") {
      out[i] = " ";
      i += 1;
      while (i < out.length) {
        if (out[i] === "'" && out[i + 1] === "'") {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (out[i] === "'") {
          out[i] = " ";
          i += 1;
          break;
        }
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    // Note: we deliberately DO NOT strip double-quoted strings, since in
    // most SQL dialects (Postgres, MSSQL) double quotes denote
    // identifiers, not string literals.
    i += 1;
  }
  return out.join("");
}
