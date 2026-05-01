/**
 * SQL statement splitter — frontend mirror of the backend's
 * `split_statements` (see `src-tauri/src/commands/database.rs`). We need
 * the offsets here too so we can find the statement that contains the
 * cursor and run only that one (DataGrip-style).
 *
 * Respects:
 *   - `'…'` and `"…"` string literals (incl. `''` escaped quotes)
 *   - `-- …` line comments
 *   - `/* … *\/` block comments
 */

export interface SqlStatement {
  /** Trimmed SQL ready to execute. */
  sql: string;
  /** Inclusive start offset in the original buffer (after trim). */
  from: number;
  /** Exclusive end offset in the original buffer (after trim). */
  to: number;
}

export function splitStatements(input: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  let stmtStart = 0; // offset of the first char of the current statement
  let i = 0;

  const flush = (end: number) => {
    const raw = input.slice(stmtStart, end);
    const trimmedStart = stmtStart + (raw.length - raw.trimStart().length);
    const trimmedEnd = stmtStart + raw.trimEnd().length;
    if (trimmedEnd > trimmedStart) {
      out.push({
        sql: input.slice(trimmedStart, trimmedEnd),
        from: trimmedStart,
        to: trimmedEnd,
      });
    }
  };

  while (i < input.length) {
    const c = input[i];
    const next = i + 1 < input.length ? input[i + 1] : "";

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
          // Escaped quote; advance past both.
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
    if (c === ";") {
      flush(i); // statement does NOT include the trailing ;
      stmtStart = i + 1;
      i += 1;
      continue;
    }

    i += 1;
  }

  // Trailing statement without a closing `;`.
  flush(input.length);
  return out;
}

/**
 * Return the statement that contains `cursor` (an offset into `input`).
 * Returns `null` when the cursor is between statements (e.g. on a
 * blank line or right on a `;`).
 */
export function statementAtCursor(
  input: string,
  cursor: number,
): SqlStatement | null {
  const stmts = splitStatements(input);
  // Use `<=` for `to` so a cursor parked right after a statement still
  // matches that statement (typical case: cursor on its own line below).
  for (const s of stmts) {
    if (cursor >= s.from && cursor <= s.to) return s;
  }
  // Fallback: last statement before the cursor (handy when cursor is
  // on whitespace after the final statement).
  for (let idx = stmts.length - 1; idx >= 0; idx--) {
    if (stmts[idx].from <= cursor) return stmts[idx];
  }
  return null;
}
