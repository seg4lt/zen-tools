/**
 * Drag-reorder list for the title-bar tool pills. Built on dnd-kit's
 * sortable preset — keyboard reorder works out of the box (Tab to a
 * row, Space to lift, arrow keys to move, Space to drop).
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
import { cn } from "@/lib/utils";
import { useToolOrder } from "@/hooks/use-tool-order";
import type { Tool } from "@/config/tools";

export function AppOrderList() {
  const { tools, setOrder } = useToolOrder();

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
    const oldIndex = tools.findIndex((t) => t.id === active.id);
    const newIndex = tools.findIndex((t) => t.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(tools, oldIndex, newIndex).map((t) => t.id);
    void setOrder(next);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={tools.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul className="flex flex-col gap-1">
          {tools.map((t) => (
            <SortableRow key={t.id} tool={t} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({ tool }: { tool: Tool }) {
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
    </li>
  );
}
