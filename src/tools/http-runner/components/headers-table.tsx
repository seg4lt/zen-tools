import { cn } from "@/lib/utils";

interface HeadersTableProps {
  headers: Record<string, string>;
}

/** Vertical key/value table for response headers. */
export function HeadersTable({ headers }: HeadersTableProps) {
  const entries = Object.entries(headers);
  if (entries.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground">No headers.</div>
    );
  }
  return (
    <ul className="divide-y font-mono text-xs">
      {entries.map(([k, v], idx) => (
        <li
          key={`${k}-${idx}`}
          className={cn(
            "grid grid-cols-[max-content_1fr] gap-3 px-3 py-1.5",
            idx % 2 === 1 && "bg-muted/30",
          )}
        >
          <span className="font-semibold text-muted-foreground">{k}</span>
          <span className="break-all">{v}</span>
        </li>
      ))}
    </ul>
  );
}
