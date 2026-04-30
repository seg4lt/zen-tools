import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { TitleBar } from "@/components/app-shell/title-bar";
import { HTTPRunnerShell } from "@/tools/http-runner/HTTPRunnerShell";
import { RequestsView } from "@/tools/http-runner/RequestsView";
import { ProcessMonitorShell } from "@/tools/process-monitor/ProcessMonitorShell";
import { CleanerShell } from "@/tools/cleaner/CleanerShell";

const rootRoute = createRootRoute({
  component: () => (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />
      <main className="flex min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/http-runner/requests" });
  },
});

const httpRunnerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/http-runner",
  component: HTTPRunnerShell,
});

const httpRunnerIndexRoute = createRoute({
  getParentRoute: () => httpRunnerRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/http-runner/requests" });
  },
});

const requestsRoute = createRoute({
  getParentRoute: () => httpRunnerRoute,
  path: "requests",
  component: RequestsView,
});

// Legacy `/performance` URLs from the previous two-tab layout redirect
// back to the unified Requests view — perf files are now opened the
// same way as `.http` files.
const performanceRoute = createRoute({
  getParentRoute: () => httpRunnerRoute,
  path: "performance",
  beforeLoad: () => {
    throw redirect({ to: "/http-runner/requests" });
  },
});

const processMonitorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/process-monitor",
  component: ProcessMonitorShell,
});

const cleanerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cleaner",
  component: CleanerShell,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  httpRunnerRoute.addChildren([
    httpRunnerIndexRoute,
    requestsRoute,
    performanceRoute,
  ]),
  processMonitorRoute,
  cleanerRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
