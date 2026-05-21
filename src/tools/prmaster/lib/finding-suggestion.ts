import type { AiReviewFinding } from "./tauri";

/** True when a finding carries a concrete code fix worth showing. */
export function hasActionableSuggestion(finding: AiReviewFinding): boolean {
  const suggested = finding.suggested?.trim() ?? "";
  if (!suggested) return false;
  if (suggested === (finding.current?.trim() ?? "")) return false;
  return true;
}
