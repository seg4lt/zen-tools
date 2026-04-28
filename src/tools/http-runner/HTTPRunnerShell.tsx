import { Outlet } from "@tanstack/react-router";
import { HttpRunnerStoreProvider } from "./store/http-runner-store";
import { HttpRunnerSubNav } from "./components/sub-nav";

/**
 * Layout route for the HTTP Runner tool. Provides the per-tool reducer
 * store and renders the sub-navigation strip above the active sub-view.
 */
export function HTTPRunnerShell() {
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
