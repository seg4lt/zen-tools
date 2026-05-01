//! Database Explorer commands — thin wrappers over `zen_db`.
//!
//! Connection metadata (no password) is persisted in `preferences.json`;
//! passwords live in the OS keychain via `zen_db::secrets`. Live driver
//! handles are kept in [`zen_db::ConnectionRegistry`] inside `AppState`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::sync::Mutex;
use zen_db::{secrets, ConnectionConfig, ConnectionRegistry, DbDriver, QueryResult};

use crate::commands::preferences::{
    load_preferences, write_preferences, DbConnectionPrefs, Preferences,
};
use crate::error::{AppError, AppResult};
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
/// keychain entry, and prune the prefs entry.
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
