/**
 * Keybinding cheatsheet overlay (bound to `?`).
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@zen-tools/ui";
import { useCleanerStore } from "../store/cleaner-store";

interface Binding {
  keys: string[];
  description: string;
}

const BINDINGS: { group: string; items: Binding[] }[] = [
  {
    group: "Navigation",
    items: [
      { keys: ["j", "↓"], description: "Move cursor down" },
      { keys: ["k", "↑"], description: "Move cursor up" },
      { keys: ["g g"], description: "Top of list" },
      { keys: ["G"], description: "Bottom of list" },
      { keys: ["h", "←"], description: "Collapse section" },
      { keys: ["l", "→"], description: "Expand section" },
    ],
  },
  {
    group: "Marking",
    items: [
      { keys: ["Space"], description: "Cycle action under cursor" },
      { keys: ["c"], description: "Mark Clean" },
      { keys: ["d"], description: "Mark Delete" },
      { keys: ["x"], description: "Clear mark" },
    ],
  },
  {
    group: "Run",
    items: [
      { keys: ["Enter"], description: "Open run-confirm dialog" },
      { keys: ["Esc"], description: "Close dialog / palette / sheet" },
    ],
  },
  {
    group: "Folders",
    items: [
      { keys: ["a"], description: "Add scan folder (native picker)" },
      { keys: ["r"], description: "Refresh folder under cursor" },
      { keys: ["Shift+R"], description: "Refresh every folder" },
    ],
  },
  {
    group: "Sort",
    items: [
      { keys: ["s"], description: "Cycle sort: alpha → clean → delete" },
    ],
  },
  {
    group: "Overlays",
    items: [
      { keys: ["⌘ K", "Ctrl K"], description: "Bulk-action palette" },
      { keys: ["?"], description: "This cheatsheet" },
    ],
  },
];

export function HelpOverlay() {
  const { state, dispatch } = useCleanerStore();

  return (
    <Dialog
      open={state.helpOpen}
      onOpenChange={(open) => dispatch({ type: "setHelp", open })}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            The Cleaner is fully keyboard-driven — every action below is
            available from the palette too (⌘K).
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {BINDINGS.map((g) => (
            <section key={g.group}>
              <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {g.group}
              </h3>
              <ul className="space-y-1 text-xs">
                {g.items.map((b) => (
                  <li
                    key={b.keys.join("|")}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="text-muted-foreground/80">
                      {b.description}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1">
                      {b.keys.map((k) => (
                        <kbd
                          key={k}
                          className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
