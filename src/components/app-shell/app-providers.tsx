/**
 * App-wide store providers.
 *
 * Every tool ships its own `useReducer`-backed Context provider
 * (`HttpRunnerStoreProvider`, `DbExplorerStoreProvider`, …). They
 * used to be wrapped *inside* each tool's Shell component, which
 * meant the provider unmounted whenever the user navigated away
 * from that tool's route — and re-mounted with `initial` state
 * when they came back. That's why "I had a Postgres connection
 * active, switched to HTTP runner, came back, and now there's no
 * connection selected" kept happening: the React state was gone
 * even though the **backend** `ConnectionRegistry` (and the live
 * tiberius/sqlx pools) was still alive in the Tauri process.
 *
 * Hoisting the providers to the root layout fixes that — they
 * mount once at app start and stay mounted for the lifetime of
 * the window. State is preserved across every tool-tab switch;
 * the only thing that resets it is closing the app.
 *
 * Each provider is gated on the tool's enabled state from
 * `useToolOrder`. Disabling a tool unmounts its provider, which
 * tears down any `useEffect` listeners it owns (e.g. the
 * `prmaster:refreshed` Tauri-event listener inside
 * `PrMasterStoreProvider`). Re-enabling re-mounts cleanly.
 *
 * Provider nesting order doesn't matter for correctness (none of
 * them depend on each other), but the order below groups by tool
 * so it reads as a list.
 */

import type { ReactNode } from "react";
import { CleanerStoreProvider } from "@/tools/cleaner/store/cleaner-store";
import { DbExplorerStoreProvider } from "@/tools/database-explorer/store/db-explorer-store";
import { useProjectsBootstrap } from "@/tools/http-runner/hooks/use-projects";
import { HttpRunnerStoreProvider } from "@/tools/http-runner/store/http-runner-store";
import { MarkdownStoreProvider } from "@/tools/markdown/store/markdown-store";
import { ProcessMonitorStoreProvider } from "@/tools/process-monitor/store/process-monitor-store";
import { AiSummaryStoreProvider } from "@/tools/prmaster/store/ai-summary-store";
import { PrMasterStoreProvider } from "@/tools/prmaster/store/prmaster-store";
import { TerminalStoreProvider } from "@/tools/terminal/store/terminal-store";
import { useToolOrder } from "@/hooks/use-tool-order";

export function AppProviders({ children }: { children: ReactNode }) {
  const { disabledIds, isLoaded } = useToolOrder();

  // Until the preferences query resolves, mount every provider so
  // tools render normally on first paint — the disabled set is
  // applied as soon as it loads. (`staleTime: Infinity` means this
  // happens once per session.)
  const isDisabled = (id: string) => isLoaded && disabledIds.has(id);

  // Tiny passthrough so each `gate` line below stays a single
  // expression instead of a nested ternary block.
  const gate = (id: string, Wrapper: (kids: ReactNode) => ReactNode) =>
    isDisabled(id) ? (kids: ReactNode) => <>{kids}</> : Wrapper;

  const HttpRunner = gate("http-runner", (kids) => (
    <HttpRunnerStoreProvider>{kids}</HttpRunnerStoreProvider>
  ));
  const ProcessMonitor = gate("process-monitor", (kids) => (
    <ProcessMonitorStoreProvider>{kids}</ProcessMonitorStoreProvider>
  ));
  const Cleaner = gate("cleaner", (kids) => (
    <CleanerStoreProvider>{kids}</CleanerStoreProvider>
  ));
  const Markdown = gate("markdown", (kids) => (
    <MarkdownStoreProvider>{kids}</MarkdownStoreProvider>
  ));
  const DbExplorer = gate("database-explorer", (kids) => (
    <DbExplorerStoreProvider>{kids}</DbExplorerStoreProvider>
  ));
  const PrMaster = gate("prmaster", (kids) => (
    <PrMasterStoreProvider>
      <AiSummaryStoreProvider>{kids}</AiSummaryStoreProvider>
    </PrMasterStoreProvider>
  ));
  // Terminal pane store. Survives navigation so the inner pane-tab
  // strip doesn't lose state when the user briefly switches to
  // another tool. The actual NSView + PTY lives in the Rust
  // `tauri-plugin-ghostty` plugin state and is shared across mounts
  // regardless. The provider is no-op-cheap when the user never
  // visits /terminal — the four `tab:*` event listeners are
  // attached at mount but no shell is spawned until the
  // `ensureBootstrapped` call inside `TerminalView`'s mount effect.
  const Terminal = gate("terminal", (kids) => (
    <TerminalStoreProvider>{kids}</TerminalStoreProvider>
  ));

  return HttpRunner(
    ProcessMonitor(
      Cleaner(
        Markdown(
          DbExplorer(
            PrMaster(
              Terminal(
                <>
                  {/* Bootstrap hooks need to live inside the providers
                      whose state they touch. `useProjectsBootstrap`
                      uses React Query (already wired in App.tsx) plus
                      the http-runner backend; doesn't actually depend
                      on the http-runner store, but keeping it here
                      groups all "fire-once at app start" effects in
                      one place so they're easy to find. */}
                  <Bootstrappers httpRunnerEnabled={!isDisabled("http-runner")} />
                  {children}
                </>,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * Renders nothing. Exists purely so we can call hook-based
 * bootstrap effects inside the provider tree without forcing
 * `AppProviders` itself to grow a hook chain that runs on every
 * route change. (The hooks are themselves `ranRef`-guarded, but
 * isolating them keeps the provider component pure.)
 *
 * The bootstrappers are gated on the relevant tool being enabled —
 * disabling HTTP runner shouldn't trigger its project-list rehydrate.
 */
function Bootstrappers({ httpRunnerEnabled }: { httpRunnerEnabled: boolean }) {
  return httpRunnerEnabled ? <HttpRunnerBootstrap /> : null;
}

function HttpRunnerBootstrap() {
  // Re-add HTTP-runner project folders from localStorage on first
  // mount of the app. Idempotent — the hook itself uses a `ranRef`
  // guard so it only fires once per session.
  useProjectsBootstrap();
  return null;
}
