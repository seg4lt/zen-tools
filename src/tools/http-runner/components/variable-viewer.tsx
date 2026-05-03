import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@zen-tools/ui";
import { Button } from "@zen-tools/ui";
import { Badge } from "@zen-tools/ui";
import { Separator } from "@zen-tools/ui";
import { tauri } from "../lib/tauri";
import { useHttpRunner } from "../store/http-runner-store";

interface VariableRow {
  source: "extracted" | "env";
  key: string;
  value: string;
}

/**
 * Right-side drawer listing every variable that participates in
 * substitution: extracted (response-derived) on top, then env-file values.
 */
export function VariableViewer({ children }: { children: React.ReactNode }) {
  return (
    <Sheet>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent side="right" className="w-[420px] sm:max-w-[420px]">
        <SheetHeader>
          <SheetTitle>Variables</SheetTitle>
          <SheetDescription>
            Values resolved into <code>{`{{placeholders}}`}</code>. Extracted
            values override env values.
          </SheetDescription>
        </SheetHeader>
        <Separator className="my-3" />
        <VariableList />
      </SheetContent>
    </Sheet>
  );
}

function VariableList() {
  const { state } = useHttpRunner();
  const queryClient = useQueryClient();

  const { data: extracted = {} } = useQuery({
    queryKey: ["extracted-vars", state.activeEnv],
    queryFn: () => tauri.getExtractedVars(),
  });

  const { data: env = {} } = useQuery({
    queryKey: ["env-vars", state.activeEnv],
    queryFn: () => tauri.getEnvVars(),
  });

  const rows: VariableRow[] = [
    ...Object.entries(extracted).map(([key, value]) => ({
      source: "extracted" as const,
      key,
      value,
    })),
    ...Object.entries(env)
      .filter(([key]) => !(key in extracted))
      .map(([key, value]) => ({ source: "env" as const, key, value })),
  ];

  const deleteVar = async (key: string) => {
    await tauri.deleteExtractedVar(key);
    void queryClient.invalidateQueries({ queryKey: ["extracted-vars"] });
  };

  const clearAll = async () => {
    await tauri.clearExtractedVars();
    void queryClient.invalidateQueries({ queryKey: ["extracted-vars"] });
  };

  if (rows.length === 0) {
    return (
      <p className="px-1 text-xs text-muted-foreground">
        No variables yet. Run a request that uses <code>@extract</code> or pick
        an environment.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={clearAll}
          disabled={Object.keys(extracted).length === 0}
        >
          Clear extracted
        </Button>
      </div>
      <ul className="flex flex-col gap-px overflow-hidden rounded-md border font-mono text-xs">
        {rows.map((row) => (
          <li
            key={`${row.source}:${row.key}`}
            className="grid grid-cols-[max-content_1fr_max-content] items-center gap-2 bg-card px-2 py-1.5"
          >
            <Badge
              variant={row.source === "extracted" ? "default" : "secondary"}
              className="px-1 text-[10px]"
            >
              {row.source}
            </Badge>
            <div className="flex min-w-0 flex-col">
              <span className="font-semibold text-foreground">{row.key}</span>
              <span className="truncate text-muted-foreground">
                {row.value}
              </span>
            </div>
            {row.source === "extracted" && (
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                onClick={() => deleteVar(row.key)}
                title="Delete"
              >
                <Trash2 className="size-3" />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
