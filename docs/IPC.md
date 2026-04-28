# IPC Contract — `src-tauri` ↔ Front-end

The Rust workspace crates know nothing about Tauri. Only `src-tauri/src/`
imports the `tauri` crate, and it does **two** things:

1. Exposes Rust functions as `#[tauri::command]`s the front-end calls via
   `invoke()`.
2. Pushes streaming progress as named events the front-end subscribes to
   via `listen()`.

Anything you build on top of this contract — the current React UI, a CLI,
a WebSocket bridge, a GTK UI, a vim plugin — works without modifying the
Rust crates. Swapping the UI = re-implement the calls below.

## Architectural layers

```
┌─────────────────────────────────────────────────────────┐
│  Front-end (React today, anything tomorrow)             │
│  Speaks two languages: invoke(...) and listen(...)      │
└──────────────────▲────────────────────▲─────────────────┘
                   │                    │
                   │ JSON IPC           │ JSON events
                   │                    │
┌──────────────────┴────────────────────┴─────────────────┐
│  src-tauri/src/  — the *only* place that knows Tauri    │
│   • commands/  (one file per concern)                   │
│   • dto.rs      (camelCase wire types)                  │
│   • state.rs    (Mutex<AppState>)                       │
│   • error.rs    (AppError → { kind, message })          │
└──────────────────▲──────────────────────────────────────┘
                   │
                   │ pure Rust function calls
                   │
┌──────────────────┴──────────────────────────────────────┐
│  Workspace crates — framework-agnostic                  │
│   zen-types  · zen-parser · zen-http · zen-perf         │
└─────────────────────────────────────────────────────────┘
```

## Commands (request → response)

Every command is `async`, returns either a typed JSON value or an
`AppError` (`{ kind: string, message: string }`). Argument names are
camelCased on the wire (Tauri auto-converts).

### Files / working directory

| Command                       | Args                  | Returns                  |
| ----------------------------- | --------------------- | ------------------------ |
| `set_working_dir`             | `{ path }`            | `string \| null` (auto-picked env) |
| `get_working_dir`             | —                     | `string \| null`         |
| `pick_directory`              | —                     | `string \| null`         |
| `discover_http_files`         | —                     | `FileTreeItem[]`         |
| `discover_perf_files`         | —                     | `FileTreeItem[]`         |
| `find_env_file_command`       | `{ directory }`       | `string \| null`         |

### Parse / read / write

| Command               | Args              | Returns              |
| --------------------- | ----------------- | -------------------- |
| `open_http_file`      | `{ path }`        | `OpenedHttpFileDto`  |
| `read_file_content`   | `{ path }`        | `string`             |
| `write_file_content`  | `{ path, content }` | `void`             |
| `reload_http_file`    | `{ path }`        | `OpenedHttpFileDto`  |

### Environment / cookies

| Command                     | Args                  | Returns                       |
| --------------------------- | --------------------- | ----------------------------- |
| `list_environments`         | —                     | `string[]`                    |
| `set_active_environment`    | `{ envName }`         | `void`                        |
| `get_active_environment`    | —                     | `string \| null`              |
| `get_env_vars`              | —                     | `Record<string, string>`      |
| `get_extracted_vars`        | —                     | `Record<string, string>`      |
| `set_extracted_var`         | `{ key, value }`      | `void`                        |
| `delete_extracted_var`      | `{ key }`             | `void`                        |
| `clear_extracted_vars`      | —                     | `void`                        |
| `get_cookies`               | —                     | `[string, string][]`          |
| `clear_cookies`             | —                     | `void`                        |
| `load_env_file`             | `{ path }`            | `string[]` (env names)        |

### Execute

| Command                  | Args                   | Returns | Streaming events           |
| ------------------------ | ---------------------- | ------- | -------------------------- |
| `run_request`            | `{ filePath, requestId }` | `void` | `request:result`        |
| `run_request_with_deps`  | `{ filePath, requestId }` | `void` | `request:chain` once + `request:result` per step |
| `build_curl_command`     | `{ filePath, requestId }` | `string` | —                       |

Both run commands return immediately; the actual progress flows through
events.

### Performance

| Command                | Args                   | Returns                   | Streaming events |
| ---------------------- | ---------------------- | ------------------------- | ---------------- |
| `load_perf_config`     | `{ path }`             | `PerfConfigDto`           | —                |
| `run_perf_test`        | `{ testIndex }`        | `void`                    | `perf:update`    |
| `stop_perf_test`       | —                      | `void`                    | (last `perf:update` is `Stopped`) |
| `export_perf_results`  | `{ outputDir? }`       | `string` (written path)   | —                |
| `get_perf_metrics`     | —                      | `MetricsSnapshot \| null` | —                |

### Misc

| Command          | Args        | Returns |
| ---------------- | ----------- | ------- |
| `open_in_editor` | `{ path }`  | `void`  |

## Events (push from backend)

Subscribe with `await listen("event:name", e => use(e.payload))`.

### `request:result`

Emitted once per step in a single-request or chain run.

```ts
interface RequestResult {
  requestId: string;
  status:
    | { type: "idle" }
    | { type: "running"; message: string | null }
    | { type: "success"; response: HttpResponse }
    | { type: "error"; message: string };
  extractedVars: Record<string, string>;
  newCookies: [string, string][];
  logMessage: string | null;
  completedAt: string | null;
}
```

### `request:chain`

Fired once at the start of `run_request_with_deps` so the UI can render
the planned execution order before any step has finished.

```ts
{ steps: { id: string; name: string }[] }
```

### `perf:update`

Streaming progress for a perf run.

```ts
type PerfUpdate =
  | { type: "started"; testName: string }
  | { type: "progress"; metrics: MetricsSnapshot; currentUsers: number; targetDurationMs: number }
  | { type: "completed"; testName: string; finalMetrics: MetricsSnapshot }
  | { type: "stopped"; testName: string; finalMetrics: MetricsSnapshot }
  | { type: "error"; testName: string; message: string };
```

## Wire types (full reference)

See:

- `src-tauri/src/dto.rs` — Rust `*Dto` structs with `From<&T>` impls.
- `crates/zen-types/src/{request,response,environment}.rs` — wire-stable
  domain types (`#[serde(rename_all = "camelCase")]` on every public
  struct).
- `crates/zen-perf/src/metrics.rs` — `MetricsSnapshot`.
- `crates/zen-perf/src/runner.rs` — `PerfUpdate`.

`Duration` is always serialised as integer milliseconds. Enums use
`#[serde(tag = "type")]` so TypeScript can discriminate cleanly:

```ts
if (status.type === "success") status.response.statusCode  // typed
```

## Swapping the front-end

Minimal port surface for a fresh UI:

1. **Connection layer**: import `invoke` and `listen` from
   `@tauri-apps/api/core` + `/event`.
2. **Type definitions**: copy `src/tools/http-runner/lib/tauri.ts` and
   `src/tools/http-runner/lib/perf-types.ts` — they already define
   every wire type.
3. **State management**: anything goes — Zustand, Redux, vanilla. The
   contract is async commands + push events, period.
4. **The Rust side stays untouched** — no `src-tauri/` changes needed
   to add a new UI variant.

If you want to ship a CLI variant: skip Tauri entirely, depend directly
on the workspace crates. `zen-perf::PerfRunner::run_test` already takes
an `mpsc::Sender<PerfUpdate>` you can drain to stdout. `zen-http::HttpExecutor`
runs anywhere `tokio` does.
