# Zen Tools

A modular Tauri 2 desktop app hosting developer tooling. The first tool is an
IntelliJ-style **HTTP file runner** with a built-in **performance testing**
engine — ported from `rust-tui-http-file-runner`.

The shell is designed so additional tools can drop in next to the HTTP
runner without changing the routing or layout: each tool registers itself
in `src/config/tools.ts` and gets its own segmented-pill in the title bar.

## Stack

| Layer        | Tech                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| Backend      | **Rust** Cargo workspace · Tauri 2                                      |
| HTTP runtime | `reqwest` (rustls), `tokio`, `petgraph`, `jsonpath-rust`, `urlencoding` |
| Perf runtime | `hdrhistogram`, `tokio::sync::watch` stop signal                        |
| Frontend     | **React 18** · TypeScript · Vite · Tailwind v4 · shadcn (new-york)      |
| Routing      | TanStack Router (code-based)                                            |
| Data         | TanStack Query · React Context + `useReducer`                           |
| Editor       | **CodeMirror 6** vanilla · Vim mode · custom `.http` `StreamLanguage`   |
| Charts       | `recharts` (sparklines + bucket histogram)                              |
| Package mgr  | `pnpm`                                                                  |

## Workspace layout

```
zen-tools/
├── Cargo.toml                # workspace root + shared dep declarations
├── crates/
│   ├── zen-types/            # pure data model — no I/O, no async
│   ├── zen-parser/           # .http / env JSON / perf YAML parsers
│   ├── zen-http/             # HTTP execution + variables + dep graph
│   ├── zen-perf/             # load test engine + metrics + CSV export
│   └── zen-test-server/      # axum mock backend (port 3000) for examples/
├── src-tauri/                # Tauri binary that composes the crates
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs / lib.rs
│       ├── state.rs          # AppState (Mutex<AppState>)
│       ├── error.rs          # AppError ({ kind, message } over IPC)
│       ├── dto.rs            # serializable boundary types
│       └── commands/
│           ├── files.rs      # tree, working dir, env discovery
│           ├── parse.rs      # open / read / write / reload .http files
│           ├── environment.rs# env, extracted vars, cookies
│           ├── execute.rs    # run_request, run_request_with_deps,
│           │                 # build_curl_command (request:* events)
│           ├── perf.rs       # load_perf_config, run/stop/export
│           │                 # (perf:update events)
│           └── misc.rs       # open_in_editor
├── src/                      # React frontend
│   ├── components/
│   │   ├── ui/               # shadcn primitives
│   │   ├── app-shell/        # title bar, tool pills, working-dir picker
│   │   └── theme-toggle.tsx
│   ├── config/tools.ts       # tool registry — drives the title bar
│   ├── lib/
│   │   ├── utils.ts
│   │   └── keyboard/         # DSL-based global keybinding registry
│   ├── hooks/use-theme.tsx
│   ├── router.tsx            # TanStack Router code tree
│   └── tools/http-runner/
│       ├── HTTPRunnerShell.tsx
│       ├── RequestsView.tsx
│       ├── PerformanceView.tsx
│       ├── components/       # editor, file tree, response panel, etc.
│       ├── store/            # useReducer + Context
│       └── lib/              # tauri client, lang-http, run-gutter,
│                             # cm-theme, perf-types
└── examples/                 # sample .http / env / perf YAML files
```

## Develop

Prerequisites: pnpm (10+), Rust 1.78+, the platform's WebView runtime
(WebKit on macOS — comes with the OS).

```bash
pnpm install
pnpm tauri dev
```

The first cold build of the Tauri target takes ~1 minute; subsequent
runs are quick.

## Build a release bundle

```bash
pnpm tauri build
```

## Run quality gates

```bash
pnpm lint                                  # tsc --noEmit
cargo fmt --all
cargo clippy --workspace -- -D warnings
cargo test --workspace                     # 32 unit tests across 4 crates
```

## Try it out

1. **In one terminal**, boot the mock backend the examples talk to:

   ```bash
   cargo run -p zen-test-server
   ```

   It listens on `http://localhost:3000` and serves `/api/users`,
   `/api/auth/login` (password `password123`), `/api/session/*`,
   `/api/slow?ms=N`, `/api/random-delay`, and a handful of others.
   The `examples/http-client.env.json` `development` env is already
   pointed at it.

2. **In another terminal**, run the app:

   ```bash
   pnpm tauri dev
   ```

3. Click the folder icon in the title bar and pick this repo's
   `examples/` directory, then choose the `development` environment in
   the env selector (it points at `http://localhost:3000`).
4. Open `api.http` from the file tree.
5. Click the ▶ icon next to a request line — or place the cursor on the
   request and press **Cmd+Enter**.
6. Press **Cmd+Shift+Enter** on `GetUsers` to run it with its cross-file
   dependency on `auth.http:Login`. The Dependency Chain tab shows the
   full chain status and the Variables drawer shows the extracted
   `token`.
7. Switch to the Performance tab (`Cmd+2`), pick `api.perf.yaml`, run
   "Login Baseline" or "API Load Test", watch live counters + charts,
   and click Export to save a `*_summary.csv`.

## File formats

### `.http` / `.rest`

Standard IntelliJ HTTP client syntax with annotations:

```http
@baseUrl = {{host}}/api

### Login
# @name Login
# @extract token = $.accessToken
# @assert status = 200
POST {{baseUrl}}/auth/login
Content-Type: application/json

{ "username": "{{username}}", "password": "{{password}}" }

### Get Users
# @name GetUsers
# @depends auth.http:Login
GET {{baseUrl}}/users
Authorization: Bearer {{token}}
```

Cross-file dependencies use `file:Name` (where `file.http`/`file.rest`).

### `*.perf.yaml`

```yaml
tests:
  - name: "Login Baseline"
    request: "auth.http:Login"
    type: atomic

  - name: "API Load Test"
    request: "api.http:GetUsers"
    type: concurrent
    users: 10
    duration: 30s
    rps: 20

  - name: "Stress Test"
    request: "api.http:GetUsers"
    type: stress
    start_users: 1
    end_users: 50
    ramp_up: 10s
    duration: 60s
```

`{{placeholders}}` in a perf config are substituted from any
`perf.variable.yaml` files found at or above the config's directory.

### `http-client.env.json`

```json
{
  "development": { "host": "http://localhost:3000", "username": "dev" },
  "production":  { "host": "https://api.example.com" }
}
```

`http-client.private.env.json` and `.env.json` are also discovered (in
that priority order). Discovery walks the directory tree upward from the
opened file.

## Keyboard shortcuts

| Action                          | Shortcut                                |
| ------------------------------- | --------------------------------------- |
| Switch to Requests sub-view     | <kbd>⌘1</kbd> / <kbd>Ctrl+1</kbd>       |
| Switch to Performance sub-view  | <kbd>⌘2</kbd> / <kbd>Ctrl+2</kbd>       |
| Run request at cursor           | <kbd>⌘Enter</kbd> / <kbd>Ctrl+Enter</kbd> |
| Run with dependencies           | <kbd>⌘⇧Enter</kbd> / <kbd>Ctrl+Shift+Enter</kbd> |
| Save the open file              | <kbd>⌘S</kbd> / <kbd>Ctrl+S</kbd>       |
| Editor (Vim mode)               | full Vim normal/insert/visual + `:w`    |

## Architecture notes

- **Workspace crates are framework-agnostic.** `zen-perf::PerfRunner`
  emits `PerfUpdate` over an `mpsc::Sender`; the Tauri layer drains it
  and translates each value into a `perf:update` event. Swapping in a
  CLI host would only require a different translator.
- **`HttpExecutor` is `Clone`-cheap** (Arc-wrapped reqwest client) so
  every spawned worker shares the same connection pool.
- **`FileRegistry` uses a parking_lot `RwLock`** holding
  `Arc<HttpFile>` values, so concurrent reads during cross-file
  dependency resolution don't block each other.
- **DTO layer (`src-tauri/src/dto.rs`)** keeps wire shapes camelCased
  and converts `Duration` → `u64 ms` etc. Internal model types stay
  high-precision.
- **No Mutex held across `await`.** Run commands snapshot context, drop
  the lock, and only re-acquire to persist results.
- **`tokio::sync::watch::Sender<bool>`** replaces the old
  `Arc<AtomicBool>` stop signal — workers fan out the cancel without
  polling.
- **Frontend rAF-batches `perf:update` events** so high-frequency
  progress messages don't trigger a re-render storm.
