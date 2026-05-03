/**
 * Compact density primitives — local to PRMaster.
 *
 * The shared shadcn `<Card>` ships with generous defaults (`gap-6 py-6`,
 * `[.border-b]:pb-6` on the header) that read fine for a marketing site
 * but waste vertical real estate in a tool packed with rows of settings,
 * filters, and PR cards. PRMaster needs the *information density* of
 * tools like Linear or GitHub — small headers, thin separators, tight
 * row spacing.
 *
 * Rather than fighting the shared Card with `!pb-2` overrides every
 * time, we ship our own dumb wrappers that target the same shadcn
 * tokens (`bg-card`, `text-card-foreground`, `border`) but with
 * PRMaster spacing baked in. Drop-in replacements for `<Card>` /
 * `<CardHeader>` / `<CardContent>` / `<CardTitle>` / `<CardFooter>`.
 */
import { cn } from "@zen-tools/ui";

export function Panel({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel"
      className={cn(
        "flex flex-col rounded-md border bg-card text-card-foreground shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function PanelHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-header"
      className={cn(
        "flex items-center justify-between gap-2 border-b px-3 py-1.5",
        className,
      )}
      {...props}
    />
  );
}

export function PanelTitle({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-title"
      className={cn("text-xs font-medium", className)}
      {...props}
    />
  );
}

export function PanelContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-content"
      className={cn("p-3", className)}
      {...props}
    />
  );
}

export function PanelFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-footer"
      className={cn(
        "flex items-center gap-2 border-t bg-muted/30 px-3 py-1.5",
        className,
      )}
      {...props}
    />
  );
}
