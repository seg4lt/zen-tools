/**
 * In-app cheatsheet for the perf YAML schema.
 *
 * Mirrors the Rust `PerfTest` / `TestType` shape verbatim — when you
 * change a field there, update the table here too. The previous flow
 * required users to read `examples/api.perf.yaml` or the parser
 * source to know what fields are available; this Sheet ships the
 * reference next to the editor.
 */
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FieldDoc {
  name: string;
  required?: boolean;
  type: string;
  description: string;
  example?: string;
}

interface TestTypeDoc {
  type: "atomic" | "concurrent" | "stress" | "spike" | "soak";
  summary: string;
  fields: FieldDoc[];
  /** Yaml snippet you can paste into a `tests:` list. */
  example: string;
}

const COMMON_FIELDS: FieldDoc[] = [
  {
    name: "name",
    required: true,
    type: "string",
    description: "Display name shown in the test list and exports.",
    example: '"API Smoke"',
  },
  {
    name: "request",
    required: true,
    type: "string",
    description:
      'Reference to the HTTP request to drive: `"<file>:<request name>"`. Path is relative to the perf YAML.',
    example: '"api.http:GetUsers"',
  },
  {
    name: "type",
    required: true,
    type: "atomic | concurrent | stress | spike | soak",
    description: "Selects the load shape (see sections below).",
  },
];

const TEST_TYPES: TestTypeDoc[] = [
  {
    type: "atomic",
    summary:
      "Single-shot baseline. Fires the request once, captures latency + assertion outcome. Useful as a smoke test or sanity check.",
    fields: [],
    example: `- name: "Login Smoke"
  request: "auth.http:Login"
  type: atomic`,
  },
  {
    type: "concurrent",
    summary:
      "Steady-state load. N virtual users hammer the request for `duration`. Pair with `rps` to cap the global request rate.",
    fields: [
      {
        name: "users",
        required: true,
        type: "u32",
        description: "Concurrent virtual users.",
        example: "10",
      },
      {
        name: "duration",
        required: true,
        type: "duration",
        description:
          "Wall-clock duration. Accepts humantime strings (`30s`, `5m`, `1h`).",
        example: "30s",
      },
      {
        name: "rps",
        type: "u32",
        description:
          "Optional global request-per-second cap. Without it users fire as fast as the server allows.",
        example: "100",
      },
    ],
    example: `- name: "API Load"
  request: "api.http:GetUsers"
  type: concurrent
  users: 10
  duration: 30s
  rps: 100`,
  },
  {
    type: "stress",
    summary:
      "Linear ramp-up. Starts at `start_users`, climbs to `end_users` over `ramp_up`, then holds the peak until `duration` elapses.",
    fields: [
      {
        name: "start_users",
        required: true,
        type: "u32",
        description: "Initial concurrent users.",
        example: "1",
      },
      {
        name: "end_users",
        required: true,
        type: "u32",
        description: "Peak concurrent users.",
        example: "50",
      },
      {
        name: "ramp_up",
        required: true,
        type: "duration",
        description: "Time taken to grow from `start_users` → `end_users`.",
        example: "10s",
      },
      {
        name: "duration",
        required: true,
        type: "duration",
        description: "Total wall-clock duration *including* the ramp.",
        example: "1m",
      },
      {
        name: "rps",
        type: "u32",
        description: "Optional global rate cap (req/s).",
      },
    ],
    example: `- name: "Stress GetUsers"
  request: "api.http:GetUsers"
  type: stress
  start_users: 1
  end_users: 50
  ramp_up: 10s
  duration: 1m`,
  },
  {
    type: "spike",
    summary:
      "Sudden burst on top of a baseline. Runs at `base_users` for the first third of `total_duration`, then jumps to `spike_users` for `spike_duration`, then drops back to baseline.",
    fields: [
      {
        name: "base_users",
        required: true,
        type: "u32",
        description: "Steady baseline user count outside the spike.",
        example: "5",
      },
      {
        name: "spike_users",
        required: true,
        type: "u32",
        description: "Peak user count during the spike window.",
        example: "30",
      },
      {
        name: "spike_duration",
        required: true,
        type: "duration",
        description: "How long the spike holds.",
        example: "10s",
      },
      {
        name: "total_duration",
        required: true,
        type: "duration",
        description:
          "Full test duration. Spike begins at `total_duration / 3`.",
        example: "60s",
      },
      {
        name: "rps",
        type: "u32",
        description: "Optional global rate cap (req/s).",
      },
    ],
    example: `- name: "Spike Login"
  request: "auth.http:Login"
  type: spike
  base_users: 5
  spike_users: 30
  spike_duration: 10s
  total_duration: 60s`,
  },
  {
    type: "soak",
    summary:
      "Long-running steady load — equivalent to `concurrent` but signals intent. Use for memory-leak / endurance testing.",
    fields: [
      {
        name: "users",
        required: true,
        type: "u32",
        description: "Concurrent virtual users.",
        example: "5",
      },
      {
        name: "duration",
        required: true,
        type: "duration",
        description: "Wall-clock duration. Often `1h+`.",
        example: "1h",
      },
      {
        name: "rps",
        type: "u32",
        description: "Optional global rate cap (req/s).",
      },
    ],
    example: `- name: "Health Soak"
  request: "api.http:Health"
  type: soak
  users: 5
  duration: 1h`,
  },
];

const VARIABLES_BLURB = `# perf.variable.yaml — one per directory, looked up upward
load_users: 10
load_duration: 30s
load_rps: 100`;

const VARIABLES_USAGE = `# api.perf.yaml — refers to vars with {{...}}
tests:
  - name: "API Load"
    request: "api.http:GetUsers"
    type: concurrent
    users: {{load_users}}
    duration: {{load_duration}}
    rps: {{load_rps}}`;

/**
 * Trigger + side-sheet that shows everything you can put in a perf
 * YAML, with copy-pasteable snippets per test type.
 */
export function PerfSchemaSheet({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent
        side="right"
        className="w-[min(38rem,100vw)] sm:max-w-none p-0 flex flex-col"
      >
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="text-sm">Perf YAML reference</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 py-4 text-xs">
          <Section title="File shape">
            <p className="text-muted-foreground">
              A perf YAML declares a top-level <Code>tests</Code> list.
              Each entry is one perf test. Fields below are common to every
              test; variant-specific fields are listed per test type.
            </p>
            <FieldTable fields={COMMON_FIELDS} />
          </Section>

          {TEST_TYPES.map((t) => (
            <Section
              key={t.type}
              title={
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-primary">{t.type}</span>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    type:
                  </span>
                  <span className="font-mono text-muted-foreground">
                    "{t.type}"
                  </span>
                </span>
              }
            >
              <p className="text-muted-foreground">{t.summary}</p>
              {t.fields.length > 0 ? (
                <FieldTable fields={t.fields} />
              ) : (
                <p className="text-muted-foreground italic">
                  No additional fields.
                </p>
              )}
              <Snippet code={t.example} />
            </Section>
          ))}

          <Section title="Variables (perf.variable.yaml)">
            <p className="text-muted-foreground">
              Place a <Code>perf.variable.yaml</Code> next to (or above) your
              perf config. Values cascade upward, so a sibling file wins over
              an ancestor.
            </p>
            <Snippet code={VARIABLES_BLURB} />
            <p className="text-muted-foreground">
              Reference variables anywhere in the perf YAML (including the
              <Code>request</Code> path) using <Code>{"{{name}}"}</Code>:
            </p>
            <Snippet code={VARIABLES_USAGE} />
          </Section>

          <Section title="Assertions">
            <p className="text-muted-foreground">
              Per-request assertions live in the <Code>.http</Code> file (not
              the perf YAML) via <Code># @assert</Code> annotations. The runner
              evaluates each one for every sample and surfaces the failure
              count in the metrics dashboard.
            </p>
            <Snippet
              code={`### GetUsers
GET {{baseUrl}}/users
Authorization: Bearer {{token}}
# @assert status = 200
# @assert response_time < 500
# @assert body.length > 0`}
            />
          </Section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Section({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6 flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function FieldTable({ fields }: { fields: FieldDoc[] }) {
  return (
    <div className="overflow-hidden rounded-md border">
      <table className="w-full border-collapse text-[11px]">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium">Name</th>
            <th className="px-2 py-1.5 text-left font-medium">Type</th>
            <th className="px-2 py-1.5 text-left font-medium">Description</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f, idx) => (
            <tr
              key={f.name}
              className={cn(
                "align-top",
                idx % 2 === 1 && "bg-muted/20",
              )}
            >
              <td className="px-2 py-1.5 font-mono">
                {f.name}
                {f.required && (
                  <span
                    className="ml-1 text-destructive"
                    title="required"
                    aria-label="required"
                  >
                    *
                  </span>
                )}
                {f.example && (
                  <div className="mt-0.5 text-[10px] font-normal text-muted-foreground">
                    e.g. <span className="font-mono">{f.example}</span>
                  </div>
                )}
              </td>
              <td className="px-2 py-1.5 font-mono text-muted-foreground">
                {f.type}
              </td>
              <td className="px-2 py-1.5 text-muted-foreground">
                {f.description}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10.5px]">
      {children}
    </code>
  );
}

function Snippet({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("clipboard write failed", err);
    }
  };
  return (
    <div className="relative rounded-md border bg-muted/40">
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-1 top-1 size-6"
        onClick={onCopy}
        title={copied ? "Copied" : "Copy"}
        aria-label={copied ? "Copied" : "Copy snippet"}
      >
        {copied ? (
          <Check className="size-3 text-emerald-500" />
        ) : (
          <Copy className="size-3" />
        )}
      </Button>
      <pre className="overflow-x-auto px-3 py-2 pr-9 font-mono text-[10.5px] leading-relaxed">
        {code}
      </pre>
    </div>
  );
}
