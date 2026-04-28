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
import { PerformanceView } from "@/tools/http-runner/PerformanceView";

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

const performanceRoute = createRoute({
  getParentRoute: () => httpRunnerRoute,
  path: "performance",
  component: PerformanceView,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  httpRunnerRoute.addChildren([
    httpRunnerIndexRoute,
    requestsRoute,
    performanceRoute,
  ]),
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
