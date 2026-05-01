//! Database Explorer commands — thin wrappers over `zen_db`.
//!
//! Connection metadata (no password) is persisted in `preferences.json`;
//! passwords live in the OS keychain via `zen_db::secrets`. Live driver
//! handles are kept in [`zen_db::ConnectionRegistry`] inside `AppState`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use zen_db::{
    secrets, ConnectionConfig, ConnectionRegistry, DbDriver, QueryResult, RoutineDescription,
    TableDescription, TableSummary,
};

use crate::commands::preferences::{
    load_preferences, write_preferences, DbConnectionPrefs, Preferences,
};
use crate::error::{AppError, AppResult};
use crate::schema_cache::{now_ms, CachedTableMeta, SchemaCache, DEFAULT_TTL_MS};
use crate::state::AppState;

/// Connection details posted from the front-end. Same shape as
/// `zen_db::ConnectionConfig` — duplicated locally so we control
/// (de)serialisation against the JS layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectionInput {
    /// Stable UUID minted by the front-end.
    pub id: String,
    /// User-facing display name.
    pub name: String,
    /// `"postgres"` or `"mssql"`.
    pub driver: String,
    /// Host or IP address.
    pub host: String,
    /// TCP port.
    pub port: u16,
    /// Initial database / catalogue.
    pub database: String,
    /// SQL-auth username.
    pub username: String,
    /// Plaintext password — only ever lives in this transient struct;
    /// stored in the OS keychain on save.
    #[serde(default)]
    pub password: String,
    /// Trust a self-signed server cert.
    #[serde(default)]
    pub trust_server_certificate: bool,
}

impl DbConnectionInput {
    fn driver(&self) -> AppResult<DbDriver> {
        match self.driver.to_ascii_lowercase().as_str() {
            "postgres" | "postgresql" | "pg" => Ok(DbDriver::Postgres),
            "mssql" | "sqlserver" | "sql-server" => Ok(DbDriver::MsSql),
            other => Err(AppError::BadRequest(format!("unknown db driver: {other}"))),
        }
    }

    fn into_config(self) -> AppResult<ConnectionConfig> {
        let driver = self.driver()?;
        Ok(ConnectionConfig {
            id: self.id,
            name: self.name,
            driver,
            host: self.host,
            port: self.port,
            database: self.database,
            username: self.username,
            password: self.password,
            trust_server_certificate: self.trust_server_certificate,
        })
    }

    fn to_prefs(&self) -> DbConnectionPrefs {
        DbConnectionPrefs {
            id: self.id.clone(),
            name: self.name.clone(),
            driver: self.driver.clone(),
            host: self.host.clone(),
            port: self.port,
            database: self.database.clone(),
            username: self.username.clone(),
            trust_server_certificate: self.trust_server_certificate,
        }
    }
}

fn registry(state: &AppState) -> Arc<ConnectionRegistry> {
    state.db.clone()
}

fn prefs_to_config(prefs: &DbConnectionPrefs, password: String) -> AppResult<ConnectionConfig> {
    let driver = match prefs.driver.to_ascii_lowercase().as_str() {
        "postgres" | "postgresql" | "pg" => DbDriver::Postgres,
        "mssql" | "sqlserver" | "sql-server" => DbDriver::MsSql,
        other => return Err(AppError::BadRequest(format!("unknown db driver: {other}"))),
    };
    Ok(ConnectionConfig {
        id: prefs.id.clone(),
        name: prefs.name.clone(),
        driver,
        host: prefs.host.clone(),
        port: prefs.port,
        database: prefs.database.clone(),
        username: prefs.username.clone(),
        password,
        trust_server_certificate: prefs.trust_server_certificate,
    })
}

// ── Test ────────────────────────────────────────────────────────────────

/// One-shot connectivity check. Does not register the connection.
#[tauri::command]
pub async fn db_test_connection(input: DbConnectionInput) -> AppResult<()> {
    let cfg = input.into_config()?;
    ConnectionRegistry::test(cfg).await?;
    Ok(())
}

// ── Persist ─────────────────────────────────────────────────────────────

/// Save (or update) a connection. Metadata goes to `preferences.json`,
/// the password goes to the OS keychain.
#[tauri::command]
pub async fn db_save_connection(input: DbConnectionInput, app: AppHandle) -> AppResult<()> {
    // Validate driver before touching disk/keychain.
    let _ = input.driver()?;

    if !input.password.is_empty() {
        secrets::store_password(&input.id, &input.password)?;
    }

    let mut prefs = load_preferences(&app)?;
    let new_prefs = input.to_prefs();
    if let Some(existing) = prefs
        .db_connections
        .iter_mut()
        .find(|c| c.id == new_prefs.id)
    {
        *existing = new_prefs;
    } else {
        prefs.db_connections.push(new_prefs);
    }
    write_preferences(&app, &prefs)?;
    Ok(())
}

/// Delete the connection: drop the live handle (if any), remove the
/// keychain entry, prune the prefs entry, and clear any cached schema
/// rows so the connection's UUID never gets re-used to mask stale data.
#[tauri::command]
pub async fn db_delete_connection(
    id: String,
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    registry.disconnect(&id);

    secrets::delete_password(&id)?;

    if let Some(cache) = app.try_state::<SchemaCache>() {
        let cache = cache.inner().clone();
        let id_for_cache = id.clone();
        // SQLite is sync; off-load to the blocking pool so we don't
        // stall the runtime on disk I/O.
        let _ = tokio::task::spawn_blocking(move || cache.invalidate_connection(&id_for_cache))
            .await;
    }

    let mut prefs = load_preferences(&app)?;
    prefs.db_connections.retain(|c| c.id != id);
    write_preferences(&app, &prefs)?;
    Ok(())
}

/// Return all saved connections (no passwords).
#[tauri::command]
pub async fn db_list_saved_connections(app: AppHandle) -> AppResult<Vec<DbConnectionPrefs>> {
    let prefs: Preferences = load_preferences(&app)?;
    Ok(prefs.db_connections)
}

// ── Connect / disconnect ────────────────────────────────────────────────

/// Open a live connection using the saved metadata + keychain password.
#[tauri::command]
pub async fn db_connect(
    id: String,
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    let prefs = load_preferences(&app)?;
    let entry = prefs
        .db_connections
        .iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::NotInitialised(format!("connection not saved: {id}")))?
        .clone();

    let password = secrets::load_password(&id)?
        .ok_or_else(|| AppError::NotInitialised(format!("no password in keychain for: {id}")))?;

    let cfg = prefs_to_config(&entry, password)?;

    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    registry.connect(cfg).await?;
    Ok(())
}

/// Drop a live driver handle (the keychain entry is preserved).
#[tauri::command]
pub async fn db_disconnect(
    id: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    registry.disconnect(&id);
    Ok(())
}

// ── Tree ────────────────────────────────────────────────────────────────

/// Top-level databases / catalogues visible to this connection.
#[tauri::command]
pub async fn db_list_databases(
    id: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<String>> {
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    Ok(registry.list_databases(&id).await?)
}

/// Schemas inside the given database.
#[tauri::command]
pub async fn db_list_schemas(
    id: String,
    database: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<String>> {
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    Ok(registry.list_schemas(&id, &database).await?)
}

/// Tables and views inside `database.schema`.
#[tauri::command]
pub async fn db_list_tables(
    id: String,
    database: String,
    schema: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<String>> {
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    Ok(registry.list_tables(&id, &database, &schema).await?)
}

/// Stored procedures + functions in `database.schema`. Drives the
/// per-schema "Routines" folder in the DB tree. Single round-trip;
/// front-end caches the result for the session (no SQLite
/// persistence).
#[tauri::command]
pub async fn db_list_routines(
    id: String,
    database: String,
    schema: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<RoutineDescription>> {
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    Ok(registry.list_routines(&id, &database, &schema).await?)
}

/// Every relation in `database` — used by the SQL editor's autocomplete
/// to populate schema and qualified-table completions cold, before the
/// user has typed any references. One round-trip on the wire.
///
/// Emits `schema-cache-progress` with `kind: catalog` so the UI can
/// show "Loading catalog…" while the query runs.
#[tauri::command]
pub async fn db_list_all_tables(
    id: String,
    database: String,
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<TableSummary>> {
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    let job = SchemaCacheProgress::new(
        next_job_id(ProgressKind::Catalog),
        ProgressKind::Catalog,
        id.clone(),
        database.clone(),
        None,
        1,
    );
    emit_progress(&app, &job);
    match registry.list_all_tables(&id, &database).await {
        Ok(rows) => {
            emit_progress(&app, &job.clone().done());
            Ok(rows)
        }
        Err(e) => {
            emit_progress(&app, &job.error(e.to_string()));
            Err(e.into())
        }
    }
}

// ── Query ───────────────────────────────────────────────────────────────

/// Execute one or more `;`-separated statements. Returns one
/// [`QueryResult`] per statement, in order. Comments and string literals
/// are respected by the splitter.
///
/// `database` (MSSQL only) and `schema` (Postgres only) apply session
/// context once before the first user statement runs.
#[tauri::command]
pub async fn db_query(
    id: String,
    sql: String,
    database: Option<String>,
    schema: Option<String>,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<QueryResult>> {
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };

    let stmts = split_statements(&sql);
    let trimmed: Vec<&str> = stmts
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    Ok(registry
        .execute_batch(&id, database.as_deref(), schema.as_deref(), &trimmed)
        .await?)
}

// ── Schema cache (autocomplete) ─────────────────────────────────────────

/// Payload of the `schema-cache-updated` Tauri event. The front-end
/// listens for this so the editor's completion source can re-pull the
/// affected rows from the cache and reconfigure CodeMirror without
/// polling.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaCacheUpdated {
    connection_id: String,
    database: String,
    schema: String,
    tables: Vec<String>,
}

const SCHEMA_CACHE_EVENT: &str = "schema-cache-updated";

// ── Progress events ─────────────────────────────────────────────────────

/// Tauri event channel for streaming "I'm working on it" updates to
/// the front-end. Subscribed by the floating progress chip in the SQL
/// editor; ignore it elsewhere.
const SCHEMA_CACHE_PROGRESS_EVENT: &str = "schema-cache-progress";

/// One unit of cache work the user can see happening.
///
/// * `Catalog`       — bulk schema/table-name fetch (the "cold start"
///                     load that lights up `<schema>.<table>`
///                     completions before any column fetch).
/// * `Describe`      — foreground per-table description fetch
///                     (user-triggered: `Opt+Enter` reindex, right-click
///                     "Index table").
/// * `Background`    — typing-triggered or stale auto-refresh that
///                     runs out-of-band. The UI shows these with a
///                     subtler indicator since the user didn't ask.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum ProgressKind {
    Catalog,
    Describe,
    Background,
}

/// Lifecycle marker. Emit `Started` once at the top of the job,
/// `Progress` for each step (current/total advance), and exactly one
/// terminator (`Done` on success, `Error` on failure) so the front-end
/// can fade the chip out.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum ProgressState {
    Started,
    Progress,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaCacheProgress {
    /// Stable id for the duration of one job. Front-end keys its store
    /// by this so a `Done` always matches its `Started`.
    job_id: String,
    kind: ProgressKind,
    state: ProgressState,
    connection_id: String,
    database: String,
    /// Absent for `Catalog` (which spans every schema in `database`).
    schema: Option<String>,
    /// Number of items completed so far. `0` on `Started`, `total` on
    /// `Done`.
    current: u32,
    /// Total items in the job. `1` for catalog (one query), N for a
    /// table-by-table describe loop.
    total: u32,
    /// Name of the table currently being processed, when applicable.
    current_item: Option<String>,
    /// Free-text status. Carries the error message on `Error`.
    message: Option<String>,
}

impl SchemaCacheProgress {
    fn new(
        job_id: String,
        kind: ProgressKind,
        connection_id: String,
        database: String,
        schema: Option<String>,
        total: u32,
    ) -> Self {
        Self {
            job_id,
            kind,
            state: ProgressState::Started,
            connection_id,
            database,
            schema,
            current: 0,
            total,
            current_item: None,
            message: None,
        }
    }

    fn step(mut self, current: u32, item: Option<String>) -> Self {
        self.state = ProgressState::Progress;
        self.current = current;
        self.current_item = item;
        self
    }

    fn done(mut self) -> Self {
        self.state = ProgressState::Done;
        self.current = self.total;
        self.current_item = None;
        self
    }

    fn error(mut self, message: impl Into<String>) -> Self {
        self.state = ProgressState::Error;
        self.message = Some(message.into());
        self
    }
}

/// Mint a unique id for a progress job. Pairs `(connection, db, kind)`
/// with a monotonic counter + timestamp so concurrent jobs never
/// collide. Counter wraps every ~584 years at one job/ns, which is
/// fine.
fn next_job_id(kind: ProgressKind) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let prefix = match kind {
        ProgressKind::Catalog => "cat",
        ProgressKind::Describe => "desc",
        ProgressKind::Background => "bg",
    };
    format!("{prefix}-{}-{n}", now_ms())
}

fn emit_progress(app: &AppHandle, p: &SchemaCacheProgress) {
    if let Err(e) = app.emit(SCHEMA_CACHE_PROGRESS_EVENT, p) {
        tracing::warn!(?e, "schema_cache: emit progress failed");
    }
}

fn require_cache(app: &AppHandle) -> AppResult<SchemaCache> {
    app.try_state::<SchemaCache>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| AppError::NotInitialised("schema cache not initialised".into()))
}

/// Fetch a table description and upsert it into the cache. Pure helper
/// shared by the foreground "force" path and the background refresh
/// task.
async fn fetch_and_cache(
    registry: &Arc<ConnectionRegistry>,
    cache: &SchemaCache,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> AppResult<TableDescription> {
    let desc = registry
        .describe_table(connection_id, database, schema, table)
        .await?;
    let cache = cache.clone();
    let conn = connection_id.to_string();
    let owned = desc.clone();
    tokio::task::spawn_blocking(move || cache.upsert(&conn, &owned, now_ms()))
        .await
        .map_err(|e| AppError::Other(format!("join: {e}")))??;
    Ok(desc)
}

/// Spawn a background refresh for `tables` and emit one
/// `schema-cache-updated` event when the batch finishes (only listing
/// the tables that actually got refreshed). Streams per-table progress
/// under `kind: background` so the UI can show a subtle "indexing…"
/// indicator.
fn schedule_background_refresh(
    app: AppHandle,
    registry: Arc<ConnectionRegistry>,
    cache: SchemaCache,
    connection_id: String,
    database: String,
    schema: String,
    tables: Vec<String>,
) {
    if tables.is_empty() {
        return;
    }
    let total = tables.len() as u32;
    let job = SchemaCacheProgress::new(
        next_job_id(ProgressKind::Background),
        ProgressKind::Background,
        connection_id.clone(),
        database.clone(),
        Some(schema.clone()),
        total,
    );
    tauri::async_runtime::spawn(async move {
        emit_progress(&app, &job);
        let mut refreshed = Vec::new();
        let mut errors = 0u32;
        for (idx, t) in tables.iter().enumerate() {
            // Announce which table we're starting on so the chip can
            // show the name as it advances.
            emit_progress(
                &app,
                &job.clone().step((idx) as u32, Some(t.clone())),
            );
            match fetch_and_cache(&registry, &cache, &connection_id, &database, &schema, t).await {
                Ok(_) => refreshed.push(t.clone()),
                Err(e) => {
                    errors += 1;
                    // Cache miss/stale + failure to refresh is non-fatal:
                    // the editor still has whatever was cached before.
                    tracing::warn!(?e, table = %t, "schema_cache: background refresh failed");
                }
            }
        }
        if errors > 0 {
            emit_progress(
                &app,
                &job.clone().error(format!("{errors} table(s) failed to refresh")),
            );
        } else {
            emit_progress(&app, &job.clone().done());
        }
        if !refreshed.is_empty() {
            let _ = app.emit(
                SCHEMA_CACHE_EVENT,
                SchemaCacheUpdated {
                    connection_id,
                    database,
                    schema,
                    tables: refreshed,
                },
            );
        }
    });
}

/// Describe a single table.
///
/// * `force = false` — return cached row if present (any age). If the
///   row is missing, fetch synchronously and upsert. If the row is
///   stale (`indexed_at` older than `DEFAULT_TTL_MS`), return the
///   cached value immediately and queue a background refresh.
/// * `force = true` — bypass the cache; fetch fresh, upsert, return.
#[tauri::command]
pub async fn db_describe_table(
    id: String,
    database: String,
    schema: String,
    table: String,
    force: Option<bool>,
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<TableDescription> {
    let force = force.unwrap_or(false);
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    let cache = require_cache(&app)?;

    if !force {
        let lookup = {
            let cache = cache.clone();
            let id = id.clone();
            let database = database.clone();
            let schema = schema.clone();
            let table = table.clone();
            tokio::task::spawn_blocking(move || cache.get(&id, &database, &schema, &table))
                .await
                .map_err(|e| AppError::Other(format!("join: {e}")))?
        }?;
        if let Some(cached) = lookup {
            // Stale → background refresh, return cached now.
            if now_ms() - cached.indexed_at > DEFAULT_TTL_MS {
                schedule_background_refresh(
                    app.clone(),
                    registry.clone(),
                    cache.clone(),
                    id.clone(),
                    database.clone(),
                    schema.clone(),
                    vec![table.clone()],
                );
            }
            return Ok(cached.description);
        }
        // Miss → synchronous fetch + upsert.
    }

    fetch_and_cache(&registry, &cache, &id, &database, &schema, &table).await
}

/// Bulk variant for the editor's autocomplete plugin. Returns whatever
/// is cached *now* (any age) for the requested tables, and queues
/// background refreshes for the missing or stale ones.
///
/// `force = true` short-circuits everything: every requested table is
/// re-fetched, upserted, and returned.
#[tauri::command]
pub async fn db_describe_tables_bulk(
    id: String,
    database: String,
    schema: String,
    tables: Vec<String>,
    force: Option<bool>,
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<TableDescription>> {
    let force = force.unwrap_or(false);
    if tables.is_empty() {
        return Ok(Vec::new());
    }
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    let cache = require_cache(&app)?;

    if force {
        // User-triggered reindex — emit progress per table so the
        // floating chip can show "Indexing 3/10 zen_db.metrics".
        let total = tables.len() as u32;
        let job = SchemaCacheProgress::new(
            next_job_id(ProgressKind::Describe),
            ProgressKind::Describe,
            id.clone(),
            database.clone(),
            Some(schema.clone()),
            total,
        );
        emit_progress(&app, &job);
        let mut out = Vec::with_capacity(tables.len());
        for (idx, t) in tables.iter().enumerate() {
            emit_progress(&app, &job.clone().step(idx as u32, Some(t.clone())));
            match fetch_and_cache(&registry, &cache, &id, &database, &schema, t).await {
                Ok(desc) => out.push(desc),
                Err(e) => {
                    emit_progress(&app, &job.clone().error(e.to_string()));
                    return Err(e);
                }
            }
        }
        emit_progress(&app, &job.clone().done());
        // One event for the whole batch so subscribers debounce
        // naturally.
        let _ = app.emit(
            SCHEMA_CACHE_EVENT,
            SchemaCacheUpdated {
                connection_id: id,
                database,
                schema,
                tables,
            },
        );
        return Ok(out);
    }

    // Read cache → split into (fresh-or-stale-but-present) and (missing).
    let cached = {
        let cache = cache.clone();
        let id = id.clone();
        let database = database.clone();
        let schema = schema.clone();
        let names: Vec<String> = tables.clone();
        tokio::task::spawn_blocking(move || {
            let refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
            cache.get_many(&id, &database, &schema, &refs)
        })
        .await
        .map_err(|e| AppError::Other(format!("join: {e}")))?
    }?;

    let now = now_ms();
    let cached_names: std::collections::HashSet<String> =
        cached.iter().map(|c| c.description.name.clone()).collect();
    let missing: Vec<String> = tables
        .iter()
        .filter(|t| !cached_names.contains(*t))
        .cloned()
        .collect();
    let stale: Vec<String> = cached
        .iter()
        .filter(|c| now - c.indexed_at > DEFAULT_TTL_MS)
        .map(|c| c.description.name.clone())
        .collect();

    let mut to_refresh = missing;
    to_refresh.extend(stale);
    to_refresh.sort();
    to_refresh.dedup();

    if !to_refresh.is_empty() {
        schedule_background_refresh(
            app.clone(),
            registry.clone(),
            cache.clone(),
            id.clone(),
            database.clone(),
            schema.clone(),
            to_refresh,
        );
    }

    Ok(cached.into_iter().map(|c| c.description).collect())
}

/// Lightweight metadata for the DB-explorer freshness badge.
#[tauri::command]
pub async fn db_list_cached_tables(
    id: String,
    database: String,
    schema: String,
    app: AppHandle,
) -> AppResult<Vec<CachedTableMeta>> {
    let cache = require_cache(&app)?;
    tokio::task::spawn_blocking(move || cache.list_cached(&id, &database, &schema))
        .await
        .map_err(|e| AppError::Other(format!("join: {e}")))?
}

/// Drop cache rows for `(id, database, schema)`. An empty `tables` list
/// drops every row under that schema. The next autocomplete request
/// will refetch.
#[tauri::command]
pub async fn db_invalidate_schema_cache(
    id: String,
    database: String,
    schema: String,
    tables: Vec<String>,
    app: AppHandle,
) -> AppResult<()> {
    let cache = require_cache(&app)?;
    let names: Vec<String> = tables;
    tokio::task::spawn_blocking(move || {
        let refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
        cache.invalidate(&id, &database, &schema, &refs)
    })
    .await
    .map_err(|e| AppError::Other(format!("join: {e}")))??;
    Ok(())
}

/// Split a SQL string on top-level `;`, respecting `'...'` and `"..."`
/// strings, `--` line comments, and `/* ... */` block comments.
fn split_statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let bytes = sql.as_bytes();
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;

    while i < bytes.len() {
        let c = bytes[i] as char;
        let next = bytes.get(i + 1).copied().map(|b| b as char);

        if in_line_comment {
            cur.push(c);
            if c == '\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }
        if in_block_comment {
            cur.push(c);
            if c == '*' && next == Some('/') {
                cur.push('/');
                i += 2;
                in_block_comment = false;
                continue;
            }
            i += 1;
            continue;
        }
        if in_single {
            cur.push(c);
            if c == '\'' {
                // SQL '' = escaped quote inside string literal.
                if next == Some('\'') {
                    cur.push('\'');
                    i += 2;
                    continue;
                }
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            cur.push(c);
            if c == '"' {
                in_double = false;
            }
            i += 1;
            continue;
        }

        match c {
            '-' if next == Some('-') => {
                in_line_comment = true;
                cur.push_str("--");
                i += 2;
            }
            '/' if next == Some('*') => {
                in_block_comment = true;
                cur.push_str("/*");
                i += 2;
            }
            '\'' => {
                in_single = true;
                cur.push(c);
                i += 1;
            }
            '"' => {
                in_double = true;
                cur.push(c);
                i += 1;
            }
            ';' => {
                out.push(std::mem::take(&mut cur));
                i += 1;
            }
            _ => {
                cur.push(c);
                i += 1;
            }
        }
    }

    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_simple() {
        let out = split_statements("SELECT 1; SELECT 2");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].trim(), "SELECT 1");
        assert_eq!(out[1].trim(), "SELECT 2");
    }

    #[test]
    fn ignores_semicolon_in_string() {
        let out = split_statements("SELECT ';'; SELECT 2");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].trim(), "SELECT ';'");
    }

    #[test]
    fn ignores_semicolon_in_line_comment() {
        let out = split_statements("SELECT 1 -- ;\n; SELECT 2");
        assert_eq!(out.len(), 2);
    }
}
