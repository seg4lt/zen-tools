/**
 * File-name ranking helpers ported from Flowstate's fff search.
 *
 * Two algorithms:
 *
 *   - `rankSubstring` — fast 5-tier bucket sort: exact basename →
 *     basename starts-with → path-segment prefix → basename contains →
 *     path contains.  This is the **default** mode and matches what
 *     the user gets when they type a few characters into the picker
 *     without flipping the fuzzy toggle.
 *
 *   - `rankFuzzy` — subsequence scorer with bonuses for word-boundary
 *     hits, consecutive runs, basename matches, and basename prefixes;
 *     gap penalty per skipped char.  Activated by the sparkles toggle
 *     in the file-picker header.
 *
 * Both return a sorted-and-capped list of paths (descending by quality).
 */

/** Maximum results we surface in the picker — tracks Flowstate. */
export const PICKER_RESULT_LIMIT = 200;

const BONUS_WORD_BOUNDARY = 30;
const BONUS_CONSECUTIVE_BASE = 16;
const BONUS_BASENAME_HIT = 8;
const BONUS_BASENAME_PREFIX = 40;
const PENALTY_GAP = 1;

/** Last `/`-segment of a path — basename, no extension stripping. */
function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** True for ASCII letters/digits — used to detect word boundaries. */
function isAlphanumeric(ch: string): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) // a-z
  );
}

/** Index *into `path`* where the basename starts. */
function basenameOffset(path: string): number {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? idx + 1 : 0;
}

/**
 * Score `query` against `path` using a subsequence match with the
 * bonuses described above.  Returns `null` when the query isn't a
 * subsequence of the path at all.
 */
export function fuzzyScore(query: string, path: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const baseStart = basenameOffset(p);
  const baseLower = p.slice(baseStart);
  const basePrefixHit = baseLower.startsWith(q);

  let score = 0;
  let qi = 0;
  let lastMatchIdx = -1;
  let consecutiveRun = 0;
  let hitsInBasename = 0;

  for (let i = 0; i < p.length && qi < q.length; i++) {
    if (p[i] !== q[qi]) {
      // gap penalty starts as soon as we've at least matched one char.
      if (lastMatchIdx >= 0) score -= PENALTY_GAP;
      continue;
    }
    qi++;

    // Word-boundary bonus: previous char isn't alphanumeric (or this
    // is the very first character of the path).
    const prev = i > 0 ? p[i - 1] : "";
    if (i === 0 || !isAlphanumeric(prev)) {
      score += BONUS_WORD_BOUNDARY;
    }

    // Basename bonus.
    if (i >= baseStart) {
      score += BONUS_BASENAME_HIT;
      hitsInBasename++;
    }

    // Consecutive-run bonus, doubling.
    if (i === lastMatchIdx + 1) {
      consecutiveRun = consecutiveRun === 0 ? 1 : consecutiveRun * 2;
      score += BONUS_CONSECUTIVE_BASE * consecutiveRun;
    } else {
      consecutiveRun = 0;
    }
    lastMatchIdx = i;
  }
  if (qi < q.length) return null; // query not a subsequence

  if (basePrefixHit) score += BONUS_BASENAME_PREFIX;
  // Slight tiebreaker so identical scores prefer the shorter path
  // (matches Flowstate's behaviour — produces stabler ordering).
  score -= path.length / 1000;
  // Boost matches that landed entirely in the basename a bit more
  // so `foo` beats a faraway `foo` deep in a path.
  score += hitsInBasename * 2;
  return score;
}

/** Rank `paths` against `query` using the fuzzy subsequence scorer. */
export function rankFuzzy(paths: string[], query: string): string[] {
  if (!query) return paths.slice(0, PICKER_RESULT_LIMIT);
  const scored: { path: string; score: number }[] = [];
  for (const p of paths) {
    const s = fuzzyScore(query, p);
    if (s !== null) scored.push({ path: p, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, PICKER_RESULT_LIMIT).map((x) => x.path);
}

/**
 * Rank `paths` against `query` using a 5-tier substring bucket sort.
 *
 * Buckets (highest → lowest priority):
 *   1. Exact basename match (case-insensitive)
 *   2. Basename starts-with
 *   3. Any path-segment prefix
 *   4. Basename contains
 *   5. Full-path contains
 */
export function rankSubstring(paths: string[], query: string): string[] {
  if (!query) return paths.slice(0, PICKER_RESULT_LIMIT);
  const q = query.toLowerCase();
  const tier1: string[] = [];
  const tier2: string[] = [];
  const tier3: string[] = [];
  const tier4: string[] = [];
  const tier5: string[] = [];

  for (const path of paths) {
    const lower = path.toLowerCase();
    const base = basename(lower);
    if (base === q) {
      tier1.push(path);
      continue;
    }
    if (base.startsWith(q)) {
      tier2.push(path);
      continue;
    }
    let segmentHit = false;
    for (const seg of lower.split("/")) {
      if (seg.startsWith(q) && seg !== base) {
        segmentHit = true;
        break;
      }
    }
    if (segmentHit) {
      tier3.push(path);
      continue;
    }
    if (base.includes(q)) {
      tier4.push(path);
      continue;
    }
    if (lower.includes(q)) {
      tier5.push(path);
      continue;
    }
  }

  const sortByPath = (a: string, b: string) =>
    a.length - b.length || a.localeCompare(b);
  tier1.sort(sortByPath);
  tier2.sort(sortByPath);
  tier3.sort(sortByPath);
  tier4.sort(sortByPath);
  tier5.sort(sortByPath);

  return [...tier1, ...tier2, ...tier3, ...tier4, ...tier5].slice(
    0,
    PICKER_RESULT_LIMIT,
  );
}
