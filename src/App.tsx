/**
 * Root component — replaced in phase 7 with the TanStack Router shell.
 * For the initial scaffold we render a simple welcome screen so the dev
 * loop is verifiable.
 */
export default function App() {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
      <h1 className="text-3xl font-semibold tracking-tight">Zen Tools</h1>
      <p className="text-muted-foreground">
        Workspace scaffold ready. Tooling will land in subsequent commits.
      </p>
    </div>
  );
}
