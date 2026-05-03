import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Globe, RefreshCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@zen-tools/ui";
import { Badge } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { tauri } from "../lib/tauri";
import { useHttpRunner } from "../store/http-runner-store";

/**
 * Environment dropdown.
 *
 * Hand-rolled (no Popover / cmdk) because the radix-portal +
 * asChild-merging chain dropped clicks intermittently and the
 * cmdk filter swallowed `onSelect` on the small env list. This
 * version is one `<button>` trigger and one absolutely-positioned
 * `<div>` menu, with a `mousedown` outside-click handler. The
 * trigger uses plain DOM events so there's nothing to be silently
 * proxied.
 */
export function EnvSelector() {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { state, dispatch } = useHttpRunner();
  const queryClient = useQueryClient();

  const {
    data: envs = [],
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ["environments"],
    queryFn: () => tauri.listEnvironments(),
  });

  // Hydrate the active env once on mount.
  useEffect(() => {
    void tauri.getActiveEnvironment().then((name) => {
      if (name) dispatch({ type: "setEnv", env: name });
    });
  }, [dispatch]);

  // Force a fresh fetch every time the menu opens — the env file
  // could have been (re)loaded since the last open.
  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);

  // Close when the user clicks outside the wrapper or hits Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The bootstrap / project-add flow auto-selects an env on the
  // backend. Listen for the broadcast so the badge stays in sync.
  useEffect(() => {
    function onAutoSelected(e: Event) {
      const detail = (e as CustomEvent<{ env: string }>).detail;
      if (!detail?.env) return;
      dispatch({ type: "setEnv", env: detail.env });
      void queryClient.invalidateQueries({ queryKey: ["environments"] });
      void queryClient.invalidateQueries({ queryKey: ["env-vars"] });
      void queryClient.invalidateQueries({ queryKey: ["extracted-vars"] });
    }
    window.addEventListener(
      "zen:env-auto-selected",
      onAutoSelected as EventListener,
    );
    return () =>
      window.removeEventListener(
        "zen:env-auto-selected",
        onAutoSelected as EventListener,
      );
  }, [dispatch, queryClient]);

  const selectEnv = async (name: string) => {
    setOpen(false);
    try {
      await tauri.setActiveEnvironment(name);
      dispatch({ type: "setEnv", env: name });
      void queryClient.invalidateQueries({ queryKey: ["env-vars"] });
      void queryClient.invalidateQueries({ queryKey: ["extracted-vars"] });
    } catch (err) {
      console.error("set active environment failed", err);
    }
  };

  const label = state.activeEnv ?? (envs.length > 0 ? "select env" : "no env");
  const hasEnv = state.activeEnv != null;

  return (
    <div ref={wrapperRef} className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        title="Pick environment"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Globe
          className={
            hasEnv ? "size-3.5 text-primary" : "size-3.5 text-muted-foreground"
          }
        />
        <Badge
          variant={hasEnv ? "default" : "secondary"}
          className="px-1 text-[10px]"
        >
          {label}
        </Badge>
        <ChevronDown className="size-3 opacity-60" />
      </Button>
      {open && (
        <div
          role="dialog"
          className={cn(
            "absolute right-0 top-full z-50 mt-1 w-56 rounded-md border bg-popover text-popover-foreground shadow-md",
            "animate-in fade-in-0 zoom-in-95",
          )}
        >
          <div className="flex items-center justify-between border-b px-2 py-1.5">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Environment
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-5"
              onClick={(e) => {
                e.stopPropagation();
                void refetch();
              }}
              title="Refresh"
              aria-label="Refresh environment list"
            >
              <RefreshCw
                className={cn(
                  "size-3",
                  isFetching && "animate-spin text-primary",
                )}
              />
            </Button>
          </div>
          {envs.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No env file loaded. Open an{" "}
              <code className="font-mono">.http</code> file inside a folder
              with <code className="font-mono">http-client.env.json</code>.
            </div>
          ) : (
            <ul role="listbox" className="max-h-64 overflow-y-auto py-1">
              {envs.map((env) => {
                const active = state.activeEnv === env;
                return (
                  <li key={env} role="option" aria-selected={active}>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        // mousedown (not click) so we win the race
                        // against the outside-click handler that
                        // would otherwise close the menu before
                        // click fires.
                        e.preventDefault();
                        void selectEnv(env);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs",
                        "hover:bg-muted/60 focus:bg-muted/60 focus:outline-none",
                        active && "bg-muted",
                      )}
                    >
                      <Check
                        className={cn(
                          "size-3.5 shrink-0",
                          active
                            ? "opacity-100 text-primary"
                            : "opacity-0",
                        )}
                      />
                      <span className="truncate font-mono">{env}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
