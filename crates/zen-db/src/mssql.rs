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
    Cell, Column, ColumnDescription, ConnectionConfig, QueryResult, TableDescription, TableKind,
    TableSummary,
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
                let ordinal: i32 = row.try_get::<i32, _>("ordinal_position").ok().flatten().unwrap_or(0);
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

        Ok(TableDescription {
            database: database.to_string(),
            schema: schema.to_string(),
            name: table.to_string(),
            kind,
            columns,
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
        })
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
