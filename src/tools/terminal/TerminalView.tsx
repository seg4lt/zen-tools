/**
 * Terminal route view.
 *
 * The terminal *content* is rendered by a native macOS NSView
 * (GhosttyHostView, owned by `tauri-plugin-ghostty`). That NSView is
 * attached as a subview of the Tauri window's `contentView`, sitting
 * **below** the WKWebView in the compositor stack. The WKWebView paints
 * a transparent overlay with the terminal workspace rail; clicks fall
 * through to the NSView via `pointer-events: none` (scoped to this
 * route only — see `terminal.css` and the `<body>` class toggle below).
 *
 * Responsibilities of this React component:
 *
 *   1. Trigger the one-time plugin bootstrap on first visit.
 *   2. Push the chrome inset (top/right/bottom/left distances from
 *      window edges, in CSS points) to native side via a
 *      `ResizeObserver`. The plugin uses this to size the NSView's
 *      tab container so it doesn't render under the title bar or
 *      workspace rail.
 *   3. On unmount (user navigates to another tool), push a
 *      "collapse-to-empty" inset so the NSView is invisible behind
 *      the next tab's HTML. The PTY keeps running in the background
 *      — switching back is instant.
 *   4. Render the workspace list, pane list, and management actions.
 *      These are the only HTML elements that need clicks, so they get
 *      `pointer-events: auto` via the `.terminal-chrome` carve-out.
 */

import {
  AlertTriangle,
  BellDot,
  CheckCircle2,
  ChevronsLeft,
  ChevronsRight,
  FolderPlus,
  Loader2,
  Pause,
  Plus,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useShortcut } from "@zen-tools/keyboard";
import { cn } from "@zen-tools/ui";
import { useDistractionFree } from "./store/distraction-free";
import {
  useTerminalStore,
  type TerminalPane,
  type TerminalWorkspace,
} from "./store/terminal-store";
import {
  terminalFocusTab,
  terminalSetChromeInset,
  terminalSetTrafficLightsHidden,
  type ChromeInset,
} from "./lib/tauri";
import "./terminal.css";

const HIDDEN_INSET: ChromeInset = {
  top: 99_999,
  right: 0,
  bottom: 0,
  left: 0,
};

const RAIL_MODE_KEY = "terminal.railMode.v1";

type RailMode = "mini" | "expanded";

function readRailMode(): RailMode {
  try {
    const raw = window.localStorage.getItem(RAIL_MODE_KEY);
    if (raw === "mini" || raw === "expanded") return raw;
  } catch {
    /* ignore */
  }
  return "expanded";
}

function writeRailMode(mode: RailMode) {
  try {
    window.localStorage.setItem(RAIL_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

function paneTitle(title: string | null | undefined): string {
  return title?.trim() || "shell";
}

function paneMiniLabel(title: string): string {
  return paneTitle(title).slice(0, 1).toUpperCase();
}

function workspaceMiniLabel(name: string, index: number): string {
  const trimmed = name.trim();
  const numericSuffix = trimmed.match(/(\d+)$/)?.[1];
  if (numericSuffix) return numericSuffix.slice(-2);
  return trimmed.slice(0, 1).toUpperCase() || String(index + 1);
}

function paneDisplayTitle(pane: {
  ghosttyTitle: string;
  titleOverride: string | null;
}): string {
  return paneTitle(pane.titleOverride ?? pane.ghosttyTitle);
}

function isPaneInfo<T>(pane: T | undefined): pane is T {
  return pane != null;
}

interface TerminalAttentionSummary {
  loading: boolean;
  paused: boolean;
  actionRequired: boolean;
  completed: boolean;
  unreadCount: number;
  unhealthy: boolean;
  progress: number | null;
  label: string;
}

function summarizePaneAttention(
  pane: TerminalPane,
): TerminalAttentionSummary | null {
  const { status } = pane;
  const paused = status.progressState === "pause";
  const unhealthy = status.rendererHealthy === false;
  const actionRequired =
    status.lastNoticeKind === "desktop-notification" ||
    status.lastNoticeKind === "child-exited";
  const completed = status.lastNoticeKind === "command-finished";
  const label = actionRequired
    ? (status.lastNoticeMessage ?? "Action required")
    : unhealthy
      ? "Renderer unhealthy"
      : status.loading
      ? status.progress != null
        ? `Loading ${status.progress}%`
        : "Loading"
      : completed
        ? (status.lastNoticeMessage ?? "Command finished")
      : paused
        ? "Paused"
        : status.lastNoticeMessage ??
          (status.unreadCount > 0
            ? `${status.unreadCount} terminal notifications`
            : "");
  if (
    !status.loading &&
    !paused &&
    status.unreadCount === 0 &&
    !unhealthy &&
    !actionRequired &&
    !completed
  ) {
    return null;
  }
  return {
    loading: status.loading,
    paused,
    actionRequired,
    completed,
    unreadCount: status.unreadCount,
    unhealthy,
    progress: status.progress,
    label,
  };
}

function summarizeWorkspaceAttention(
  workspace: TerminalWorkspace,
  panesById: Map<number, TerminalPane>,
): TerminalAttentionSummary | null {
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
    const summary = summarizePaneAttention(pane);
    if (!summary) continue;
    if (summary.loading) loading += 1;
    if (summary.paused) paused += 1;
    if (summary.actionRequired) actionRequired += 1;
    if (summary.completed) completed += 1;
    if (summary.unhealthy) unhealthy += 1;
    unreadCount += summary.unreadCount;
    if (summary.progress != null) {
      maxProgress =
        maxProgress == null ? summary.progress : Math.max(maxProgress, summary.progress);
    }
  }
  if (
    loading === 0 &&
    paused === 0 &&
    actionRequired === 0 &&
    completed === 0 &&
    unreadCount === 0 &&
    unhealthy === 0
  ) {
    return null;
  }
  const label =
    actionRequired > 0
      ? `Action required in ${actionRequired} pane${actionRequired === 1 ? "" : "s"}`
      : unhealthy > 0
      ? `Renderer unhealthy in ${unhealthy} pane${unhealthy === 1 ? "" : "s"}`
      : loading > 0
        ? maxProgress != null && loading === 1
          ? `Loading ${maxProgress}%`
          : `Loading in ${loading} pane${loading === 1 ? "" : "s"}`
        : completed > 0
          ? `Completed in ${completed} pane${completed === 1 ? "" : "s"}`
        : paused > 0
          ? `Paused in ${paused} pane${paused === 1 ? "" : "s"}`
          : `${unreadCount} terminal notification${unreadCount === 1 ? "" : "s"}`;
  return {
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

export function TerminalView() {
  const {
    panes,
    activeId,
    activeWorkspaceId,
    workspaces,
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
    cyclePane,
    cycleWorkspace,
  } = useTerminalStore();
  const { enabled: dfEnabled, toggle: toggleDF } = useDistractionFree();
  const [railMode, setRailMode] = useState<RailMode>(() => readRailMode());
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(
    null,
  );
  const [editingWorkspaceName, setEditingWorkspaceName] = useState("");
  const [editingPaneId, setEditingPaneId] = useState<number | null>(null);
  const [editingPaneName, setEditingPaneName] = useState("");
  const [draggedPaneId, setDraggedPaneId] = useState<number | null>(null);
  const [dropWorkspaceId, setDropWorkspaceId] = useState<string | null>(null);
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<
    string | null
  >(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const growthRef = useRef<HTMLDivElement | null>(null);
  const lastInset = useRef<ChromeInset>({
    top: -1,
    right: -1,
    bottom: -1,
    left: -1,
  });

  const panesById = useMemo(
    () => new Map(panes.map((pane) => [pane.id, pane])),
    [panes],
  );
  const activeWorkspace = useMemo(
    () =>
      workspaces.find((workspace) => workspace.id === activeWorkspaceId) ??
      workspaces[0] ??
      null,
    [activeWorkspaceId, workspaces],
  );
  const activeWorkspacePanes = useMemo(
    () => (activeWorkspace?.paneIds ?? []).map((id) => panesById.get(id)).filter(isPaneInfo),
    [activeWorkspace, panesById],
  );
  const workspaceAttentionById = useMemo(
    () =>
      new Map(
        workspaces.map((workspace) => [
          workspace.id,
          summarizeWorkspaceAttention(workspace, panesById),
        ]),
      ),
    [panesById, workspaces],
  );
  const terminalAttention = useMemo(
    () =>
      summarizeWorkspaceAttention(
        {
          id: "__all__",
          name: "Terminal",
          paneIds: panes.map((pane) => pane.id),
          lastActivePaneId: activeId,
        },
        panesById,
      ),
    [activeId, panes, panesById],
  );
  const activeWorkspaceHasPane = activeWorkspacePanes.length > 0;

  useEffect(() => {
    writeRailMode(railMode);
  }, [railMode]);

  useEffect(() => {
    void ensureBootstrapped();
  }, [ensureBootstrapped]);

  useEffect(() => {
    if (activeId == null) return;
    void terminalFocusTab(activeId).catch((e) =>
      console.error("[terminal] focus_tab failed:", e),
    );
  }, [activeId]);

  useEffect(() => {
    document.body.classList.add("terminal-route-active");
    const prevDocumentBackground = document.documentElement.style.background;
    const prevBodyBackground = document.body.style.background;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    return () => {
      document.body.classList.remove("terminal-route-active");
      document.documentElement.style.background = prevDocumentBackground;
      document.body.style.background = prevBodyBackground;
      void terminalSetChromeInset(HIDDEN_INSET).catch((e) =>
        console.error("[terminal] set_chrome_inset (hide) failed:", e),
      );
      lastInset.current = { top: -1, right: -1, bottom: -1, left: -1 };
    };
  }, []);

  const pushInsetRef = useRef<() => void>(() => {});
  useEffect(() => {
    const push = () => {
      const inset =
        growthRef.current
          ? (() => {
              const rect = growthRef.current.getBoundingClientRect();
              return {
                top: Math.max(0, Math.round(rect.top)),
                left: Math.max(0, Math.round(rect.left)),
                right: Math.max(0, Math.round(window.innerWidth - rect.right)),
                bottom: Math.max(
                  0,
                  Math.round(window.innerHeight - rect.bottom),
                ),
              } satisfies ChromeInset;
            })()
          : HIDDEN_INSET;

      const last = lastInset.current;
      if (
        inset.top === last.top &&
        inset.left === last.left &&
        inset.right === last.right &&
        inset.bottom === last.bottom
      ) {
        return;
      }
      lastInset.current = inset;
      void terminalSetChromeInset(inset).catch((e) =>
        console.error("[terminal] set_chrome_inset failed:", e),
      );
    };
    pushInsetRef.current = push;

    push();
    const ro = new ResizeObserver(push);
    if (growthRef.current) ro.observe(growthRef.current);
    if (containerRef.current) ro.observe(containerRef.current);
    if (railRef.current) ro.observe(railRef.current);
    window.addEventListener("resize", push);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", push);
      pushInsetRef.current = () => {};
    };
  }, [workspaces.length]);

  useEffect(() => {
    const id = requestAnimationFrame(() => pushInsetRef.current());
    return () => cancelAnimationFrame(id);
  }, [
    activeWorkspaceHasPane,
    activeWorkspaceId,
    dfEnabled,
    railMode,
    workspaces.length,
  ]);

  useEffect(() => {
    void terminalSetTrafficLightsHidden(dfEnabled).catch((e) =>
      console.error("[terminal] set_traffic_lights_hidden failed:", e),
    );
    return () => {
      void terminalSetTrafficLightsHidden(false).catch((e) =>
        console.error(
          "[terminal] set_traffic_lights_hidden (restore) failed:",
          e,
        ),
      );
    };
  }, [dfEnabled]);

  const cancelWorkspaceRename = () => {
    setEditingWorkspaceId(null);
    setEditingWorkspaceName("");
  };

  const cancelPaneRename = () => {
    setEditingPaneId(null);
    setEditingPaneName("");
  };

  const commitWorkspaceRename = (workspaceId: string) => {
    renameWorkspace(workspaceId, editingWorkspaceName);
    cancelWorkspaceRename();
  };

  const commitPaneRename = (paneId: number) => {
    renamePane(paneId, editingPaneName);
    cancelPaneRename();
  };

  const handleCreateWorkspace = useCallback(() => {
    const created = createWorkspace();
    if (railMode === "expanded") {
      setEditingWorkspaceId(created.id);
      setEditingWorkspaceName(created.name);
    }
  }, [createWorkspace, railMode]);

  const openPaneInActiveWorkspace = useCallback(() => {
    const sourcePane =
      activeWorkspacePanes.find((pane) => pane.id === activeId) ??
      activeWorkspacePanes[activeWorkspacePanes.length - 1];
    void newPane(sourcePane?.cwdAbsolutePath ?? sourcePane?.launchDirectory ?? null);
  }, [activeId, activeWorkspacePanes, newPane]);

  useShortcut("mod+[", () => cyclePane(-1), true, { fireInInputs: true });
  useShortcut("mod+]", () => cyclePane(1), true, { fireInInputs: true });
  useShortcut("mod+shift+[", () => void cycleWorkspace(-1), true, {
    fireInInputs: true,
  });
  useShortcut("mod+shift+]", () => void cycleWorkspace(1), true, {
    fireInInputs: true,
  });
  useShortcut("mod+n", openPaneInActiveWorkspace, true, { fireInInputs: true });
  useShortcut("mod+shift+n", handleCreateWorkspace, true, {
    fireInInputs: true,
  });
  const toggleRail = useCallback(
    () => setRailMode((current) => (current === "expanded" ? "mini" : "expanded")),
    [],
  );
  useShortcut("mod+shift+e", toggleRail, true, { fireInInputs: true });

  // Keep a ref to each native-key-hook handler so the Tauri `listen`
  // useEffect can safely use [] deps (register ONCE on mount). Without
  // this pattern, every pane switch re-creates `openPaneInActiveWorkspace`
  // and `handleCreateWorkspace`, which causes the async listener-setup to
  // unregister and re-register on every state change — leaving a brief gap
  // where key events are silently dropped.
  const nativeHookHandlers = useRef({
    cyclePane,
    cycleWorkspace,
    openPaneInActiveWorkspace,
    handleCreateWorkspace,
    toggleDF,
    toggleRail,
  });
  nativeHookHandlers.current = {
    cyclePane,
    cycleWorkspace,
    openPaneInActiveWorkspace,
    handleCreateWorkspace,
    toggleDF,
    toggleRail,
  };

  useEffect(() => {
    let unlisteners: Array<() => void> = [];
    let cancelled = false;
    void (async () => {
      const subs = await Promise.all([
        listen("terminal:host-key-hook:cmd-opt-f", () => {
          nativeHookHandlers.current.toggleDF();
        }),
        listen("terminal:host-key-hook:cmd-left-bracket", () => {
          nativeHookHandlers.current.cyclePane(-1);
        }),
        listen("terminal:host-key-hook:cmd-right-bracket", () => {
          nativeHookHandlers.current.cyclePane(1);
        }),
        listen("terminal:host-key-hook:cmd-shift-left-bracket", () => {
          void nativeHookHandlers.current.cycleWorkspace(-1);
        }),
        listen("terminal:host-key-hook:cmd-shift-right-bracket", () => {
          void nativeHookHandlers.current.cycleWorkspace(1);
        }),
        listen("terminal:host-key-hook:cmd-n", () => {
          nativeHookHandlers.current.openPaneInActiveWorkspace();
        }),
        listen("terminal:host-key-hook:cmd-shift-n", () => {
          nativeHookHandlers.current.handleCreateWorkspace();
        }),
        listen("terminal:host-key-hook:cmd-shift-e", () => {
          nativeHookHandlers.current.toggleRail();
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
  }, []); // empty: register listeners ONCE, read latest handlers via ref

  const handleDeleteWorkspace = async (workspaceId: string) => {
    if (deletingWorkspaceId) return;
    setDeletingWorkspaceId(workspaceId);
    const deleted = await deleteWorkspace(workspaceId);
    setDeletingWorkspaceId(null);
    if (deleted && editingWorkspaceId === workspaceId) {
      cancelWorkspaceRename();
    }
  };

  const handlePaneDrop = (workspaceId: string) => {
    if (
      draggedPaneId == null ||
      workspaceId === activeWorkspaceId
    ) {
      return;
    }
    movePaneToWorkspace(draggedPaneId, workspaceId);
  };

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 w-full flex-col"
    >
      <div className="flex min-h-0 flex-1">
        {workspaces.length > 0 && (
          <aside
            ref={railRef}
            className={cn(
              "terminal-chrome terminal-tab-rail",
              railMode === "mini" ? "is-mini" : "is-expanded",
            )}
            aria-label="Terminal workspace rail"
          >
            <div className="terminal-rail__header">
              {railMode === "expanded" ? (
                <TerminalAttentionIndicators summary={terminalAttention} />
              ) : (
                <span className="sr-only">Terminal workspaces</span>
              )}
              <IconRailButton
                icon={railMode === "expanded" ? ChevronsLeft : ChevronsRight}
                label={
                  railMode === "expanded"
                    ? "Minimize workspace rail"
                    : "Expand workspace rail"
                }
                className="terminal-rail-toggle"
                onClick={toggleRail}
              />
            </div>

            <div className="terminal-rail__section">
              {railMode === "expanded" && (
                <span className="terminal-rail__section-title">Workspaces</span>
              )}
              <div className="terminal-workspace-list" role="list">
                {workspaces.map((workspace, index) => {
                  const active = workspace.id === activeWorkspace?.id;
                  const editing = workspace.id === editingWorkspaceId;
                  const attention = workspaceAttentionById.get(workspace.id) ?? null;
                  return (
                    <button
                      key={workspace.id}
                      type="button"
                      role="listitem"
                      draggable={workspaces.length > 1 && !editing}
                      title={workspace.name}
                      aria-pressed={active}
                      onClick={() => {
                        if (!editing) void activateWorkspace(workspace.id);
                      }}
                      onDoubleClick={() => {
                        if (railMode === "expanded") {
                          setEditingWorkspaceId(workspace.id);
                          setEditingWorkspaceName(workspace.name);
                        }
                      }}
                      onDragOver={(event) => {
                        if (
                          draggedPaneId == null ||
                          workspace.id === activeWorkspaceId
                        ) {
                          return;
                        }
                        event.preventDefault();
                        setDropWorkspaceId(workspace.id);
                      }}
                      onDragLeave={() => {
                        if (dropWorkspaceId === workspace.id) {
                          setDropWorkspaceId(null);
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        handlePaneDrop(workspace.id);
                        setDraggedPaneId(null);
                        setDropWorkspaceId(null);
                      }}
                      className={cn(
                        "terminal-workspace",
                        active && "is-active",
                        dropWorkspaceId === workspace.id && "is-drop-target",
                      )}
                    >
                      <span className="terminal-workspace__label">
                        {editing ? (
                          <input
                            autoFocus
                            value={editingWorkspaceName}
                            onChange={(event) =>
                              setEditingWorkspaceName(event.target.value)
                            }
                            onBlur={() => commitWorkspaceRename(workspace.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commitWorkspaceRename(workspace.id);
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                cancelWorkspaceRename();
                              }
                            }}
                            onClick={(event) => event.stopPropagation()}
                            className="terminal-workspace__input"
                          />
                        ) : (
                          <span className="terminal-workspace__name">
                            {railMode === "expanded"
                              ? workspace.name
                              : workspaceMiniLabel(workspace.name, index)}
                          </span>
                        )}
                      </span>
                      <TerminalAttentionIndicators
                        summary={attention}
                        mini={railMode === "mini"}
                      />
                      {railMode === "expanded" && !editing && (
                        <>
                          <button
                            type="button"
                            aria-label={`Delete ${workspace.name}`}
                            title={`Delete ${workspace.name}`}
                            disabled={deletingWorkspaceId === workspace.id}
                            className="terminal-workspace__delete"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDeleteWorkspace(workspace.id);
                            }}
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="terminal-rail__separator" />

            <div className="terminal-rail__section terminal-rail__section--grow">
              {railMode === "expanded" && (
                <span className="terminal-rail__section-title">Panes</span>
              )}
              {activeWorkspaceHasPane ? (
                <div
                  className="terminal-tab-list"
                  role="tablist"
                  aria-label={`${activeWorkspace?.name ?? "Terminal"} panes`}
                >
                  {activeWorkspacePanes.map((pane) => {
                    const title = paneDisplayTitle(pane);
                    const editing = pane.id === editingPaneId;
                    const cwdTitle =
                      pane.cwdAbsolutePath ?? pane.launchDirectory ?? title;
                    const attention = summarizePaneAttention(pane);
                    return (
                      <button
                        key={pane.id}
                        type="button"
                        role="tab"
                        draggable={workspaces.length > 1 && !editing}
                        aria-selected={pane.id === activeId}
                        aria-label={title}
                        title={cwdTitle}
                        onClick={() => {
                          if (!editing) focusPane(pane.id);
                        }}
                        onDoubleClick={() => {
                          if (railMode === "expanded") {
                            setEditingPaneId(pane.id);
                            setEditingPaneName(pane.titleOverride ?? "");
                          }
                        }}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData(
                            "text/plain",
                            String(pane.id),
                          );
                          setDraggedPaneId(pane.id);
                        }}
                        onDragEnd={() => {
                          setDraggedPaneId(null);
                          setDropWorkspaceId(null);
                        }}
                        className={cn(
                          "terminal-tab",
                          pane.id === activeId && "is-active",
                        )}
                      >
                        <span className="terminal-tab__label">
                          {editing ? (
                            <input
                              autoFocus
                              value={editingPaneName}
                              onChange={(event) =>
                                setEditingPaneName(event.target.value)
                              }
                              onBlur={() => commitPaneRename(pane.id)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  commitPaneRename(pane.id);
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelPaneRename();
                                }
                              }}
                              onClick={(event) => event.stopPropagation()}
                              className="terminal-pane__input"
                            />
                          ) : railMode === "expanded" ? (
                            title
                          ) : (
                            paneMiniLabel(title)
                          )}
                        </span>
                        <TerminalAttentionIndicators
                          summary={attention}
                          mini={railMode === "mini"}
                        />
                        {railMode === "expanded" && !editing && (
                          <span
                            role="button"
                            aria-label={`Close ${title}`}
                            title={`Close ${title}`}
                            className="terminal-tab__close"
                            onClick={(event) => {
                              event.stopPropagation();
                              void closePane(pane.id);
                            }}
                          >
                            ×
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="terminal-rail__empty">
                  {railMode === "expanded" ? "No panes yet" : "∅"}
                </div>
              )}
            </div>

            <div className="terminal-rail__footer">
              <IconRailButton
                icon={Plus}
                label="New pane"
                expandedLabel={railMode === "expanded" ? "New pane" : undefined}
                className="terminal-tab-add"
                onClick={openPaneInActiveWorkspace}
              />
              <IconRailButton
                icon={FolderPlus}
                label="New workspace"
                expandedLabel={
                  railMode === "expanded" ? "New workspace" : undefined
                }
                className="terminal-tab-add"
                onClick={handleCreateWorkspace}
              />
            </div>
          </aside>
        )}

        <div className="relative min-h-0 flex-1">
          <div ref={growthRef} className="absolute inset-0" aria-hidden />
          {!activeWorkspaceHasPane && activeWorkspace && (
            <div className="terminal-chrome terminal-empty-state">
              <div className="terminal-empty-state__card">
                <h2 className="terminal-empty-state__title">
                  {activeWorkspace.name}
                </h2>
                <p className="terminal-empty-state__body">
                  This workspace has no terminal panes yet.
                </p>
                <button
                  type="button"
                  className="terminal-empty-state__action"
                  onClick={() => {
                    void newPane();
                  }}
                >
                  <Plus className="size-3.5" /> New pane
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TerminalAttentionIndicators({
  summary,
  mini = false,
}: {
  summary: TerminalAttentionSummary | null;
  mini?: boolean;
}) {
  if (!summary) return null;
  if (mini) {
    return (
      <span
        aria-hidden
        title={summary.label}
        className={cn(
          "terminal-status-dot",
          summary.loading && "is-loading",
          summary.paused && "is-paused",
          summary.actionRequired && "is-action-required",
          summary.completed && "is-completed",
          summary.unhealthy && "is-unhealthy",
          summary.unreadCount > 0 && !summary.loading && !summary.unhealthy && "is-notice",
        )}
      />
    );
  }
  return (
    <span className="terminal-status-indicators" title={summary.label}>
      {summary.loading ? (
        <Loader2 className="terminal-status-icon is-loading" />
      ) : summary.paused ? (
        <Pause className="terminal-status-icon" />
      ) : null}
      {summary.actionRequired || summary.unhealthy ? (
        <AlertTriangle className="terminal-status-icon is-unhealthy" />
      ) : null}
      {summary.completed && !summary.loading && !summary.actionRequired ? (
        <CheckCircle2 className="terminal-status-icon is-completed" />
      ) : null}
      {summary.unreadCount > 0 ? (
        <span className="terminal-status-badge">
          <BellDot className="size-3" />
          <span>{summary.unreadCount > 99 ? "99+" : summary.unreadCount}</span>
        </span>
      ) : null}
    </span>
  );
}

function IconRailButton({
  icon: Icon,
  label,
  expandedLabel,
  className,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  expandedLabel?: string;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={className}
      onClick={onClick}
    >
      <Icon className="size-3.5" />
      {expandedLabel ? (
        <span className="terminal-tab-add__label">{expandedLabel}</span>
      ) : null}
    </button>
  );
}
