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
  terminalCloseTab,
  terminalListTabs,
  terminalNew,
  terminalNewTab,
  terminalSetCloseWindowOnLastTab,
  terminalSetColorScheme,
  type PaneInfo,
} from "../lib/tauri";

export interface TerminalPane {
  id: number;
  active: boolean;
  persistentId: string;
  ghosttyTitle: string;
  titleOverride: string | null;
  cwdAbsolutePath: string | null;
  launchDirectory: string | null;
}

export interface TerminalWorkspace {
  id: string;
  name: string;
  paneIds: number[];
  /** Last pane the user had focused inside this workspace. */
  lastActivePaneId: number | null;
}

interface State {
  panes: TerminalPane[];
  activeId: number | null;
  activeWorkspaceId: string | null;
  workspaces: TerminalWorkspace[];
  /** Flat lookup so focus events can switch workspaces cheaply. */
  paneWorkspaceIds: Record<string, string>;
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
  | { type: "create_workspace"; id: string; name: string; activate: boolean }
  | { type: "rename_workspace"; id: string; name: string }
  | { type: "activate_workspace"; id: string; paneId: number | null }
  | { type: "move_pane"; paneId: number; workspaceId: string }
  | { type: "delete_workspace"; id: string };

const initial: State = {
  panes: [],
  activeId: null,
  activeWorkspaceId: null,
  workspaces: [],
  paneWorkspaceIds: {},
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

function workspaceForCreate(id: string, name: string): TerminalWorkspace {
  return {
    id,
    name,
    paneIds: [],
    lastActivePaneId: null,
  };
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
        panes: setPaneActiveFlags(
          state.panes.filter((pane) => pane.id !== action.id),
          activeId,
        ),
        activeId,
        workspaces,
        paneWorkspaceIds,
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
        panes: setPaneActiveFlags(state.panes, action.id),
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
        panes: setPaneActiveFlags(state.panes, action.paneId),
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
        nextWorkspaceNumber,
      };
    }
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
  };
}

function buildTerminalSession(state: State): TerminalSessionPreferences {
  const panesById = new Map(state.panes.map((pane) => [pane.id, pane]));
  return {
    panes: state.panes.map((pane) => ({
      id: pane.persistentId,
      titleOverride: pane.titleOverride,
      cwdAbsolutePath: pane.cwdAbsolutePath,
      launchDirectory: pane.cwdAbsolutePath ?? pane.launchDirectory,
    })),
    workspaces: state.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      paneIds: workspace.paneIds
        .map((paneId) => panesById.get(paneId)?.persistentId ?? null)
        .filter((paneId): paneId is string => paneId != null),
      lastActivePaneId:
        workspace.lastActivePaneId != null
          ? (panesById.get(workspace.lastActivePaneId)?.persistentId ?? null)
          : null,
    })),
    activeWorkspaceId: state.activeWorkspaceId,
  };
}

interface RestoredState {
  panes: TerminalPane[];
  workspaces: TerminalWorkspace[];
  activeWorkspaceId: string | null;
  activeId: number | null;
  nextWorkspaceNumber: number;
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
            title: "",
            active: false,
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
        if (!pane) return null;
        assignedPersistentIds.add(persistentId);
        return pane.id;
      })
      .filter((paneId): paneId is number => paneId != null);
    const lastActivePaneId =
      workspace.lastActivePaneId != null
        ? (paneByPersistentId.get(workspace.lastActivePaneId)?.id ?? null)
        : null;
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
    nextWorkspaceNumber: nextWorkspaceNumberFor(workspaces),
  };
}

interface ContextValue extends State {
  ensureBootstrapped: () => Promise<void>;
  createWorkspace: () => { id: string; name: string };
  renameWorkspace: (workspaceId: string, name: string) => void;
  renamePane: (paneId: number, name: string) => void;
  activateWorkspace: (workspaceId: string) => void;
  deleteWorkspace: (workspaceId: string) => Promise<boolean>;
  movePaneToWorkspace: (paneId: number, workspaceId: string) => void;
  focusPane: (paneId: number) => void;
  closePane: (paneId: number) => Promise<void>;
  newPane: (workingDirectory?: string | null) => Promise<void>;
}

const TerminalStoreContext = createContext<ContextValue | null>(null);

export function TerminalStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const stateRef = useRef(state);
  stateRef.current = state;

  const bootstrapPromise = useRef<Promise<void> | null>(null);
  const suppressLifecycleEvents = useRef(false);
  const persistTimer = useRef<number | null>(null);
  const persistQueue = useRef(Promise.resolve());

  useEffect(() => {
    let unlisteners: Array<() => void> = [];
    let cancelled = false;

    const shouldIgnoreLifecycleEvent = () =>
      suppressLifecycleEvents.current && !stateRef.current.bootstrapped;

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
    if (!state.bootstrapped) return;
    if (persistTimer.current != null) {
      window.clearTimeout(persistTimer.current);
    }
    persistTimer.current = window.setTimeout(() => {
      const snapshot = buildTerminalSession(stateRef.current);
      persistQueue.current = persistQueue.current.then(async () => {
        try {
          const prefs = await getPreferences();
          await savePreferences({
            ...prefs,
            terminalSession: snapshot,
          });
        } catch (err) {
          console.error("[terminal] save terminal session failed:", err);
        }
      });
    }, 150);

    return () => {
      if (persistTimer.current != null) {
        window.clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
    };
  }, [state]);

  const restoreSession = useCallback(
    async (snapshot: TerminalSessionPreferences): Promise<RestoredState> => {
      const seenPaneIds = new Set<string>();
      const orderedPaneSnapshotIds = snapshot.workspaces
        .flatMap((workspace) => workspace.paneIds)
        .filter((paneId) => {
          if (seenPaneIds.has(paneId)) return false;
          seenPaneIds.add(paneId);
          return true;
        });
      for (const pane of snapshot.panes) {
        if (!seenPaneIds.has(pane.id)) {
          orderedPaneSnapshotIds.push(pane.id);
        }
      }

      const paneSnapshotById = new Map(snapshot.panes.map((pane) => [pane.id, pane]));
      const runtimeIdByPersistentId = new Map<string, number>();
      let needsTerminalBootstrap = true;

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

      if (existing.length === 0 && snapshot) {
        suppressLifecycleEvents.current = true;
        try {
          const restored = await restoreSession(snapshot);
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

  const activateWorkspace = useCallback((workspaceId: string) => {
    const workspace = stateRef.current.workspaces.find(
      (item) => item.id === workspaceId,
    );
    if (!workspace) return;
    dispatch({
      type: "activate_workspace",
      id: workspaceId,
      paneId: chooseWorkspacePane(workspace),
    });
  }, []);

  const deleteWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = stateRef.current.workspaces.find(
      (item) => item.id === workspaceId,
    );
    if (!workspace) return false;

    const results = await Promise.allSettled(
      workspace.paneIds.map((paneId) => terminalCloseTab(paneId)),
    );
    if (results.some((result) => result.status === "rejected")) {
      console.error("[terminal] delete workspace failed to close one or more panes");
      return false;
    }

    dispatch({ type: "delete_workspace", id: workspaceId });
    return true;
  }, []);

  const movePaneToWorkspace = useCallback(
    (paneId: number, workspaceId: string) => {
      dispatch({ type: "move_pane", paneId, workspaceId });
    },
    [],
  );

  const focusPane = useCallback((paneId: number) => {
    dispatch({ type: "set_active", id: paneId });
  }, []);

  const closePane = useCallback(async (paneId: number) => {
    try {
      await terminalCloseTab(paneId);
    } catch (err) {
      console.error("[terminal] close_tab failed:", err);
    }
  }, []);

  const newPane = useCallback(async (workingDirectory?: string | null) => {
    try {
      await terminalNewTab(
        workingDirectory ? { working_directory: workingDirectory } : {},
      );
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

  const value = useMemo<ContextValue>(
    () => ({
      ...state,
      ensureBootstrapped,
      createWorkspace,
      renameWorkspace,
      renamePane,
      activateWorkspace,
      deleteWorkspace,
      movePaneToWorkspace,
      focusPane,
      closePane,
      newPane,
    }),
    [
      state,
      ensureBootstrapped,
      createWorkspace,
      renameWorkspace,
      renamePane,
      activateWorkspace,
      deleteWorkspace,
      movePaneToWorkspace,
      focusPane,
      closePane,
      newPane,
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
