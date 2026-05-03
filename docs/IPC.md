# IPC Reference

Tauri command surface exposed by `src-tauri` to the frontend, plus the
events emitted back. Every command is registered in `invoke_handler!`
in `src-tauri/src/lib.rs`; the typed wrappers consumers should use live
in each tool's `src/tools/<tool>/lib/tauri.ts`. Cross-tool commands
(preferences, file pick / read / write) are wrapped in
`@zen-tools/ipc`.

102 commands total, grouped by domain.

## Conventions

- Inputs and outputs use `serde` so JSON values mirror Rust struct
  shapes. Tauri converts `snake_case` field names on the input side to
  `camelCase` when the type isn't returned directly to the frontend.
  Types returned through `src-tauri/src/dto.rs` apply
  `#[serde(rename_all = "camelCase")]` consistently. Types returned
  directly from `zen-prmaster` / `zen-github` (notification filters,
  PR settings, gh call log, etc.) currently keep snake_case on the
  wire — frontend mirrors must match. Phase 4.2 of the cleanup plan
  proposes a one-time normalisation; until then, do not add
  `rename_all = "camelCase"` to those crate types without updating
  every TS DTO in lockstep.
- Errors serialise as `{ kind, message }` (see `error.rs::AppError`).
  `kind` is one of: `io`, `parser`, `http`, `dependency`,
  `crossFileDependency`, `fileRegistry`, `perf`, `db`, `github`,
  `storage`, `tauri`, `other`, `badRequest`, `notInitialised`.
- All commands are `async`. Long-running commands (perf runs, DB
  queries, content searches) emit progress events while the call is
  in flight.

## Commands by tool

### Files & projects (HTTP runner working dirs)

| Command | Inputs | Returns |
|---|---|---|
| `discover_http_files` | — | `DiscoveredProject[]` (one per working dir) |
| `find_env_file_command` | `dir: string` | `string \| null` |
| `add_working_dir` | `path: string` | `string[]` (updated list) |
| `remove_working_dir` | `path: string` | `string[]` (updated list) |
| `list_working_dirs` | — | `string[]` |
| `pick_directory` | — | `string \| null` (native folder picker) |

### HTTP file open / read / write

| Command | Inputs | Returns |
|---|---|---|
| `open_http_file` | `path: string` | `OpenedHttpFileDto` (parsed file + env) |
| `read_file_content` | `path: string` | `string` |
| `write_file_content` | `path: string, content: string` | `void` |
| `reload_http_file` | `path: string` | `OpenedHttpFileDto` |

### Environments

| Command | Inputs | Returns |
|---|---|---|
| `list_environments` | — | `string[]` (env names) |
| `set_active_environment` | `name: string` | `void` |
| `get_active_environment` | — | `string \| null` |
| `get_env_vars` | — | `Record<string, string>` |
| `get_extracted_vars` | — | `Record<string, string>` |
| `set_extracted_var` | `key: string, value: string` | `void` |
| `delete_extracted_var` | `key: string` | `void` |
| `clear_extracted_vars` | — | `void` |
| `get_cookies` | — | `[string, string][]` |
| `clear_cookies` | — | `void` |
| `load_env_file` | `path: string` | `EnvironmentFileDto` |

### Execute

| Command | Inputs | Returns |
|---|---|---|
| `run_request` | `request_id: string` | `RequestResult` |
| `run_request_with_deps` | `request_id: string` | `RequestResult` (chain final) |
| `build_curl_command` | `request_id: string` | `string` |

### Performance

| Command | Inputs | Returns |
|---|---|---|
| `load_perf_config` | `path: string` | `PerfConfigDto` |
| `get_perf_metrics` | — | `MetricsSnapshot` |
| `run_perf_test` | `test_id: string` | `void` (emits `perf:update`) |
| `stop_perf_test` | — | `void` |
| `export_perf_results` | `dir: string` | `string` (CSV path) |

### Preferences

Wrapped in `@zen-tools/ipc` — every tool consumes through that
package, not directly.

| Command | Inputs | Returns |
|---|---|---|
| `get_preferences` | — | `Preferences` |
| `save_preferences` | `prefs: Preferences` | `void` |

### Run history

| Command | Inputs | Returns |
|---|---|---|
| `record_run` | `request_id: string, entry: RunHistoryEntry` | `void` |
| `get_run_history` | `request_id: string` | `RunHistoryEntry[]` |
| `clear_run_history` | `request_id?: string` | `void` |

### Misc

| Command | Inputs | Returns |
|---|---|---|
| `open_in_editor` | `path: string` | `void` (launches `$EDITOR` or `open`) |

### Process Monitor

| Command | Inputs | Returns |
|---|---|---|
| `pm_list_processes` | — | `ProcSummary[]` |
| `pm_add_target` | `pid: number` | `void` |
| `pm_remove_target` | `pid: number` | `void` |
| `pm_set_targets` | `pids: number[]` | `void` |
| `pm_clear_targets` | — | `void` |
| `pm_get_config` | — | `PmConfig` |
| `pm_get_history` | — | `Sample[]` |
| `pm_set_poll_interval` | `pollMs: number` | `void` |
| `pm_popover_close` | — | `void` |
| `pm_show_main_window` | — | `void` |

### Cleaner

| Command | Inputs | Returns |
|---|---|---|
| `cleaner_list_scan_folders` | — | `string[]` |
| `cleaner_add_scan_folder` | `path: string` | `string[]` |
| `cleaner_remove_scan_folder` | `path: string` | `string[]` |
| `cleaner_scan_folder` | `path: string` | `void` (emits `cleaner:*`) |
| `cleaner_discover_globals` | — | `Tree` |
| `cleaner_run_actions` | `items: RunActionItem[]` | `RunResultDto` |
| `cleaner_get_cached_tree` | `path: string` | `Tree \| null` |

### Markdown

| Command | Inputs | Returns |
|---|---|---|
| `markdown_list_vaults` | — | `string[]` |
| `markdown_add_vault` | `path: string` | `string[]` |
| `markdown_remove_vault` | `path: string` | `string[]` |
| `markdown_discover_files` | `vaults: string[]` | `MarkdownVaultDto[]` |
| `markdown_recent_files` | — | `string[]` |
| `markdown_push_recent` | `path: string` | `string[]` |
| `markdown_create_file` | `parentDir: string, name: string` | `string` |
| `markdown_create_dir` | `parentDir: string, name: string` | `string` |
| `markdown_rename` | `oldPath: string, newName: string` | `string` |
| `markdown_move` | `source: string, targetDir: string` | `string` |
| `markdown_delete_to_trash` | `path: string` | `void` |
| `markdown_search_contents` | `vaults, query, options, token` | `ContentBlock[]` |
| `markdown_stop_content_search` | `token: number` | `void` |
| `markdown_search_files` | `vaults, query, currentFile` | `string[]` |
| `markdown_save_pasted_image` | `targetDir, fileName, bytes` | `string` |
| `markdown_copy_svg_as_png` | `svg: string, scale: number` | `void` |
| `markdown_write_bytes` | `path: string, bytes: number[]` | `void` |

### Database Explorer

| Command | Inputs | Returns |
|---|---|---|
| `db_test_connection` | `input: DbConnectionInput` | `void` |
| `db_save_connection` | `input: DbConnectionInput` | `string` (id) |
| `db_delete_connection` | `id: string` | `void` |
| `db_list_saved_connections` | — | `DbConnectionPrefs[]` |
| `db_connect` | `id: string` | `void` |
| `db_disconnect` | `id: string` | `void` |
| `db_list_databases` | `id: string` | `string[]` |
| `db_list_schemas` | `id: string, database: string` | `string[]` |
| `db_list_tables` | `id, database, schema` | `string[]` |
| `db_list_all_tables` | `id, database` | `TableSummary[]` |
| `db_list_routines` | `id, database, schema` | `RoutineDescription[]` |
| `db_query` | `id, sql, options?` | `QueryResult[]` |
| `db_explain_query` | `id, sql, format` | `ExplainResult` |
| `db_describe_table` | `id, database, schema, table` | `TableDescription` |
| `db_describe_tables_bulk` | `id, database, schema, tables[]` | `TableDescription[]` |
| `db_list_cached_tables` | `id, database, schema` | `CachedTableMeta[]` |
| `db_invalidate_schema_cache` | `id, database, schema, tables[]` | `void` |

### SQL workspace

| Command | Inputs | Returns |
|---|---|---|
| `sql_workspace_list` | — | `string[]` |
| `sql_workspace_add` | `path: string` | `string[]` |
| `sql_workspace_remove` | `path: string` | `string[]` |
| `sql_workspace_discover` | `roots: string[]` | `DiscoveredSqlProject[]` |
| `sql_workspace_create_file` | `parentDir, name` | `string` |
| `sql_workspace_create_dir` | `parentDir, name` | `string` |
| `sql_workspace_rename` | `oldPath, newName` | `string` |
| `sql_workspace_delete_to_trash` | `path` | `void` |

### PRMaster

| Command | Inputs | Returns |
|---|---|---|
| `prmaster_whoami` | — | `string` |
| `prmaster_get_gh_status` | — | `AuthStatus` |
| `prmaster_get_mine` | — | `EnrichedPullRequest[]` |
| `prmaster_get_to_review` | — | `EnrichedPullRequest[]` |
| `prmaster_get_reviewed` | — | `EnrichedPullRequest[]` |
| `prmaster_get_conversations` | — | `ConversationGroup[]` |
| `prmaster_approve_pr` | `pr: PrRef` | `void` |
| `prmaster_request_changes` | `pr: PrRef, body: string` | `void` |
| `prmaster_add_self_reviewer` | `pr: PrRef, login: string` | `void` |
| `prmaster_get_call_log` | — | `GhCall[]` |
| `prmaster_get_ai_runs` | — | `AiRunRecord[]` |
| `prmaster_hide_popover` | — | `void` |
| `prmaster_set_badge` | `badge: string` | `void` |
| `prmaster_open_full_window` | — | `void` |
| `prmaster_get_settings` | — | `PrMasterSettings` |
| `prmaster_save_settings` | `settings: PrMasterSettings` | `void` |
| `prmaster_list_filters` | — | `NotificationFilter[]` |
| `prmaster_save_filter` | `filter: NotificationFilter` | `void` |
| `prmaster_delete_filter` | `id: string` | `void` |
| `prmaster_test_filter_notification` | `id: string` | `void` |
| `prmaster_refresh` | — | `void` (emits `prmaster:refreshed`) |
| `prmaster_ai_summary` | `params: AiSummaryParams` | `SummaryCard` |
| `prmaster_ai_list_models` | — | `string[]` |
| `prmaster_clear_ai_cache` | — | `void` |
| `prmaster_load_ai_summaries` | — | `SummaryCard[]` |
| `prmaster_save_ai_summaries` | `summaries: SummaryCard[]` | `void` |
| `prmaster_clear_ai_summaries` | — | `void` |
| `prmaster_load_pr_snapshot` | — | `RefreshSnapshot \| null` |
| `prmaster_list_repos` | — | `RepoListResult` |
| `prmaster_fetch_repos` | — | `RepoListResult` |
| `prmaster_quit_app` | — | `void` |

## Events

Frontend subscribes via `@tauri-apps/api/event::listen`. Payload shape
is documented in the typed wrapper for each subscriber.

| Event | Emitter | Payload |
|---|---|---|
| `request:result` | `commands::execute` | `RequestResult` |
| `request:chain` | `commands::execute` | `{ steps: { id, name }[] }` |
| `perf:update` | `commands::perf` | `PerfUpdate` |
| `pm:sample` | `lib.rs` (sampler bridge) | `Sample` (PM tick) |
| `pm:targets-cleared` | `commands::process_monitor` | `null` |
| `cleaner:scan-started` | `commands::cleaner` | `{ folder: string }` |
| `cleaner:scan-progress` | `commands::cleaner` | `ScanResultDto` (incremental) |
| `cleaner:scan-complete` | `commands::cleaner` | `ScanResultDto` (final) |
| `cleaner:size-update` | `commands::cleaner` | `SizeUpdateDto` |
| `cleaner:size-progress` | `commands::cleaner` | `SizeProgressDto` |
| `schema-cache-updated` | `commands::database` | `{ id, database, schema, table }` |
| `schema-cache-progress` | `commands::database` | `ProgressState` |
| `prmaster:refreshed` | `lib.rs` (broadcast bridge) | `RefreshSnapshot` |
| `prmaster:badge-changed` | `lib.rs` (broadcast bridge) | `string` (badge text) |
| `prmaster:notification` | `lib.rs` (broadcast bridge) | `PendingNotification` |
| `prmaster:focus-route` | `prmaster_tray::focus_main_window_at_prmaster` | `null` |

## Where each command lives

| Source file | Commands |
|---|---|
| `src-tauri/src/commands/files.rs` | working-dir CRUD, `discover_http_files`, `pick_directory` |
| `src-tauri/src/commands/parse.rs` | HTTP file open/read/write/reload |
| `src-tauri/src/commands/environment.rs` | env vars, extracted vars, cookies |
| `src-tauri/src/commands/execute.rs` | request execution + chains |
| `src-tauri/src/commands/perf.rs` | perf load/run/stop/export |
| `src-tauri/src/commands/preferences.rs` | preferences get/save |
| `src-tauri/src/commands/runs.rs` | per-request run history |
| `src-tauri/src/commands/process_monitor.rs` | PM commands |
| `src-tauri/src/commands/cleaner.rs` | cleaner commands |
| `src-tauri/src/commands/markdown.rs` | markdown vault commands |
| `src-tauri/src/commands/markdown_index.rs` | fff-search file picker |
| `src-tauri/src/commands/database.rs` | DB driver commands + schema cache |
| `src-tauri/src/commands/sql_workspace.rs` | SQL workspace projects |
| `src-tauri/src/commands/prmaster.rs` | PRMaster commands |
| `src-tauri/src/commands/misc.rs` | `open_in_editor` |
