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
 * Bootstrap effects (`useProjectsBootstrap`, the saved-connections
 * loader inside `DbExplorerStoreProvider`) now fire once at app
 * launch instead of every time the user enters the tool. That
 * removes the redundant Tauri round-trips and means the first
 * navigation to any tool is instant — its data is already loaded.
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

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <HttpRunnerStoreProvider>
      <ProcessMonitorStoreProvider>
        <CleanerStoreProvider>
          <MarkdownStoreProvider>
            <DbExplorerStoreProvider>
              <PrMasterStoreProvider>
                <AiSummaryStoreProvider>
                  {/* Bootstrap hooks need to live inside the providers
                      whose state they touch. `useProjectsBootstrap`
                      uses React Query (already wired in App.tsx) plus
                      the http-runner backend; doesn't actually depend
                      on the http-runner store, but keeping it here
                      groups all "fire-once at app start" effects in
                      one place so they're easy to find. */}
                  <Bootstrappers />
                  {children}
                </AiSummaryStoreProvider>
              </PrMasterStoreProvider>
            </DbExplorerStoreProvider>
          </MarkdownStoreProvider>
        </CleanerStoreProvider>
      </ProcessMonitorStoreProvider>
    </HttpRunnerStoreProvider>
  );
}

/**
 * Renders nothing. Exists purely so we can call hook-based
 * bootstrap effects inside the provider tree without forcing
 * `AppProviders` itself to grow a hook chain that runs on every
 * route change. (The hooks are themselves `ranRef`-guarded, but
 * isolating them keeps the provider component pure.)
 */
function Bootstrappers() {
  // Re-add HTTP-runner project folders from localStorage on first
  // mount of the app. Idempotent — the hook itself uses a `ranRef`
  // guard so it only fires once per session.
  useProjectsBootstrap();
  return null;
}
