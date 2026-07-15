/**
 * Case-insensitive picker search with shell-style wildcards.
 *
 * Plain text matches anywhere. `*` matches any number of characters and
 * `?` matches exactly one character, so both `tools` and `*tools*` find
 * `openai/zen-tools`, while `zen-?ools` also matches `zen-tools`.
 */
export function matchesWildcardSearch(value: string, query: string): boolean {
  const pattern = query.trim();
  if (!pattern) return true;

  let source = ".*";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += escapeRegexCharacter(char);
  }
  source += ".*";

  return new RegExp(`^${source}$`, "i").test(value);
}

function escapeRegexCharacter(char: string): string {
  return /[\\^$+?.()|{}\[\]]/.test(char) ? `\\${char}` : char;
}
