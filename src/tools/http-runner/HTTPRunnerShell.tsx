import { Outlet } from "@tanstack/react-router";

/**
 * Layout route for the HTTP Runner tool. Owns the 3-pane state context in
 * later phases — for the initial scaffold it just renders the active sub-
 * route inside the central area.
 */
export function HTTPRunnerShell() {
  return (
    <div className="flex h-full w-full flex-col">
      <Outlet />
    </div>
  );
}
