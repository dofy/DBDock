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
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{AssertSqlSafe, Column, Connection, Either, Row, ValueRef};

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

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TableData {
    pub sql: String,
    pub result: QueryResult,
    pub has_more: bool,
}

pub enum SqlPool {
    My(MySqlPool),
    Pg(PgPool),
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

/// Pool size 1: the editor and the browser share one session, so `USE`, `SET`
/// and transactions behave like a single interactive connection.
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
            SqlConn { pool: SqlPool::My(pool), cancel: Canceller::My(o, id) }
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
            SqlConn { pool: SqlPool::Pg(pool), cancel: Canceller::Pg(o, id) }
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
            SqlConn { pool: SqlPool::Lite(pool), cancel: Canceller::Unsupported }
        }
        Kind::D1 => {
            let client = crate::d1::D1Client::new(&cfg.cf_account_id, &cfg.database, Some(pw.clone()))?;
            SqlConn { pool: SqlPool::D1(client), cancel: Canceller::Unsupported }
        }
        Kind::Redis | Kind::Mongodb => unreachable!("handled elsewhere"),
    };
    Ok(conn)
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

fn decode_my(row: &MySqlRow, i: usize) -> Value {
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

fn decode_pg(row: &PgRow, i: usize) -> Value {
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

fn decode_lite(row: &SqliteRow, i: usize) -> Value {
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

impl SqlPool {
    pub fn dialect(&self) -> Kind {
        match self {
            SqlPool::My(_) => Kind::Mysql,
            SqlPool::Pg(_) => Kind::Postgres,
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
            SqlPool::Pg(p) => run_many!(p, sql, decode_pg),
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
        match self.dialect() {
            Kind::Mysql => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
            _ => format!("'{}'", s.replace('\'', "''")),
        }
    }

    pub async fn server_version(&self) -> Result<String> {
        match self {
            SqlPool::My(_) => self.scalar("SELECT VERSION()").await.map(|v| format!("MySQL {v}")),
            SqlPool::Pg(_) => self.scalar("SHOW server_version").await.map(|v| format!("PostgreSQL {v}")),
            SqlPool::Lite(_) => self.scalar("SELECT sqlite_version()").await.map(|v| format!("SQLite {v}")),
            SqlPool::D1(c) => c.version().await,
        }
    }

    pub async fn current_schema(&self) -> Result<String> {
        match self {
            SqlPool::My(_) => self.scalar("SELECT DATABASE()").await,
            SqlPool::Pg(_) => self.scalar("SELECT current_schema()").await,
            SqlPool::Lite(_) | SqlPool::D1(_) => Ok("main".into()),
        }
    }

    pub async fn schemas(&self) -> Result<Vec<String>> {
        if let SqlPool::D1(_) = self {
            return Ok(vec!["main".into()]);
        }
        let sql = match self {
            SqlPool::My(_) => "SHOW DATABASES",
            SqlPool::Pg(_) => {
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
            SqlPool::My(_) => format!(
                "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = {lit} ORDER BY TABLE_NAME"
            ),
            SqlPool::Pg(_) => format!(
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
            SqlPool::My(_) => format!(
                "SELECT COLUMN_NAME AS `column`, COLUMN_TYPE AS `type`, IS_NULLABLE AS `nullable`, \
                 COLUMN_DEFAULT AS `default`, COLUMN_KEY AS `key`, EXTRA AS `extra`, COLUMN_COMMENT AS `comment` \
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = {s} AND TABLE_NAME = {t} \
                 ORDER BY ORDINAL_POSITION"
            ),
            SqlPool::Pg(_) => format!(
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

    pub async fn table_data(
        &self,
        schema: &str,
        table: &str,
        limit: u32,
        offset: u64,
        order_by: Option<String>,
        order_desc: bool,
        filter: Option<String>,
    ) -> Result<TableData> {
        let mut sql = format!("SELECT * FROM {}", self.table_ref(schema, table));
        if let Some(f) = filter.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
            sql.push_str(&format!(" WHERE {f}"));
        }
        if let Some(col) = order_by.filter(|c| !c.is_empty()) {
            sql.push_str(&format!(
                " ORDER BY {} {}",
                self.quote_ident(&col),
                if order_desc { "DESC" } else { "ASC" }
            ));
        }
        let shown = format!("{sql} LIMIT {limit} OFFSET {offset}");
        // Fetch one extra row to know whether another page exists.
        let probe = format!("{sql} LIMIT {} OFFSET {offset}", limit + 1);
        let mut result = self.execute(probe).await?.into_iter().next().unwrap_or_default();
        let has_more = result.rows.len() > limit as usize;
        result.rows.truncate(limit as usize);
        result.rows_affected = None;
        Ok(TableData { sql: shown, result, has_more })
    }
}

/// One pending grid edit; keys identify the row by its primary-key values.
#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Change {
    Update { key: BTreeMap<String, Value>, set: BTreeMap<String, Value> },
    Delete { key: BTreeMap<String, Value> },
    Insert { values: BTreeMap<String, Value> },
}

impl SqlPool {
    pub async fn columns(&self, schema: &str) -> Result<BTreeMap<String, Vec<String>>> {
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
                    let idx = r.columns.iter().position(|c| c == "name").unwrap_or(1);
                    (t.name, r.rows.into_iter().map(|row| value_to_string(row.get(idx).cloned().unwrap_or(Value::Null))).collect())
                })
                .collect());
        }
        let lit = self.quote_lit(schema);
        let sql = match self {
            SqlPool::My(_) => format!(
                "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = {lit} ORDER BY TABLE_NAME, ORDINAL_POSITION"
            ),
            SqlPool::Pg(_) => format!(
                "SELECT c.relname, a.attname FROM pg_catalog.pg_attribute a \
                 JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = {lit} AND c.relkind IN ('r','p','v','m','f') \
                 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum"
            ),
            SqlPool::Lite(_) => format!(
                "SELECT m.name, p.name FROM {}.sqlite_master m JOIN pragma_table_info(m.name, {lit}) p \
                 WHERE m.type IN ('table','view') ORDER BY m.name, p.cid",
                self.quote_ident(schema)
            ),
            SqlPool::D1(_) => unreachable!(),
        };
        let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for r in self.strings(sql).await? {
            let mut it = r.into_iter();
            if let (Some(t), Some(c)) = (it.next(), it.next()) {
                out.entry(t).or_default().push(c);
            }
        }
        Ok(out)
    }

    fn value_lit(&self, v: &Value) -> String {
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

    pub fn change_sql(&self, schema: &str, table: &str, changes: &[Change]) -> Result<Vec<String>> {
        let t = self.table_ref(schema, table);
        changes
            .iter()
            .map(|c| {
                Ok(match c {
                    Change::Update { key, set } => {
                        anyhow::ensure!(!set.is_empty(), "empty update");
                        let set = set
                            .iter()
                            .map(|(k, v)| format!("{} = {}", self.quote_ident(k), self.value_lit(v)))
                            .collect::<Vec<_>>()
                            .join(", ");
                        format!("UPDATE {t} SET {set} WHERE {}", self.where_key(key)?)
                    }
                    Change::Delete { key } => format!("DELETE FROM {t} WHERE {}", self.where_key(key)?),
                    Change::Insert { values } if values.is_empty() => match self {
                        SqlPool::My(_) => format!("INSERT INTO {t} () VALUES ()"),
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

    /// Apply all changes in one transaction. Updates and deletes must hit exactly
    /// one row; SQLx negotiates MySQL's FOUND_ROWS capability.
    pub async fn apply(&self, schema: &str, table: &str, changes: &[Change]) -> Result<usize> {
        let stmts = self.change_sql(schema, table, changes)?;
        macro_rules! run_tx {
            ($p:expr) => {{
                let mut tx = $p.begin().await?;
                for (sql, ch) in stmts.iter().zip(changes) {
                    let n = sqlx::raw_sql(AssertSqlSafe(sql.clone())).execute(&mut *tx).await?.rows_affected();
                    let insert = matches!(ch, Change::Insert { .. });
                    if !insert && n != 1 {
                        tx.rollback().await?;
                        anyhow::bail!("{sql}\naffected {n} rows, expected 1; rolled back (row changed elsewhere, or key not unique)");
                    }
                }
                tx.commit().await?;
            }};
        }
        match self {
            SqlPool::My(p) => run_tx!(p),
            SqlPool::Pg(p) => run_tx!(p),
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
                        anyhow::anyhow!("an UPDATE / DELETE did not hit exactly one row; nothing was changed (row changed elsewhere, or key not unique)")
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
    async fn missing_row_rolls_back_entire_grid_batch() {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        let db = SqlPool::Lite(pool);
        db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES (1, 'before')".into()).await.unwrap();
        let key = |id| BTreeMap::from([("id".into(), Value::from(id))]);
        let changes = vec![
            Change::Update { key: key(1), set: BTreeMap::from([("value".into(), Value::from("after"))]) },
            Change::Update { key: key(2), set: BTreeMap::from([("value".into(), Value::from("missing"))]) },
        ];
        assert!(db.apply("main", "items", &changes).await.is_err());
        let result = db.execute("SELECT value FROM items WHERE id = 1".into()).await.unwrap();
        assert_eq!(result[0].rows[0][0], Value::from("before"));
    }
}
