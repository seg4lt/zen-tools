//! Database Explorer commands — thin wrappers over `zen_db`.
//!
//! Connection metadata and Base64-encoded credentials are persisted in the
//! `preferences` row of `user_config.db`. Live driver handles are kept in
//! [`zen_db::ConnectionRegistry`] inside `AppState`.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex, OnceLock, Weak},
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use zen_db::{
    ConnectionConfig, ConnectionRegistry, DbDriver, ExecuteOptions, ExplainResult, QueryResult,
    RoutineDescription, TableDescription, TableSummary,
};

use crate::commands::preferences::{
    load_preferences, write_preferences, DbConnectionPrefs, Preferences,
};
use crate::error::{AppError, AppResult};
use crate::schema_cache::{
    now_ms, CachedTableMeta, CatalogSearchResult, SchemaCache, DEFAULT_TTL_MS,
};
use crate::state::AppState;

const CATALOG_TTL_MS: i64 = 60 * 60 * 1_000;
static CATALOG_REFRESH_LOCKS: OnceLock<StdMutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

fn catalog_refresh_lock(connection_id: &str, database: &str) -> Arc<tokio::sync::Mutex<()>> {
    let locks = CATALOG_REFRESH_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let key = format!("{connection_id}\0{database}");
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

async fn refresh_catalog(
    registry: Arc<ConnectionRegistry>,
    cache: SchemaCache,
    connection_id: String,
    database: String,
) -> AppResult<()> {
    let (relations, schemas) = tokio::join!(
        registry.list_all_tables(&connection_id, &database),
        registry.list_schemas(&connection_id, &database),
    );
    let relations = relations?;
    let (schemas, schemas_complete) = match schemas {
        Ok(schemas) => (schemas, true),
        Err(e) => {
            tracing::warn!(
                ?e,
                "catalog schema listing failed; indexing relation schemas only"
            );
            (Vec::new(), false)
        }
    };
    tokio::task::spawn_blocking(move || {
        cache.replace_relations(
            &connection_id,
            &database,
            &schemas,
            schemas_complete,
            &relations,
            now_ms(),
        )
    })
    .await
    .map_err(|e| AppError::Other(format!("join: {e}")))??;
    Ok(())
}

async fn refresh_database_catalog(
    registry: Arc<ConnectionRegistry>,
    cache: SchemaCache,
    connection_id: String,
) -> AppResult<Vec<String>> {
    let databases = registry.list_databases(&connection_id).await?;
    let cache_databases = databases.clone();
    let indexed = tokio::task::spawn_blocking(move || {
        cache.replace_databases(&connection_id, &cache_databases, now_ms())
    })
    .await
    .map_err(|e| AppError::Other(format!("join: {e}")))?;
    if let Err(e) = indexed {
        tracing::warn!(?e, "database catalog index update failed");
    }
    Ok(databases)
}

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
    /// Plaintext password — only ever lives in this transient command DTO;
    /// Base64-encoded before persistence.
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

    fn to_prefs(&self, password_base64: String) -> DbConnectionPrefs {
        DbConnectionPrefs {
            id: self.id.clone(),
            name: self.name.clone(),
            driver: self.driver.clone(),
            host: self.host.clone(),
            port: self.port,
            database: self.database.clone(),
            legacy_username: String::new(),
            username_base64: encode_credential(&self.username),
            password_base64,
            trust_server_certificate: self.trust_server_certificate,
        }
    }
}

fn registry(state: &AppState) -> Arc<ConnectionRegistry> {
    state.db.clone()
}

fn encode_credential(value: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(value.as_bytes())
}

fn decode_credential(value: &str, field: &str) -> AppResult<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|e| AppError::Other(format!("invalid Base64 database {field}: {e}")))?;
    String::from_utf8(bytes)
        .map_err(|e| AppError::Other(format!("database {field} is not UTF-8: {e}")))
}

#[cfg(test)]
mod credential_tests {
    use super::*;

    #[test]
    fn base64_credentials_round_trip_without_plaintext_in_preferences() {
        let input = DbConnectionInput {
            id: "connection-1".into(),
            name: "Local".into(),
            driver: "postgres".into(),
            host: "localhost".into(),
            port: 5432,
            database: "app".into(),
            username: "alice@example.com".into(),
            password: "correct horse battery staple".into(),
            trust_server_certificate: false,
        };
        let prefs = input.to_prefs(encode_credential(&input.password));
        let json = serde_json::to_string(&prefs).unwrap();

        assert!(!json.contains("alice@example.com"));
        assert!(!json.contains("correct horse battery staple"));
        assert_eq!(
            decode_credential(&prefs.username_base64, "username").unwrap(),
            input.username
        );
        assert_eq!(
            decode_credential(&prefs.password_base64, "password").unwrap(),
            input.password
        );
    }
}

fn prefs_to_config(prefs: &DbConnectionPrefs) -> AppResult<ConnectionConfig> {
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
        username: decode_credential(&prefs.username_base64, "username")?,
        password: decode_credential(&prefs.password_base64, "password")?,
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

/// Save or update a connection in the local user-config database.
#[tauri::command]
pub async fn db_save_connection(input: DbConnectionInput, app: AppHandle) -> AppResult<()> {
    // Validate driver before touching storage.
    let _ = input.driver()?;

    let mut prefs = load_preferences(&app)?;
    let existing_password = prefs
        .db_connections
        .iter()
        .find(|connection| connection.id == input.id)
        .map(|connection| connection.password_base64.clone())
        .unwrap_or_default();
    let password_base64 = if input.password.is_empty() {
        existing_password
    } else {
        encode_credential(&input.password)
    };
    let new_prefs = input.to_prefs(password_base64);
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

/// Delete the connection, its persisted credentials, and cached schema rows.
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

    if let Some(cache) = app.try_state::<SchemaCache>() {
        let cache = cache.inner().clone();
        let id_for_cache = id.clone();
        // SQLite is sync; off-load to the blocking pool so we don't
        // stall the runtime on disk I/O.
        let _ =
            tokio::task::spawn_blocking(move || cache.invalidate_connection(&id_for_cache)).await;
    }

    let mut prefs = load_preferences(&app)?;
    prefs.db_connections.retain(|c| c.id != id);
    write_preferences(&app, &prefs)?;
    Ok(())
}

/// Public saved-connection shape. The encoded password never crosses IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectionSummary {
    /// Stable connection identifier.
    pub id: String,
    /// User-facing connection name.
    pub name: String,
    /// Database driver identifier.
    pub driver: String,
    /// Database server host.
    pub host: String,
    /// Database server port.
    pub port: u16,
    /// Initial database or catalog.
    pub database: String,
    /// Decoded SQL-auth username.
    pub username: String,
    /// Whether this connection has a Base64-encoded password in local storage.
    pub has_saved_password: bool,
    /// Whether the driver trusts a self-signed server certificate.
    pub trust_server_certificate: bool,
}

/// Return saved connections with decoded usernames and no passwords.
#[tauri::command]
pub async fn db_list_saved_connections(app: AppHandle) -> AppResult<Vec<DbConnectionSummary>> {
    let prefs: Preferences = load_preferences(&app)?;
    prefs
        .db_connections
        .into_iter()
        .map(|connection| {
            Ok(DbConnectionSummary {
                username: decode_credential(&connection.username_base64, "username")?,
                has_saved_password: !connection.password_base64.is_empty(),
                id: connection.id,
                name: connection.name,
                driver: connection.driver,
                host: connection.host,
                port: connection.port,
                database: connection.database,
                trust_server_certificate: connection.trust_server_certificate,
            })
        })
        .collect()
}

// ── Connect / disconnect ────────────────────────────────────────────────

/// Open a live connection using the locally persisted credentials.
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

    if entry.password_base64.is_empty() {
        return Err(AppError::NotInitialised(format!(
            "no saved password for connection: {id}; edit it and save the password once"
        )));
    }
    let cfg = prefs_to_config(&entry)?;

    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    registry.connect(cfg).await?;
    Ok(())
}

/// Drop a live driver handle (saved credentials are preserved).
#[tauri::command]
pub async fn db_disconnect(id: String, state: tauri::State<'_, Mutex<AppState>>) -> AppResult<()> {
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
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<String>> {
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    refresh_database_catalog(registry, require_cache(&app)?.clone(), id).await
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
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<RoutineDescription>> {
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    let rows = registry.list_routines(&id, &database, &schema).await?;
    if let Ok(cache) = require_cache(&app) {
        let cache = cache.clone();
        let cache_id = id.clone();
        let cache_database = database.clone();
        let cache_schema = schema.clone();
        let cache_rows = rows.clone();
        match tokio::task::spawn_blocking(move || {
            cache.upsert_routines(&cache_id, &cache_database, &cache_schema, &cache_rows)
        })
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!(?e, "routine catalog index update failed"),
            Err(e) => tracing::warn!(?e, "routine catalog index task failed"),
        }
    }
    Ok(rows)
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
    let refresh_lock = catalog_refresh_lock(&id, &database);
    let _refresh_guard = refresh_lock.lock().await;
    match registry.list_all_tables(&id, &database).await {
        Ok(rows) => {
            let (schemas, schemas_complete) = match registry.list_schemas(&id, &database).await {
                Ok(schemas) => (schemas, true),
                Err(e) => {
                    tracing::warn!(
                        ?e,
                        "catalog schema listing failed; indexing relation schemas only"
                    );
                    (Vec::new(), false)
                }
            };
            if let Ok(cache) = require_cache(&app) {
                let cache = cache.clone();
                let cache_id = id.clone();
                let cache_database = database.clone();
                let cache_schemas = schemas;
                let cache_rows = rows.clone();
                match tokio::task::spawn_blocking(move || {
                    cache.replace_relations(
                        &cache_id,
                        &cache_database,
                        &cache_schemas,
                        schemas_complete,
                        &cache_rows,
                        now_ms(),
                    )
                })
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => tracing::warn!(?e, "catalog index update failed"),
                    Err(e) => tracing::warn!(?e, "catalog index task failed"),
                }
            }
            emit_progress(&app, &job.clone().done());
            Ok(rows)
        }
        Err(e) => {
            emit_progress(&app, &job.error(e.to_string()));
            Err(e.into())
        }
    }
}

/// Search the persistent database catalog. Catalog construction, DSL parsing,
/// matching, kind filtering, and result bounds all stay in Rust/SQLite; the
/// frontend receives only a small render-ready page.
#[tauri::command]
pub async fn db_search_catalog(
    id: String,
    database: String,
    query: String,
    limit: Option<u32>,
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<CatalogSearchResult> {
    let cache = require_cache(&app)?;
    let requested_limit = limit.unwrap_or(200) as usize;
    let query_database = SchemaCache::query_database_scope(&query, &database);
    let refresh_scope = query_database.as_deref().unwrap_or("").to_owned();
    let initial = {
        let cache = cache.clone();
        let cache_id = id.clone();
        let cache_database = database.clone();
        let cache_query = query.clone();
        tokio::task::spawn_blocking(move || {
            cache.search_catalog(&cache_id, &cache_database, &cache_query, requested_limit)
        })
        .await
        .map_err(|e| AppError::Other(format!("join: {e}")))??
    };
    if initial.query_too_broad {
        return Ok(initial);
    }

    let indexed_at = initial.indexed_at;
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    if indexed_at.is_none() {
        let refresh_lock = catalog_refresh_lock(&id, &refresh_scope);
        let _refresh_guard = refresh_lock.lock().await;
        let after_wait = {
            let cache = cache.clone();
            let cache_id = id.clone();
            let cache_database = database.clone();
            let cache_query = query.clone();
            tokio::task::spawn_blocking(move || {
                cache.search_catalog(&cache_id, &cache_database, &cache_query, requested_limit)
            })
            .await
            .map_err(|e| AppError::Other(format!("join: {e}")))??
        };
        if after_wait.indexed_at.is_some() {
            return Ok(after_wait);
        }
        if let Some(query_database) = query_database.clone() {
            refresh_catalog(registry, cache.clone(), id.clone(), query_database).await?;
        } else {
            refresh_database_catalog(registry, cache.clone(), id.clone()).await?;
        }
    } else if indexed_at.map_or(false, |ts| now_ms() - ts > CATALOG_TTL_MS) {
        let refresh_lock = catalog_refresh_lock(&id, &refresh_scope);
        let refresh_cache = cache.clone();
        let refresh_id = id.clone();
        let refresh_database = query_database.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(_guard) = refresh_lock.try_lock_owned() else {
                return;
            };
            let refresh = if let Some(refresh_database) = refresh_database {
                refresh_catalog(registry, refresh_cache, refresh_id, refresh_database)
                    .await
                    .map(|_| ())
            } else {
                refresh_database_catalog(registry, refresh_cache, refresh_id)
                    .await
                    .map(|_| ())
            };
            if let Err(e) = refresh {
                tracing::warn!(?e, "background catalog refresh failed; serving stale index");
            }
        });
        return Ok(initial);
    }

    tokio::task::spawn_blocking(move || {
        cache.search_catalog(&id, &database, &query, requested_limit)
    })
    .await
    .map_err(|e| AppError::Other(format!("join: {e}")))?
    .map_err(Into::into)
}

// ── Query ───────────────────────────────────────────────────────────────

/// Execute one or more `;`-separated statements. Returns one
/// [`QueryResult`] per statement, in order. Comments and string literals
/// are respected by the splitter.
///
/// `database` (MSSQL only) and `schema` (Postgres only) apply session
/// context once before the first user statement runs.
///
/// `captureLocks` (default: `false`) toggles the per-query lock
/// telemetry sidecar — see [`zen_db::ExecuteOptions::capture_locks`].
/// `lockSampleIntervalMs` (default: driver default, currently 25 ms)
/// sets the polling cadence. The "Run with locks" UI button passes
/// `captureLocks: true`.
///
/// `queryId` is an optional opaque identifier minted by the
/// front-end (typically a UUID). When supplied, the registry
/// registers a cancellation token under that id for the duration of
/// the run; calling [`db_cancel_query`] with the same id while the
/// query is in flight aborts the driver future and returns
/// `DbError::Cancelled` to the caller. Without `queryId` the run is
/// uncancellable — same behaviour as before this command grew the
/// parameter.
#[tauri::command]
pub async fn db_query(
    id: String,
    sql: String,
    database: Option<String>,
    schema: Option<String>,
    capture_locks: Option<bool>,
    lock_sample_interval_ms: Option<u64>,
    query_id: Option<String>,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<QueryResult>> {
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };

    let stmts = zen_db::split_statements(&sql);
    let trimmed: Vec<&str> = stmts
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let options = ExecuteOptions {
        capture_locks: capture_locks.unwrap_or(false),
        lock_sample_interval_ms,
    };

    let result = if let Some(qid) = query_id {
        registry
            .execute_batch_cancellable(
                &id,
                &qid,
                database.as_deref(),
                schema.as_deref(),
                &trimmed,
                &options,
            )
            .await
    } else {
        registry
            .execute_batch_with_options(
                &id,
                database.as_deref(),
                schema.as_deref(),
                &trimmed,
                &options,
            )
            .await
    };

    Ok(result?)
}

/// Cancel a running query by its `query_id`. Returns `true` if a
/// matching in-flight query was found and signalled, `false`
/// otherwise (already finished, never started, or wrong id).
/// Idempotent — safe to call repeatedly.
#[tauri::command]
pub async fn db_cancel_query(
    query_id: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<bool> {
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    Ok(registry.cancel(&query_id))
}

/// Run the user SQL through the dialect's "explain + analyze" path
/// and return the captured plan. Drives the perf-visualizer "Run
/// with plan" toolbar button + the auto-EXPLAIN piggyback. The
/// front-end parses `result.raw` into a unified `PlanRoot` model
/// and renders Raw / Plan / Flame views.
// `analyze`:
//   - `true`  → execute and gather actual rows / timings / buffers
//                (Postgres `ANALYZE`, MSSQL `STATISTICS XML`).
//   - `false` → planner-estimate only — no execution, safe for
//                destructive statements (Postgres `EXPLAIN`, MSSQL
//                `SHOWPLAN_XML`).
// `Option<bool>` defaulting to `true` preserves the original
// `db_explain_query` behaviour for callers (the auto-EXPLAIN
// piggyback in `handleRun`) that don't bother to pass the flag.
#[tauri::command]
pub async fn db_explain_query(
    id: String,
    sql: String,
    database: Option<String>,
    schema: Option<String>,
    analyze: Option<bool>,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<ExplainResult> {
    let registry = {
        let s = state.lock().await;
        registry(&s)
    };
    Ok(registry
        .explain_query(
            &id,
            database.as_deref(),
            schema.as_deref(),
            &sql,
            analyze.unwrap_or(true),
        )
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
            emit_progress(&app, &job.clone().step((idx) as u32, Some(t.clone())));
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
                &job.clone()
                    .error(format!("{errors} table(s) failed to refresh")),
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
    Ok(
        tokio::task::spawn_blocking(move || cache.list_cached(&id, &database, &schema))
            .await
            .map_err(|e| AppError::Other(format!("join: {e}")))??,
    )
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
