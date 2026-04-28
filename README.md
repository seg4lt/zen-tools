# Zen Tools

A modular Tauri 2 desktop app hosting developer tooling. The first tool is an
IntelliJ-style HTTP file runner with performance testing — ported from
`rust-tui-http-file-runner`.

## Workspace layout

```
crates/
  zen-types/     # pure data model (no I/O)
  zen-parser/    # .http / env JSON / perf YAML parsing
  zen-http/      # HTTP execution, variables, dependency resolution
  zen-perf/      # load testing, metrics, CSV export
src-tauri/       # Tauri 2 binary that composes the crates
src/             # React frontend (TanStack Router, Tailwind, shadcn, CodeMirror)
```

## Develop

```bash
pnpm install
pnpm tauri dev
```

## Build

```bash
pnpm tauri build
```

## Lint / test

```bash
pnpm lint                      # tsc --noEmit
cargo check --workspace
cargo clippy --workspace -- -D warnings
cargo test --workspace
```
