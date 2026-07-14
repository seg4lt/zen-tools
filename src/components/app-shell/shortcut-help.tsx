import { isMac } from "@zen-tools/keyboard";

interface Shortcut {
  keys: string;
  action: string;
  context?: string;
}

interface ShortcutGroup {
  app: string;
  shortcuts: Shortcut[];
}

const mod = isMac ? "⌘" : "Ctrl";
const alt = isMac ? "⌥" : "Alt";
const key = (...parts: string[]) => parts.join(" ");

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    app: "Everywhere",
    shortcuts: [
      { keys: key(mod, "+"), action: "Zoom in" },
      { keys: key(mod, "−"), action: "Zoom out" },
      { keys: key(mod, "0"), action: "Reset zoom" },
    ],
  },
  {
    app: "Terminal",
    shortcuts: [
      { keys: key(mod, "⇧", "E"), action: "Show or hide the workspace rail" },
      { keys: key(mod, alt, "F"), action: "Toggle distraction-free mode" },
      { keys: key(mod, "F"), action: "Search the active terminal" },
      { keys: key(mod, "[ / ]"), action: "Previous / next pane" },
      { keys: key(mod, "⇧", "[ / ]"), action: "Previous / next workspace" },
      { keys: key(mod, "N"), action: "New pane" },
      { keys: key(mod, "⇧", "N"), action: "New workspace" },
      { keys: key(mod, "1–9"), action: "Open pinned pane" },
    ],
  },
  {
    app: "Explorer",
    shortcuts: [
      { keys: key(mod, "P"), action: "Find a file" },
      { keys: key(mod, "⇧", "F"), action: "Search file contents" },
      { keys: key(mod, "⇧", "O"), action: "Add a vault folder" },
      { keys: key(mod, "T"), action: "Open a terminal tab" },
      { keys: key(mod, "W"), action: "Close the active tab" },
      { keys: key(mod, alt, "T"), action: "Close other tabs" },
      { keys: key(mod, "1–8 / 9"), action: "Open tab 1–8 / last tab" },
      { keys: key(mod, alt, "[ / ]"), action: "Previous / next tab" },
      { keys: key(mod, "S"), action: "Save the active file", context: "Editor" },
      { keys: key(alt, "R"), action: "Start or stop presenting", context: "Drawing" },
      { keys: "Space Space", action: "Open architecture panel", context: "Drawing" },
    ],
  },
  {
    app: "HTTP Runner",
    shortcuts: [
      { keys: key(mod, "S"), action: "Save the active file" },
      { keys: key(mod, "Enter"), action: "Run request at cursor" },
      { keys: key(mod, "⇧", "Enter"), action: "Run request with dependencies" },
    ],
  },
  {
    app: "Database",
    shortcuts: [
      { keys: key(mod, "S"), action: "Save the active SQL file" },
      { keys: key(mod, "Enter"), action: "Run query" },
      { keys: key(alt, "Enter"), action: "Open query actions" },
      { keys: key(mod, "W"), action: "Close the active result tab" },
      { keys: "/ or F", action: "Focus plan filter", context: "Explain plan" },
      { keys: "Arrow keys", action: "Move through plan nodes", context: "Explain plan" },
      { keys: "Enter / Esc", action: "Zoom into / out of a plan node", context: "Explain plan" },
      { keys: "I", action: "Inspect selected plan node", context: "Explain plan" },
    ],
  },
  {
    app: "Editors",
    shortcuts: [
      { keys: "Ctrl W, H/J/K/L", action: "Move between split panes", context: "HTTP, Explorer, Database" },
      { keys: "Ctrl O / Ctrl I", action: "Jump backward / forward", context: "HTTP, Explorer, Database" },
    ],
  },
  {
    app: "Cleaner",
    shortcuts: [
      { keys: "J/K or ↓/↑", action: "Move cursor" },
      { keys: "G G / ⇧ G", action: "Jump to top / bottom" },
      { keys: "H/L or ←/→", action: "Collapse / expand" },
      { keys: "Space", action: "Cycle the selected action" },
      { keys: "C / D / X", action: "Mark clean / delete / clear" },
      { keys: "Enter", action: "Review and run selected actions" },
      { keys: key(mod, "K"), action: "Open bulk-action palette" },
      { keys: "A / Backspace", action: "Add / remove scan folder" },
      { keys: "R / ⇧ R", action: "Refresh folder / all folders" },
      { keys: "S", action: "Cycle sort order" },
      { keys: "?", action: "Open Cleaner shortcuts" },
    ],
  },
  {
    app: "PRMaster",
    shortcuts: [
      { keys: "1 / 2 / 3", action: "Open Mine / To Review / Reviewed" },
      { keys: "← / →", action: "Previous / next section" },
      { keys: key(mod, "Enter"), action: "Submit a comment", context: "Comment editor" },
      { keys: key(mod, "R"), action: "Refresh commits or merge", context: "Git review" },
      { keys: "F7 / ⇧ F7", action: "Next / previous conflict", context: "Merge editor" },
      { keys: key(mod, "Z"), action: "Undo resolution", context: "Merge editor" },
      { keys: key(mod, "⇧", "Z"), action: "Redo resolution", context: "Merge editor" },
    ],
  },
];

export function ShortcutHelpView() {
  return (
    <div className="flex h-full min-h-0 flex-1 justify-center overflow-auto bg-background">
      <div className="flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">Keyboard shortcuts</h1>
          <p className="text-xs text-muted-foreground">
            Shortcuts are grouped by the app where they are available.
          </p>
        </header>

        <div className="grid items-start gap-4 md:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => (
            <section
              key={group.app}
              className="rounded-md border border-border/60 bg-card/40 p-4"
            >
              <h2 className="mb-3 border-b pb-2 text-sm font-medium">
                {group.app}
              </h2>
              <ul className="space-y-2.5">
                {group.shortcuts.map((shortcut) => (
                  <li
                    key={`${shortcut.keys}-${shortcut.action}`}
                    className="flex items-start justify-between gap-4 text-xs"
                  >
                    <span className="min-w-0 text-muted-foreground">
                      <span className="text-foreground">{shortcut.action}</span>
                      {shortcut.context && (
                        <span className="ml-1 text-[10px]">
                          · {shortcut.context}
                        </span>
                      )}
                    </span>
                    <kbd className="shrink-0 whitespace-nowrap rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground shadow-sm">
                      {shortcut.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
