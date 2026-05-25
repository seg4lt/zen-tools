import type {
  TerminalPane,
  TerminalPaneStatus,
  TerminalWorkspace,
} from "../store/terminal-store";
import type { TerminalStatusEvent } from "./tauri";

/** Single visible status per pane — higher priority wins when aggregating. */
export type TerminalDisplayState = "loading" | "paused" | "alert" | "completed";

export interface TerminalAttentionSummary {
  displayState: TerminalDisplayState;
  loading: boolean;
  paused: boolean;
  actionRequired: boolean;
  completed: boolean;
  unreadCount: number;
  unhealthy: boolean;
  progress: number | null;
  label: string;
}

const DISPLAY_PRIORITY: Record<TerminalDisplayState, number> = {
  alert: 4,
  completed: 3,
  loading: 2,
  paused: 1,
};

function isActionRequired(status: TerminalPaneStatus): boolean {
  return (
    status.lastNoticeKind === "desktop-notification" ||
    status.lastNoticeKind === "child-exited"
  );
}

function isCompleted(status: TerminalPaneStatus): boolean {
  return status.lastNoticeKind === "command-finished";
}

function isPaused(status: TerminalPaneStatus): boolean {
  return status.progressState === "pause";
}

function isUnhealthy(status: TerminalPaneStatus): boolean {
  return status.rendererHealthy === false;
}

export function resolvePaneDisplayState(
  status: TerminalPaneStatus,
  isActive: boolean,
): TerminalDisplayState | null {
  if (isActive) {
    if (status.loading) return "loading";
    if (isPaused(status)) return "paused";
    if (isUnhealthy(status)) return "alert";
    if (isCompleted(status)) return "completed";
    return null;
  }

  if (isActionRequired(status)) return "alert";
  if (isUnhealthy(status)) return "alert";
  if (status.unreadCount > 0 && !isCompleted(status)) return "alert";
  if (status.loading) return "loading";
  if (isCompleted(status)) return "completed";
  if (isPaused(status)) return "paused";
  return null;
}

export function pickHigherDisplayState(
  current: TerminalDisplayState | null,
  next: TerminalDisplayState | null,
): TerminalDisplayState | null {
  if (next == null) return current;
  if (current == null) return next;
  return DISPLAY_PRIORITY[next] > DISPLAY_PRIORITY[current] ? next : current;
}

function paneAttentionLabel(
  status: TerminalPaneStatus,
  displayState: TerminalDisplayState,
): string {
  if (displayState === "alert") {
    if (isActionRequired(status)) {
      return status.lastNoticeMessage ?? "Action required";
    }
    if (isUnhealthy(status)) {
      return "Renderer unhealthy";
    }
    return status.lastNoticeMessage ?? "Terminal alert";
  }
  if (displayState === "completed") {
    return status.lastNoticeMessage ?? "Command finished";
  }
  if (displayState === "loading") {
    return status.progress != null ? `Loading ${status.progress}%` : "Loading";
  }
  if (displayState === "paused") {
    return "Paused";
  }
  return "";
}

export function summarizePaneAttention(
  pane: TerminalPane,
  isActive: boolean,
): TerminalAttentionSummary | null {
  const { status } = pane;
  const displayState = resolvePaneDisplayState(status, isActive);
  if (displayState == null) return null;

  return {
    displayState,
    loading: status.loading,
    paused: isPaused(status),
    actionRequired: isActionRequired(status),
    completed: isCompleted(status),
    unreadCount: status.unreadCount,
    unhealthy: isUnhealthy(status),
    progress: status.progress,
    label: paneAttentionLabel(status, displayState),
  };
}

export function summarizeWorkspaceAttention(
  workspace: TerminalWorkspace,
  panesById: Map<number, TerminalPane>,
  activePaneId: number | null,
): TerminalAttentionSummary | null {
  let displayState: TerminalDisplayState | null = null;
  let loading = 0;
  let paused = 0;
  let actionRequired = 0;
  let completed = 0;
  let unreadCount = 0;
  let unhealthy = 0;
  let maxProgress: number | null = null;

  for (const paneId of workspace.paneIds) {
    const pane = panesById.get(paneId);
    if (!pane) continue;
    const summary = summarizePaneAttention(pane, paneId === activePaneId);
    if (!summary) continue;

    displayState = pickHigherDisplayState(displayState, summary.displayState);
    if (summary.loading) loading += 1;
    if (summary.paused) paused += 1;
    if (summary.actionRequired) actionRequired += 1;
    if (summary.completed) completed += 1;
    if (summary.unhealthy) unhealthy += 1;
    unreadCount += summary.unreadCount;
    if (summary.progress != null) {
      maxProgress =
        maxProgress == null
          ? summary.progress
          : Math.max(maxProgress, summary.progress);
    }
  }

  if (displayState == null) return null;

  const label =
    displayState === "alert"
      ? actionRequired > 0
        ? `Action required in ${actionRequired} pane${actionRequired === 1 ? "" : "s"}`
        : unhealthy > 0
          ? `Renderer unhealthy in ${unhealthy} pane${unhealthy === 1 ? "" : "s"}`
          : unreadCount > 0
            ? `${unreadCount} terminal notification${unreadCount === 1 ? "" : "s"}`
            : "Terminal alert"
      : displayState === "completed"
        ? `Completed in ${completed} pane${completed === 1 ? "" : "s"}`
        : displayState === "loading"
          ? maxProgress != null && loading === 1
            ? `Loading ${maxProgress}%`
            : `Loading in ${loading} pane${loading === 1 ? "" : "s"}`
          : displayState === "paused"
            ? `Paused in ${paused} pane${paused === 1 ? "" : "s"}`
            : "";

  return {
    displayState,
    loading: loading > 0,
    paused: paused > 0,
    actionRequired: actionRequired > 0,
    completed: completed > 0,
    unreadCount,
    unhealthy: unhealthy > 0,
    progress: maxProgress,
    label,
  };
}

export interface TerminalToolTabState {
  loading: boolean;
  paused: boolean;
  actionRequired: boolean;
  completed: boolean;
  unreadCount: number;
  unhealthy: boolean;
  progress: number | null;
}

export function emptyTerminalToolTabState(): TerminalToolTabState {
  return {
    loading: false,
    paused: false,
    actionRequired: false,
    completed: false,
    unreadCount: 0,
    unhealthy: false,
    progress: null,
  };
}

export function applyTerminalToolStatus(
  current: TerminalToolTabState,
  event: TerminalStatusEvent,
): TerminalToolTabState {
  switch (event.kind) {
    case "progress":
      if (event.state === "remove") {
        return { ...current, loading: false, paused: false, progress: null };
      }
      if (event.state === "error") {
        return {
          ...current,
          loading: false,
          paused: false,
          completed: false,
          progress: event.progress,
          unreadCount: current.unreadCount + 1,
        };
      }
      return {
        ...current,
        loading: event.state === "set" || event.state === "indeterminate",
        paused: event.state === "pause",
        completed: false,
        progress: event.progress,
      };
    case "desktop-notification":
    case "child-exited":
      return {
        ...current,
        actionRequired: true,
        completed: false,
        unreadCount: current.unreadCount + 1,
      };
    case "bell":
      return {
        ...current,
        unreadCount: current.unreadCount + 1,
      };
    case "interaction":
      return {
        ...current,
        actionRequired: false,
        unreadCount: 0,
      };
    case "command-finished":
      return {
        ...current,
        loading: false,
        paused: false,
        completed: true,
        unreadCount: current.unreadCount + 1,
      };
    case "renderer-health":
      return { ...current, unhealthy: !event.healthy };
  }
}

export function resolveToolTabDisplayState(
  tab: TerminalToolTabState,
): TerminalDisplayState | null {
  if (tab.actionRequired || tab.unhealthy) return "alert";
  if (tab.unreadCount > 0 && !tab.completed) return "alert";
  if (tab.loading) return "loading";
  if (tab.completed) return "completed";
  if (tab.paused) return "paused";
  return null;
}

export function summarizeTerminalToolAttention(
  tabs: Record<number, TerminalToolTabState>,
): {
  displayState: TerminalDisplayState;
  label: string;
  actionRequired: boolean;
  unhealthy: boolean;
} | null {
  const values = Object.values(tabs);
  if (values.length === 0) return null;

  let displayState: TerminalDisplayState | null = null;
  let loadingCount = 0;
  let pausedCount = 0;
  let actionRequiredCount = 0;
  let completedCount = 0;
  let unreadCount = 0;
  let unhealthyCount = 0;
  let maxProgress: number | null = null;

  for (const tab of values) {
    displayState = pickHigherDisplayState(
      displayState,
      resolveToolTabDisplayState(tab),
    );
    if (tab.loading) loadingCount += 1;
    if (tab.paused) pausedCount += 1;
    if (tab.actionRequired) actionRequiredCount += 1;
    if (tab.completed) completedCount += 1;
    unreadCount += tab.unreadCount;
    if (tab.unhealthy) unhealthyCount += 1;
    if (tab.progress != null) {
      maxProgress =
        maxProgress == null
          ? tab.progress
          : Math.max(maxProgress, tab.progress);
    }
  }

  if (displayState == null) return null;

  const label =
    displayState === "alert"
      ? actionRequiredCount > 0
        ? `Action required in ${actionRequiredCount} pane${actionRequiredCount === 1 ? "" : "s"}`
        : unhealthyCount > 0
          ? `Renderer unhealthy in ${unhealthyCount} pane${unhealthyCount === 1 ? "" : "s"}`
          : `${unreadCount} terminal notification${unreadCount === 1 ? "" : "s"}`
      : displayState === "completed"
        ? `Completed in ${completedCount} pane${completedCount === 1 ? "" : "s"}`
        : displayState === "loading"
          ? maxProgress != null && loadingCount === 1
            ? `Loading ${maxProgress}%`
            : `Loading in ${loadingCount} pane${loadingCount === 1 ? "" : "s"}`
          : displayState === "paused"
            ? `Paused in ${pausedCount} pane${pausedCount === 1 ? "" : "s"}`
            : "";

  return { displayState, label, actionRequired: actionRequiredCount > 0, unhealthy: unhealthyCount > 0 };
}
