import { Outlet } from "@tanstack/react-router";
import { HttpRunnerSubNav } from "./components/sub-nav";

/**
 * Layout route for the HTTP Runner tool. Renders the sub-navigation
 * strip above the active sub-view.
 *
 * The `HttpRunnerStoreProvider` and the `useProjectsBootstrap` effect
 * are now hosted by `<AppProviders>` at the router root so per-tool
 * state survives navigation between tools (the previous "switch away,
 * come back, all my open requests are gone" issue).
 */
export function HTTPRunnerShell() {
  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <HttpRunnerSubNav />
      <div className="flex min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
