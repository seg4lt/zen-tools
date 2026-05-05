/**
 * Shared React Query options for the review-page data sources.
 *
 * Centralised here (rather than inlined in each consumer) so the
 * hover prefetch on the "Review Pull Request" button uses the
 * exact same query key + fetcher as the review page's `useQuery`.
 * Same key → cache lookup hits on click → page renders instantly,
 * while a background refetch (forced by `staleTime: 0`) folds in
 * the latest server state.
 *
 * The "fast on click + always latest" promise is the combination of:
 *   1. `staleTime: 0` — every mount immediately treats the cached
 *      data as stale and kicks a fresh fetch in the background.
 *   2. `gcTime` left at the React Query default (5 min) — long
 *      enough for hover → click flows, short enough that a stale
 *      cache doesn't pile up.
 * The user sees cached data for the few hundred ms the network
 * call takes, then it swaps to fresh.
 */

import type { QueryClient } from "@tanstack/react-query";
import {
  prmasterTauri,
  type IssueComment,
  type PrDiff,
  type PrRef,
  type ReviewComment,
} from "./tauri";

/** Query options for the per-file PR diff. The `baseRef` / `headRef`
 *  are part of the key because the engine resolves the diff against
 *  those refs — caching across different ref pairs would be wrong. */
export function prDiffQueryOptions(
  pr: PrRef,
  baseRef: string | null,
  headRef: string | null,
) {
  return {
    queryKey: [
      "prmaster",
      "pr-diff",
      pr.owner,
      pr.repo,
      pr.number,
      baseRef,
      headRef,
    ] as const,
    queryFn: () => prmasterTauri.getPrDiff(pr, baseRef, headRef),
    // Always stale on mount — guarantees a fresh fetch on every
    // click, while still letting the cached payload paint instantly
    // while that fetch runs.
    staleTime: 0,
  };
}

/** Query options for the inline review comments. */
export function prReviewCommentsQueryOptions(pr: PrRef) {
  return {
    queryKey: [
      "prmaster",
      "pr-review-comments",
      pr.owner,
      pr.repo,
      pr.number,
    ] as const,
    queryFn: () => prmasterTauri.listReviewComments(pr),
    staleTime: 0,
  };
}

/** Query options for the general (non-code-anchored) PR comments
 *  shown on the Comments tab of the review page. */
export function prIssueCommentsQueryOptions(pr: PrRef) {
  return {
    queryKey: [
      "prmaster",
      "pr-issue-comments",
      pr.owner,
      pr.repo,
      pr.number,
    ] as const,
    queryFn: () => prmasterTauri.listIssueComments(pr),
    staleTime: 0,
  };
}

/**
 * Trigger background fetches for the review page's two data
 * sources. Called from the "Review Pull Request" button's
 * `onMouseEnter` so the click feels instant. Failures are logged
 * but never thrown — a missed prefetch only loses the warm-cache
 * speedup; the page's own `useQuery` will still fetch on mount.
 */
export function prefetchReviewPageData(
  client: QueryClient,
  pr: PrRef,
  baseRef: string | null,
  headRef: string | null,
): void {
  void client
    .prefetchQuery<PrDiff>(prDiffQueryOptions(pr, baseRef, headRef))
    .catch((err) => {
      console.warn("[prmaster] prefetch pr-diff failed:", err);
    });
  void client
    .prefetchQuery<ReviewComment[]>(prReviewCommentsQueryOptions(pr))
    .catch((err) => {
      console.warn("[prmaster] prefetch pr-review-comments failed:", err);
    });
  // The Comments tab on the review page reads from this same key.
  // Prefetching it on hover means clicking the Comments tab right
  // after entering the page is also instant, not just the diff.
  void client
    .prefetchQuery<IssueComment[]>(prIssueCommentsQueryOptions(pr))
    .catch((err) => {
      console.warn("[prmaster] prefetch pr-issue-comments failed:", err);
    });
}
