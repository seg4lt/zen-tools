/**
 * Terminal pane + workspace store.
 *
 * Ghostty still owns the native tabs, PTYs, and focused surface. This
 * store mirrors that flat tab list, layers a terminal-only workspace
 * grouping model on top, and persists a restorable session snapshot
 * through shared preferences.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getPreferences,
  savePreferences,
  type TerminalSessionPanePreferences,
  type TerminalSessionPreferences,
  type TerminalSessionWorkspacePreferences,
} from "@zen-tools/ipc";
import { useTheme } from "@/hooks/use-theme";
import {
  onTabClosed,
  onTabCreated,
  onTabFocused,
  onTabPwdChanged,
  onTabTitleChanged,
  onTerminalStatus,
  terminalCloseTab,
  terminalListTabs,
  terminalNew,
  terminalNewTab,
  terminalSetCloseWindowOnLastTab,
  terminalSetColorScheme,
  type PaneInfo,
  type TerminalStatusEvent,
} from "../lib/tauri";

export interface TerminalPaneStatus {
  loading: boolean;
  progress: number | null;
  progressState: "set" | "error" | "indeterminate" | "pause" | null;
  unreadCount: number;
  lastNoticeKind:
    | "progress-error"
    | "bell"
    | "command-finished"
    | "desktop-notification"
    | "child-exited"
    | "renderer-health"
    | null;
  lastNoticeMessage: string | null;
  lastEventAt: number | null;
  rendererHealthy: boolean | null;
}

export interface TerminalPane {
  id: number;
  active: boolean;
  persistentId: string;
  ghosttyTitle: string;
  titleOverride: string | null;
  cwdAbsolutePath: string | null;
  launchDirectory: string | null;
  status: TerminalPaneStatus;
}

export interface TerminalWorkspace {
  id: string;
  name: string;
  paneIds: number[];
  /** Last pane the user had focused inside this workspace. */
  lastActivePaneId: number | null;
}

export interface TerminalPinnedPane {
  persistentId: string;
  paneId: number | null;
  workspaceId: string | null;
  title: string;
  active: boolean;
  live: boolean;
}

interface State {
  panes: TerminalPane[];
  activeId: number | null;
  activeWorkspaceId: string | null;
  workspaces: TerminalWorkspace[];
  /** Flat lookup so focus events can switch workspaces cheaply. */
  paneWorkspaceIds: Record<string, string>;
  /** Ordered persistent pane ids pinned by the user. */
  pinnedPaneIds: string[];
  /** Monotonic numbering for default workspace labels. */
  nextWorkspaceNumber: number;
  /** True once bootstrap has adopted/spawned terminal state. */
  bootstrapped: boolean;
}

type Action =
  | { type: "initialize"; panes: TerminalPane[]; activeId: number | null }
  | {
      type: "hydrate";
      panes: TerminalPane[];
      workspaces: TerminalWorkspace[];
      activeWorkspaceId: string | null;
      activeId: number | null;
      pinnedPaneIds: string[];
      nextWorkspaceNumber: number;
    }
  | { type: "add_pane"; pane: TerminalPane; workspaceId: string | null }
  | { type: "remove_pane"; id: number }
  | { type: "set_active"; id: number | null }
  | { type: "set_title"; id: number; title: string }
  | {
      type: "set_cwd";
      id: number;
      cwdAbsolutePath: string | null;
      launchDirectory?: string | null;
    }
  | { type: "rename_pane"; id: number; titleOverride: string }
  | { type: "apply_status_event"; event: TerminalStatusEvent; receivedAt: number }
  | { type: "create_workspace"; id: string; name: string; activate: boolean }
  | { type: "rename_workspace"; id: string; name: string }
  | { type: "activate_workspace"; id: string; paneId: number | null }
  | { type: "move_pane"; paneId: number; workspaceId: string }
  | { type: "delete_workspace"; id: string }
  | { type: "pin_pane"; id: number }
  | { type: "unpin_pane"; id: number }
  | { type: "unpin_pane_persistent"; persistentId: string }
  | { type: "reorder_pinned_pane"; persistentId: string; toIndex: number };

const initial: State = {
  panes: [],
  activeId: null,
  activeWorkspaceId: null,
  workspaces: [],
  paneWorkspaceIds: {},
  pinnedPaneIds: [],
  nextWorkspaceNumber: 1,
  bootstrapped: false,
};

function paneKey(id: number): string {
  return String(id);
}

function defaultWorkspaceName(n: number): string {
  return `Workspace ${n}`;
}

function normalizeWorkspaceName(name: string, fallback: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizePaneOverride(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function paneDisplayTitle(pane: {
  ghosttyTitle: string | null | undefined;
  titleOverride: string | null | undefined;
}): string {
  return (pane.titleOverride ?? pane.ghosttyTitle)?.trim() || "shell";
}

function workspaceForCreate(id: string, name: string): TerminalWorkspace {
  return {
    id,
    name,
    paneIds: [],
    lastActivePaneId: null,
  };
}

function emptyPaneStatus(): TerminalPaneStatus {
  return {
    loading: false,
    progress: null,
    progressState: null,
    unreadCount: 0,
    lastNoticeKind: null,
    lastNoticeMessage: null,
    lastEventAt: null,
    rendererHealthy: null,
  };
}

function clearPaneAttention(status: TerminalPaneStatus): TerminalPaneStatus {
  if (
    status.unreadCount === 0 &&
    status.lastNoticeKind == null &&
    status.lastNoticeMessage == null
  ) {
    return status;
  }
  return {
    ...status,
    unreadCount: 0,
    lastNoticeKind: null,
    lastNoticeMessage: null,
  };
}

function formatCommandFinishedNotice(
  exitCode: number | null,
  durationNs: number,
): string {
  const seconds = durationNs > 0 ? durationNs / 1_000_000_000 : 0;
  const durationLabel =
    seconds >= 1 ? `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s` : null;
  if (exitCode == null) {
    return durationLabel ? `Command finished in ${durationLabel}` : "Command finished";
  }
  if (exitCode === 0) {
    return durationLabel
      ? `Command completed in ${durationLabel}`
      : "Command completed";
  }
  return durationLabel
    ? `Command failed (${exitCode}) after ${durationLabel}`
    : `Command failed (${exitCode})`;
}

function formatDesktopNotificationNotice(
  title: string | null,
  body: string | null,
): string {
  return title?.trim() || body?.trim() || "Terminal notification";
}

function formatChildExitedNotice(exitCode: number, runtimeMs: number): string {
  const seconds = runtimeMs > 0 ? runtimeMs / 1_000 : 0;
  const durationLabel =
    seconds >= 1 ? `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s` : null;
  return durationLabel
    ? `Child exited (${exitCode}) after ${durationLabel}`
    : `Child exited (${exitCode})`;
}

function applyStatusEventToPane(
  pane: TerminalPane,
  event: TerminalStatusEvent,
  receivedAt: number,
): TerminalPane {
  const status = pane.status;
  switch (event.kind) {
    case "progress": {
      if (event.state === "remove") {
        return {
          ...pane,
          status: {
            ...status,
            loading: false,
            progress: null,
            progressState: null,
            lastEventAt: receivedAt,
          },
        };
      }
      if (event.state === "error") {
        return {
          ...pane,
          status: {
            ...status,
            loading: false,
            progress: event.progress,
            progressState: "error",
            unreadCount: status.unreadCount + 1,
            lastNoticeKind: "progress-error",
            lastNoticeMessage: "Terminal reported progress error",
            lastEventAt: receivedAt,
          },
        };
      }
      return {
        ...pane,
        status: {
          ...status,
          loading: event.state === "set" || event.state === "indeterminate",
          progress: event.progress,
          progressState: event.state,
          lastEventAt: receivedAt,
        },
      };
    }
    case "command-finished":
      return {
        ...pane,
        status: {
          ...status,
          loading: false,
          progress: null,
          progressState: null,
          unreadCount: status.unreadCount + 1,
          lastNoticeKind: "command-finished",
          lastNoticeMessage: formatCommandFinishedNotice(
            event.exit_code,
            event.duration_ns,
          ),
          lastEventAt: receivedAt,
        },
      };
    case "bell":
      return {
        ...pane,
        status: {
          ...status,
          unreadCount: status.unreadCount + 1,
          lastNoticeKind: "bell",
          lastNoticeMessage: "Terminal bell",
          lastEventAt: receivedAt,
        },
      };
    case "interaction":
      return {
        ...pane,
        status: {
          ...clearPaneAttention(status),
          lastEventAt: receivedAt,
        },
      };
    case "desktop-notification":
      return {
        ...pane,
        status: {
          ...status,
          unreadCount: status.unreadCount + 1,
          lastNoticeKind: "desktop-notification",
          lastNoticeMessage: formatDesktopNotificationNotice(
            event.title,
            event.body,
          ),
          lastEventAt: receivedAt,
        },
      };
    case "child-exited":
      return {
        ...pane,
        status: {
          ...status,
          loading: false,
          progress: null,
          progressState: null,
          unreadCount: status.unreadCount + 1,
          lastNoticeKind: "child-exited",
          lastNoticeMessage: formatChildExitedNotice(
            event.exit_code,
            event.runtime_ms,
          ),
          lastEventAt: receivedAt,
        },
      };
    case "renderer-health":
      return {
        ...pane,
        status: {
          ...status,
          rendererHealthy: event.healthy,
          unreadCount: event.healthy ? status.unreadCount : status.unreadCount + 1,
          lastNoticeKind: event.healthy ? status.lastNoticeKind : "renderer-health",
          lastNoticeMessage: event.healthy
            ? status.lastNoticeMessage
            : "Terminal renderer is unhealthy",
          lastEventAt: receivedAt,
        },
      };
  }
}

function paneFromInfo(
  pane: PaneInfo,
  options?: {
    persistentId?: string;
    titleOverride?: string | null;
    cwdAbsolutePath?: string | null;
    launchDirectory?: string | null;
  },
): TerminalPane {
  return {
    id: pane.id,
    active: pane.active,
    persistentId: options?.persistentId ?? crypto.randomUUID(),
    ghosttyTitle: pane.title,
    titleOverride: options?.titleOverride ?? null,
    cwdAbsolutePath:
      options?.cwdAbsolutePath ?? pane.cwd_absolute_path ?? null,
    launchDirectory:
      options?.launchDirectory ?? pane.launch_directory ?? null,
    status: emptyPaneStatus(),
  };
}

function setPaneActiveFlags(
  panes: TerminalPane[],
  activeId: number | null,
): TerminalPane[] {
  return panes.map((pane) => ({ ...pane, active: pane.id === activeId }));
}

function chooseWorkspacePane(
  workspace: TerminalWorkspace | null | undefined,
): number | null {
  if (!workspace) return null;
  if (
    workspace.lastActivePaneId != null &&
    workspace.paneIds.includes(workspace.lastActivePaneId)
  ) {
    return workspace.lastActivePaneId;
  }
  return workspace.paneIds[workspace.paneIds.length - 1] ?? null;
}

function nextWorkspaceNumberFor(workspaces: TerminalWorkspace[]): number {
  const highestExplicit = workspaces.reduce((max, workspace) => {
    const match = workspace.name.match(/^Workspace (\d+)$/);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0);
  return Math.max(workspaces.length, highestExplicit) + 1;
}

function removePinnedPaneByRuntimeId(
  pinnedPaneIds: string[],
  panes: TerminalPane[],
  paneId: number,
): string[] {
  const persistentId = panes.find((pane) => pane.id === paneId)?.persistentId;
  if (!persistentId) return pinnedPaneIds;
  return pinnedPaneIds.filter((item) => item !== persistentId);
}

function retainPinnedPaneIds(
  pinnedPaneIds: string[],
  livePanes: Pick<TerminalPane, "persistentId">[],
  deferredWorkspaces?: Map<string, DeferredWorkspaceRestore> | null,
): string[] {
  const allowedIds = new Set(livePanes.map((pane) => pane.persistentId));
  for (const workspace of deferredWorkspaces?.values() ?? []) {
    for (const paneId of workspace.paneIds) {
      allowedIds.add(paneId);
    }
  }
  return pinnedPaneIds.filter((persistentId) => allowedIds.has(persistentId));
}

function movePinnedPaneId(
  pinnedPaneIds: string[],
  persistentId: string,
  toIndex: number,
): string[] {
  const fromIndex = pinnedPaneIds.indexOf(persistentId);
  if (fromIndex === -1) return pinnedPaneIds;
  const boundedIndex = Math.max(0, Math.min(toIndex, pinnedPaneIds.length - 1));
  if (fromIndex === boundedIndex) return pinnedPaneIds;
  const next = [...pinnedPaneIds];
  next.splice(fromIndex, 1);
  next.splice(boundedIndex, 0, persistentId);
  return next;
}

function buildDefaultState(
  panes: TerminalPane[],
  activeId: number | null,
): State {
  const workspaceId = crypto.randomUUID();
  const workspace: TerminalWorkspace = {
    id: workspaceId,
    name: defaultWorkspaceName(1),
    paneIds: panes.map((pane) => pane.id),
    lastActivePaneId: activeId ?? panes[panes.length - 1]?.id ?? null,
  };
  return {
    panes: setPaneActiveFlags(panes, activeId),
    activeId,
    activeWorkspaceId: workspaceId,
    workspaces: [workspace],
    paneWorkspaceIds: Object.fromEntries(
      panes.map((pane) => [paneKey(pane.id), workspaceId]),
    ),
    pinnedPaneIds: [],
    nextWorkspaceNumber: 2,
    bootstrapped: true,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "initialize":
      return buildDefaultState(action.panes, action.activeId);

    case "hydrate": {
      const workspaces =
        action.workspaces.length > 0
          ? action.workspaces
          : [
              workspaceForCreate(
                crypto.randomUUID(),
                defaultWorkspaceName(action.nextWorkspaceNumber),
              ),
            ];
      const activeWorkspaceId =
        workspaces.find((workspace) => workspace.id === action.activeWorkspaceId)
          ?.id ??
        workspaces[0]?.id ??
        null;
      const activeId =
        action.activeId != null &&
        action.panes.some((pane) => pane.id === action.activeId)
          ? action.activeId
          : chooseWorkspacePane(
              workspaces.find((workspace) => workspace.id === activeWorkspaceId),
            );
      return {
        panes: setPaneActiveFlags(action.panes, activeId),
        activeId,
        activeWorkspaceId,
        workspaces,
        paneWorkspaceIds: Object.fromEntries(
          workspaces.flatMap((workspace) =>
            workspace.paneIds.map((paneId) => [paneKey(paneId), workspace.id]),
          ),
        ),
        pinnedPaneIds: action.pinnedPaneIds,
        nextWorkspaceNumber: action.nextWorkspaceNumber,
        bootstrapped: true,
      };
    }

    case "add_pane": {
      const key = paneKey(action.pane.id);
      if (state.panes.some((pane) => pane.id === action.pane.id)) {
        const panes = state.panes.map((pane) =>
          pane.id === action.pane.id
              ? {
                  ...pane,
                  ghosttyTitle: action.pane.ghosttyTitle,
                  cwdAbsolutePath:
                    action.pane.cwdAbsolutePath ?? pane.cwdAbsolutePath,
                  launchDirectory:
                    action.pane.launchDirectory ?? pane.launchDirectory,
                  status: pane.status,
                  active: action.pane.active,
                }
            : action.pane.active
              ? { ...pane, active: false }
              : pane,
        );
        const activeId = action.pane.active ? action.pane.id : state.activeId;
        return {
          ...state,
          panes,
          activeId,
          pinnedPaneIds: state.pinnedPaneIds,
          paneWorkspaceIds: state.paneWorkspaceIds[key]
            ? state.paneWorkspaceIds
            : action.workspaceId
              ? { ...state.paneWorkspaceIds, [key]: action.workspaceId }
              : state.paneWorkspaceIds,
        };
      }

      let workspaces = state.workspaces;
      let activeWorkspaceId = state.activeWorkspaceId;
      let nextWorkspaceNumber = state.nextWorkspaceNumber;

      let workspaceId = action.workspaceId ?? state.activeWorkspaceId;
      if (!workspaceId || !workspaces.some((workspace) => workspace.id === workspaceId)) {
        workspaceId = crypto.randomUUID();
        workspaces = [
          ...workspaces,
          workspaceForCreate(
            workspaceId,
            defaultWorkspaceName(nextWorkspaceNumber),
          ),
        ];
        activeWorkspaceId = workspaceId;
        nextWorkspaceNumber += 1;
      }

      const paneWorkspaceIds = {
        ...state.paneWorkspaceIds,
        [key]: workspaceId,
      };

      workspaces = workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              paneIds: workspace.paneIds.includes(action.pane.id)
                ? workspace.paneIds
                : [...workspace.paneIds, action.pane.id],
              lastActivePaneId: action.pane.active
                ? action.pane.id
                : (workspace.lastActivePaneId ?? action.pane.id),
            }
          : workspace,
      );

      const activeId = action.pane.active ? action.pane.id : state.activeId;
      return {
        ...state,
        panes: setPaneActiveFlags([...state.panes, action.pane], activeId),
        activeId,
        activeWorkspaceId,
        workspaces,
        paneWorkspaceIds,
        pinnedPaneIds: state.pinnedPaneIds,
        nextWorkspaceNumber,
      };
    }

    case "remove_pane": {
      const key = paneKey(action.id);
      const workspaceId = state.paneWorkspaceIds[key] ?? null;
      const paneWorkspaceIds = { ...state.paneWorkspaceIds };
      delete paneWorkspaceIds[key];

      const workspaces = state.workspaces.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        const paneIds = workspace.paneIds.filter((id) => id !== action.id);
        const lastActivePaneId =
          workspace.lastActivePaneId === action.id
            ? (paneIds[paneIds.length - 1] ?? null)
            : workspace.lastActivePaneId;
        return {
          ...workspace,
          paneIds,
          lastActivePaneId,
        };
      });

      let activeId = state.activeId;
      if (state.activeId === action.id) {
        const activeWorkspace = workspaces.find(
          (workspace) => workspace.id === state.activeWorkspaceId,
        );
        activeId = chooseWorkspacePane(activeWorkspace);
      }

      return {
        ...state,
        panes: setPaneActiveFlags(state.panes.filter((pane) => pane.id !== action.id), activeId),
        activeId,
        workspaces,
        paneWorkspaceIds,
        pinnedPaneIds: removePinnedPaneByRuntimeId(
          state.pinnedPaneIds,
          state.panes,
          action.id,
        ),
      };
    }

    case "set_active": {
      const activeWorkspaceId =
        action.id == null
          ? state.activeWorkspaceId
          : (state.paneWorkspaceIds[paneKey(action.id)] ?? state.activeWorkspaceId);

      const workspaces =
        action.id == null
          ? state.workspaces
          : state.workspaces.map((workspace) =>
              workspace.id === activeWorkspaceId
                ? { ...workspace, lastActivePaneId: action.id }
                : workspace,
            );

      return {
        ...state,
        panes: setPaneActiveFlags(state.panes, action.id).map((pane) =>
          pane.id === action.id
            ? { ...pane, status: clearPaneAttention(pane.status) }
            : pane,
        ),
        activeId: action.id,
        activeWorkspaceId,
        workspaces,
      };
    }

    case "set_title":
      return {
        ...state,
        panes: state.panes.map((pane) =>
          pane.id === action.id
            ? { ...pane, ghosttyTitle: action.title }
            : pane,
        ),
      };

    case "set_cwd":
      return {
        ...state,
        panes: state.panes.map((pane) =>
          pane.id === action.id
            ? {
                ...pane,
                cwdAbsolutePath: action.cwdAbsolutePath,
                launchDirectory:
                  action.launchDirectory === undefined
                    ? pane.launchDirectory
                    : action.launchDirectory,
              }
            : pane,
        ),
      };

    case "rename_pane":
      return {
        ...state,
        panes: state.panes.map((pane) =>
          pane.id === action.id
            ? {
                ...pane,
                titleOverride: normalizePaneOverride(action.titleOverride),
              }
            : pane,
        ),
      };

    case "apply_status_event":
      return {
        ...state,
        panes: state.panes.map((pane) =>
          pane.id === action.event.id
            ? applyStatusEventToPane(pane, action.event, action.receivedAt)
            : pane,
        ),
      };

    case "create_workspace": {
      const workspaces = [
        ...state.workspaces,
        workspaceForCreate(action.id, action.name),
      ];
      return {
        ...state,
        workspaces,
        activeWorkspaceId: action.activate ? action.id : state.activeWorkspaceId,
        activeId: action.activate ? null : state.activeId,
        panes: action.activate
          ? setPaneActiveFlags(state.panes, null)
          : state.panes,
        nextWorkspaceNumber: state.nextWorkspaceNumber + 1,
      };
    }

    case "rename_workspace":
      return {
        ...state,
        workspaces: state.workspaces.map((workspace) =>
          workspace.id === action.id
            ? {
                ...workspace,
                name: normalizeWorkspaceName(action.name, workspace.name),
              }
            : workspace,
        ),
      };

    case "activate_workspace": {
      const workspaces = state.workspaces.map((workspace) =>
        workspace.id === action.id && action.paneId != null
          ? { ...workspace, lastActivePaneId: action.paneId }
          : workspace,
      );
      return {
        ...state,
        activeWorkspaceId: action.id,
        activeId: action.paneId,
        panes: setPaneActiveFlags(state.panes, action.paneId).map((pane) =>
          pane.id === action.paneId
            ? { ...pane, status: clearPaneAttention(pane.status) }
            : pane,
        ),
        workspaces,
      };
    }

    case "move_pane": {
      const key = paneKey(action.paneId);
      const sourceWorkspaceId = state.paneWorkspaceIds[key];
      if (!sourceWorkspaceId || sourceWorkspaceId === action.workspaceId) {
        return state;
      }
      if (!state.workspaces.some((workspace) => workspace.id === action.workspaceId)) {
        return state;
      }

      const paneWorkspaceIds = {
        ...state.paneWorkspaceIds,
        [key]: action.workspaceId,
      };

      const workspaces = state.workspaces.map((workspace) => {
        if (workspace.id === sourceWorkspaceId) {
          const paneIds = workspace.paneIds.filter((id) => id !== action.paneId);
          return {
            ...workspace,
            paneIds,
            lastActivePaneId:
              workspace.lastActivePaneId === action.paneId
                ? (paneIds[paneIds.length - 1] ?? null)
                : workspace.lastActivePaneId,
          };
        }
        if (workspace.id === action.workspaceId) {
          return {
            ...workspace,
            paneIds: workspace.paneIds.includes(action.paneId)
              ? workspace.paneIds
              : [...workspace.paneIds, action.paneId],
            lastActivePaneId:
              state.activeId === action.paneId
                ? action.paneId
                : (workspace.lastActivePaneId ?? action.paneId),
          };
        }
        return workspace;
      });

      let activeId = state.activeId;
      if (
        state.activeWorkspaceId === sourceWorkspaceId &&
        state.activeId === action.paneId
      ) {
        activeId = chooseWorkspacePane(
          workspaces.find((workspace) => workspace.id === sourceWorkspaceId),
        );
      }

      return {
        ...state,
        panes: setPaneActiveFlags(state.panes, activeId),
        activeId,
        workspaces,
        paneWorkspaceIds,
        pinnedPaneIds: state.pinnedPaneIds,
      };
    }

    case "delete_workspace": {
      const deleteIndex = state.workspaces.findIndex(
        (workspace) => workspace.id === action.id,
      );
      if (deleteIndex === -1) return state;

      const deletedWorkspace = state.workspaces[deleteIndex];
      let workspaces = state.workspaces.filter(
        (workspace) => workspace.id !== action.id,
      );
      const paneWorkspaceIds = { ...state.paneWorkspaceIds };
      for (const paneId of deletedWorkspace.paneIds) {
        delete paneWorkspaceIds[paneKey(paneId)];
      }

      let nextWorkspaceNumber = state.nextWorkspaceNumber;
      let activeWorkspaceId = state.activeWorkspaceId;
      let activeId = state.activeId;

      if (workspaces.length === 0) {
        const workspaceId = crypto.randomUUID();
        workspaces = [
          workspaceForCreate(
            workspaceId,
            defaultWorkspaceName(nextWorkspaceNumber),
          ),
        ];
        nextWorkspaceNumber += 1;
        activeWorkspaceId = workspaceId;
        activeId = null;
      } else if (state.activeWorkspaceId === action.id) {
        const fallbackWorkspace =
          workspaces[Math.min(deleteIndex, workspaces.length - 1)] ??
          workspaces[0];
        activeWorkspaceId = fallbackWorkspace.id;
        activeId = chooseWorkspacePane(fallbackWorkspace);
      } else if (
        activeId != null &&
        deletedWorkspace.paneIds.includes(activeId)
      ) {
        activeId = chooseWorkspacePane(
          workspaces.find((workspace) => workspace.id === activeWorkspaceId),
        );
      }

      return {
        ...state,
        panes: setPaneActiveFlags(
          state.panes.filter((pane) => !deletedWorkspace.paneIds.includes(pane.id)),
          activeId,
        ),
        activeId,
        activeWorkspaceId,
        workspaces,
        paneWorkspaceIds,
        pinnedPaneIds: state.pinnedPaneIds.filter((persistentId) => {
          const pane = state.panes.find((item) => item.persistentId === persistentId);
          return pane ? !deletedWorkspace.paneIds.includes(pane.id) : true;
        }),
        nextWorkspaceNumber,
      };
    }

    case "pin_pane": {
      const pane = state.panes.find((item) => item.id === action.id);
      if (!pane) return state;
      if (state.pinnedPaneIds.includes(pane.persistentId)) return state;
      return {
        ...state,
        pinnedPaneIds: [...state.pinnedPaneIds, pane.persistentId],
      };
    }

    case "unpin_pane": {
      const pane = state.panes.find((item) => item.id === action.id);
      if (!pane) return state;
      return {
        ...state,
        pinnedPaneIds: state.pinnedPaneIds.filter(
          (persistentId) => persistentId !== pane.persistentId,
        ),
      };
    }

    case "unpin_pane_persistent":
      return {
        ...state,
        pinnedPaneIds: state.pinnedPaneIds.filter(
          (persistentId) => persistentId !== action.persistentId,
        ),
      };

    case "reorder_pinned_pane":
      return {
        ...state,
        pinnedPaneIds: movePinnedPaneId(
          state.pinnedPaneIds,
          action.persistentId,
          action.toIndex,
        ),
      };
  }
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizePaneSnapshot(
  value: unknown,
): TerminalSessionPanePreferences | null {
  if (!value || typeof value !== "object") return null;
  const pane = value as Record<string, unknown>;
  if (typeof pane.id !== "string" || pane.id.length === 0) return null;
  return {
    id: pane.id,
    ghosttyTitle: readOptionalString(pane.ghosttyTitle),
    titleOverride: readOptionalString(pane.titleOverride),
    cwdAbsolutePath: readOptionalString(pane.cwdAbsolutePath),
    launchDirectory: readOptionalString(pane.launchDirectory),
  };
}

function normalizeWorkspaceSnapshot(
  value: unknown,
): TerminalSessionWorkspacePreferences | null {
  if (!value || typeof value !== "object") return null;
  const workspace = value as Record<string, unknown>;
  if (
    typeof workspace.id !== "string" ||
    workspace.id.length === 0 ||
    typeof workspace.name !== "string"
  ) {
    return null;
  }
  return {
    id: workspace.id,
    name: workspace.name,
    paneIds: Array.isArray(workspace.paneIds)
      ? workspace.paneIds.filter((paneId): paneId is string => typeof paneId === "string")
      : [],
    lastActivePaneId: readOptionalString(workspace.lastActivePaneId),
  };
}

function normalizeTerminalSession(
  value: unknown,
): TerminalSessionPreferences | null {
  if (!value || typeof value !== "object") return null;
  const session = value as Record<string, unknown>;
  const panes = Array.isArray(session.panes)
    ? session.panes.map(normalizePaneSnapshot).filter((pane): pane is TerminalSessionPanePreferences => pane != null)
    : [];
  const workspaces = Array.isArray(session.workspaces)
    ? session.workspaces
        .map(normalizeWorkspaceSnapshot)
        .filter(
          (workspace): workspace is TerminalSessionWorkspacePreferences =>
            workspace != null,
        )
    : [];
  if (panes.length === 0 && workspaces.length === 0) return null;
  return {
    panes,
    workspaces,
    activeWorkspaceId: readOptionalString(session.activeWorkspaceId),
    pinnedPaneIds: Array.isArray(session.pinnedPaneIds)
      ? session.pinnedPaneIds.filter((paneId): paneId is string => typeof paneId === "string")
      : [],
  };
}

function buildTerminalSession(
  state: State,
  deferredWorkspaces?: Map<string, DeferredWorkspaceRestore> | null,
): TerminalSessionPreferences {
  const panesById = new Map(state.panes.map((pane) => [pane.id, pane]));
  return {
    panes: state.panes.map((pane) => ({
      id: pane.persistentId,
      ghosttyTitle: pane.ghosttyTitle,
      titleOverride: pane.titleOverride,
      cwdAbsolutePath: pane.cwdAbsolutePath,
      launchDirectory: pane.cwdAbsolutePath ?? pane.launchDirectory,
    })),
    workspaces: state.workspaces.map((workspace) => {
      const statePaneIds = workspace.paneIds
        .map((paneId) => panesById.get(paneId)?.persistentId ?? null)
        .filter((paneId): paneId is string => paneId != null);
      // For workspaces that haven't been activated yet (deferred restore),
      // statePaneIds is empty. Fall back to the deferred snapshot data so
      // we don't accidentally persist an empty pane list and lose the
      // workspace's terminals on the next app start.
      const deferred = statePaneIds.length === 0 ? deferredWorkspaces?.get(workspace.id) : null;
      const paneIds = deferred ? deferred.paneIds : statePaneIds;
      // Only save lastActivePaneId if the pane is actually in this workspace.
      const lastActivePaneId = deferred
        ? deferred.lastActivePaneId
        : workspace.lastActivePaneId != null &&
            workspace.paneIds.includes(workspace.lastActivePaneId)
          ? (panesById.get(workspace.lastActivePaneId)?.persistentId ?? null)
          : null;
      return {
        id: workspace.id,
        name: workspace.name,
        paneIds,
        lastActivePaneId,
      };
    }),
    activeWorkspaceId: state.activeWorkspaceId,
    pinnedPaneIds: retainPinnedPaneIds(
      state.pinnedPaneIds,
      state.panes,
      deferredWorkspaces,
    ),
  };
}

interface RestoredState {
  panes: TerminalPane[];
  workspaces: TerminalWorkspace[];
  activeWorkspaceId: string | null;
  activeId: number | null;
  pinnedPaneIds: string[];
  nextWorkspaceNumber: number;
}

function orderedSnapshotPaneIds(
  snapshot: TerminalSessionPreferences,
): string[] {
  const seenPaneIds = new Set<string>();
  const orderedPaneIds = snapshot.workspaces
    .flatMap((workspace) => workspace.paneIds)
    .filter((paneId) => {
      if (seenPaneIds.has(paneId)) return false;
      seenPaneIds.add(paneId);
      return true;
    });
  for (const pane of snapshot.panes) {
    if (!seenPaneIds.has(pane.id)) {
      orderedPaneIds.push(pane.id);
    }
  }
  return orderedPaneIds;
}

function buildRestoredState(
  snapshot: TerminalSessionPreferences,
  runtimePanes: PaneInfo[],
  runtimeIdByPersistentId: Map<string, number>,
): RestoredState {
  const runtimePaneById = new Map(runtimePanes.map((pane) => [pane.id, pane]));

  const panes: TerminalPane[] = snapshot.panes
    .map((snapshotPane) => {
      const runtimeId = runtimeIdByPersistentId.get(snapshotPane.id);
      if (runtimeId == null) return null;
      const runtimePane = runtimePaneById.get(runtimeId);
      if (!runtimePane) {
        return paneFromInfo(
          {
            id: runtimeId,
            active: false,
            title: snapshotPane.ghosttyTitle ?? "",
            cwd_absolute_path:
              snapshotPane.cwdAbsolutePath ?? snapshotPane.launchDirectory ?? null,
            launch_directory: snapshotPane.launchDirectory ?? null,
          },
          {
            persistentId: snapshotPane.id,
            titleOverride: snapshotPane.titleOverride ?? null,
          },
        );
      }
      return paneFromInfo(runtimePane, {
        persistentId: snapshotPane.id,
        titleOverride: snapshotPane.titleOverride ?? null,
        cwdAbsolutePath:
          runtimePane.cwd_absolute_path ??
          snapshotPane.cwdAbsolutePath ??
          snapshotPane.launchDirectory ??
          null,
        launchDirectory:
          runtimePane.launch_directory ??
          snapshotPane.launchDirectory ??
          null,
      });
    })
    .filter((pane): pane is TerminalPane => pane != null);

  const paneByPersistentId = new Map(panes.map((pane) => [pane.persistentId, pane]));
  const assignedPersistentIds = new Set<string>();

  const workspaces = snapshot.workspaces.map((workspace) => {
    const paneIds = workspace.paneIds
      .map((persistentId) => {
        const pane = paneByPersistentId.get(persistentId);
        if (!pane) {
          console.warn("[terminal] snapshot pane not mapped to runtime id:", persistentId);
          return null;
        }
        assignedPersistentIds.add(persistentId);
        return pane.id;
      })
      .filter((paneId): paneId is number => paneId != null);
    const lastActivePaneId = ((): number | null => {
      if (workspace.lastActivePaneId == null) return null;
      const pane = paneByPersistentId.get(workspace.lastActivePaneId);
      if (!pane) return null;
      // Only use lastActivePaneId if the pane actually belongs to this workspace.
      return paneIds.includes(pane.id) ? pane.id : null;
    })();
    return {
      id: workspace.id,
      name: workspace.name,
      paneIds,
      lastActivePaneId,
    };
  });

  const unassignedPaneIds = panes
    .filter((pane) => !assignedPersistentIds.has(pane.persistentId))
    .map((pane) => pane.id);
  if (unassignedPaneIds.length > 0) {
    if (workspaces.length === 0) {
      workspaces.push({
        id: crypto.randomUUID(),
        name: defaultWorkspaceName(1),
        paneIds: unassignedPaneIds,
        lastActivePaneId: unassignedPaneIds[unassignedPaneIds.length - 1] ?? null,
      });
    } else {
      workspaces[0] = {
        ...workspaces[0],
        paneIds: [...workspaces[0].paneIds, ...unassignedPaneIds],
        lastActivePaneId:
          workspaces[0].lastActivePaneId ??
          unassignedPaneIds[unassignedPaneIds.length - 1] ??
          null,
      };
    }
  }

  if (workspaces.length === 0) {
    workspaces.push(
      workspaceForCreate(
        crypto.randomUUID(),
        defaultWorkspaceName(nextWorkspaceNumberFor([])),
      ),
    );
  }

  const activeWorkspaceId =
    workspaces.find((workspace) => workspace.id === snapshot.activeWorkspaceId)?.id ??
    workspaces[0]?.id ??
    null;
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const restoredActiveId = chooseWorkspacePane(activeWorkspace);
  const runtimeActive = runtimePanes.find((pane) => pane.active)?.id ?? null;
  const activeId =
    restoredActiveId != null
      ? restoredActiveId
      : runtimeActive != null && panes.some((pane) => pane.id === runtimeActive)
        ? runtimeActive
        : null;

  return {
    panes,
    workspaces,
    activeWorkspaceId,
    activeId,
    pinnedPaneIds: (snapshot.pinnedPaneIds ?? []).filter((persistentId) =>
      snapshot.panes.some((pane) => pane.id === persistentId),
    ),
    nextWorkspaceNumber: nextWorkspaceNumberFor(workspaces),
  };
}

function adoptExistingSession(
  snapshot: TerminalSessionPreferences,
  runtimePanes: PaneInfo[],
): RestoredState {
  const runtimeIdByPersistentId = new Map<string, number>();
  const orderedPaneIds = orderedSnapshotPaneIds(snapshot);
  for (let index = 0; index < orderedPaneIds.length; index += 1) {
    const persistentId = orderedPaneIds[index];
    const runtimePane = runtimePanes[index];
    if (!persistentId || !runtimePane) break;
    runtimeIdByPersistentId.set(persistentId, runtimePane.id);
  }
  return buildRestoredState(snapshot, runtimePanes, runtimeIdByPersistentId);
}

function orderedWorkspacePaneIds(
  snapshot: TerminalSessionPreferences,
  workspaceIds: Set<string>,
): string[] {
  const seenPaneIds = new Set<string>();
  return snapshot.workspaces
    .filter((workspace) => workspaceIds.has(workspace.id))
    .flatMap((workspace) => workspace.paneIds)
    .filter((paneId) => {
      if (seenPaneIds.has(paneId)) return false;
      seenPaneIds.add(paneId);
      return true;
    });
}

interface ContextValue extends State {
  pinnedPanes: TerminalPinnedPane[];
  ensureBootstrapped: () => Promise<void>;
  createWorkspace: () => { id: string; name: string };
  renameWorkspace: (workspaceId: string, name: string) => void;
  renamePane: (paneId: number, name: string) => void;
  activateWorkspace: (workspaceId: string) => Promise<void>;
  activatePinnedPane: (persistentId: string) => Promise<void>;
  deleteWorkspace: (workspaceId: string) => Promise<boolean>;
  movePaneToWorkspace: (paneId: number, workspaceId: string) => void;
  pinPane: (paneId: number) => void;
  unpinPane: (paneId: number) => void;
  reorderPinnedPane: (persistentId: string, toIndex: number) => void;
  focusPane: (paneId: number) => void;
  closePane: (paneId: number) => Promise<void>;
  newPane: (workingDirectory?: string | null) => Promise<void>;
  /** Cycle to the next (+1) or previous (-1) pane within the active workspace. */
  cyclePane: (delta: number) => void;
  /** Cycle to the next (+1) or previous (-1) workspace, restoring its last active pane. */
  cycleWorkspace: (delta: number) => Promise<void>;
}

const TerminalStoreContext = createContext<ContextValue | null>(null);

interface DeferredWorkspaceRestore {
  paneIds: string[];
  lastActivePaneId: string | null;
}

interface DeferredSessionRestore {
  snapshot: TerminalSessionPreferences;
  workspaces: Map<string, DeferredWorkspaceRestore>;
}

function buildPinnedPanes(
  state: State,
  deferredRestore: DeferredSessionRestore | null,
): TerminalPinnedPane[] {
  const panesByPersistentId = new Map(
    state.panes.map((pane) => [pane.persistentId, pane] as const),
  );
  const workspaceIdByPersistentId = new Map<string, string>();
  for (const workspace of state.workspaces) {
    for (const paneId of workspace.paneIds) {
      const pane = state.panes.find((item) => item.id === paneId);
      if (pane) workspaceIdByPersistentId.set(pane.persistentId, workspace.id);
    }
  }
  const deferredPaneById = new Map(
    (deferredRestore?.snapshot.panes ?? []).map((pane) => [pane.id, pane] as const),
  );
  const deferredWorkspaceIdByPaneId = new Map<string, string>();
  for (const workspace of deferredRestore?.snapshot.workspaces ?? []) {
    for (const persistentId of workspace.paneIds) {
      deferredWorkspaceIdByPaneId.set(persistentId, workspace.id);
    }
  }
  const pinnedPanes: TerminalPinnedPane[] = [];
  for (const persistentId of state.pinnedPaneIds) {
    const livePane = panesByPersistentId.get(persistentId);
    if (livePane) {
      pinnedPanes.push({
        persistentId,
        paneId: livePane.id,
        workspaceId: workspaceIdByPersistentId.get(persistentId) ?? null,
        title: paneDisplayTitle(livePane),
        active: livePane.id === state.activeId,
        live: true,
      });
      continue;
    }
    const deferredPane = deferredPaneById.get(persistentId);
    const deferredWorkspaceId = deferredWorkspaceIdByPaneId.get(persistentId) ?? null;
    if (!deferredPane || !deferredWorkspaceId) continue;
    pinnedPanes.push({
      persistentId,
      paneId: null,
      workspaceId: deferredWorkspaceId,
      title: paneDisplayTitle({
        titleOverride: deferredPane.titleOverride ?? null,
        ghosttyTitle: deferredPane.ghosttyTitle ?? null,
      }),
      active: false,
      live: false,
    });
  }
  return pinnedPanes;
}

export function TerminalStoreProvider({ children }: { children: ReactNode }) {
  const [state, baseDispatch] = useReducer(reducer, initial);
  const stateRef = useRef(state);
  stateRef.current = state;

  const bootstrapPromise = useRef<Promise<void> | null>(null);
  const suppressLifecycleEvents = useRef(false);
  const persistQueue = useRef<Promise<void>>(Promise.resolve());
  const lastPersistedSnapshot = useRef<string | null>(null);
  const allowWindowClose = useRef(false);
  const deferredSessionRestore = useRef<DeferredSessionRestore | null>(null);

  const persistSessionSnapshot = useCallback(
    (snapshot: TerminalSessionPreferences) => {
      const serialized = JSON.stringify(snapshot);
      if (lastPersistedSnapshot.current === serialized) {
        return persistQueue.current;
      }
      persistQueue.current = persistQueue.current.then(async () => {
        try {
          const prefs = await getPreferences();
          await savePreferences({
            ...prefs,
            terminalSession: snapshot,
          });
          lastPersistedSnapshot.current = serialized;
        } catch (err) {
          console.error("[terminal] save terminal session failed:", err);
        }
      });
      return persistQueue.current;
    },
    [],
  );

  const flushPersistedSession = useCallback(() => {
    if (!stateRef.current.bootstrapped) return Promise.resolve();
    return persistSessionSnapshot(
      buildTerminalSession(stateRef.current, deferredSessionRestore.current?.workspaces),
    );
  }, [persistSessionSnapshot]);

  const dispatch = useCallback(
    (action: Action) => {
      const nextState = reducer(stateRef.current, action);
      stateRef.current = nextState;
      baseDispatch(action);
      if (nextState.bootstrapped) {
        void persistSessionSnapshot(
          buildTerminalSession(nextState, deferredSessionRestore.current?.workspaces),
        );
      }
    },
    [persistSessionSnapshot],
  );

  useEffect(() => {
    let unlisteners: Array<() => void> = [];
    let cancelled = false;

    const shouldIgnoreLifecycleEvent = () => suppressLifecycleEvents.current;

    void (async () => {
      const subs = await Promise.all([
        onTabCreated((payload) => {
          if (shouldIgnoreLifecycleEvent()) return;
          dispatch({
            type: "add_pane",
            pane: paneFromInfo(
              {
                id: payload.id,
                title: payload.title ?? "",
                active: false,
                cwd_absolute_path: payload.cwd_absolute_path,
                launch_directory: payload.launch_directory,
              },
              {
                cwdAbsolutePath: payload.cwd_absolute_path ?? null,
                launchDirectory: payload.launch_directory ?? null,
              },
            ),
            workspaceId: stateRef.current.activeWorkspaceId,
          });
        }),
        onTabFocused((payload) => {
          if (shouldIgnoreLifecycleEvent()) return;
          dispatch({ type: "set_active", id: payload.id });
        }),
        onTabClosed((payload) => {
          if (shouldIgnoreLifecycleEvent()) return;
          dispatch({ type: "remove_pane", id: payload.id });
        }),
        onTabTitleChanged((payload) => {
          if (shouldIgnoreLifecycleEvent()) return;
          dispatch({
            type: "set_title",
            id: payload.id,
            title: payload.title ?? "",
          });
          if (
            payload.cwd_absolute_path !== undefined ||
            payload.launch_directory !== undefined
          ) {
            dispatch({
              type: "set_cwd",
              id: payload.id,
              cwdAbsolutePath: payload.cwd_absolute_path ?? null,
              launchDirectory: payload.launch_directory ?? null,
            });
          }
        }),
        onTabPwdChanged((payload) => {
          if (shouldIgnoreLifecycleEvent()) return;
          dispatch({
            type: "set_cwd",
            id: payload.id,
            cwdAbsolutePath: payload.cwd_absolute_path ?? null,
            launchDirectory:
              payload.launch_directory ?? payload.cwd_absolute_path ?? null,
          });
        }),
        onTerminalStatus((event) => {
          if (shouldIgnoreLifecycleEvent()) return;
          dispatch({
            type: "apply_status_event",
            event,
            receivedAt: Date.now(),
          });
        }),
      ]);

      if (cancelled) {
        for (const unlisten of subs) unlisten();
      } else {
        unlisteners = subs;
      }
    })();

    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

  useEffect(() => {
    const handlePageHide = () => {
      void flushPersistedSession();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void flushPersistedSession();
      }
    };
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    let unlistenCloseRequested: (() => void) | null = null;
    try {
      const win = getCurrentWindow();
      void win
        .onCloseRequested(async (event) => {
          if (allowWindowClose.current) return;
          event.preventDefault();
          await flushPersistedSession();
          allowWindowClose.current = true;
          try {
            await win.close();
          } finally {
            allowWindowClose.current = false;
          }
        })
        .then((unlisten) => {
          unlistenCloseRequested = unlisten;
        })
        .catch((err) => {
          console.error("[terminal] onCloseRequested listener failed:", err);
        });
    } catch {
      /* ignore outside Tauri */
    }

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      unlistenCloseRequested?.();
    };
  }, [flushPersistedSession]);

  const restoreSession = useCallback(
    async (
      snapshot: TerminalSessionPreferences,
      workspaceIds?: Set<string>,
    ): Promise<RestoredState> => {
      const orderedPaneSnapshotIds = workspaceIds
        ? orderedWorkspacePaneIds(snapshot, workspaceIds)
        : orderedSnapshotPaneIds(snapshot);
      const paneSnapshotById = new Map(snapshot.panes.map((pane) => [pane.id, pane]));
      const runtimeIdByPersistentId = new Map<string, number>();
      let needsTerminalBootstrap = stateRef.current.panes.length === 0;

      if (needsTerminalBootstrap) {
        try {
          const existing = await terminalListTabs();
          needsTerminalBootstrap = existing.length === 0;
        } catch (err) {
          console.error("[terminal] terminal_list_tabs before restore failed:", err);
        }
      }

      for (const persistentId of orderedPaneSnapshotIds) {
        const snapshotPane = paneSnapshotById.get(persistentId);
        if (!snapshotPane) continue;
        const config =
          snapshotPane.launchDirectory != null
            ? { working_directory: snapshotPane.launchDirectory }
            : {};

        try {
          if (needsTerminalBootstrap) {
            const result = await terminalNew(config);
            runtimeIdByPersistentId.set(persistentId, result.tab_id);
            needsTerminalBootstrap = false;
          } else {
            const result = await terminalNewTab(config);
            runtimeIdByPersistentId.set(persistentId, result.tab_id);
          }
        } catch (err) {
          console.error("[terminal] restore pane failed:", err);
        }
      }

      let runtimePanes: PaneInfo[] = [];
      try {
        runtimePanes = await terminalListTabs();
      } catch (err) {
        console.error("[terminal] terminal_list_tabs after restore failed:", err);
      }

      return buildRestoredState(snapshot, runtimePanes, runtimeIdByPersistentId);
    },
    [],
  );

  const ensureBootstrapped = useCallback(async () => {
    if (stateRef.current.bootstrapped) return;
    if (bootstrapPromise.current) return bootstrapPromise.current;

    bootstrapPromise.current = (async () => {
      try {
        await terminalSetCloseWindowOnLastTab(false);
      } catch (err) {
        console.error("[terminal] set_close_window_on_last_tab failed:", err);
      }

      let existing: PaneInfo[] = [];
      try {
        existing = await terminalListTabs();
      } catch (err) {
        console.error("[terminal] terminal_list_tabs failed:", err);
      }

      let snapshot: TerminalSessionPreferences | null = null;
      try {
        const prefs = await getPreferences();
        snapshot = normalizeTerminalSession(prefs.terminalSession);
      } catch (err) {
        console.error("[terminal] load terminal session failed:", err);
      }

      if (snapshot) {
        if (existing.length > 0) {
          deferredSessionRestore.current = null;
          dispatch({ type: "hydrate", ...adoptExistingSession(snapshot, existing) });
          return;
        }

        const eagerWorkspaceId =
          snapshot.workspaces.find(
            (workspace) => workspace.id === snapshot.activeWorkspaceId,
          )?.id ??
          snapshot.workspaces[0]?.id ??
          null;
        const eagerWorkspaceIds =
          eagerWorkspaceId != null ? new Set([eagerWorkspaceId]) : new Set<string>();
        const deferredWorkspaces = new Map<string, DeferredWorkspaceRestore>();
        for (const workspace of snapshot.workspaces) {
          if (eagerWorkspaceIds.has(workspace.id) || workspace.paneIds.length === 0) {
            continue;
          }
          deferredWorkspaces.set(workspace.id, {
            paneIds: workspace.paneIds,
            lastActivePaneId: workspace.lastActivePaneId ?? null,
          });
        }
        deferredSessionRestore.current =
          deferredWorkspaces.size > 0
            ? {
                snapshot,
                workspaces: deferredWorkspaces,
              }
            : null;

        suppressLifecycleEvents.current = true;
        try {
          const restored = await restoreSession(
            snapshot,
            eagerWorkspaceIds.size > 0 ? eagerWorkspaceIds : undefined,
          );
          dispatch({ type: "hydrate", ...restored });
          return;
        } finally {
          suppressLifecycleEvents.current = false;
        }
      }

      if (existing.length === 0) {
        try {
          await terminalNew({});
          existing = await terminalListTabs();
        } catch (err) {
          console.error("[terminal] terminal_new failed:", err);
        }
      }

      dispatch({
        type: "initialize",
        panes: existing.map((pane) => paneFromInfo(pane)),
        activeId: existing.find((pane) => pane.active)?.id ?? null,
      });
    })().finally(() => {
      bootstrapPromise.current = null;
    });

    return bootstrapPromise.current;
  }, [restoreSession]);

  const createWorkspace = useCallback(() => {
    const id = crypto.randomUUID();
    const name = defaultWorkspaceName(stateRef.current.nextWorkspaceNumber);
    dispatch({ type: "create_workspace", id, name, activate: true });
    return { id, name };
  }, []);

  const renameWorkspace = useCallback((workspaceId: string, name: string) => {
    dispatch({ type: "rename_workspace", id: workspaceId, name });
  }, []);

  const renamePane = useCallback((paneId: number, name: string) => {
    dispatch({ type: "rename_pane", id: paneId, titleOverride: name });
  }, []);

  const activateWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = stateRef.current.workspaces.find(
      (item) => item.id === workspaceId,
    );
    if (!workspace) return;

    const deferred = deferredSessionRestore.current?.workspaces.get(workspaceId);
    if (workspace.paneIds.length === 0 && deferred && deferred.paneIds.length > 0) {
      const snapshot = deferredSessionRestore.current?.snapshot;
      if (!snapshot) return;

      suppressLifecycleEvents.current = true;
      try {
        const restored = await restoreSession(snapshot, new Set([workspaceId]));
        const restoredPanes = restored.panes.filter((pane) =>
          deferred.paneIds.includes(pane.persistentId),
        );
        for (const pane of restoredPanes) {
          dispatch({
            type: "add_pane",
            pane: { ...pane, active: false },
            workspaceId,
          });
        }
        const restoredWorkspace = restored.workspaces.find(
          (item) => item.id === workspaceId,
        );
        dispatch({
          type: "activate_workspace",
          id: workspaceId,
          paneId:
            restoredWorkspace?.lastActivePaneId ??
            restoredPanes[restoredPanes.length - 1]?.id ??
            null,
        });
        deferredSessionRestore.current?.workspaces.delete(workspaceId);
        if (deferredSessionRestore.current?.workspaces.size === 0) {
          deferredSessionRestore.current = null;
        }
        return;
      } finally {
        suppressLifecycleEvents.current = false;
      }
    }

    dispatch({
      type: "activate_workspace",
      id: workspaceId,
      paneId: chooseWorkspacePane(workspace),
    });
  }, [restoreSession]);

  const activatePinnedPane = useCallback(
    async (persistentId: string) => {
      const livePane = stateRef.current.panes.find(
        (pane) => pane.persistentId === persistentId,
      );
      if (livePane) {
        const workspaceId = stateRef.current.paneWorkspaceIds[paneKey(livePane.id)];
        if (workspaceId) {
          await activateWorkspace(workspaceId);
        }
        dispatch({ type: "set_active", id: livePane.id });
        return;
      }

      const deferredSnapshot = deferredSessionRestore.current?.snapshot;
      if (!deferredSnapshot) {
        dispatch({ type: "unpin_pane_persistent", persistentId });
        return;
      }
      const workspaceId =
        deferredSnapshot.workspaces.find((workspace) =>
          workspace.paneIds.includes(persistentId),
        )?.id ?? null;
      if (!workspaceId) {
        dispatch({ type: "unpin_pane_persistent", persistentId });
        return;
      }

      await activateWorkspace(workspaceId);

      const restoredPane = stateRef.current.panes.find(
        (pane) => pane.persistentId === persistentId,
      );
      if (restoredPane) {
        dispatch({ type: "set_active", id: restoredPane.id });
      } else {
        dispatch({ type: "unpin_pane_persistent", persistentId });
      }
    },
    [activateWorkspace, dispatch],
  );

  const deleteWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = stateRef.current.workspaces.find(
      (item) => item.id === workspaceId,
    );
    if (!workspace) return false;
    const deferredPinnedPaneIds =
      deferredSessionRestore.current?.snapshot.workspaces
        .find((item) => item.id === workspaceId)
        ?.paneIds.filter((persistentId) =>
          stateRef.current.pinnedPaneIds.includes(persistentId),
        ) ?? [];

    const results = await Promise.allSettled(
      workspace.paneIds.map((paneId) => terminalCloseTab(paneId)),
    );
    if (results.some((result) => result.status === "rejected")) {
      console.error("[terminal] delete workspace failed to close one or more panes");
      return false;
    }

    deferredSessionRestore.current?.workspaces.delete(workspaceId);
    if (deferredSessionRestore.current?.workspaces.size === 0) {
      deferredSessionRestore.current = null;
    }

    dispatch({ type: "delete_workspace", id: workspaceId });
    for (const persistentId of deferredPinnedPaneIds) {
      dispatch({ type: "unpin_pane_persistent", persistentId });
    }
    return true;
  }, []);

  const movePaneToWorkspace = useCallback(
    (paneId: number, workspaceId: string) => {
      dispatch({ type: "move_pane", paneId, workspaceId });
    },
    [],
  );

  const pinPane = useCallback((paneId: number) => {
    dispatch({ type: "pin_pane", id: paneId });
  }, []);

  const unpinPane = useCallback((paneId: number) => {
    dispatch({ type: "unpin_pane", id: paneId });
  }, []);

  const reorderPinnedPane = useCallback((persistentId: string, toIndex: number) => {
    dispatch({ type: "reorder_pinned_pane", persistentId, toIndex });
  }, []);

  const focusPane = useCallback((paneId: number) => {
    dispatch({ type: "set_active", id: paneId });
  }, []);

  /**
   * Advance to the next (+1) or previous (-1) pane within the active workspace,
   * wrapping around. Always reads fresh state so rapid key presses advance
   * correctly even before React re-renders.
   */
  const cyclePane = useCallback((delta: number) => {
    const { activeId, activeWorkspaceId, workspaces, panes } = stateRef.current;
    const activeWorkspace =
      workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0] ?? null;
    const paneIds = activeWorkspace?.paneIds ?? [];
    if (paneIds.length === 0) return;
    const panesById = new Map(panes.map((p) => [p.id, p]));
    const activePanes = paneIds
      .map((id) => panesById.get(id))
      .filter((p): p is TerminalPane => p != null);
    if (activePanes.length === 0) return;
    const currentIndex = activePanes.findIndex((p) => p.id === activeId);
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (baseIndex + delta + activePanes.length) % activePanes.length;
    dispatch({ type: "set_active", id: activePanes[nextIndex]!.id });
  }, []);

  /**
   * Switch to the next (+1) or previous (-1) workspace, wrapping around.
   * The workspace's last active pane is restored automatically via
   * `activateWorkspace → chooseWorkspacePane`. Always reads fresh state.
   */
  const cycleWorkspace = useCallback(
    async (delta: number) => {
      const { workspaces, activeWorkspaceId } = stateRef.current;
      if (workspaces.length === 0) return;
      const currentIndex = workspaces.findIndex((w) => w.id === activeWorkspaceId);
      const baseIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = (baseIndex + delta + workspaces.length) % workspaces.length;
      await activateWorkspace(workspaces[nextIndex]!.id);
    },
    [activateWorkspace],
  );

  const closePane = useCallback(async (paneId: number) => {
    try {
      await terminalCloseTab(paneId);
    } catch (err) {
      console.error("[terminal] close_tab failed:", err);
    }
  }, []);

  const newPane = useCallback(async (workingDirectory?: string | null) => {
    const config = workingDirectory ? { working_directory: workingDirectory } : {};
    try {
      if (stateRef.current.panes.length === 0) {
        await terminalNew(config);
      } else {
        await terminalNewTab(config);
      }
    } catch (err) {
      console.error("[terminal] new_tab failed:", err);
    }
  }, []);

  const { theme } = useTheme();
  useEffect(() => {
    if (!state.bootstrapped) return;
    void terminalSetColorScheme(theme === "dark").catch((err) =>
      console.error("[terminal] set_color_scheme failed:", err),
    );
  }, [theme, state.bootstrapped]);

  const pinnedPanes = useMemo(
    () => buildPinnedPanes(state, deferredSessionRestore.current),
    [state],
  );

  const value = useMemo<ContextValue>(
    () => ({
      ...state,
      pinnedPanes,
      ensureBootstrapped,
      createWorkspace,
      renameWorkspace,
      renamePane,
      activateWorkspace,
      activatePinnedPane,
      deleteWorkspace,
      movePaneToWorkspace,
      pinPane,
      unpinPane,
      reorderPinnedPane,
      focusPane,
      closePane,
      newPane,
      cyclePane,
      cycleWorkspace,
    }),
    [
      state,
      pinnedPanes,
      ensureBootstrapped,
      createWorkspace,
      renameWorkspace,
      renamePane,
      activateWorkspace,
      activatePinnedPane,
      deleteWorkspace,
      movePaneToWorkspace,
      pinPane,
      unpinPane,
      reorderPinnedPane,
      focusPane,
      closePane,
      newPane,
      cyclePane,
      cycleWorkspace,
    ],
  );

  return (
    <TerminalStoreContext.Provider value={value}>
      {children}
    </TerminalStoreContext.Provider>
  );
}

export function useTerminalStore(): ContextValue {
  const ctx = useContext(TerminalStoreContext);
  if (!ctx) {
    throw new Error(
      "useTerminalStore must be used inside <TerminalStoreProvider>",
    );
  }
  return ctx;
}
