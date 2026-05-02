import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppProviders } from "@/components/app-shell/app-providers";
import { TitleBar } from "@/components/app-shell/title-bar";
import { HTTPRunnerShell } from "@/tools/http-runner/HTTPRunnerShell";
import { RequestsView } from "@/tools/http-runner/RequestsView";
import { ProcessMonitorShell } from "@/tools/process-monitor/ProcessMonitorShell";
import { CleanerShell } from "@/tools/cleaner/CleanerShell";
import { MarkdownShell } from "@/tools/markdown/MarkdownShell";
import { DatabaseExplorerShell } from "@/tools/database-explorer/DatabaseExplorerShell";
import { SettingsShell } from "@/tools/settings/SettingsShell";
import { readLastRoute } from "@/hooks/use-last-route";

const rootRoute = createRootRoute({
  component: () => (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />
      <main className="flex min-h-0 flex-1">
        {/* All tool store providers live here so per-tool state
            (active connection, open files, results, …) survives
            navigation between tool tabs. The route Outlet only
            swaps the shell component; the providers and their
            useReducer state stay mounted for the lifetime of
            the app. */}
        <AppProviders>
          <Outlet />
        </AppProviders>
      </main>
    </div>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    // Resume on the last route the user was viewing (sync read from
    // localStorage; see use-last-route.tsx). Falls back to the HTTP
    // runner's requests view on first launch / cleared storage / when
    // the saved string fails the simple `/`-prefix sanity check.
    const target = readLastRoute() ?? "/http-runner/requests";
    throw redirect({ to: target });
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

const markdownRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/markdown",
  component: MarkdownShell,
});

const databaseExplorerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/database-explorer",
  component: DatabaseExplorerShell,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsShell,
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
  markdownRoute,
  databaseExplorerRoute,
  settingsRoute,
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
