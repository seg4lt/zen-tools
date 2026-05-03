/**
 * `:name` placeholder support for the SQL editor.
 *
 * The editor lets users write reusable queries with named placeholders
 * (DataGrip-style):
 *
 *   SELECT * FROM users WHERE id = :id AND name = :name
 *
 * On run, we scan the buffer, prompt the user for each unique `:name`
 * via a dialog, then substitute the values verbatim before sending the
 * SQL to the backend. The user types their own quoting (`'aman'` for a
 * string, `42` for a number) — there is no type inference.
 *
 * Both the scan and the substitute pass walk the input character-by-
 * character so we can skip:
 *   - `'…'` and `"…"` string literals (with `''` escape support)
 *   - `-- …` line comments
 *   - `/* … *\/` block comments
 *
 * This mirrors `lib/sql-statements.ts`'s splitter, which is the
 * project's standard pattern for SQL-aware string walking. We don't
 * import its splitter directly because it tokenises at statement
 * granularity (`;`); we need token granularity (`:name`).
 *
 * Postgres `value::text` casts must NOT be detected as placeholders.
 * The walker only starts a placeholder match on a `:` whose previous
 * character is not another `:`.
 */

export interface PlaceholderOccurrence {
  /** Identifier without the leading `:`. */
  name: string;
  /** Inclusive offset of the leading `:` in the source string. */
  from: number;
  /** Exclusive offset right after the last name character. */
  to: number;
}

const NAME_HEAD = /[A-Za-z_]/;
const NAME_TAIL = /[A-Za-z0-9_]/;

/**
 * Scan `sql` and return every `:name` occurrence with its source
 * offsets. Skips string literals and SQL comments. Postgres `::cast`
 * operators are ignored (the second `:` of `::` cannot start a
 * placeholder because its predecessor is `:`).
 *
 * Used by:
 *   - the editor decoration to italicise placeholder tokens.
 *   - the run path (via `uniqueNames`) to know which inputs to ask
 *     the user for.
 */
export function extractPlaceholders(sql: string): PlaceholderOccurrence[] {
  const out: PlaceholderOccurrence[] = [];
  const len = sql.length;

  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  let i = 0;
  while (i < len) {
    const c = sql[i];
    const next = i + 1 < len ? sql[i + 1] : "";

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inSingle) {
      if (c === "'") {
        if (next === "'") {
          // Doubled-up `''` — escaped single quote, stay in string.
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i += 1;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      i += 1;
      continue;
    }

    if (c === "-" && next === "-") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      i += 1;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      i += 1;
      continue;
    }

    if (c === ":") {
      // Skip `::` casts — second colon's predecessor is `:`. We also
      // skip the lead `:` if its NEXT char is `:` (so `::text` never
      // even tries to match).
      const prev = i > 0 ? sql[i - 1] : "";
      if (prev === ":" || next === ":") {
        i += 1;
        continue;
      }
      if (next && NAME_HEAD.test(next)) {
        const start = i;
        let j = i + 2;
        while (j < len && NAME_TAIL.test(sql[j])) j += 1;
        out.push({
          name: sql.slice(start + 1, j),
          from: start,
          to: j,
        });
        i = j;
        continue;
      }
    }

    i += 1;
  }

  return out;
}

/**
 * Deduplicate occurrences to a list of unique names in
 * first-appearance order. Drives the dialog's input list.
 */
export function uniqueNames(occurrences: PlaceholderOccurrence[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of occurrences) {
    if (!seen.has(o.name)) {
      seen.add(o.name);
      out.push(o.name);
    }
  }
  return out;
}

/**
 * Replace every `:name` token in `sql` with its value from `values`,
 * verbatim. Skips string literals and comments — placeholders inside
 * them are NOT touched.
 *
 * Throws when the body contains a `:name` whose `name` has no entry
 * in `values`. Empty-string values are allowed (they serialise to an
 * empty literal, which is sometimes what the user wants).
 */
export function substitutePlaceholders(
  sql: string,
  values: Record<string, string>,
): string {
  const occurrences = extractPlaceholders(sql);
  if (occurrences.length === 0) return sql;

  // Walk occurrences in reverse so earlier offsets stay valid as we
  // splice in replacements that may differ in length from the
  // original `:name` token.
  let out = sql;
  for (let idx = occurrences.length - 1; idx >= 0; idx--) {
    const occ = occurrences[idx];
    if (!Object.prototype.hasOwnProperty.call(values, occ.name)) {
      throw new Error(
        `Missing value for placeholder \`:${occ.name}\` at offset ${occ.from}`,
      );
    }
    out = out.slice(0, occ.from) + values[occ.name] + out.slice(occ.to);
  }
  return out;
}
