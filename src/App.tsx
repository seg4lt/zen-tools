import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "@/hooks/use-theme";
import { TooltipProvider } from "@zen-tools/ui";
import { UpdaterProvider } from "@/lib/updater/use-updater";
import { router } from "@/router";
import { DistractionFreeProvider } from "@/tools/terminal/store/distraction-free";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Stay fresh for 30s — Tauri commands hit local state, not network.
      staleTime: 30_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={200}>
          {/* UpdaterProvider sits above the router so the title bar
              (rendered inside the root route) can read update state
              for the yellow-dot indicator on the Settings icon. The
              banner above the router uses the same source. */}
          <UpdaterProvider>
            {/* Distraction-free mode (cmd+opt+f on the terminal route)
                hides the host TitleBar. Provider sits above the router
                so both <TitleBar> (in the root route) and <TerminalView>
                (inside <Outlet>) read/write the same state. */}
            <DistractionFreeProvider>
              <RouterProvider router={router} />
            </DistractionFreeProvider>
          </UpdaterProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
