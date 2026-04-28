import { useEffect, useState } from "react";
import { Check, ChevronDown, Globe } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { tauri } from "../lib/tauri";
import { useHttpRunner } from "../store/http-runner-store";

/** Top-bar combobox letting the user pick the active environment. */
export function EnvSelector() {
  const [open, setOpen] = useState(false);
  const { state, dispatch } = useHttpRunner();
  const queryClient = useQueryClient();

  const { data: envs = [] } = useQuery({
    queryKey: ["environments"],
    queryFn: () => tauri.listEnvironments(),
  });

  // Hydrate the active env once on mount.
  useEffect(() => {
    void tauri.getActiveEnvironment().then((name) => {
      if (name) dispatch({ type: "setEnv", env: name });
    });
  }, [dispatch]);

  const selectEnv = async (name: string) => {
    setOpen(false);
    await tauri.setActiveEnvironment(name);
    dispatch({ type: "setEnv", env: name });
    void queryClient.invalidateQueries({ queryKey: ["env-vars"] });
    void queryClient.invalidateQueries({ queryKey: ["extracted-vars"] });
  };

  const label = state.activeEnv ?? "no env";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          title="Pick environment"
        >
          <Globe className="size-3.5" />
          <Badge variant="secondary" className="px-1 text-[10px]">
            {label}
          </Badge>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="end">
        <Command>
          <CommandInput placeholder="Search environments…" className="h-8" />
          <CommandList>
            <CommandEmpty>No environments found.</CommandEmpty>
            <CommandGroup>
              {envs.map((env) => (
                <CommandItem
                  key={env}
                  value={env}
                  onSelect={() => selectEnv(env)}
                  className="text-xs"
                >
                  <Check
                    className={
                      state.activeEnv === env
                        ? "size-3.5 opacity-100"
                        : "size-3.5 opacity-0"
                    }
                  />
                  {env}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
