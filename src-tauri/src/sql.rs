//! MySQL / PostgreSQL / SQLite through sqlx, with dynamic row decoding to JSON.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::mysql::{MySqlConnection, MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::postgres::{PgConnection, PgConnectOptions, PgPool, PgPoolOptions, PgRow, PgValueFormat};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{AssertSqlSafe, Column, Connection, Either, Row, ValueRef};

use crate::sql_browser::TableFilter;
use crate::store::{expand_tilde, ConnectionConfig, Kind};

/// Rows kept per result set; the rest of the stream is drained and dropped.
pub(crate) const MAX_ROWS: usize = 5000;

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub rows_affected: Option<u64>,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

#[derive(Serialize, Debug)]
pub struct TableInfo {
    pub name: String,
    pub kind: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompletionColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TableData {
    pub sql: String,
    pub result: QueryResult,
    pub has_more: bool,
    pub row_versions: Vec<String>,
}

pub enum SqlPool {
    My(MySqlPool),
    Pg(PgPool),
    BrowserMy(MySqlPool),
    BrowserPg(PgPool),
    Lite(SqlitePool),
    /// SQLite dialect over HTTP; see d1.rs for what D1 does not allow.
    D1(crate::d1::D1Client),
}

/// Server-side id of the pooled session, used to cancel its running query from
/// a second connection.
enum Canceller {
    My(MySqlConnectOptions, Arc<AtomicU64>),
    Pg(PgConnectOptions, Arc<AtomicU64>),
    Unsupported,
}

pub struct SqlConn {
    pub pool: SqlPool,
    pub browser: Option<SqlPool>,
    cancel: Canceller,
}

impl SqlConn {
    pub async fn cancel(&self) -> Result<()> {
        match &self.cancel {
            Canceller::My(o, id) => {
                anyhow::ensure!(id.load(Ordering::SeqCst) != 0, "this server did not report a connection id; cannot cancel");
                let mut c = MySqlConnection::connect_with(o).await?;
                sqlx::raw_sql(AssertSqlSafe(format!("KILL QUERY {}", id.load(Ordering::SeqCst))))
                    .execute(&mut c)
                    .await?;
                let _ = c.close().await;
            }
            Canceller::Pg(o, id) => {
                let mut c = PgConnection::connect_with(o).await?;
                sqlx::raw_sql(AssertSqlSafe(format!("SELECT pg_cancel_backend({})", id.load(Ordering::SeqCst))))
                    .execute(&mut c)
                    .await?;
                let _ = c.close().await;
            }
            Canceller::Unsupported => anyhow::bail!("this database does not support cancelling a running query"),
        }
        Ok(())
    }
}

/// The editor uses one session for transactions and session settings. Network SQL
/// browsing uses a separate, bounded pool and therefore sees committed data.
pub async fn connect(cfg: &ConnectionConfig, host: &str, port: u16, password: Option<String>) -> Result<SqlConn> {
    let timeout = Duration::from_secs(20);
    let pw = password.unwrap_or_default();
    let conn = match cfg.kind {
        Kind::Mysql => {
            // No session tweaks beyond SET NAMES, like other clients: sqlx's default
            // `SET sql_mode=(SELECT CONCAT(...)), time_zone='+00:00'` is rejected by
            // MySQL-protocol servers such as StarRocks / Doris ("Set statement only
            // support constant expr"), and would change how TIMESTAMPs display.
            let mut o = MySqlConnectOptions::new()
                .host(host)
                .port(if port == 0 { 3306 } else { port })
                .username(&cfg.user)
                .password(&pw)
                .pipes_as_concat(false)
                .no_engine_substitution(false)
                .timezone(None);
            if !cfg.database.is_empty() {
                o = o.database(&cfg.database);
            }
            let id = Arc::new(AtomicU64::new(0));
            let hook = id.clone();
            let pool = MySqlPoolOptions::new()
                .max_connections(1)
                .acquire_timeout(timeout)
                .after_connect(move |c, _| {
                    let hook = hook.clone();
                    Box::pin(async move {
                        // Best effort: only needed for Cancel; type varies across servers.
                        if let Ok(row) = sqlx::raw_sql("SELECT CONNECTION_ID()").fetch_one(&mut *c).await {
                            let v = row.try_get::<u64, _>(0).ok().or_else(|| row.try_get::<i64, _>(0).ok().map(|v| v as u64));
                            hook.store(v.unwrap_or(0), Ordering::SeqCst);
                        }
                        Ok(())
                    })
                })
                .connect_with(o.clone())
                .await?;
            SqlConn { pool: SqlPool::My(pool), browser: Some(SqlPool::BrowserMy(MySqlPoolOptions::new().max_connections(2).acquire_timeout(timeout).connect_lazy_with(o.clone()))), cancel: Canceller::My(o, id) }
        }
        Kind::Postgres => {
            let db = if cfg.database.is_empty() { "postgres" } else { &cfg.database };
            let o = PgConnectOptions::new()
                .host(host)
                .port(if port == 0 { 5432 } else { port })
                .username(&cfg.user)
                .password(&pw)
                .database(db);
            let id = Arc::new(AtomicU64::new(0));
            let hook = id.clone();
            let pool = PgPoolOptions::new()
                .max_connections(1)
                .acquire_timeout(timeout)
                .after_connect(move |c, _| {
                    let hook = hook.clone();
                    Box::pin(async move {
                        let v: i32 = sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut *c).await?;
                        hook.store(v as u64, Ordering::SeqCst);
                        Ok(())
                    })
                })
                .connect_with(o.clone())
                .await?;
            SqlConn { pool: SqlPool::Pg(pool), browser: Some(SqlPool::BrowserPg(PgPoolOptions::new().max_connections(2).acquire_timeout(timeout).connect_lazy_with(o.clone()))), cancel: Canceller::Pg(o, id) }
        }
        Kind::Sqlite => {
            let o = SqliteConnectOptions::new()
                .filename(expand_tilde(&cfg.file))
                .create_if_missing(false);
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .acquire_timeout(timeout)
                .connect_with(o)
                .await
                .with_context(|| format!("open {}", cfg.file))?;
            SqlConn { pool: SqlPool::Lite(pool), browser: None, cancel: Canceller::Unsupported }
        }
        Kind::D1 => {
            let client = crate::d1::D1Client::new(&cfg.cf_account_id, &cfg.database, Some(pw.clone()))?;
            SqlConn { pool: SqlPool::D1(client), browser: None, cancel: Canceller::Unsupported }
        }
        Kind::Redis | Kind::Mongodb => unreachable!("handled elsewhere"),
    };
    Ok(conn)
}

/// Check a SQLite file without creating or modifying it.
pub async fn check_sqlite_readonly(path: &str) -> Result<()> {
    let file = expand_tilde(path);
    let options = SqliteConnectOptions::new().filename(&file).read_only(true).create_if_missing(false);
    let mut conn = match SqliteConnection::connect_with(&options).await {
        Ok(conn) => conn,
        Err(error) => {
            // SQLite reports the same generic error for missing files and other
            // open failures. Only classify it as missing when metadata confirms it.
            if matches!(tokio::fs::metadata(&file).await, Err(e) if e.kind() == std::io::ErrorKind::NotFound) {
                anyhow::bail!("SQLite database file does not exist");
            }
            return Err(error.into());
        }
    };
    sqlx::query_scalar::<_, i64>("PRAGMA schema_version").fetch_one(&mut conn).await?;
    conn.close().await?;
    Ok(())
}

// ---------- value decoding ----------

fn int_json(v: i64) -> Value {
    // JS numbers lose precision beyond 2^53.
    if v.unsigned_abs() > (1u64 << 53) {
        Value::String(v.to_string())
    } else {
        Value::from(v)
    }
}

fn uint_json(v: u64) -> Value {
    if v > (1u64 << 53) { Value::String(v.to_string()) } else { Value::from(v) }
}

fn float_json(v: f64) -> Value {
    serde_json::Number::from_f64(v)
        .map(Value::Number)
        .unwrap_or_else(|| Value::String(v.to_string()))
}

fn bytes_json(b: Vec<u8>) -> Value {
    match String::from_utf8(b) {
        Ok(s) => Value::String(s),
        Err(e) => {
            let b = e.into_bytes();
            let mut s = String::from("0x");
            for byte in b.iter().take(4096) {
                s.push_str(&format!("{byte:02x}"));
            }
            if b.len() > 4096 {
                s.push('…');
            }
            Value::String(s)
        }
    }
}

pub fn bytes_preview(b: Vec<u8>) -> Value {
    bytes_json(b)
}

fn str_json<T: ToString>(v: T) -> Value {
    Value::String(v.to_string())
}

/// Try each type in order; type compatibility is checked by sqlx, so the first
/// decodable type wins.
macro_rules! cascade {
    ($row:expr, $i:expr; $($t:ty => $conv:expr),+ $(,)?) => {
        $(
            if let Ok(v) = $row.try_get::<Option<$t>, _>($i) {
                return match v { Some(v) => ($conv)(v), None => Value::Null };
            }
        )+
    };
}

pub(crate) fn decode_my(row: &MySqlRow, i: usize) -> Value {
    if row.try_get_raw(i).map(|v| v.is_null()).unwrap_or(false) {
        return Value::Null;
    }
    cascade!(row, i;
        i64 => int_json,
        u64 => uint_json,
        f64 => float_json,
        f32 => |v: f32| float_json(v as f64),
        rust_decimal::Decimal => str_json,
        chrono::NaiveDateTime => str_json,
        chrono::DateTime<chrono::Utc> => |v: chrono::DateTime<chrono::Utc>| str_json(v.naive_utc()),
        chrono::NaiveDate => str_json,
        chrono::NaiveTime => str_json,
        serde_json::Value => |v: Value| Value::String(v.to_string()),
        String => Value::String,
        Vec<u8> => bytes_json,
    );
    // Text protocol: anything else (zero dates, TIME > 24h, BIT, GEOMETRY) as raw bytes.
    match row.try_get_unchecked::<Vec<u8>, _>(i) {
        Ok(b) => bytes_json(b),
        Err(_) => Value::String(format!("<{}>", row.column(i).type_info())),
    }
}

pub(crate) fn decode_pg(row: &PgRow, i: usize) -> Value {
    let raw = match row.try_get_raw(i) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }
    let text_format = raw.format() == PgValueFormat::Text;
    cascade!(row, i;
        bool => Value::Bool,
        i16 => |v: i16| Value::from(v),
        i32 => |v: i32| Value::from(v),
        i64 => int_json,
        f32 => |v: f32| float_json(v as f64),
        f64 => float_json,
        rust_decimal::Decimal => str_json,
        String => Value::String,
        uuid::Uuid => str_json,
        chrono::NaiveDateTime => str_json,
        chrono::DateTime<chrono::Utc> => str_json,
        chrono::NaiveDate => str_json,
        chrono::NaiveTime => str_json,
        serde_json::Value => |v: Value| Value::String(v.to_string()),
        Vec<u8> => bytes_json,
    );
    // Arrays, enums, inet, intervals…: the simple query protocol hands us text.
    if text_format {
        if let Ok(raw) = row.try_get_raw(i) {
            if let Ok(s) = raw.as_str() {
                return Value::String(s.to_string());
            }
        }
    }
    Value::String(format!("<{}>", row.column(i).type_info()))
}

pub(crate) fn decode_lite(row: &SqliteRow, i: usize) -> Value {
    if row.try_get_raw(i).map(|v| v.is_null()).unwrap_or(false) {
        return Value::Null;
    }
    cascade!(row, i;
        i64 => int_json,
        f64 => float_json,
        String => Value::String,
        Vec<u8> => bytes_json,
    );
    match row.try_get_unchecked::<String, _>(i) {
        Ok(s) => Value::String(s),
        Err(_) => Value::String(format!("<{}>", row.column(i).type_info())),
    }
}

/// Run one or more statements; one QueryResult per statement.
macro_rules! run_many {
    ($pool:expr, $sql:expr, $decode:ident) => {{
        let mut out = Vec::new();
        let mut cur = QueryResult::default();
        let mut started = Instant::now();
        let mut stream = sqlx::raw_sql(AssertSqlSafe($sql)).fetch_many($pool);
        while let Some(item) = stream.try_next().await? {
            match item {
                Either::Right(row) => {
                    if cur.columns.is_empty() {
                        cur.columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                    }
                    if cur.rows.len() < MAX_ROWS {
                        cur.rows.push((0..row.len()).map(|i| $decode(&row, i)).collect());
                    } else {
                        cur.truncated = true;
                    }
                }
                Either::Left(done) => {
                    cur.rows_affected = Some(done.rows_affected());
                    cur.elapsed_ms = started.elapsed().as_millis() as u64;
                    out.push(std::mem::take(&mut cur));
                    started = Instant::now();
                }
            }
        }
        if !cur.columns.is_empty() || !cur.rows.is_empty() {
            cur.elapsed_ms = started.elapsed().as_millis() as u64;
            out.push(cur);
        }
        Ok::<_, anyhow::Error>(out)
    }};
}

// Dropping a cancelled or timed-out read must discard the underlying connection.
struct BrowserLease<DB: sqlx::Database> {
    conn: sqlx::pool::PoolConnection<DB>,
    finished: bool,
}

impl<DB: sqlx::Database> Drop for BrowserLease<DB> {
    fn drop(&mut self) {
        if !self.finished { self.conn.close_on_drop(); }
    }
}

// A timed-out read must not return a connection with an unfinished query to the pool.
macro_rules! run_browser {
    ($pool:expr, $sql:expr, $decode:ident, $timeout:expr) => {{
        let conn = $pool.acquire().await.map_err(|e| match e {
            sqlx::Error::PoolTimedOut => anyhow::anyhow!("Database connection wait timed out: connections are busy or a new connection could not be established"),
            other => other.into(),
        })?;
        let mut lease = BrowserLease { conn, finished: false };
        match tokio::time::timeout($timeout, async { run_many!(&mut *lease.conn, $sql, $decode) }).await {
            Ok(result) => { lease.finished = true; result },
            Err(_) => Err(anyhow::anyhow!("Database browsing query timed out after 30 seconds")),
        }
    }};
}

impl SqlPool {
    pub fn dialect(&self) -> Kind {
        match self {
            SqlPool::My(_) | SqlPool::BrowserMy(_) => Kind::Mysql,
            SqlPool::Pg(_) | SqlPool::BrowserPg(_) => Kind::Postgres,
            SqlPool::Lite(_) | SqlPool::D1(_) => Kind::Sqlite,
        }
    }

    /// `"schema"."table"`; D1 exposes a single database, referenced without a schema.
    pub fn table_ref(&self, schema: &str, table: &str) -> String {
        match self {
            SqlPool::D1(_) => self.quote_ident(table),
            _ => format!("{}.{}", self.quote_ident(schema), self.quote_ident(table)),
        }
    }

    pub async fn execute(&self, sql: String) -> Result<Vec<QueryResult>> {
        match self {
            SqlPool::My(p) => run_many!(p, sql, decode_my),
            SqlPool::BrowserMy(p) => run_browser!(p, sql, decode_my, Duration::from_secs(30)),
            SqlPool::Pg(p) => run_many!(p, sql, decode_pg),
            SqlPool::BrowserPg(p) => run_browser!(p, sql, decode_pg, Duration::from_secs(30)),
            SqlPool::Lite(p) => run_many!(p, sql, decode_lite),
            SqlPool::D1(c) => c.query(&sql).await,
        }
    }

    /// First column of the first result as strings.
    async fn strings(&self, sql: String) -> Result<Vec<Vec<String>>> {
        let res = self.execute(sql).await?;
        let Some(first) = res.into_iter().find(|r| !r.columns.is_empty()) else {
            return Ok(vec![]);
        };
        Ok(first
            .rows
            .into_iter()
            .map(|r| r.into_iter().map(value_to_string).collect())
            .collect())
    }

    async fn scalar(&self, sql: &str) -> Result<String> {
        Ok(self
            .strings(sql.to_string())
            .await?
            .into_iter()
            .next()
            .and_then(|r| r.into_iter().next())
            .unwrap_or_default())
    }

    pub fn quote_ident(&self, s: &str) -> String {
        match self.dialect() {
            Kind::Mysql => format!("`{}`", s.replace('`', "``")),
            _ => format!("\"{}\"", s.replace('"', "\"\"")),
        }
    }

    pub fn quote_lit(&self, s: &str) -> String {
        let quoted = s.replace('\'', "''");
        let hex = || s.bytes().map(|b| format!("{b:02x}")).collect::<String>();
        match self.dialect() {
            Kind::Mysql if s.contains(['\\', '\0']) => format!("CONVERT(X'{}' USING utf8mb4)", hex()),
            Kind::Postgres if s.contains('\\') => format!("E'{}'", quoted.replace('\\', "\\\\")),
            Kind::Sqlite if s.contains('\0') => format!("CAST(X'{}' AS TEXT)", hex()),
            _ => format!("'{quoted}'"),
        }
    }

    pub async fn server_version(&self) -> Result<String> {
        match self {
            SqlPool::My(_) | SqlPool::BrowserMy(_) => self.scalar("SELECT VERSION()").await.map(|v| format!("MySQL {v}")),
            SqlPool::Pg(_) | SqlPool::BrowserPg(_) => self.scalar("SHOW server_version").await.map(|v| format!("PostgreSQL {v}")),
            SqlPool::Lite(_) => self.scalar("SELECT sqlite_version()").await.map(|v| format!("SQLite {v}")),
            SqlPool::D1(c) => c.version().await,
        }
    }

    pub async fn current_schema(&self) -> Result<String> {
        match self {
            SqlPool::My(_) | SqlPool::BrowserMy(_) => self.scalar("SELECT DATABASE()").await,
            SqlPool::Pg(_) | SqlPool::BrowserPg(_) => self.scalar("SELECT current_schema()").await,
            SqlPool::Lite(_) | SqlPool::D1(_) => Ok("main".into()),
        }
    }

    /// PostgreSQL databases are separate connection targets, unlike schemas.
    pub async fn databases(&self) -> Result<Vec<String>> {
        if !matches!(self, SqlPool::Pg(_) | SqlPool::BrowserPg(_)) {
            return Ok(Vec::new());
        }
        let rows = self.strings(
            "SELECT datname::text FROM pg_catalog.pg_database \
             WHERE datallowconn AND NOT datistemplate \
               AND pg_catalog.has_database_privilege(oid, 'CONNECT') ORDER BY datname".into(),
        ).await?;
        Ok(rows.into_iter().filter_map(|row| row.into_iter().next()).collect())
    }

    pub async fn schemas(&self) -> Result<Vec<String>> {
        if let SqlPool::D1(_) = self {
            return Ok(vec!["main".into()]);
        }
        let sql = match self {
            SqlPool::My(_) | SqlPool::BrowserMy(_) => "SHOW DATABASES",
            SqlPool::Pg(_) | SqlPool::BrowserPg(_) => {
                "SELECT nspname FROM pg_catalog.pg_namespace \
                 WHERE nspname NOT IN ('pg_catalog','information_schema') \
                 AND nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp\\_%' \
                 ORDER BY nspname"
            }
            SqlPool::Lite(_) => "SELECT name FROM pragma_database_list ORDER BY seq",
            SqlPool::D1(_) => unreachable!(),
        };
        Ok(self
            .strings(sql.into())
            .await?
            .into_iter()
            .filter_map(|r| r.into_iter().next())
            .collect())
    }

    pub async fn tables(&self, schema: &str) -> Result<Vec<TableInfo>> {
        let lit = self.quote_lit(schema);
        let sql = match self {
            SqlPool::My(_) | SqlPool::BrowserMy(_) => format!(
                "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = {lit} ORDER BY TABLE_NAME"
            ),
            SqlPool::Pg(_) | SqlPool::BrowserPg(_) => format!(
                "SELECT c.relname, CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' \
                 ELSE 'BASE TABLE' END FROM pg_catalog.pg_class c \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = {lit} AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname"
            ),
            SqlPool::Lite(_) => format!(
                "SELECT name, type FROM {}.sqlite_master WHERE type IN ('table','view') \
                 AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
                self.quote_ident(schema)
            ),
            // Hide D1's internal tables (_cf_KV, ...).
            SqlPool::D1(_) => "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') \
                 AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name"
                .to_string(),
        };
        Ok(self
            .strings(sql)
            .await?
            .into_iter()
            .map(|r| {
                let mut it = r.into_iter();
                let name = it.next().unwrap_or_default();
                let kind = it.next().unwrap_or_default().to_lowercase();
                let kind = if kind.contains("view") { "view" } else { "table" };
                TableInfo { name, kind: kind.into() }
            })
            .collect())
    }

    pub async fn structure(&self, schema: &str, table: &str) -> Result<QueryResult> {
        if let SqlPool::D1(_) = self {
            return Ok(d1_structure(self.execute(format!("PRAGMA table_info({})", self.quote_ident(table))).await?.into_iter().next().unwrap_or_default()));
        }
        let (s, t) = (self.quote_lit(schema), self.quote_lit(table));
        let sql = match self {
            SqlPool::My(_) | SqlPool::BrowserMy(_) => format!(
                "SELECT COLUMN_NAME AS `column`, COLUMN_TYPE AS `type`, IS_NULLABLE AS `nullable`, \
                 COLUMN_DEFAULT AS `default`, COLUMN_KEY AS `key`, EXTRA AS `extra`, COLUMN_COMMENT AS `comment` \
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = {s} AND TABLE_NAME = {t} \
                 ORDER BY ORDINAL_POSITION"
            ),
            SqlPool::Pg(_) | SqlPool::BrowserPg(_) => format!(
                "SELECT a.attname AS column, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, \
                 CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable, \
                 pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default, \
                 CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid \
                   AND i.indisprimary AND a.attnum = ANY(i.indkey)) THEN 'PRI' ELSE '' END AS key, \
                 pg_catalog.col_description(c.oid, a.attnum) AS comment \
                 FROM pg_catalog.pg_attribute a \
                 JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE n.nspname = {s} AND c.relname = {t} AND a.attnum > 0 AND NOT a.attisdropped \
                 ORDER BY a.attnum"
            ),
            SqlPool::Lite(_) => format!(
                "SELECT name AS \"column\", type, CASE WHEN \"notnull\" THEN 'NO' ELSE 'YES' END AS nullable, \
                 dflt_value AS \"default\", CASE WHEN pk > 0 THEN 'PRI' ELSE '' END AS \"key\" \
                 FROM pragma_table_info({t}, {s}) ORDER BY cid"
            ),
            SqlPool::D1(_) => unreachable!(),
        };
        Ok(self.execute(sql).await?.into_iter().next().unwrap_or_default())
    }

    // Use the server representation of the full row, including values that the
    // grid only previews. The same expression runs in the UPDATE/DELETE predicate.
    async fn row_version_expression(&self, schema: &str, table: &str) -> Result<String> {
        if self.dialect() == Kind::Postgres {
            return Ok(format!("pg_catalog.md5(CAST({}.* AS text))", self.quote_ident(table)));
        }
        let columns = self.structure(schema, table).await?;
        let names = columns.rows.iter().filter_map(|r| r.first()?.as_str()).map(|c| self.quote_ident(c)).collect::<Vec<_>>();
        anyhow::ensure!(!names.is_empty(), "Table columns are unavailable");
        if self.dialect() == Kind::Mysql {
            let values = names.iter().map(|c| format!("COALESCE(HEX(CAST({c} AS BINARY)), '-')")).collect::<Vec<_>>().join(", ");
            return Ok(format!("SHA2(CONCAT_WS(':', {values}), 256)"));
        }
        // Small chunks keep JSON_ARRAY below SQLite's argument limit on wide tables.
        let chunks = names.chunks(32).map(|names| {
            let values = names.iter().map(|c| format!(
                "typeof({c}) || ':' || CASE WHEN typeof({c}) = 'real' THEN printf('%!.26g', {c}) ELSE hex(CAST({c} AS BLOB)) END"
            )).collect::<Vec<_>>().join(", ");
            format!("json_array({values})")
        }).collect::<Vec<_>>();
        Ok(chunks.join(" || '|' || "))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn table_data(
        &self,
        schema: &str,
        table: &str,
        limit: u32,
        offset: u64,
        order_by: Option<String>,
        order_desc: bool,
        filter: Option<String>,
        visual_filter: Option<TableFilter>,
        capture_versions: bool,
    ) -> Result<TableData> {
        anyhow::ensure!((1..=1000).contains(&limit), "Invalid table page size");
        let mut sql = format!(" FROM {}", self.table_ref(schema, table));
        let raw = filter.as_deref().map(str::trim).unwrap_or_default();
        let visual = visual_filter.map(|f| self.visual_predicate(f)).transpose()?.unwrap_or_default();
        anyhow::ensure!(raw.is_empty() || visual.is_empty(), "Choose one filter mode");
        let predicate = if raw.is_empty() { visual.as_str() } else { raw };
        if !predicate.is_empty() {
            sql.push_str(&format!(" WHERE {predicate}"));
        }
        if let Some(col) = order_by.filter(|c| !c.is_empty()) {
            sql.push_str(&format!(
                " ORDER BY {} {}",
                self.quote_ident(&col),
                if order_desc { "DESC" } else { "ASC" }
            ));
        }
        let shown = format!("SELECT *{sql} LIMIT {limit} OFFSET {offset}");
        let version_column = if capture_versions {
            let expression = self.row_version_expression(schema, table).await?;
            format!(", ({expression}) AS __dbdock_row_version")
        } else {
            String::new()
        };
        let probe = format!("SELECT *{version_column}{sql} LIMIT {} OFFSET {offset}", limit + 1);
        let mut result = self.execute(probe).await?.into_iter().next().unwrap_or_default();
        let has_more = result.rows.len() > limit as usize;
        result.rows.truncate(limit as usize);
        let mut row_versions = Vec::with_capacity(result.rows.len());
        if capture_versions && !result.rows.is_empty() {
            anyhow::ensure!(result.columns.pop().as_deref() == Some("__dbdock_row_version"), "Row version is unavailable");
            for row in &mut result.rows {
                let version = row.pop().and_then(|v| v.as_str().map(str::to_owned)).context("Row version is unavailable")?;
                row_versions.push(version);
            }
        }
        result.rows_affected = None;
        Ok(TableData { sql: shown, result, has_more, row_versions })
    }
}

/// An UPDATE or DELETE must still match the row version shown in the grid.
#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Change {
    Update { key: BTreeMap<String, Value>, set: BTreeMap<String, Value>, version: String },
    Delete { key: BTreeMap<String, Value>, version: String },
    Insert { values: BTreeMap<String, Value> },
}

impl SqlPool {
    pub async fn columns(&self, schema: &str) -> Result<BTreeMap<String, Vec<CompletionColumn>>> {
        if let SqlPool::D1(_) = self {
            // One request: a PRAGMA per table (table-valued pragmas are not allowed).
            let tables = self.tables(schema).await?;
            if tables.is_empty() {
                return Ok(BTreeMap::new());
            }
            let sql = tables.iter().map(|t| format!("PRAGMA table_info({})", self.quote_ident(&t.name))).collect::<Vec<_>>().join("; ");
            let res = self.execute(sql).await?;
            return Ok(tables
                .into_iter()
                .zip(res)
                .map(|(t, r)| {
                    let structure = d1_structure(r);
                    let columns = structure.rows.into_iter().filter_map(|row| {
                        Some(CompletionColumn {
                            name: row.first()?.as_str()?.into(),
                            data_type: row.get(1).and_then(Value::as_str).unwrap_or_default().into(),
                            nullable: row.get(2).and_then(Value::as_str) == Some("YES"),
                        })
                    }).collect();
                    (t.name, columns)
                })
                .collect());
        }
        let lit = self.quote_lit(schema);
        let sql = match self {
            SqlPool::My(_) | SqlPool::BrowserMy(_) => format!(
                "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = {lit} ORDER BY TABLE_NAME, ORDINAL_POSITION"
            ),
            SqlPool::Pg(_) | SqlPool::BrowserPg(_) => format!(
                "SELECT c.relname, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), \
                 CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END FROM pg_catalog.pg_attribute a \
                 JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = {lit} AND c.relkind IN ('r','p','v','m','f') \
                 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum"
            ),
            SqlPool::Lite(_) => format!(
                "SELECT m.name, p.name, p.type, CASE WHEN p.\"notnull\" THEN 'NO' ELSE 'YES' END \
                 FROM {}.sqlite_master m JOIN pragma_table_info(m.name, {lit}) p \
                 WHERE m.type IN ('table','view') ORDER BY m.name, p.cid",
                self.quote_ident(schema)
            ),
            SqlPool::D1(_) => unreachable!(),
        };
        let mut out: BTreeMap<String, Vec<CompletionColumn>> = BTreeMap::new();
        for row in self.strings(sql).await? {
            if let Ok([table, name, data_type, nullable]) = <[String; 4]>::try_from(row) {
                out.entry(table).or_default().push(CompletionColumn {
                    name,
                    data_type,
                    nullable: nullable.eq_ignore_ascii_case("YES"),
                });
            }
        }
        Ok(out)
    }

    pub(crate) fn value_lit(&self, v: &Value) -> String {
        match v {
            Value::Null => "NULL".into(),
            Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
            Value::Number(n) => n.to_string(),
            Value::String(s) => self.quote_lit(s),
            other => self.quote_lit(&other.to_string()),
        }
    }

    fn where_key(&self, key: &BTreeMap<String, Value>) -> Result<String> {
        anyhow::ensure!(!key.is_empty(), "row has no primary key; cannot target it safely");
        Ok(key
            .iter()
            .map(|(k, v)| match v {
                Value::Null => format!("{} IS NULL", self.quote_ident(k)),
                v => format!("{} = {}", self.quote_ident(k), self.value_lit(v)),
            })
            .collect::<Vec<_>>()
            .join(" AND "))
    }

    pub async fn change_sql(&self, schema: &str, table: &str, changes: &[Change]) -> Result<Vec<String>> {
        let t = self.table_ref(schema, table);
        let version = if changes.iter().any(|change| !matches!(change, Change::Insert { .. })) {
            self.row_version_expression(schema, table).await?
        } else {
            String::new()
        };
        let where_row = |key: &BTreeMap<String, Value>, original: &str| -> Result<String> {
            anyhow::ensure!(!original.is_empty(), "Row version is unavailable");
            Ok(format!("{} AND ({version}) = {}", self.where_key(key)?, self.quote_lit(original)))
        };
        changes
            .iter()
            .map(|c| {
                Ok(match c {
                    Change::Update { key, set, version } => {
                        anyhow::ensure!(!set.is_empty(), "empty update");
                        let set = set
                            .iter()
                            .map(|(k, v)| format!("{} = {}", self.quote_ident(k), self.value_lit(v)))
                            .collect::<Vec<_>>()
                            .join(", ");
                        format!("UPDATE {t} SET {set} WHERE {}", where_row(key, version)?)
                    }
                    Change::Delete { key, version } => format!("DELETE FROM {t} WHERE {}", where_row(key, version)?),
                    Change::Insert { values } if values.is_empty() => match self {
                        SqlPool::My(_) | SqlPool::BrowserMy(_) => format!("INSERT INTO {t} () VALUES ()"),
                        _ => format!("INSERT INTO {t} DEFAULT VALUES"),
                    },
                    Change::Insert { values } => format!(
                        "INSERT INTO {t} ({}) VALUES ({})",
                        values.keys().map(|k| self.quote_ident(k)).collect::<Vec<_>>().join(", "),
                        values.values().map(|v| self.value_lit(v)).collect::<Vec<_>>().join(", ")
                    ),
                })
            })
            .collect()
    }

    pub(crate) async fn ensure_transactional(&self, schema: &str, table: &str) -> Result<()> {
        if self.dialect() == Kind::Mysql {
            let (s, t) = (self.quote_lit(schema), self.quote_lit(table));
            let transactional = self.scalar(&format!(
                "SELECT e.TRANSACTIONS FROM information_schema.TABLES t
                 JOIN information_schema.ENGINES e ON e.ENGINE = t.ENGINE
                 WHERE t.TABLE_SCHEMA = {s} AND t.TABLE_NAME = {t}"
            )).await?;
            anyhow::ensure!(transactional == "YES", "This table does not support transactional writes");
        }
        Ok(())
    }

    /// Apply all changes in one transaction. Updates and deletes must hit exactly
    /// one row; SQLx negotiates MySQL's FOUND_ROWS capability.
    pub async fn apply(&self, schema: &str, table: &str, changes: &[Change]) -> Result<usize> {
        self.ensure_transactional(schema, table).await?;
        let stmts = self.change_sql(schema, table, changes).await?;
        macro_rules! run_tx {
            ($p:expr) => {{
                let mut tx = $p.begin().await?;
                for (index, (sql, ch)) in stmts.iter().zip(changes).enumerate() {
                    let n = sqlx::raw_sql(AssertSqlSafe(sql.clone())).execute(&mut *tx).await?.rows_affected();
                    let insert = matches!(ch, Change::Insert { .. });
                    if !insert && n != 1 {
                        tx.rollback().await?;
                        anyhow::bail!("Row conflict: change {} no longer matches exactly one row. No changes were saved. Discard pending edits and reload.", index + 1);
                    }
                }
                tx.commit().await?;
            }};
        }
        match self {
            SqlPool::My(p) | SqlPool::BrowserMy(p) => run_tx!(p),
            SqlPool::Pg(p) | SqlPool::BrowserPg(p) => run_tx!(p),
            SqlPool::Lite(p) => run_tx!(p),
            SqlPool::D1(c) => {
                // No BEGIN on D1, but one request is one atomic batch. After each UPDATE /
                // DELETE, a guard raises "malformed JSON" unless exactly one row changed,
                // which rolls the whole batch back.
                let mut batch = Vec::new();
                for (sql, ch) in stmts.iter().zip(changes) {
                    batch.push(sql.clone());
                    if !matches!(ch, Change::Insert { .. }) {
                        batch.push("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('dbdock: expected exactly 1 row') END".into());
                    }
                }
                c.query(&batch.join(";\n")).await.map_err(|e| {
                    if e.to_string().contains("malformed JSON") {
                        anyhow::anyhow!("Row conflict: a row changed or was removed. No changes were saved. Discard pending edits and reload.")
                    } else {
                        e
                    }
                })?;
            }
        }
        Ok(stmts.len())
    }
}

/// Map `PRAGMA table_info` rows to the structure view's columns.
fn d1_structure(r: QueryResult) -> QueryResult {
    let col = |name: &str| r.columns.iter().position(|c| c == name);
    let (n, t, nn, d, pk) = (col("name"), col("type"), col("notnull"), col("dflt_value"), col("pk"));
    let get = |row: &Vec<Value>, i: Option<usize>| i.and_then(|i| row.get(i).cloned()).unwrap_or(Value::Null);
    let truthy = |v: &Value| v.as_i64().unwrap_or(0) != 0;
    QueryResult {
        columns: ["column", "type", "nullable", "default", "key"].map(String::from).to_vec(),
        rows: r
            .rows
            .iter()
            .map(|row| {
                vec![
                    get(row, n),
                    get(row, t),
                    Value::String(if truthy(&get(row, nn)) { "NO" } else { "YES" }.into()),
                    get(row, d),
                    Value::String(if truthy(&get(row, pk)) { "PRI" } else { "" }.into()),
                ]
            })
            .collect(),
        rows_affected: None,
        truncated: false,
        elapsed_ms: r.elapsed_ms,
    }
}

pub fn value_to_string(v: Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s,
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn completion_columns_include_declared_types_and_nullability() {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        let sql = SqlPool::Lite(pool);
        sql.execute("CREATE TABLE books (published BOOLEAN NOT NULL, title TEXT); CREATE VIEW book_view AS SELECT title FROM books".into()).await.unwrap();
        let columns = sql.columns("main").await.unwrap();
        assert_eq!(columns["books"], [
            CompletionColumn { name: "published".into(), data_type: "BOOLEAN".into(), nullable: false },
            CompletionColumn { name: "title".into(), data_type: "TEXT".into(), nullable: true },
        ]);
        assert_eq!(columns["book_view"][0].name, "title");
    }

    #[tokio::test]
    async fn sqlite_health_check_does_not_create_or_modify_files() {
        let dir = std::env::temp_dir().join(format!("dbdock-health-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("missing.sqlite");
        let error = check_sqlite_readonly(missing.to_str().unwrap()).await.unwrap_err();
        assert_eq!(error.to_string(), "SQLite database file does not exist");
        assert!(!missing.exists());
        let db = dir.join("valid.sqlite");
        let options = SqliteConnectOptions::new().filename(&db).create_if_missing(true);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE example (id INTEGER)").execute(&mut conn).await.unwrap();
        conn.close().await.unwrap();
        let before = std::fs::read(&db).unwrap();
        check_sqlite_readonly(db.to_str().unwrap()).await.unwrap();
        assert_eq!(std::fs::read(&db).unwrap(), before);
        let invalid = dir.join("invalid.sqlite");
        std::fs::write(&invalid, b"not a sqlite database").unwrap();
        let error = check_sqlite_readonly(invalid.to_str().unwrap()).await.unwrap_err();
        assert_ne!(error.to_string(), "SQLite database file does not exist");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn cancelled_browser_lease_discards_connection() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let opens = Arc::new(AtomicUsize::new(0));
        let counter = opens.clone();
        let pool = SqlitePoolOptions::new().max_connections(1).after_connect(move |_, _| {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }).connect("sqlite::memory:").await.unwrap();
        let conn = pool.acquire().await.unwrap();
        let lease = BrowserLease { conn, finished: false };
        let task = tokio::spawn(async move { let _lease = lease; std::future::pending::<()>().await });
        tokio::task::yield_now().await;
        task.abort();
        let _ = task.await;
        let _new_conn = pool.acquire().await.unwrap();
        assert_eq!(opens.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn browser_reports_pool_wait_timeout() {
        let pool = SqlitePoolOptions::new().max_connections(1)
            .acquire_timeout(Duration::from_millis(40)).connect("sqlite::memory:").await.unwrap();
        let held = pool.acquire().await.unwrap();
        let result = async { run_browser!(&pool, "SELECT 1", decode_lite, Duration::from_secs(1)) }.await;
        assert!(result.unwrap_err().to_string().starts_with("Database connection wait timed out"));
        drop(held);
        let result = async { run_browser!(&pool, "SELECT 1", decode_lite, Duration::from_secs(1)) }.await.unwrap();
        assert_eq!(result[0].rows[0][0], Value::from(1));
    }

    // Set DBDOCK_TEST_POSTGRES_URL to an isolated disposable PostgreSQL instance.
    #[tokio::test]
    async fn postgres_browser_is_independent_and_recovers_after_timeout() {
        let Ok(url) = std::env::var("DBDOCK_TEST_POSTGRES_URL") else { return };
        let editor = PgPoolOptions::new().max_connections(1).connect(&url).await.unwrap();
        let browser = PgPoolOptions::new().max_connections(1).acquire_timeout(Duration::from_millis(100)).connect(&url).await.unwrap();
        let mut editor_conn = editor.acquire().await.unwrap();
        sqlx::query("BEGIN").execute(&mut *editor_conn).await.unwrap();
        let result = async { run_browser!(&browser, "SELECT 42", decode_pg, Duration::from_secs(1)) }.await.unwrap();
        assert_eq!(result[0].rows[0][0], Value::from(42));
        let timeout = async { run_browser!(&browser, "SELECT pg_sleep(2)", decode_pg, Duration::from_millis(50)) }.await.unwrap_err();
        assert!(timeout.to_string().starts_with("Database browsing query timed out"));
        let result = async { run_browser!(&browser, "SELECT 43", decode_pg, Duration::from_secs(1)) }.await.unwrap();
        assert_eq!(result[0].rows[0][0], Value::from(43));
        sqlx::query("ROLLBACK").execute(&mut *editor_conn).await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires an isolated PostgreSQL instance with permission to create databases"]
    async fn postgres_database_switch_keeps_sessions_and_catalogs_separate() {
        let url = std::env::var("DBDOCK_TEST_POSTGRES_URL").unwrap();
        let options: PgConnectOptions = url.parse().unwrap();
        let first = SqlPool::BrowserPg(PgPoolOptions::new().connect_with(options.clone()).await.unwrap());
        let original = first.scalar("SELECT current_database()::text").await.unwrap();
        let suffix = uuid::Uuid::new_v4().simple();
        let alternate = format!("dbdock_alt_{suffix}");
        let disabled = format!("dbdock_disabled_{suffix}");
        first.execute(format!("CREATE DATABASE {alternate}")).await.unwrap();
        first.execute(format!("CREATE DATABASE {disabled} ALLOW_CONNECTIONS false")).await.unwrap();

        let databases = first.databases().await.unwrap();
        assert!(databases.contains(&original));
        assert!(databases.contains(&alternate));
        assert!(!databases.contains(&disabled));
        assert!(!databases.iter().any(|database| database == "template1"));

        let second_pool = PgPoolOptions::new().connect_with(options.database(&alternate)).await.unwrap();
        let second = SqlPool::BrowserPg(second_pool.clone());
        second.execute("CREATE TABLE public.quick_switch_fixture (id INTEGER)".into()).await.unwrap();
        assert_eq!(second.scalar("SELECT current_database()::text").await.unwrap(), alternate);
        assert_eq!(first.scalar("SELECT current_database()::text").await.unwrap(), original);
        assert!(second.tables("public").await.unwrap().iter().any(|table| table.name == "quick_switch_fixture"));
        assert!(!first.tables("public").await.unwrap().iter().any(|table| table.name == "quick_switch_fixture"));

        second_pool.close().await;
        first.execute(format!("DROP DATABASE {alternate}")).await.unwrap();
        first.execute(format!("DROP DATABASE {disabled}")).await.unwrap();
    }

    fn contains_filter() -> TableFilter {
        use crate::sql_browser::{Condition, Operator};
        TableFilter {
            match_any: false,
            conditions: vec![
                Condition { column: "label".into(), operator: Operator::Contains, value: "o'\\%_".into() },
                Condition { column: "parent".into(), operator: Operator::IsNull, value: String::new() },
            ],
        }
    }

    async fn check_table_tools(db: SqlPool, schema: &str) {
        use crate::sql_browser::TableMetadata;
        db.execute("CREATE TABLE dbdock_parents (id INTEGER PRIMARY KEY);
            CREATE TABLE dbdock_children (
                id INTEGER PRIMARY KEY, label VARCHAR(100), parent INTEGER,
                CONSTRAINT dbdock_child_parent FOREIGN KEY (parent) REFERENCES dbdock_parents(id)
            );
            CREATE INDEX dbdock_children_label ON dbdock_children(label);
            INSERT INTO dbdock_parents VALUES (1);
            INSERT INTO dbdock_children VALUES (1, 'initial', NULL), (2, 'similar', 1), (3, 'other', NULL)".into()).await.unwrap();
        let literal = db.quote_lit("prefix o'\\%_ suffix");
        db.execute(format!("UPDATE dbdock_children SET label = {literal} WHERE id IN (1, 2)")).await.unwrap();

        let initial = db.table_data(schema, "dbdock_children", 10, 0, Some("id".into()), false, None, Some(contains_filter()), true).await.unwrap();
        assert_eq!(initial.result.rows.len(), 1);
        assert_eq!(initial.result.rows[0][0], Value::from(1));
        assert_eq!(initial.result.columns, ["id", "label", "parent"]);

        let change = || Change::Update {
            key: BTreeMap::from([("id".into(), Value::from(1))]),
            set: BTreeMap::from([("label".into(), Value::from("ours"))]),
            version: initial.row_versions[0].clone(),
        };
        assert_eq!(db.apply(schema, "dbdock_children", &[change()]).await.unwrap(), 1);
        db.execute("UPDATE dbdock_children SET label = 'theirs' WHERE id = 1".into()).await.unwrap();
        let error = db.apply(schema, "dbdock_children", &[change()]).await.unwrap_err();
        assert!(error.to_string().starts_with("Row conflict:"));
        assert_eq!(db.scalar("SELECT label FROM dbdock_children WHERE id = 1").await.unwrap(), "theirs");

        let indexes = db.metadata(schema, "dbdock_children", TableMetadata::Indexes).await.unwrap();
        assert!(indexes.rows.iter().flatten().any(|value| value == "dbdock_children_label"));
        let foreign_keys = db.metadata(schema, "dbdock_children", TableMetadata::ForeignKeys).await.unwrap();
        assert!(foreign_keys.rows.iter().flatten().any(|value| value == "dbdock_parents"));

        db.execute("DROP TABLE dbdock_children; DROP TABLE dbdock_parents".into()).await.unwrap();
    }

    #[tokio::test]
    async fn table_tools_sqlite() {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        check_table_tools(SqlPool::Lite(pool), "main").await;
    }

    // Both URLs must point at disposable test databases.
    #[tokio::test]
    #[ignore = "requires an isolated PostgreSQL test database"]
    async fn table_tools_postgres() {
        let url = std::env::var("DBDOCK_TEST_POSTGRES_URL").unwrap();
        let pool = PgPoolOptions::new().connect(&url).await.unwrap();
        check_table_tools(SqlPool::BrowserPg(pool), "public").await;
    }

    #[tokio::test]
    #[ignore = "requires an isolated MySQL test database"]
    async fn table_tools_mysql() {
        let url = std::env::var("DBDOCK_TEST_MYSQL_URL").unwrap();
        let pool = MySqlPoolOptions::new().connect(&url).await.unwrap();
        let db = SqlPool::BrowserMy(pool);
        let schema = db.current_schema().await.unwrap();
        check_table_tools(db, &schema).await;
    }

    #[tokio::test]
    async fn concurrent_update_and_delete_roll_back_entire_grid_batch() {
        use crate::sql_browser::TableMetadata;

        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        let db = SqlPool::Lite(pool);
        db.execute("CREATE TABLE parents (id INTEGER PRIMARY KEY);
            CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT, parent INTEGER REFERENCES parents(id), bytes BLOB);
            CREATE INDEX idx_items_value ON items(value);
            INSERT INTO items VALUES (1, 'one', NULL, NULL), (2, 'two', NULL, X'00'), (3, 'three', NULL, NULL)".into()).await.unwrap();
        let page = db.table_data("main", "items", 3, 0, Some("id".into()), false, None, None, true).await.unwrap();
        assert_eq!(page.result.columns, ["id", "value", "parent", "bytes"]);
        let key = |id| BTreeMap::from([("id".into(), Value::from(id))]);
        let first_update = || Change::Update {
            key: key(1),
            version: page.row_versions[0].clone(),
            set: BTreeMap::from([("value".into(), Value::from("edited"))]),
        };
        // The key and the visible value stay the same while a different field changes.
        db.execute("UPDATE items SET bytes = X'01' WHERE id = 2; DELETE FROM items WHERE id = 3".into()).await.unwrap();
        for id in [2, 3] {
            let changes = [first_update(), Change::Delete {
                key: key(id),
                version: page.row_versions[(id - 1) as usize].clone(),
            }];
            let error = db.apply("main", "items", &changes).await.unwrap_err();
            assert!(error.to_string().starts_with("Row conflict:"));
            let result = db.execute("SELECT value FROM items WHERE id = 1".into()).await.unwrap();
            assert_eq!(result[0].rows[0][0], Value::from("one"));
        }
        assert_eq!(db.apply("main", "items", &[first_update()]).await.unwrap(), 1);
        assert!(db.apply("main", "items", &[first_update()]).await.is_err());

        let indexes = db.metadata("main", "items", TableMetadata::Indexes).await.unwrap();
        assert!(indexes.rows.iter().flatten().any(|value| value == "idx_items_value"));
        let foreign_keys = db.metadata("main", "items", TableMetadata::ForeignKeys).await.unwrap();
        assert!(foreign_keys.rows.iter().flatten().any(|value| value == "parents"));
    }
}
