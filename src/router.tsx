import { useEffect, type ReactNode } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { AppProviders } from "@/components/app-shell/app-providers";
import { TitleBar } from "@/components/app-shell/title-bar";
import { UpdateBanner } from "@/lib/updater/UpdateBanner";
import { HTTPRunnerShell } from "@/tools/http-runner/HTTPRunnerShell";
import { RequestsView } from "@/tools/http-runner/RequestsView";
import { ProcessMonitorShell } from "@/tools/process-monitor/ProcessMonitorShell";
import { CleanerShell } from "@/tools/cleaner/CleanerShell";
import { MarkdownShell } from "@/tools/markdown/MarkdownShell";
import { DatabaseExplorerShell } from "@/tools/database-explorer/DatabaseExplorerShell";
import { PRMasterShell } from "@/tools/prmaster/PRMasterShell";
import { SettingsView } from "@/tools/settings/SettingsView";
import { readLastRoute } from "@/hooks/use-last-route";
import { useToolOrder } from "@/hooks/use-tool-order";
import { isPrmasterPopover } from "@/lib/window-kind";

const rootRoute = createRootRoute({
  component: () => {
    // The PRMaster menu-bar popover (a frameless 500x700 window declared
    // in `tauri.conf.json`) renders the same React tree as the main
    // window — it just skips the TitleBar so the popover is pure tool
    // chrome. We detect it by Tauri window label (set in the config).
    const isPopover = isPrmasterPopover();
    return (
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        {!isPopover && <TitleBar />}
        {!isPopover && <UpdateBanner />}
        <main className="flex min-h-0 flex-1">
          <AppProviders>
            <FocusRouteListener />
            <Outlet />
          </AppProviders>
        </main>
      </div>
    );
  },
});

/**
 * Listens for the `prmaster:focus-route` Tauri event (emitted by the
 * permanent menu-bar tray's "Open PRMaster" item and by the global
 * ⌥⌘⇧P hotkey) and navigates the main window's router accordingly.
 * The popover window also receives the event but ignores it — its
 * router URL is set at window creation and the window itself stays
 * scoped to PRMaster.
 */
/**
 * Renders its children when the named tool is enabled; redirects to
 * the first enabled tool (or `/`) when the tool is disabled. Lets the
 * user re-enable a tool from /settings and then navigate back to it
 * without a page reload.
 *
 * The PRMaster popover window is exempt: the popover is a dedicated
 * single-tool surface and only appears when PRMaster is enabled (the
 * tray icon that summons it is itself gated on the same flag).
 */
function DisabledGuard({
  toolId,
  children,
}: {
  toolId: string;
  children: ReactNode;
}) {
  const { tools, disabledIds, isLoaded } = useToolOrder();
  const navigate = useNavigate();
  const isDisabled = disabledIds.has(toolId);

  useEffect(() => {
    if (!isLoaded || !isDisabled) return;
    if (isPrmasterPopover()) return;
    const fallback = tools[0]?.route ?? "/";
    void navigate({ to: fallback });
  }, [isDisabled, isLoaded, navigate, tools]);

  if (isDisabled && !isPrmasterPopover()) return null;
  return <>{children}</>;
}

function FocusRouteListener() {
  const navigate = useNavigate();
  useEffect(() => {
    if (isPrmasterPopover()) return;
    let unlisten: (() => void) | null = null;
    (async () => {
      unlisten = await listen<string>("prmaster:focus-route", (event) => {
        const target = event.payload || "/prmaster";
        try {
          void navigate({ to: target });
        } catch {
          // Router may not be ready on the very first event (extremely
          // unlikely outside dev hot-reload) — falling back to a hash
          // change keeps the UX correct.
          window.location.hash = `#${target}`;
        }
      });
    })();
    return () => {
      unlisten?.();
    };
  }, [navigate]);
  return null;
}


const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    // The PRMaster menu-bar popover loads the main shell at `/` so the
    // Vite dev server serves it (Vite returns 404 for an explicit
    // `/index.html` request) — redirect that window straight to
    // `/prmaster` regardless of the last-route fallback used by the
    // main window.
    if (isPrmasterPopover()) {
      throw redirect({ to: "/prmaster" });
    }
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
  component: () => (
    <DisabledGuard toolId="http-runner">
      <HTTPRunnerShell />
    </DisabledGuard>
  ),
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
  component: () => (
    <DisabledGuard toolId="process-monitor">
      <ProcessMonitorShell />
    </DisabledGuard>
  ),
});

const cleanerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cleaner",
  component: () => (
    <DisabledGuard toolId="cleaner">
      <CleanerShell />
    </DisabledGuard>
  ),
});

const markdownRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/markdown",
  component: () => (
    <DisabledGuard toolId="markdown">
      <MarkdownShell />
    </DisabledGuard>
  ),
});

const databaseExplorerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/database-explorer",
  component: () => (
    <DisabledGuard toolId="database-explorer">
      <DatabaseExplorerShell />
    </DisabledGuard>
  ),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsView,
});

const prmasterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/prmaster",
  component: () => (
    <DisabledGuard toolId="prmaster">
      <PRMasterShell />
    </DisabledGuard>
  ),
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
  prmasterRoute,
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
