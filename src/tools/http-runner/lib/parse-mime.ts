/**
 * Pick a CodeMirror language extension based on a `Content-Type` header.
 * Falls back to plain text.
 */
import type { Extension } from "@codemirror/state";
import { json } from "@codemirror/lang-json";

export function languageForContentType(contentType?: string): Extension[] {
  if (!contentType) return [];
  const lower = contentType.toLowerCase();
  if (lower.includes("application/json") || lower.includes("+json")) {
    return [json()];
  }
  return [];
}

/** Heuristic: does this look like a JSON content-type? */
export function isJsonContentType(contentType?: string): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes("application/json") || lower.includes("+json");
}
