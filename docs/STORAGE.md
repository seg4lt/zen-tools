# Local Storage — `app_data_dir/`

Everything zen-tools persists outside the OS keychain lives in the
Tauri-resolved app-data directory:

| OS      | Path (typical)                                        |
|---------|-------------------------------------------------------|
| macOS   | `~/Library/Application Support/com.zen.tools/`        |
| Linux   | `~/.local/share/com.zen.tools/`                       |
| Windows | `%APPDATA%\com.zen.tools\`                            |

Two SQLite databases live there. Everything else is either ephemeral or
keychain-managed. **Passwords never touch this directory** — they go
through `zen_db::secrets` (OS keychain).

```
app_data_dir/
├── user_config.db          ← settings (this doc, §1)
├── schema_cache.db         ← SQL-autocomplete table descriptions (§2)
├── preferences.json.bak    ← legacy file kept after migration (§1)
└── runs.json               ← perf-run history (still JSON for now, §3)
```

Both `.db` files use `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`
which is the right durability/throughput trade-off for local single-process
state.

---

## 1. `user_config.db` — user settings

**Module**: `src-tauri/src/user_config.rs`
**Public API**: `commands::preferences::{load_preferences, write_preferences, get_preferences, save_preferences}`

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

**Module**: `src-tauri/src/schema_cache.rs`
**Public API**: `commands::database::{db_describe_table, db_describe_tables_bulk, db_list_cached_tables, db_invalidate_schema_cache}`

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

## 3. `runs.json` — perf-run history

Still JSON, in `app_data_dir/runs.json`. Hasn't moved to SQLite because:

* It's effectively a ring (capped at N entries), not a key/value store.
* Writes are infrequent (once per perf-test completion).
* Migrating it now would mean a second migrator + a second on-launch
  warning if the file is malformed — not worth it until we either need
  per-entry queries, hit a corruption case, or grow it past JSON's
  practical limit.

When it does move, it'll land under a key like `runs.history` in
`user_config.db` (one JSON blob), or get its own table if we want
per-entry indexing.

---

## Don'ts

* **Don't write directly to `app_data_dir`** from new code. Go through
  `user_config::UserConfig` (settings) or `schema_cache::SchemaCache`
  (autocomplete).
* **Don't store secrets** in either DB. The OS keychain (via
  `zen_db::secrets`) is the only place credentials may live.
* **Don't use `:memory:` outside tests** — both stores assume disk
  persistence; an in-memory store would silently lose every setting on
  app close.
* **Don't add `serde(skip)` fields to `Preferences`** unless you're OK
  with them disappearing on the next save. The whole struct
  round-trips through JSON every time.
