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
  Check,
  FolderPlus,
  Pause,
  Pin,
  PinOff,
  Plus,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { BrailleSpinner } from "./components/braille-spinner";
import {
  summarizePaneAttention,
  summarizeWorkspaceAttention,
  type TerminalAttentionSummary,
} from "./lib/attention";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useShortcut } from "@zen-tools/keyboard";
import { cn } from "@zen-tools/ui";
import { DragHandle } from "@/components/drag-handle";
import { useAppZoom } from "@/hooks/use-app-zoom";
import { useDistractionFree } from "./store/distraction-free";
import { useTerminalStore } from "./store/terminal-store";
import {
  terminalFocusTab,
  terminalSearch,
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

/** Below this width the workspace rail is hidden until toggled with ⌘⇧E. */
const HIDDEN_RAIL_WINDOW_WIDTH = 960;
const DEFAULT_RAIL_WIDTH = 220;
const MIN_RAIL_WIDTH = 180;
const MAX_RAIL_WIDTH = 420;
const RAIL_WIDTH_STORAGE_KEY = "terminal.rail.width";

function readInitialRailWidth(): number {
  if (typeof window === "undefined") return DEFAULT_RAIL_WIDTH;
  const raw = window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY);
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_RAIL_WIDTH;
  return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, parsed));
}

function paneTitle(title: string | null | undefined): string {
  return title?.trim() || "shell";
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

export function TerminalView() {
  const {
    panes,
    activeId,
    activeWorkspaceId,
    workspaces,
    pinnedPanes,
    ensureBootstrapped,
    createWorkspace,
    renameWorkspace,
    renamePane,
    activateWorkspace,
    activatePinnedPane,
    deleteWorkspace,
    reorderWorkspace,
    movePaneToWorkspace,
    reorderPane,
    pinPane,
    unpinPane,
    reorderPinnedPane,
    focusPane,
    closePane,
    newPane,
    cyclePane,
    cycleWorkspace,
  } = useTerminalStore();
  const { enabled: dfEnabled, toggle: toggleDF } = useDistractionFree();
  const { zoom: appZoom } = useAppZoom();
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(
    null,
  );
  const [editingWorkspaceName, setEditingWorkspaceName] = useState("");
  const [editingPaneId, setEditingPaneId] = useState<number | null>(null);
  const [editingPaneName, setEditingPaneName] = useState("");
  const [draggedPaneId, setDraggedPaneId] = useState<number | null>(null);
  const [dropWorkspaceId, setDropWorkspaceId] = useState<string | null>(null);
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(
    null,
  );
  const [draggedPinnedPersistentId, setDraggedPinnedPersistentId] = useState<
    string | null
  >(null);
  const [dropPinnedIndex, setDropPinnedIndex] = useState<number | null>(null);
  const [dropPaneIndex, setDropPaneIndex] = useState<number | null>(null);
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<
    string | null
  >(null);
  const [railVisibleOverride, setRailVisibleOverride] = useState<boolean | null>(
    null,
  );
  const [railHiddenAuto, setRailHiddenAuto] = useState(false);
  const [railWidth, setRailWidth] = useState(() => readInitialRailWidth());
  const [search, setSearch] = useState<{
    id: number;
    query: string;
    total: number | null;
    selected: number | null;
  } | null>(null);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const railVisible = railVisibleOverride ?? !railHiddenAuto;
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
          summarizeWorkspaceAttention(workspace, panesById, activeId),
        ]),
      ),
    [activeId, panesById, workspaces],
  );
  const activeWorkspaceHasPane = activeWorkspacePanes.length > 0;

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
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<
      | { id: number; kind: "search-started"; query: string }
      | { id: number; kind: "search-ended" }
      | { id: number; kind: "search-total"; total: number }
      | { id: number; kind: "search-selected"; selected: number }
    >("terminal:status", (event) => {
      const payload = event.payload;
      if (!payload.kind.startsWith("search-")) return;
      if (payload.kind === "search-started") {
        setSearch({ id: payload.id, query: payload.query, total: null, selected: null });
        setSearchFocusRequest((request) => request + 1);
        return;
      }
      if (payload.kind === "search-ended") {
        setSearch((current) => current?.id === payload.id ? null : current);
        return;
      }
      setSearch((current) => {
        if (!current || current.id !== payload.id) return current;
        return payload.kind === "search-total"
          ? { ...current, total: payload.total >= 0 ? payload.total : null }
          : { ...current, selected: payload.selected >= 0 ? payload.selected : null };
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Focus only after React has committed the search bar. The request counter
  // changes for every Cmd+F, so pressing it again while search is already open
  // also returns focus to the query field.
  useEffect(() => {
    if (!search || search.id !== activeId || searchFocusRequest === 0) return;
    const frame = requestAnimationFrame(() => {
      const input = searchInputRef.current;
      input?.focus();
      input?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [activeId, search?.id, searchFocusRequest]);

  const openSearch = useCallback(() => {
    void terminalSearch("start").catch((error) =>
      console.error("[terminal] start search failed:", error),
    );
  }, []);

  const closeSearch = useCallback(() => {
    void terminalSearch("end").catch((error) =>
      console.error("[terminal] end search failed:", error),
    );
  }, []);

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
    window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(railWidth));
  }, [railWidth]);

  useEffect(() => {
    const push = () => {
      const hidden = window.innerWidth <= HIDDEN_RAIL_WINDOW_WIDTH;
      setRailHiddenAuto((current) => (current === hidden ? current : hidden));

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
  }, [railVisible, workspaces.length]);

  useEffect(() => {
    lastInset.current = { top: -1, right: -1, bottom: -1, left: -1 };
    pushInsetRef.current();
  }, [appZoom]);

  useEffect(() => {
    const id = requestAnimationFrame(() => pushInsetRef.current());
    return () => cancelAnimationFrame(id);
  }, [
    activeWorkspaceHasPane,
    activeWorkspaceId,
    dfEnabled,
    railVisible,
    workspaces.length,
    search?.id,
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
    setEditingWorkspaceId(created.id);
    setEditingWorkspaceName(created.name);
  }, [createWorkspace]);

  const openPaneInActiveWorkspace = useCallback(() => {
    const sourcePane =
      activeWorkspacePanes.find((pane) => pane.id === activeId) ??
      activeWorkspacePanes[activeWorkspacePanes.length - 1];
    void newPane(sourcePane?.cwdAbsolutePath ?? sourcePane?.launchDirectory ?? null);
  }, [activeId, activeWorkspacePanes, newPane]);

  const activatePinnedByIndex = useCallback(
    (index: number) => {
      const target = pinnedPanes[index];
      if (!target) return;
      void activatePinnedPane(target.persistentId);
    },
    [activatePinnedPane, pinnedPanes],
  );

  const toggleRailVisible = useCallback(() => {
    setRailVisibleOverride((current) => {
      const effective = current ?? !railHiddenAuto;
      return !effective;
    });
  }, [railHiddenAuto]);

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
  useShortcut("mod+shift+e", toggleRailVisible, true, {
    fireInInputs: true,
  });
  useShortcut("mod+f", openSearch, true, { fireInInputs: true });

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
    activatePinnedByIndex,
    toggleRailVisible,
    toggleDF,
    closeActivePane: () => {
      if (activeId != null) void closePane(activeId);
    },
  });
  nativeHookHandlers.current = {
    cyclePane,
    cycleWorkspace,
    openPaneInActiveWorkspace,
    handleCreateWorkspace,
    activatePinnedByIndex,
    toggleRailVisible,
    toggleDF,
    closeActivePane: () => {
      if (activeId != null) void closePane(activeId);
    },
  };

  useEffect(() => {
    let unlisteners: Array<() => void> = [];
    let cancelled = false;
    void (async () => {
      const subs = await Promise.all([
        listen("terminal:host-key-hook:cmd-opt-f", () => {
          nativeHookHandlers.current.toggleDF();
        }),
        listen("terminal:host-key-hook:cmd-w", () => {
          nativeHookHandlers.current.closeActivePane();
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
          nativeHookHandlers.current.toggleRailVisible();
        }),
        listen("terminal:host-key-hook:cmd-1", () => {
          nativeHookHandlers.current.activatePinnedByIndex(0);
        }),
        listen("terminal:host-key-hook:cmd-2", () => {
          nativeHookHandlers.current.activatePinnedByIndex(1);
        }),
        listen("terminal:host-key-hook:cmd-3", () => {
          nativeHookHandlers.current.activatePinnedByIndex(2);
        }),
        listen("terminal:host-key-hook:cmd-4", () => {
          nativeHookHandlers.current.activatePinnedByIndex(3);
        }),
        listen("terminal:host-key-hook:cmd-5", () => {
          nativeHookHandlers.current.activatePinnedByIndex(4);
        }),
        listen("terminal:host-key-hook:cmd-6", () => {
          nativeHookHandlers.current.activatePinnedByIndex(5);
        }),
        listen("terminal:host-key-hook:cmd-7", () => {
          nativeHookHandlers.current.activatePinnedByIndex(6);
        }),
        listen("terminal:host-key-hook:cmd-8", () => {
          nativeHookHandlers.current.activatePinnedByIndex(7);
        }),
        listen("terminal:host-key-hook:cmd-9", () => {
          nativeHookHandlers.current.activatePinnedByIndex(8);
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

  const handlePinnedDrop = (toIndex: number) => {
    if (draggedPinnedPersistentId == null) return;
    reorderPinnedPane(draggedPinnedPersistentId, toIndex);
  };

  const handleWorkspaceDrop = (toIndex: number) => {
    if (draggedWorkspaceId == null) return;
    reorderWorkspace(draggedWorkspaceId, toIndex);
  };

  const handlePaneReorderDrop = (toIndex: number) => {
    if (draggedPaneId == null || activeWorkspaceId == null) return;
    reorderPane(draggedPaneId, activeWorkspaceId, toIndex);
  };

  useShortcut("mod+1", () => activatePinnedByIndex(0), true, { fireInInputs: true });
  useShortcut("mod+2", () => activatePinnedByIndex(1), true, { fireInInputs: true });
  useShortcut("mod+3", () => activatePinnedByIndex(2), true, { fireInInputs: true });
  useShortcut("mod+4", () => activatePinnedByIndex(3), true, { fireInInputs: true });
  useShortcut("mod+5", () => activatePinnedByIndex(4), true, { fireInInputs: true });
  useShortcut("mod+6", () => activatePinnedByIndex(5), true, { fireInInputs: true });
  useShortcut("mod+7", () => activatePinnedByIndex(6), true, { fireInInputs: true });
  useShortcut("mod+8", () => activatePinnedByIndex(7), true, { fireInInputs: true });
  useShortcut("mod+9", () => activatePinnedByIndex(8), true, { fireInInputs: true });

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 w-full flex-col"
    >
      <div className="flex min-h-0 flex-1">
        {workspaces.length > 0 && railVisible && (
          <>
            <aside
              ref={railRef}
              style={{ width: railWidth, minWidth: railWidth }}
              className="terminal-chrome terminal-tab-rail is-expanded"
              aria-label="Terminal workspace rail"
            >
              <div className="terminal-rail__section">
              {pinnedPanes.length > 0 && (
                <>
                  <span className="terminal-rail__section-title">Pinned</span>
                  <div className="terminal-tab-list" role="list">
                    {pinnedPanes.map((pinnedPane, index) => (
                      <button
                        key={pinnedPane.persistentId}
                        type="button"
                        role="listitem"
                        draggable={pinnedPanes.length > 1}
                        title={pinnedPane.title}
                        aria-pressed={pinnedPane.active}
                        onClick={() => {
                          void activatePinnedPane(pinnedPane.persistentId);
                        }}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData(
                            "text/plain",
                            pinnedPane.persistentId,
                          );
                          setDraggedPinnedPersistentId(pinnedPane.persistentId);
                        }}
                        onDragOver={(event) => {
                          if (draggedPinnedPersistentId == null) return;
                          event.preventDefault();
                          setDropPinnedIndex(index);
                        }}
                        onDragLeave={() => {
                          if (dropPinnedIndex === index) {
                            setDropPinnedIndex(null);
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          handlePinnedDrop(index);
                          setDraggedPinnedPersistentId(null);
                          setDropPinnedIndex(null);
                        }}
                        onDragEnd={() => {
                          setDraggedPinnedPersistentId(null);
                          setDropPinnedIndex(null);
                        }}
                        className={cn(
                          "terminal-tab terminal-pin",
                          pinnedPane.active && "is-active",
                          dropPinnedIndex === index && "is-drop-target",
                        )}
                      >
                        <span className="terminal-tab__label">
                          {pinnedPane.title}
                        </span>
                        <Pin className="terminal-pin__icon" />
                      </button>
                    ))}
                  </div>
                  <div className="terminal-rail__separator" />
                </>
              )}

                <div className="terminal-rail__section-header">
                  <span className="terminal-rail__section-title">Workspaces</span>
                  <IconRailButton
                    icon={FolderPlus}
                    label="New workspace"
                    className="terminal-section-action"
                    onClick={handleCreateWorkspace}
                  />
                </div>
              <div className="terminal-workspace-list" role="list">
                {workspaces.map((workspace) => {
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
                        setEditingWorkspaceId(workspace.id);
                        setEditingWorkspaceName(workspace.name);
                      }}
                      onDragStart={(event) => {
                        if (editing) return;
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", workspace.id);
                        setDraggedWorkspaceId(workspace.id);
                      }}
                      onDragOver={(event) => {
                        if (draggedWorkspaceId != null) {
                          event.preventDefault();
                          setDropWorkspaceId(workspace.id);
                          return;
                        }
                        if (draggedPaneId == null || workspace.id === activeWorkspaceId) {
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
                        if (draggedWorkspaceId != null) {
                          handleWorkspaceDrop(
                            workspaces.findIndex((item) => item.id === workspace.id),
                          );
                        } else {
                          handlePaneDrop(workspace.id);
                        }
                        setDraggedWorkspaceId(null);
                        setDraggedPaneId(null);
                        setDropWorkspaceId(null);
                      }}
                      onDragEnd={() => {
                        setDraggedWorkspaceId(null);
                        setDropWorkspaceId(null);
                      }}
                      className={cn(
                        "terminal-workspace",
                        active && "is-active",
                        dropWorkspaceId === workspace.id && "is-drop-target",
                      )}
                    >
                      <TerminalAttentionIndicators summary={attention} />
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
                            {workspace.name}
                          </span>
                        )}
                      </span>
                      {!editing && (
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
                <div className="terminal-rail__section-header">
                  <span className="terminal-rail__section-title">Panes</span>
                  <IconRailButton
                    icon={Plus}
                    label="New pane"
                    className="terminal-section-action"
                    onClick={openPaneInActiveWorkspace}
                  />
                </div>
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
                    const attention = summarizePaneAttention(
                      pane,
                      pane.id === activeId,
                    );
                    return (
                      <button
                        key={pane.id}
                        type="button"
                        role="tab"
                        draggable={activeWorkspacePanes.length > 1 && !editing}
                        aria-selected={pane.id === activeId}
                        aria-label={title}
                        title={cwdTitle}
                        onClick={() => {
                          if (!editing) focusPane(pane.id);
                        }}
                        onDoubleClick={() => {
                          setEditingPaneId(pane.id);
                          setEditingPaneName(pane.titleOverride ?? "");
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
                          setDropPaneIndex(null);
                        }}
                        onDragOver={(event) => {
                          if (draggedPaneId == null) return;
                          event.preventDefault();
                          setDropPaneIndex(
                            activeWorkspacePanes.findIndex((item) => item.id === pane.id),
                          );
                        }}
                        onDragLeave={() => {
                          const index = activeWorkspacePanes.findIndex(
                            (item) => item.id === pane.id,
                          );
                          if (dropPaneIndex === index) {
                            setDropPaneIndex(null);
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          handlePaneReorderDrop(
                            activeWorkspacePanes.findIndex((item) => item.id === pane.id),
                          );
                          setDraggedPaneId(null);
                          setDropPaneIndex(null);
                        }}
                        className={cn(
                          "terminal-tab",
                          pane.id === activeId && "is-active",
                          dropPaneIndex ===
                            activeWorkspacePanes.findIndex((item) => item.id === pane.id) &&
                            "is-drop-target",
                        )}
                      >
                        <TerminalAttentionIndicators summary={attention} />
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
                          ) : (
                            title
                          )}
                        </span>
                        {!editing && (
                          <>
                            {pinnedPanes.some(
                              (pinnedPane) => pinnedPane.paneId === pane.id,
                            ) ? (
                              <button
                                type="button"
                                aria-label={`Unpin ${title}`}
                                title={`Unpin ${title}`}
                                className="terminal-tab__pin"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  unpinPane(pane.id);
                                }}
                              >
                                <PinOff className="size-3" />
                              </button>
                            ) : (
                              <button
                                type="button"
                                aria-label={`Pin ${title}`}
                                title={`Pin ${title}`}
                                className="terminal-tab__pin"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  pinPane(pane.id);
                                }}
                              >
                                <Pin className="size-3" />
                              </button>
                            )}
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
                          </>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="terminal-rail__empty">No panes yet</div>
              )}
              </div>
            </aside>
            <DragHandle
              direction="x"
              initial={railWidth}
              min={MIN_RAIL_WIDTH}
              max={MAX_RAIL_WIDTH}
              onResize={setRailWidth}
            />
          </>
        )}

        <div className="relative min-h-0 flex-1">
          <div
            ref={growthRef}
            className="absolute inset-x-0 bottom-0"
            style={{ top: search && search.id === activeId ? 48 : 0 }}
            aria-hidden
          />
          {search && search.id === activeId && (
            <div className="terminal-chrome terminal-search" role="search">
              <input
                ref={searchInputRef}
                className="terminal-search__input"
                type="text"
                value={search.query}
                placeholder="Search scrollback"
                aria-label="Search terminal scrollback"
                onChange={(event) => {
                  const query = event.currentTarget.value;
                  setSearch((current) => current ? {
                    ...current,
                    query,
                    total: null,
                    selected: null,
                  } : current);
                  void terminalSearch("update", query).catch((error) =>
                    console.error("[terminal] update search failed:", error),
                  );
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeSearch();
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    void terminalSearch(event.shiftKey ? "previous" : "next");
                  }
                }}
              />
              <span className="terminal-search__count" aria-live="polite">
                {search.total == null
                  ? "…"
                  : search.total === 0
                    ? "0/0"
                    : `${search.selected == null ? 0 : search.selected + 1}/${search.total}`}
              </span>
              <button
                type="button"
                className="terminal-search__button"
                aria-label="Previous match"
                title="Previous match (Shift+Enter)"
                onClick={() => void terminalSearch("previous")}
              >
                ↑
              </button>
              <button
                type="button"
                className="terminal-search__button"
                aria-label="Next match"
                title="Next match (Enter)"
                onClick={() => void terminalSearch("next")}
              >
                ↓
              </button>
              <button
                type="button"
                className="terminal-search__button"
                aria-label="Close search"
                title="Close search (Escape)"
                onClick={closeSearch}
              >
                ×
              </button>
            </div>
          )}
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
}: {
  summary: TerminalAttentionSummary | null;
}) {
  if (!summary) return null;

  return (
    <span className="terminal-status-indicators" title={summary.label}>
      {summary.displayState === "loading" ? (
        <BrailleSpinner className="terminal-status-icon is-loading" />
      ) : summary.displayState === "paused" ? (
        <Pause className="terminal-status-icon is-paused" />
      ) : summary.displayState === "alert" ? (
        summary.actionRequired || summary.unhealthy ? (
          <AlertTriangle className="terminal-status-icon is-unhealthy" />
        ) : (
          <BellDot className="terminal-status-icon is-alert" />
        )
      ) : summary.displayState === "completed" ? (
        <Check className="terminal-status-icon is-completed" strokeWidth={3} />
      ) : null}
    </span>
  );
}

function IconRailButton({
  icon: Icon,
  label,
  className,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
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
    </button>
  );
}
