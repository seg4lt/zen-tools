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
  return e.key.toLowerCase() === chord.key.toLowerCase();
}
