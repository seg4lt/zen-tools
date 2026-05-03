# Local Storage — `app_data_dir/`

Everything zen-tools persists outside the OS keychain lives in the
Tauri-resolved app-data directory:

| OS      | Path (typical)                                        |
|---------|-------------------------------------------------------|
| macOS   | `~/Library/Application Support/com.zen.tools/`        |
| Linux   | `~/.local/share/com.zen.tools/`                       |
| Windows | `%APPDATA%\com.zen.tools\`                            |

Two SQLite databases live there, plus the PRMaster subtree.
Everything else is either ephemeral or keychain-managed. **Passwords
never touch this directory** — they go through `zen_db::secrets` (OS
keychain).

```
app_data_dir/
├── user_config.db          ← settings (this doc, §1)
├── schema_cache.db         ← SQL-autocomplete table descriptions (§2)
├── preferences.json.bak    ← legacy file kept after migration (§1)
├── runs.json               ← per-request HTTP run history (§3)
└── com.zen-tools.app/prmaster/
    ├── filters.db          ← PRMaster notification-filter rules
    ├── notifications.json  ← last-seen state per PR (notification dedup)
    └── ai_summary_cache/   ← per-(repo, week) AI summary cards (JSON)
```

Both `.db` files in the root and the PRMaster `filters.db` go through
`zen_storage::open_at`, which centrally sets
`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;` — the right
durability/throughput trade-off for local single-process state. (Before
the cleanup pass each store applied these pragmas independently and
inconsistently — `filters.db` shipped without them.)

### Crate landscape

The on-disk shape above is owned by **two layers**:

- **`zen-storage`** — the cross-tool primitive. Provides `open_at(path)`
  (consistent pragmas + `Arc<Mutex<Connection>>`) and `KvStore`
  (the `(key, value: TEXT JSON)` table backing `user_config.db`). Any
  future store should build on these.
- **Tauri-side wrappers** in `src-tauri/src/`:
  - `user_config.rs` — resolves the canonical `app_data_dir/user_config.db`
    path, runs the legacy `preferences.json` migration, and re-exports
    `KvStore` as `UserConfig` so existing callers don't churn.
  - `schema_cache.rs` — resolves the path; the actual cache impl lives
    in `zen-db::schema_cache::SchemaCache`.
  - `commands/runs.rs` — thin Tauri shim over `zen-runs::{RunHistory, load_from_disk, save_to_disk}`.

---

## 1. `user_config.db` — user settings

**Implementation**: `zen-storage::KvStore` (in `crates/zen-storage/src/lib.rs`).
**Tauri wrapper**: `src-tauri/src/user_config.rs` — resolves the
canonical path under `app_data_dir/`, runs the one-shot
`preferences.json` migration, re-exports `KvStore` as `UserConfig`.
**Public API for callers**: `commands::preferences::{load_preferences, write_preferences, get_preferences, save_preferences}`.

### Schema

```sql
CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL  -- arbitrary JSON
);
```

A flat key/value table. Today there's exactly one row:

| key           | value                         |
|---------------|-------------------------------|
| `preferences` | the full `Preferences` struct |

Every existing call site goes through
`commands::preferences::load_preferences(app) -> Preferences` — the
storage backend changed but the struct shape did not.

### Why this shape (rather than one column per setting, or one big JSON file)?

* **One key per logical section, not one row per field.** Today
  `preferences` holds the whole `Preferences` struct. As pressure grows
  (per-tool layouts, per-vault settings, larger ring buffers), each new
  section just picks its own key — `editor.layout`, `markdown.recents`,
  `runs.history` — without touching the others or running a schema
  migration. The store is **partition-friendly by key**; we don't lock
  ourselves into a column-per-field table that needs a `CREATE TABLE`
  migration every time we add a setting.
* **SQLite gives atomic per-key writes.** A crash mid-`save_preferences`
  can't corrupt the document. The historical `preferences.json` write
  was `write_all(tmp); rename(tmp, real)` — durable but coarse: a single
  parse error in one section blanked everything. With per-key rows, a
  bad write to one key leaves the others intact.
* **Concurrency for free.** WAL mode + the in-process `Mutex<Connection>`
  means we don't fight a single global file lock when multiple commands
  read settings concurrently (the http-runner's project list, the
  database explorer's connection list, etc.). The JSON file required
  every reader to re-parse the entire blob.
* **Reuses the rusqlite dep we already added for `schema_cache.db`.**
  Zero new build cost — same vendored libsqlite3, same WAL settings,
  same `parking_lot::Mutex` pattern.
* **Extensible without a rewrite.** When a section is hot enough to
  deserve its own structure (one row per saved DB connection, one row
  per cleaner scan-folder, ...), we can promote it to its own table
  *without* rewriting unrelated sections. Just add a `db_connections`
  table, write a one-shot migrator that pulls them out of the
  `preferences` blob, and drop them from the struct on the next
  release.

### Migration from `preferences.json`

`UserConfig::open` runs **once** on first launch:

1. If `preferences.json` is missing → no-op.
2. If `user_config.db` already has a `preferences` row → no-op (means
   we've already migrated; the JSON sitting on disk is just a stale
   backup).
3. Otherwise → parse the JSON (must be valid; otherwise we skip and
   leave the file alone), write it under the `preferences` key,
   rename the file to `preferences.json.bak`.

The `.bak` file is your safety net. Future builds can drop the
migration code without losing user data — `.bak` will simply be
ignored.

### Adding a new section (recipe)

For a new chunk of state that doesn't naturally fit inside the
`Preferences` struct:

```rust
use crate::user_config;

#[derive(Serialize, Deserialize)]
struct EditorLayout { /* … */ }

const KEY: &str = "editor.layout";

fn load(app: &AppHandle) -> AppResult<EditorLayout> {
    let cfg = user_config::require(app)?;
    Ok(cfg.get::<EditorLayout>(KEY)?.unwrap_or_default())
}

fn save(app: &AppHandle, layout: &EditorLayout) -> AppResult<()> {
    let cfg = user_config::require(app)?;
    cfg.set(KEY, layout)
}
```

Add the new `*Settings` struct, derive `Default + Serialize +
Deserialize`, pick a dotted key, done.

---

## 2. `schema_cache.db` — SQL-autocomplete cache

**Implementation**: `zen-db::SchemaCache` (in `crates/zen-db/src/schema_cache.rs`).
Built on `zen-storage::open_at` so the WAL pragmas come from the same
helper as `user_config.db`.
**Tauri wrapper**: `src-tauri/src/schema_cache.rs` — resolves
`app_data_dir/schema_cache.db` and re-exports the `SchemaCache` type
for callers in `commands/database.rs`.
**Public API**: `commands::database::{db_describe_table, db_describe_tables_bulk, db_list_cached_tables, db_invalidate_schema_cache}`.

### Schema

```sql
CREATE TABLE table_schema (
  connection_id TEXT NOT NULL,
  database      TEXT NOT NULL,
  schema        TEXT NOT NULL,
  table_name    TEXT NOT NULL,
  indexed_at    INTEGER NOT NULL,        -- unix ms
  payload       TEXT NOT NULL,           -- TableDescription as JSON
  PRIMARY KEY (connection_id, database, schema, table_name)
);
CREATE INDEX idx_table_schema_lookup
  ON table_schema(connection_id, database, schema);
```

Holds one row per `(connection, database, schema, table)` we've ever
described. The payload is `zen_db::TableDescription` as JSON
(columns now; indexes and FKs land in a future revision under the
same payload shape).

### Lifecycle

* **Read** — SQL editor extracts table references from the buffer on
  every keystroke (debounced 150 ms), calls `db_describe_tables_bulk`,
  feeds the columns into CodeMirror's `sql({ schema })`. Cache hit =
  no network.
* **Write** — Cache miss triggers a synchronous fetch via the live
  `DbConnection::describe_table` (Postgres / MSSQL). Stale rows
  (>24 h) return their cached value immediately *and* schedule a
  background refresh; when it lands the backend emits a
  `schema-cache-updated` event and the frontend re-pulls.
* **Invalidate** — Per-table (Opt+Enter "Reindex table at cursor",
  right-click on a tree node) or whole-schema. Connection deletion
  drops every row for that connection_id.

### Why a separate DB from `user_config.db`?

* **Different access pattern.** Settings are written rarely and read
  cheaply at startup; the schema cache is hammered on every keystroke.
  Splitting them keeps a long-running schema-fetch background task from
  ever blocking a settings read.
* **Different lifecycle.** `schema_cache.db` is a derived cache — losing
  it is annoying but not data loss. `user_config.db` is the source of
  truth for the user's setup. Different blast radius → different file.
* **Different growth profile.** Power users with hundreds of tables
  could push schema cache into the megabytes. Settings stay tiny.

---

## 3. `runs.json` — per-request HTTP run history

**Implementation**: `zen-runs::{RunHistory, load_from_disk, save_to_disk}`
(in `crates/zen-runs/src/lib.rs`). Pure data structure with FIFO ring
buffers per `request_id`, cap of 10 runs each, body truncation at
256 KiB.
**Tauri wrapper**: `src-tauri/src/commands/runs.rs` — resolves
`app_data_dir/runs.json` and exposes `record_run` / `get_run_history` /
`clear_run_history` commands.

Still JSON, not SQLite, because:

* It's effectively a ring (capped at N entries per request), not a
  key/value store.
* Writes are infrequent (once per request completion).
* Migrating it now would mean a second migrator + a second on-launch
  warning if the file is malformed — not worth it until we either need
  per-entry queries, hit a corruption case, or grow it past JSON's
  practical limit.

When it does move, it'll land under a key like `runs.history` in
`user_config.db` (one JSON blob), or get its own table if we want
per-entry indexing.

---

## 4. `prmaster/` subtree — PR dashboard state

Owned by `crates/zen-prmaster`. The shared path resolver
`zen_prmaster::paths::data_dir()` returns `app_data_dir/com.zen-tools.app/prmaster/`
on every platform; three stores live underneath:

| File / dir              | Owner                                                  | Purpose |
|-------------------------|--------------------------------------------------------|---------|
| `filters.db`            | `zen_prmaster::filters::FilterStore`                   | Notification-filter rules + their match counts. SQLite via `zen-storage::open_at` (so it picks up the same WAL pragmas as the rest of the workspace). |
| `notifications.json`    | `zen_prmaster::notifications::NotificationStore`       | Last-seen state per PR — drives notification dedup so the user isn't pinged twice for the same review. |
| `ai_summary_cache/*.json` | `zen_prmaster::summary::AiSummaryCache`              | One JSON file per `(repo, since, until)` AI Summary card. Persists with `model_usage` so the API Stats panel shows what models were billed even after a relaunch. |

These files are independent of the two top-level DBs and are managed
entirely from inside `zen-prmaster` — no Tauri-side wrapper, no shared
storage path code (the dir name is a single constant in
`zen-prmaster/src/paths.rs`).

---

## Don'ts

* **Don't write directly to `app_data_dir`** from new code. Go through
  one of: `zen_storage::KvStore` (key/value JSON), `zen_db::SchemaCache`
  (per-table SQL metadata), `zen_runs` (run history), or
  `zen_prmaster::paths::data_dir()` (PRMaster subtree).
* **Don't open `rusqlite::Connection` yourself.** Use
  `zen_storage::open_at(path)` so the WAL + NORMAL pragmas stay
  consistent with every other store.
* **Don't store secrets** in either DB. The OS keychain (via
  `zen_db::secrets`) is the only place credentials may live.
* **Don't use `:memory:` outside tests** — both stores assume disk
  persistence; an in-memory store would silently lose every setting on
  app close.
* **Don't add `serde(skip)` fields to `Preferences`** unless you're OK
  with them disappearing on the next save. The whole struct
  round-trips through JSON every time.
