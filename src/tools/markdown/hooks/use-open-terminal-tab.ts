import { useCallback } from "react";
import { useTheme } from "@/hooks/use-theme";
import {
  terminalListTabs,
  terminalNew,
  terminalNewTab,
  terminalSetCloseWindowOnLastTab,
  terminalSetColorScheme,
} from "@/tools/terminal/lib/tauri";
import { dirname } from "../lib/tauri";
import { activeTab, useMarkdownStore } from "../store/markdown-store";

function normalizeTerminalDirectory(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith("terminal://")) return null;
  return path;
}

function nextTerminalClientTabId(): string {
  return `terminal-tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (typeof err === "string" && err.trim()) return err.trim();
  return "Failed to start terminal";
}

export function useOpenTerminalTab() {
  const { state, dispatch } = useMarkdownStore();
  const { theme } = useTheme();

  const resolveTerminalWorkingDirectory = useCallback(
    (preferredPath?: string | null, existingTabId?: string) => {
      const normalizedPreferred = normalizeTerminalDirectory(preferredPath);
      if (normalizedPreferred) return normalizedPreferred;

      if (existingTabId) {
        const existing = state.tabs.find((tab) => tab.id === existingTabId);
        if (existing?.kind === "terminal" && existing.terminal) {
          return (
            existing.terminal.cwdAbsolutePath ??
            existing.terminal.launchDirectory ??
            null
          );
        }
      }

      const current = activeTab(state);
      if (current?.kind === "terminal") {
        return current.terminal?.cwdAbsolutePath ?? current.terminal?.launchDirectory ?? null;
      }
      if (current?.path) {
        return current.kind === "file" ||
          current.kind === "html" ||
          current.kind === "markdown" ||
          current.kind === "excalidraw"
          ? dirname(current.path)
          : current.path;
      }
      return state.vaults[0] ?? null;
    },
    [state],
  );

  const openTerminalTab = useCallback(
    async (preferredPath?: string | null, existingTabId?: string) => {
      const id = existingTabId ?? nextTerminalClientTabId();
      const workingDirectory = resolveTerminalWorkingDirectory(preferredPath, id);
      dispatch({
        type: "createPendingTerminalTab",
        id,
        launchDirectory: workingDirectory,
        title: "shell",
      });

      try {
        void terminalSetCloseWindowOnLastTab(false).catch((err) =>
          console.error("[markdown] terminal close-window policy failed", err),
        );

        const existingTabs = await terminalListTabs();
        const created =
          existingTabs.length === 0
            ? await terminalNew(
                workingDirectory ? { working_directory: workingDirectory } : {},
              )
            : await terminalNewTab(
                workingDirectory ? { working_directory: workingDirectory } : {},
              );

        dispatch({
          type: "attachTerminalTabSuccess",
          id,
          paneId: created.tab_id,
          launchDirectory: workingDirectory,
          cwdAbsolutePath: workingDirectory,
          title: "shell",
        });

        void terminalSetColorScheme(theme === "dark").catch((err) =>
          console.error("[markdown] terminal color scheme failed", err),
        );
      } catch (err) {
        const message = formatError(err);
        dispatch({
          type: "attachTerminalTabFailure",
          id,
          errorMessage: message,
        });
        console.error("[markdown] open terminal tab failed", err);
      }
    },
    [dispatch, resolveTerminalWorkingDirectory, theme],
  );

  const retryTerminalTab = useCallback(
    async (tabId: string) => {
      await openTerminalTab(undefined, tabId);
    },
    [openTerminalTab],
  );

  return { openTerminalTab, resolveTerminalWorkingDirectory, retryTerminalTab };
}
