/**
 * Platform helpers for the keybinding registry.
 *
 * `mod` is `meta` on macOS and `ctrl` elsewhere — matching the convention
 * used by every editor + most desktop apps.
 */

export const isMac =
  typeof navigator !== "undefined" &&
  /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform);

/** Check whether the matching modifier (meta/ctrl) is held. */
export function modPressed(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** Format a single chord for display. */
export function formatChord(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push(isMac ? "⌘" : "Ctrl");
  if (chord.shift) parts.push(isMac ? "⇧" : "Shift");
  if (chord.alt) parts.push(isMac ? "⌥" : "Alt");
  parts.push(chord.key.toUpperCase());
  return parts.join(isMac ? "" : "+");
}

export interface KeyChord {
  /** `mod` resolves to `meta` on macOS, `ctrl` elsewhere. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Single-character key (e.g. "e", "1", "/"). */
  key: string;
}

/** Test whether an event matches a chord. */
export function matches(e: KeyboardEvent, chord: KeyChord): boolean {
  if ((chord.mod ?? false) !== modPressed(e)) return false;
  if ((chord.shift ?? false) !== e.shiftKey) return false;
  if ((chord.alt ?? false) !== e.altKey) return false;

  // Direct match — works for the common case (no Option held).
  if (e.key.toLowerCase() === chord.key.toLowerCase()) return true;

  // macOS rewrites `e.key` when Option (Alt) is held: `Opt+T` reports
  // `"†"` instead of `"t"`.  Fall back to the physical `e.code` for
  // single ASCII letters / digits so chords like `mod+alt+t` still
  // resolve.  `e.code` is layout-independent, so this also makes
  // chords work on Dvorak / Colemak users typing on a QWERTY chord.
  if (chord.alt && chord.key.length === 1) {
    const ch = chord.key.toLowerCase();
    if (ch >= "a" && ch <= "z") {
      return e.code === `Key${ch.toUpperCase()}`;
    }
    if (ch >= "0" && ch <= "9") {
      return e.code === `Digit${ch}`;
    }
  }
  return false;
}
