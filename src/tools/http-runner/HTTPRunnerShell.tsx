import { Outlet } from "@tanstack/react-router";
import { HttpRunnerStoreProvider } from "./store/http-runner-store";
import { HttpRunnerSubNav } from "./components/sub-nav";
import { useProjectsBootstrap } from "./hooks/use-projects";

/**
 * Layout route for the HTTP Runner tool. Provides the per-tool reducer
 * store and renders the sub-navigation strip above the active sub-view.
 */
export function HTTPRunnerShell() {
  // Re-add previously-open project folders from localStorage on the
  // first mount of the HTTP-runner tree.
  useProjectsBootstrap();
  return (
    <HttpRunnerStoreProvider>
      <div className="flex h-full w-full min-h-0 flex-col">
        <HttpRunnerSubNav />
        <div className="flex min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
    </HttpRunnerStoreProvider>
  );
}
