/**
 * Drag-reorder + enable/disable list for the title-bar tool pills.
 *
 * Built on dnd-kit's sortable preset — keyboard reorder works out of
 * the box (Tab to a row, Space to lift, arrow keys to move, Space to
 * drop). Each row also carries a `<Switch>` so the user can turn an
 * app off without removing it from the order; disabled rows render
 * dimmed and stay draggable.
 *
 * Disabling routes through `setDisabled`, which talks to the
 * `set_tool_disabled` Tauri command — the backend uses that signal
 * to start/stop PRMaster's tray, polling loop, hotkey, and
 * broadcast bridge live (no app restart).
 */
import { GripVertical } from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Switch, cn } from "@zen-tools/ui";
import { useToolOrder } from "@/hooks/use-tool-order";
import type { Tool } from "@/config/tools";

export function AppOrderList() {
  const { allTools, disabledIds, setOrder, setDisabled } = useToolOrder();

  const sensors = useSensors(
    // Activation distance keeps simple click-on-row from registering
    // as a drag attempt — the row has no other click action today
    // but it's good hygiene if we ever add one.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = allTools.findIndex((t) => t.id === active.id);
    const newIndex = allTools.findIndex((t) => t.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(allTools, oldIndex, newIndex).map((t) => t.id);
    void setOrder(next);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={allTools.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul className="flex flex-col gap-1">
          {allTools.map((t) => (
            <SortableRow
              key={t.id}
              tool={t}
              disabled={disabledIds.has(t.id)}
              onToggle={(next) => void setDisabled(t.id, !next)}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

interface SortableRowProps {
  tool: Tool;
  disabled: boolean;
  /** Receives the new "enabled" state — `true` when the user just turned it on. */
  onToggle: (enabled: boolean) => void;
}

function SortableRow({ tool, disabled, onToggle }: SortableRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tool.id });
  const Icon = tool.icon;
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        "flex items-center gap-2 rounded border border-border/60 bg-background px-2 py-1.5 text-sm",
        isDragging && "opacity-60 shadow-md",
        disabled && !isDragging && "opacity-60",
      )}
    >
      <button
        type="button"
        className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted/60 active:cursor-grabbing"
        aria-label={`Reorder ${tool.label}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5" />
      </button>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{tool.label}</span>
      {tool.description && (
        <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
          {tool.description}
        </span>
      )}
      <Switch
        checked={!disabled}
        onCheckedChange={onToggle}
        aria-label={disabled ? `Enable ${tool.label}` : `Disable ${tool.label}`}
        // Don't let the dnd-kit drag listeners on the parent row
        // capture the click that toggles the switch.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      />
    </li>
  );
}
