//! MSSQL driver backed by tiberius.
//!
//! tiberius doesn't ship a connection pool, so each `MsSqlConnection`
//! owns a single client. Concurrent queries on the same connection are
//! serialised by the per-entry mutex in [`crate::ConnectionRegistry`].

use std::time::Instant;

use async_trait::async_trait;
use tiberius::numeric::Numeric;
use tiberius::{AuthMethod, Client, ColumnData, Config, EncryptionLevel, QueryItem};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::driver::{DbConnection, DbError, DbResult};
use crate::types::{
    Cell, CheckDescription, Column, ColumnDescription, ConnectionConfig, ForeignKeyDescription,
    IndexDescription, KeyDescription, QueryResult, RoutineDescription, RoutineKind,
    TableDescription, TableKind, TableSummary, TriggerDescription,
};

type MsClient = Client<Compat<TcpStream>>;

pub struct MsSqlConnection {
    client: MsClient,
}

impl MsSqlConnection {
    pub async fn connect(cfg: ConnectionConfig) -> DbResult<Self> {
        let mut tib_cfg = Config::new();
        tib_cfg.host(&cfg.host);
        tib_cfg.port(cfg.port);
        if !cfg.database.is_empty() {
            tib_cfg.database(&cfg.database);
        }
        tib_cfg.authentication(AuthMethod::sql_server(&cfg.username, &cfg.password));
        // Dev/CI containers ship with self-signed certs.
        if cfg.trust_server_certificate {
            tib_cfg.trust_cert();
        }
        // Azure SQL Edge / mssql-server containers default to TLS-on; keep
        // encryption negotiated.
        tib_cfg.encryption(EncryptionLevel::Required);

        let tcp = TcpStream::connect(tib_cfg.get_addr())
            .await
            .map_err(|e| DbError::Connect(e.to_string()))?;
        tcp.set_nodelay(true).ok();

        let client = Client::connect(tib_cfg, tcp.compat_write())
            .await
            .map_err(|e| DbError::Connect(e.to_string()))?;

        Ok(Self { client })
    }
}

#[async_trait]
impl DbConnection for MsSqlConnection {
    async fn ping(&mut self) -> DbResult<()> {
        let _ = self
            .client
            .simple_query("SELECT 1")
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;
        Ok(())
    }

    async fn list_databases(&mut self) -> DbResult<Vec<String>> {
        run_string_column(
            &mut self.client,
            "SELECT name FROM sys.databases ORDER BY name",
            "name",
        )
        .await
    }

    async fn list_schemas(&mut self, database: &str) -> DbResult<Vec<String>> {
        // Switch DB then list schemas.
        let use_stmt = format!("USE [{}]", escape_ident(database));
        self.client
            .simple_query(use_stmt)
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;
        run_string_column(
            &mut self.client,
            "SELECT name FROM sys.schemas \
             WHERE name NOT IN ('sys','INFORMATION_SCHEMA','db_owner','db_accessadmin', \
                                'db_securityadmin','db_ddladmin','db_backupoperator', \
                                'db_datareader','db_datawriter','db_denydatareader','db_denydatawriter') \
             ORDER BY name",
            "name",
        )
        .await
    }

    async fn list_tables(&mut self, database: &str, schema: &str) -> DbResult<Vec<String>> {
        let use_stmt = format!("USE [{}]", escape_ident(database));
        self.client
            .simple_query(use_stmt)
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;

        let q = format!(
            "SELECT t.name AS name FROM sys.tables t \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             WHERE s.name = '{}' \
             UNION ALL \
             SELECT v.name FROM sys.views v \
             JOIN sys.schemas s ON s.schema_id = v.schema_id \
             WHERE s.name = '{}' \
             ORDER BY name",
            schema.replace('\'', "''"),
            schema.replace('\'', "''"),
        );
        run_string_column(&mut self.client, &q, "name").await
    }

    async fn list_all_tables(&mut self, database: &str) -> DbResult<Vec<TableSummary>> {
        // tiberius shares one TCP session, so the `USE` plus the
        // following query naturally run on the same db.
        let use_stmt = format!("USE [{}]", escape_ident(database));
        self.client
            .simple_query(use_stmt)
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;

        let q = "SELECT s.name AS schema_name, t.name AS table_name, 'TABLE' AS table_type \
                 FROM sys.tables t \
                 JOIN sys.schemas s ON s.schema_id = t.schema_id \
                 WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA','db_owner','db_accessadmin', \
                                      'db_securityadmin','db_ddladmin','db_backupoperator', \
                                      'db_datareader','db_datawriter','db_denydatareader','db_denydatawriter') \
                 UNION ALL \
                 SELECT s.name, v.name, 'VIEW' \
                 FROM sys.views v \
                 JOIN sys.schemas s ON s.schema_id = v.schema_id \
                 WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA','db_owner','db_accessadmin', \
                                      'db_securityadmin','db_ddladmin','db_backupoperator', \
                                      'db_datareader','db_datawriter','db_denydatareader','db_denydatawriter') \
                 ORDER BY schema_name, table_name";

        let mut out: Vec<TableSummary> = Vec::new();
        let mut stream = self
            .client
            .simple_query(q.to_string())
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;
        while let Some(item) = stream
            .try_next()
            .await
            .map_err(|e| DbError::Query(e.to_string()))?
        {
            if let QueryItem::Row(row) = item {
                let schema = row
                    .try_get::<&str, _>("schema_name")
                    .ok()
                    .flatten()
                    .unwrap_or_default()
                    .to_string();
                let name = row
                    .try_get::<&str, _>("table_name")
                    .ok()
                    .flatten()
                    .unwrap_or_default()
                    .to_string();
                let kind_raw = row
                    .try_get::<&str, _>("table_type")
                    .ok()
                    .flatten()
                    .unwrap_or("TABLE");
                let kind = if kind_raw.eq_ignore_ascii_case("VIEW") {
                    TableKind::View
                } else {
                    TableKind::Table
                };
                if !name.is_empty() && !schema.is_empty() {
                    out.push(TableSummary { schema, name, kind });
                }
            }
        }
        Ok(out)
    }

    async fn describe_table(
        &mut self,
        database: &str,
        schema: &str,
        table: &str,
    ) -> DbResult<TableDescription> {
        // Pin the session to the requested database first; the column
        // metadata queries below all reference the current DB's
        // INFORMATION_SCHEMA / sys.* views.
        let use_stmt = format!("USE [{}]", escape_ident(database));
        self.client
            .simple_query(use_stmt)
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;

        // Detect view vs base table up-front. Empty result = not found.
        let kind_q = format!(
            "SELECT TOP 1 TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_SCHEMA = '{}' AND TABLE_NAME = '{}'",
            schema.replace('\'', "''"),
            table.replace('\'', "''"),
        );
        let mut kind = TableKind::Table;
        let mut found = false;
        {
            let mut stream = self
                .client
                .simple_query(kind_q)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    found = true;
                    if let Some(t) = row.try_get::<&str, _>("TABLE_TYPE").ok().flatten() {
                        if t.eq_ignore_ascii_case("VIEW") {
                            kind = TableKind::View;
                        }
                    }
                }
            }
        }
        if !found {
            return Err(DbError::Query(format!(
                "table not found: {schema}.{table}"
            )));
        }

        // Column rundown — ordinal, type with length, null-ability,
        // default, plus a left-join against KEY_COLUMN_USAGE filtered to
        // PRIMARY KEY constraints to flag PK columns.
        let q = format!(
            "SELECT \
                c.COLUMN_NAME AS column_name, \
                c.DATA_TYPE AS data_type, \
                c.CHARACTER_MAXIMUM_LENGTH AS char_max, \
                c.NUMERIC_PRECISION AS num_prec, \
                c.NUMERIC_SCALE AS num_scale, \
                c.IS_NULLABLE AS is_nullable, \
                c.COLUMN_DEFAULT AS column_default, \
                c.ORDINAL_POSITION AS ordinal_position, \
                CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS is_pk \
             FROM INFORMATION_SCHEMA.COLUMNS c \
             LEFT JOIN ( \
               SELECT k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME \
               FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t \
               JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k \
                 ON k.CONSTRAINT_NAME = t.CONSTRAINT_NAME \
                AND k.TABLE_SCHEMA  = t.TABLE_SCHEMA \
                AND k.TABLE_NAME    = t.TABLE_NAME \
               WHERE t.CONSTRAINT_TYPE = 'PRIMARY KEY' \
             ) pk \
               ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA \
              AND pk.TABLE_NAME   = c.TABLE_NAME \
              AND pk.COLUMN_NAME  = c.COLUMN_NAME \
             WHERE c.TABLE_SCHEMA = '{}' AND c.TABLE_NAME = '{}' \
             ORDER BY c.ORDINAL_POSITION",
            schema.replace('\'', "''"),
            table.replace('\'', "''"),
        );

        let mut columns: Vec<ColumnDescription> = Vec::new();
        // Wrap the columns stream in a block so it's dropped before
        // the next `simple_query` borrows `self.client` mutably again.
        // tiberius's `Client` is `!Sync` and the stream holds a
        // `&mut Client` for its whole lifetime; sequential queries
        // need scoped streams.
        {
            let mut stream = self
                .client
                .simple_query(q)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let name: String = row
                        .try_get::<&str, _>("column_name")
                        .ok()
                        .flatten()
                        .unwrap_or_default()
                        .to_string();
                    let base_type: String = row
                        .try_get::<&str, _>("data_type")
                        .ok()
                        .flatten()
                        .unwrap_or_default()
                        .to_string();
                    let char_max: Option<i32> = row.try_get::<i32, _>("char_max").ok().flatten();
                    let num_prec: Option<u8> = row.try_get::<u8, _>("num_prec").ok().flatten();
                    let num_scale: Option<i32> = row.try_get::<i32, _>("num_scale").ok().flatten();
                    let is_nullable: String = row
                        .try_get::<&str, _>("is_nullable")
                        .ok()
                        .flatten()
                        .unwrap_or("YES")
                        .to_string();
                    let default: Option<String> = row
                        .try_get::<&str, _>("column_default")
                        .ok()
                        .flatten()
                        .map(|s| s.to_string());
                    let ordinal: i32 =
                        row.try_get::<i32, _>("ordinal_position").ok().flatten().unwrap_or(0);
                    let is_pk_raw: i32 = row.try_get::<i32, _>("is_pk").ok().flatten().unwrap_or(0);

                    let data_type = format_mssql_type(&base_type, char_max, num_prec, num_scale);

                    columns.push(ColumnDescription {
                        name,
                        data_type,
                        nullable: is_nullable.eq_ignore_ascii_case("YES"),
                        default,
                        ordinal,
                        is_primary_key: is_pk_raw != 0,
                    });
                }
            }
        }

        // ── Keys (PRIMARY KEY + UNIQUE) ──────────────────────────────
        // `sys.key_constraints` stores the PK/UQ catalogue; the
        // associated `sys.indexes` row gives us the column ordering
        // via `sys.index_columns`. One row per (constraint, column)
        // pair — collapsed into the `KeyDescription` Vec in Rust.
        let q_keys = format!(
            "SELECT \
                kc.name AS name, \
                kc.type AS kc_type, \
                COL_NAME(ic.object_id, ic.column_id) AS col_name, \
                ic.key_ordinal AS key_ordinal \
             FROM sys.key_constraints kc \
             JOIN sys.indexes i \
               ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id \
             JOIN sys.index_columns ic \
               ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             WHERE kc.parent_object_id = OBJECT_ID('{}.{}') \
               AND ic.is_included_column = 0 \
             ORDER BY kc.name, ic.key_ordinal",
            schema.replace('\'', "''"),
            table.replace('\'', "''"),
        );
        let mut keys_acc: Vec<(String, String, String, i32)> = Vec::new();
        {
            let mut stream = self
                .client
                .simple_query(q_keys)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let n = row
                        .try_get::<&str, _>("name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let t = row
                        .try_get::<&str, _>("kc_type")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let c = row
                        .try_get::<&str, _>("col_name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let o = row.try_get::<i32, _>("key_ordinal").ok().flatten().unwrap_or(0);
                    keys_acc.push((n, t, c, o));
                }
            }
        }
        let keys = collapse_keys(keys_acc);

        // ── Foreign keys ─────────────────────────────────────────────
        let q_fks = format!(
            "SELECT \
                fk.name AS name, \
                COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS col, \
                rs.name AS ref_schema, \
                rt.name AS ref_table, \
                COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS ref_col, \
                fkc.constraint_column_id AS col_ord \
             FROM sys.foreign_keys fk \
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
             JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id \
             JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
             WHERE fk.parent_object_id = OBJECT_ID('{}.{}') \
             ORDER BY fk.name, fkc.constraint_column_id",
            schema.replace('\'', "''"),
            table.replace('\'', "''"),
        );
        let mut fk_acc: Vec<(String, String, String, String, String, i32)> = Vec::new();
        {
            let mut stream = self
                .client
                .simple_query(q_fks)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let n = row
                        .try_get::<&str, _>("name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let c = row
                        .try_get::<&str, _>("col")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let rs = row
                        .try_get::<&str, _>("ref_schema")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let rt = row
                        .try_get::<&str, _>("ref_table")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let rc = row
                        .try_get::<&str, _>("ref_col")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let o = row.try_get::<i32, _>("col_ord").ok().flatten().unwrap_or(0);
                    fk_acc.push((n, c, rs, rt, rc, o));
                }
            }
        }
        let foreign_keys = collapse_foreign_keys(fk_acc);

        // ── Checks ───────────────────────────────────────────────────
        let q_checks = format!(
            "SELECT cc.name AS name, cc.definition AS definition \
             FROM sys.check_constraints cc \
             WHERE cc.parent_object_id = OBJECT_ID('{}.{}') \
             ORDER BY cc.name",
            schema.replace('\'', "''"),
            table.replace('\'', "''"),
        );
        let mut checks: Vec<CheckDescription> = Vec::new();
        {
            let mut stream = self
                .client
                .simple_query(q_checks)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let name = row
                        .try_get::<&str, _>("name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let expr = row
                        .try_get::<&str, _>("definition")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    checks.push(CheckDescription {
                        name,
                        expression: expr,
                    });
                }
            }
        }

        // ── Indexes (excluding PK/UQ — those live under Keys) ───────
        let q_indexes = format!(
            "SELECT \
                i.name AS name, \
                CAST(i.is_unique AS int) AS is_unique, \
                COL_NAME(ic.object_id, ic.column_id) AS col, \
                ic.key_ordinal AS key_ordinal \
             FROM sys.indexes i \
             JOIN sys.index_columns ic \
               ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             WHERE i.object_id = OBJECT_ID('{}.{}') \
               AND i.is_primary_key = 0 \
               AND i.is_unique_constraint = 0 \
               AND ic.is_included_column = 0 \
               AND i.name IS NOT NULL \
             ORDER BY i.name, ic.key_ordinal",
            schema.replace('\'', "''"),
            table.replace('\'', "''"),
        );
        let mut idx_acc: Vec<(String, bool, String, i32)> = Vec::new();
        {
            let mut stream = self
                .client
                .simple_query(q_indexes)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let n = row
                        .try_get::<&str, _>("name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let u = row.try_get::<i32, _>("is_unique").ok().flatten().unwrap_or(0) != 0;
                    let c = row
                        .try_get::<&str, _>("col")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let o = row.try_get::<i32, _>("key_ordinal").ok().flatten().unwrap_or(0);
                    idx_acc.push((n, u, c, o));
                }
            }
        }
        let indexes = collapse_indexes(idx_acc);

        // ── Triggers ─────────────────────────────────────────────────
        let q_triggers = format!(
            "SELECT \
                t.name AS name, \
                CAST(OBJECTPROPERTY(t.object_id, 'ExecIsInsteadOfTrigger') AS int) AS instead_of, \
                CAST(OBJECTPROPERTY(t.object_id, 'ExecIsInsertTrigger') AS int) AS on_insert, \
                CAST(OBJECTPROPERTY(t.object_id, 'ExecIsUpdateTrigger') AS int) AS on_update, \
                CAST(OBJECTPROPERTY(t.object_id, 'ExecIsDeleteTrigger') AS int) AS on_delete, \
                OBJECT_DEFINITION(t.object_id) AS definition \
             FROM sys.triggers t \
             WHERE t.parent_id = OBJECT_ID('{}.{}') \
             ORDER BY t.name",
            schema.replace('\'', "''"),
            table.replace('\'', "''"),
        );
        let mut triggers: Vec<TriggerDescription> = Vec::new();
        {
            let mut stream = self
                .client
                .simple_query(q_triggers)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let name = row
                        .try_get::<&str, _>("name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let instead = row.try_get::<i32, _>("instead_of").ok().flatten().unwrap_or(0) != 0;
                    let on_ins = row.try_get::<i32, _>("on_insert").ok().flatten().unwrap_or(0) != 0;
                    let on_upd = row.try_get::<i32, _>("on_update").ok().flatten().unwrap_or(0) != 0;
                    let on_del = row.try_get::<i32, _>("on_delete").ok().flatten().unwrap_or(0) != 0;
                    let definition = row
                        .try_get::<&str, _>("definition")
                        .ok()
                        .flatten()
                        .map(|s| s.to_string());
                    let timing = if instead { "INSTEAD OF" } else { "AFTER" }.to_string();
                    let mut events = Vec::new();
                    if on_ins {
                        events.push("INSERT".to_string());
                    }
                    if on_upd {
                        events.push("UPDATE".to_string());
                    }
                    if on_del {
                        events.push("DELETE".to_string());
                    }
                    triggers.push(TriggerDescription {
                        name,
                        timing,
                        events,
                        definition,
                    });
                }
            }
        }

        Ok(TableDescription {
            database: database.to_string(),
            schema: schema.to_string(),
            name: table.to_string(),
            kind,
            columns,
            indexes,
            foreign_keys,
            keys,
            checks,
            triggers,
        })
    }

    async fn list_routines(
        &mut self,
        database: &str,
        schema: &str,
    ) -> DbResult<Vec<RoutineDescription>> {
        let use_stmt = format!("USE [{}]", escape_ident(database));
        self.client
            .simple_query(use_stmt)
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;

        // Object types: 'P' = stored procedure, 'PC' = CLR procedure,
        // 'FN' = scalar function, 'IF' = inline TVF, 'TF' = TVF,
        // 'AF' = aggregate function. We surface all of them.
        // Return type: only relevant for FN; for TVFs we report
        // "TABLE", and for procedures/aggregates we leave it None.
        let q_objs = format!(
            "SELECT \
                o.object_id AS object_id, \
                o.name AS name, \
                RTRIM(o.type) AS obj_type, \
                CASE \
                  WHEN o.type = 'FN' THEN TYPE_NAME(p_ret.user_type_id) \
                  WHEN o.type IN ('IF', 'TF') THEN 'TABLE' \
                  ELSE NULL END AS return_type \
             FROM sys.objects o \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             LEFT JOIN sys.parameters p_ret \
               ON p_ret.object_id = o.object_id AND p_ret.parameter_id = 0 \
             WHERE s.name = '{}' \
               AND o.type IN ('P','PC','FN','IF','TF','AF') \
             ORDER BY o.name",
            schema.replace('\'', "''"),
        );

        // (object_id, name, kind, return_type)
        let mut objs: Vec<(i32, String, String, Option<String>)> = Vec::new();
        {
            let mut stream = self
                .client
                .simple_query(q_objs)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let id = row.try_get::<i32, _>("object_id").ok().flatten().unwrap_or(0);
                    let name = row
                        .try_get::<&str, _>("name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let kind_raw = row
                        .try_get::<&str, _>("obj_type")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    let ret = row
                        .try_get::<&str, _>("return_type")
                        .ok()
                        .flatten()
                        .map(|s| s.to_string());
                    objs.push((id, name, kind_raw, ret));
                }
            }
        }

        // Argument types per object_id, excluding the return-type
        // pseudo-parameter (parameter_id = 0).
        let q_args = format!(
            "SELECT \
                p.object_id AS object_id, \
                p.parameter_id AS parameter_id, \
                TYPE_NAME(p.user_type_id) AS type_name \
             FROM sys.parameters p \
             JOIN sys.objects o ON o.object_id = p.object_id \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = '{}' \
               AND o.type IN ('P','PC','FN','IF','TF','AF') \
               AND p.parameter_id > 0 \
             ORDER BY p.object_id, p.parameter_id",
            schema.replace('\'', "''"),
        );
        let mut args: std::collections::HashMap<i32, Vec<String>> = std::collections::HashMap::new();
        {
            let mut stream = self
                .client
                .simple_query(q_args)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::Query(e.to_string()))?
            {
                if let QueryItem::Row(row) = item {
                    let id = row.try_get::<i32, _>("object_id").ok().flatten().unwrap_or(0);
                    let ty = row
                        .try_get::<&str, _>("type_name")
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string();
                    args.entry(id).or_default().push(ty);
                }
            }
        }

        Ok(objs
            .into_iter()
            .map(|(id, name, kind_raw, ret)| {
                let kind = match kind_raw.as_str() {
                    "P" | "PC" => RoutineKind::Procedure,
                    _ => RoutineKind::Function,
                };
                RoutineDescription {
                    schema: schema.to_string(),
                    name,
                    kind,
                    language: Some("sql".to_string()),
                    return_type: ret,
                    argument_types: args.remove(&id).unwrap_or_default(),
                }
            })
            .collect())
    }

    async fn execute_batch(
        &mut self,
        database: Option<&str>,
        _schema: Option<&str>,
        statements: &[&str],
    ) -> DbResult<Vec<QueryResult>> {
        // tiberius's Client is a single live TCP connection, so the
        // `USE` and every subsequent statement naturally share session
        // state. No pinning required.
        if let Some(db) = database {
            let stmt = format!("USE [{}]", escape_ident(db));
            self.client
                .simple_query(stmt)
                .await
                .map_err(|e| DbError::Query(e.to_string()))?;
        }
        let mut out = Vec::with_capacity(statements.len());
        for sql in statements {
            out.push(self.execute(sql).await?);
        }
        Ok(out)
    }

    async fn execute(&mut self, sql: &str) -> DbResult<QueryResult> {
        let start = Instant::now();
        let mut stream = self
            .client
            .simple_query(sql.to_string())
            .await
            .map_err(|e| DbError::Query(e.to_string()))?;

        let mut columns: Vec<Column> = Vec::new();
        let mut rows: Vec<Vec<Cell>> = Vec::new();

        while let Some(item) = stream
            .try_next()
            .await
            .map_err(|e| DbError::Query(e.to_string()))?
        {
            match item {
                QueryItem::Metadata(meta) => {
                    if columns.is_empty() {
                        columns = meta
                            .columns()
                            .iter()
                            .map(|c| Column {
                                name: c.name().to_string(),
                                type_name: format!("{:?}", c.column_type()),
                            })
                            .collect();
                    }
                }
                QueryItem::Row(row) => {
                    let mut cells = Vec::with_capacity(row.len());
                    for col_data in row.into_iter() {
                        cells.push(decode_cell(&col_data));
                    }
                    rows.push(cells);
                }
            }
        }

        // tiberius's `simple_query` does not surface a unified
        // `rows_affected` count across all batches in v0.12; for v1 we
        // report None for mutations and let the UI badge "OK" when a
        // statement returns no rows. v2 will switch to `query` for
        // mutations to capture the count.
        Ok(QueryResult {
            statement: sql.to_string(),
            columns,
            rows,
            rows_affected: None,
            duration_ms: start.elapsed().as_millis() as u64,
        })
    }
}

async fn run_string_column(
    client: &mut MsClient,
    sql: &str,
    col: &str,
) -> DbResult<Vec<String>> {
    let mut stream = client
        .simple_query(sql.to_string())
        .await
        .map_err(|e| DbError::Query(e.to_string()))?;
    let mut out = Vec::new();
    while let Some(item) = stream
        .try_next()
        .await
        .map_err(|e| DbError::Query(e.to_string()))?
    {
        if let QueryItem::Row(row) = item {
            if let Some(v) = row.try_get::<&str, _>(col).ok().flatten() {
                out.push(v.to_string());
            }
        }
    }
    Ok(out)
}

fn escape_ident(s: &str) -> String {
    s.replace(']', "]]")
}

/// Render an MSSQL `INFORMATION_SCHEMA.COLUMNS` row into a tooltip-ready
/// type string, e.g. `varchar(64)`, `decimal(10,2)`. Width is appended
/// only for types that actually carry one.
fn format_mssql_type(
    base: &str,
    char_max: Option<i32>,
    num_prec: Option<u8>,
    num_scale: Option<i32>,
) -> String {
    let lower = base.to_ascii_lowercase();
    match lower.as_str() {
        "char" | "varchar" | "nchar" | "nvarchar" | "binary" | "varbinary" => match char_max {
            Some(n) if n < 0 => format!("{base}(max)"),
            Some(n) => format!("{base}({n})"),
            None => base.to_string(),
        },
        "decimal" | "numeric" => match (num_prec, num_scale) {
            (Some(p), Some(s)) => format!("{base}({p},{s})"),
            (Some(p), None) => format!("{base}({p})"),
            _ => base.to_string(),
        },
        _ => base.to_string(),
    }
}

fn decode_cell(col: &ColumnData<'_>) -> Cell {
    match col {
        ColumnData::Bit(Some(v)) => Cell::Bool(*v),
        ColumnData::U8(Some(v)) => Cell::Integer(*v as i64),
        ColumnData::I16(Some(v)) => Cell::Integer(*v as i64),
        ColumnData::I32(Some(v)) => Cell::Integer(*v as i64),
        ColumnData::I64(Some(v)) => Cell::Integer(*v),
        ColumnData::F32(Some(v)) => Cell::Float(*v as f64),
        ColumnData::F64(Some(v)) => Cell::Float(*v),
        ColumnData::String(Some(v)) => Cell::Text(v.to_string()),
        ColumnData::Guid(Some(v)) => Cell::Text(v.to_string()),
        ColumnData::Numeric(Some(v)) => Cell::Text(format_numeric(v)),
        ColumnData::Binary(Some(v)) => Cell::Text(format!("0x{}", short_hex(v))),
        ColumnData::DateTime(v) => match v {
            Some(d) => Cell::Text(format!("{:?}", d)),
            None => Cell::Null,
        },
        ColumnData::SmallDateTime(v) => match v {
            Some(d) => Cell::Text(format!("{:?}", d)),
            None => Cell::Null,
        },
        ColumnData::Time(v) => match v {
            Some(d) => Cell::Text(format!("{:?}", d)),
            None => Cell::Null,
        },
        ColumnData::Date(v) => match v {
            Some(d) => Cell::Text(format!("{:?}", d)),
            None => Cell::Null,
        },
        ColumnData::DateTime2(v) => match v {
            Some(d) => Cell::Text(format!("{:?}", d)),
            None => Cell::Null,
        },
        ColumnData::DateTimeOffset(v) => match v {
            Some(d) => Cell::Text(format!("{:?}", d)),
            None => Cell::Null,
        },
        ColumnData::Xml(Some(v)) => Cell::Text(v.to_string()),
        // Any None variant is SQL NULL.
        ColumnData::U8(None)
        | ColumnData::I16(None)
        | ColumnData::I32(None)
        | ColumnData::I64(None)
        | ColumnData::F32(None)
        | ColumnData::F64(None)
        | ColumnData::Bit(None)
        | ColumnData::String(None)
        | ColumnData::Guid(None)
        | ColumnData::Numeric(None)
        | ColumnData::Binary(None)
        | ColumnData::Xml(None) => Cell::Null,
    }
}

fn format_numeric(n: &Numeric) -> String {
    // Numeric Display gives a decimal string.
    n.to_string()
}

fn short_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    const MAX: usize = 64;
    let take = bytes.len().min(MAX);
    let mut s = String::with_capacity(take * 2 + 4);
    for b in &bytes[..take] {
        let _ = write!(s, "{:02x}", b);
    }
    if bytes.len() > MAX {
        s.push_str("...");
    }
    s
}

// tiberius's QueryStream doesn't implement futures::TryStreamExt directly
// in the public re-exports; pull it in via the futures crate.
use futures::TryStreamExt;

/// Group a flat `(name, kc_type, column, ordinal)` row stream into
/// `KeyDescription`s. `kc_type` is the trimmed `sys.key_constraints.type`
/// — `"PK"` for primary keys, `"UQ"` for unique constraints. Within a
/// group, ordinal is monotonic so ordering is preserved.
fn collapse_keys(rows: Vec<(String, String, String, i32)>) -> Vec<KeyDescription> {
    let mut out: Vec<KeyDescription> = Vec::new();
    for (name, kc_type, col, _ord) in rows {
        if let Some(last) = out.last_mut() {
            if last.name == name {
                last.columns.push(col);
                continue;
            }
        }
        out.push(KeyDescription {
            name,
            columns: vec![col],
            is_primary: kc_type.trim().eq_ignore_ascii_case("PK"),
        });
    }
    out
}

/// Group a flat FK row stream
/// `(name, col, ref_schema, ref_table, ref_col, ord)` into
/// `ForeignKeyDescription`s. Multi-column FKs naturally consolidate
/// because the query orders by `(name, ord)`.
fn collapse_foreign_keys(
    rows: Vec<(String, String, String, String, String, i32)>,
) -> Vec<ForeignKeyDescription> {
    let mut out: Vec<ForeignKeyDescription> = Vec::new();
    for (name, col, ref_schema, ref_table, ref_col, _ord) in rows {
        if let Some(last) = out.last_mut() {
            if last.name == name {
                last.columns.push(col);
                last.referenced_columns.push(ref_col);
                continue;
            }
        }
        out.push(ForeignKeyDescription {
            name,
            columns: vec![col],
            referenced_schema: ref_schema,
            referenced_table: ref_table,
            referenced_columns: vec![ref_col],
        });
    }
    out
}

/// Group a flat index row stream `(name, is_unique, column, ordinal)`
/// into `IndexDescription`s.
fn collapse_indexes(rows: Vec<(String, bool, String, i32)>) -> Vec<IndexDescription> {
    let mut out: Vec<IndexDescription> = Vec::new();
    for (name, is_unique, col, _ord) in rows {
        if let Some(last) = out.last_mut() {
            if last.name == name {
                last.columns.push(col);
                continue;
            }
        }
        out.push(IndexDescription {
            name,
            columns: vec![col],
            is_unique,
            is_primary: false,
        });
    }
    out
}
