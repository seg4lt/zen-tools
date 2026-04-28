import { Outlet } from "@tanstack/react-router";
import { HttpRunnerStoreProvider } from "./store/http-runner-store";

/**
 * Layout route for the HTTP Runner tool. Provides the per-tool reducer
 * store; the actual pane layout is owned by the sub-views.
 */
export function HTTPRunnerShell() {
  return (
    <HttpRunnerStoreProvider>
      <div className="flex h-full w-full min-h-0 flex-col">
        <Outlet />
      </div>
    </HttpRunnerStoreProvider>
  );
}
