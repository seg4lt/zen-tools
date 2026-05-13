/**
 * Terminal pane + workspace store.
 *
 * Ghostty still owns the native tabs, PTYs, and focused surface. This
 * store mirrors that flat tab list and layers a terminal-only
 * "workspace" grouping model on top so the UI can organize panes
 * without requiring backend changes.
 *
 * Hoisted into `<AppProviders>` so navigating away from `/terminal`
 * doesn't drop either the pane list or workspace grouping. The
 * tab-lifecycle listeners are wired once at app start and kept alive
 * for the lifetime of the window.
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
import { useTheme } from "@/hooks/use-theme";
import {
  onTabClosed,
  onTabCreated,
  onTabFocused,
  onTabTitleChanged,
  terminalCloseTab,
  terminalListTabs,
  terminalNew,
  terminalNewTab,
  terminalSetCloseWindowOnLastTab,
  terminalSetColorScheme,
  type PaneInfo,
} from "../lib/tauri";

export interface TerminalWorkspace {
  id: string;
  name: string;
  paneIds: number[];
  /** Last pane the user had focused inside this workspace. */
  lastActivePaneId: number | null;
}

interface State {
  panes: PaneInfo[];
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
  | { type: "initialize"; panes: PaneInfo[]; activeId: number | null }
  | { type: "add_pane"; pane: PaneInfo; workspaceId: string | null }
  | { type: "remove_pane"; id: number }
  | { type: "set_active"; id: number | null }
  | { type: "set_title"; id: number; title: string }
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

function workspaceForCreate(id: string, name: string): TerminalWorkspace {
  return {
    id,
    name,
    paneIds: [],
    lastActivePaneId: null,
  };
}

function setPaneActiveFlags(
  panes: PaneInfo[],
  activeId: number | null,
): PaneInfo[] {
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

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "initialize": {
      const workspaceId = crypto.randomUUID();
      const workspace: TerminalWorkspace = {
        id: workspaceId,
        name: defaultWorkspaceName(1),
        paneIds: action.panes.map((pane) => pane.id),
        lastActivePaneId:
          action.activeId ?? action.panes[action.panes.length - 1]?.id ?? null,
      };
      return {
        panes: setPaneActiveFlags(action.panes, action.activeId),
        activeId: action.activeId,
        activeWorkspaceId: workspaceId,
        workspaces: [workspace],
        paneWorkspaceIds: Object.fromEntries(
          action.panes.map((pane) => [paneKey(pane.id), workspaceId]),
        ),
        nextWorkspaceNumber: 2,
        bootstrapped: true,
      };
    }

    case "add_pane": {
      const key = paneKey(action.pane.id);
      if (state.panes.some((pane) => pane.id === action.pane.id)) {
        const panes = state.panes.map((pane) =>
          pane.id === action.pane.id
            ? { ...pane, title: action.pane.title, active: action.pane.active }
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

      let workspaces = state.workspaces.map((workspace) => {
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
          pane.id === action.id ? { ...pane, title: action.title } : pane,
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
      let paneWorkspaceIds = { ...state.paneWorkspaceIds };
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

interface ContextValue extends State {
  ensureBootstrapped: () => Promise<void>;
  createWorkspace: () => { id: string; name: string };
  renameWorkspace: (workspaceId: string, name: string) => void;
  activateWorkspace: (workspaceId: string) => void;
  deleteWorkspace: (workspaceId: string) => Promise<boolean>;
  movePaneToWorkspace: (paneId: number, workspaceId: string) => void;
  focusPane: (paneId: number) => void;
  closePane: (paneId: number) => Promise<void>;
  newPane: () => Promise<void>;
}

const TerminalStoreContext = createContext<ContextValue | null>(null);

export function TerminalStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Lock so concurrent `ensureBootstrapped` callers don't race.
  const bootstrapPromise = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let unlisteners: Array<() => void> = [];
    let cancelled = false;

    void (async () => {
      const subs = await Promise.all([
        onTabCreated((payload) => {
          dispatch({
            type: "add_pane",
            pane: { id: payload.id, title: payload.title ?? "", active: false },
            workspaceId: stateRef.current.activeWorkspaceId,
          });
        }),
        onTabFocused((payload) => dispatch({ type: "set_active", id: payload.id })),
        onTabClosed((payload) => dispatch({ type: "remove_pane", id: payload.id })),
        onTabTitleChanged((payload) =>
          dispatch({
            type: "set_title",
            id: payload.id,
            title: payload.title ?? "",
          }),
        ),
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

      if (existing.length === 0) {
        try {
          const result = await terminalNew({});
          existing = [{ id: result.tab_id, title: "", active: true }];
        } catch (err) {
          console.error("[terminal] terminal_new failed:", err);
        }
      }

      dispatch({
        type: "initialize",
        panes: existing,
        activeId: existing.find((pane) => pane.active)?.id ?? null,
      });
    })();

    return bootstrapPromise.current;
  }, []);

  const createWorkspace = useCallback(() => {
    const id = crypto.randomUUID();
    const name = defaultWorkspaceName(stateRef.current.nextWorkspaceNumber);
    dispatch({ type: "create_workspace", id, name, activate: true });
    return { id, name };
  }, []);

  const renameWorkspace = useCallback((workspaceId: string, name: string) => {
    dispatch({ type: "rename_workspace", id: workspaceId, name });
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

  const newPane = useCallback(async () => {
    try {
      await terminalNewTab();
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
