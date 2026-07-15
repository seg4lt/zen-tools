/** Match a repo-relative path against a shell-style file glob. */
export function matchesFileGlob(path: string, glob: string): boolean {
  const pattern = glob.trim().replaceAll("\\", "/");
  if (!pattern) return false;
  return new RegExp(`^${globSource(pattern)}$`).test(path.replaceAll("\\", "/"));
}

function globSource(pattern: string): string {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += /[\\^$+?.()|{}\[\]]/.test(char) ? `\\${char}` : char;
    }
  }
  return source;
}
