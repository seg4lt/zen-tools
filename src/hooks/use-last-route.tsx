/**
 * Persists the current `location.pathname` to `localStorage` on every
 * navigation, so a relaunch can resume the user on the exact tool/page
 * they were viewing. Mounted once at the root layout — there's no
 * provider; it's fire-and-forget.
 *
 * `localStorage` (synchronous) is intentional: `indexRoute.beforeLoad`
 * needs the value before React has hydrated the TanStack Query cache
 * that backs `getPreferences()`, so we can't use the prefs file here
 * without blocking initial paint. Same trade-off the theme provider
 * already makes (`zen-tools.theme`).
 */
import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";

export const LAST_ROUTE_KEY = "zen-tools.last-route";

export function useLastRoute(): void {
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });

  useEffect(() => {
    if (typeof pathname !== "string" || pathname.length === 0) return;
    try {
      localStorage.setItem(LAST_ROUTE_KEY, pathname);
    } catch {
      // localStorage may be disabled (private mode etc.); silently skip.
    }
  }, [pathname]);
}

/**
 * Read the last-active route synchronously. Used by
 * `indexRoute.beforeLoad` to pick the redirect target on app launch.
 * Returns `null` when nothing is saved or the value looks invalid.
 */
export function readLastRoute(): string | null {
  try {
    const raw = localStorage.getItem(LAST_ROUTE_KEY);
    if (!raw || !raw.startsWith("/")) return null;
    return raw;
  } catch {
    return null;
  }
}
