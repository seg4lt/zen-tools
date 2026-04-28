/**
 * Tiny DSL for declaring keybindings as strings: `"mod+e"`, `"mod+shift+/"`,
 * `"mod+1"` etc.
 */

import type { KeyChord } from "./platform";

/** Parse a DSL string into a KeyChord. Throws on malformed input. */
export function parseChord(input: string): KeyChord {
  const segments = input.toLowerCase().split("+").map((s) => s.trim());
  const chord: KeyChord = { key: "" };
  for (const seg of segments) {
    if (seg === "mod") chord.mod = true;
    else if (seg === "shift") chord.shift = true;
    else if (seg === "alt" || seg === "option") chord.alt = true;
    else chord.key = seg;
  }
  if (!chord.key) {
    throw new Error(`Invalid chord: ${input}`);
  }
  return chord;
}
