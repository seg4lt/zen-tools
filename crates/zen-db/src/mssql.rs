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
use crate::types::{Cell, Column, ConnectionConfig, QueryResult};

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
