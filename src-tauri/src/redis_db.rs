//! Redis browsing: SCAN keys, typed value preview, raw command line.

use std::time::Duration;

use anyhow::{Context, Result};
use redis::aio::MultiplexedConnection;
use redis::{ConnectionAddr, IntoConnectionInfo, RedisConnectionInfo, Value as RValue};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::RwLock;

/// Items fetched per collection preview.
const PREVIEW: isize = 1000;

pub struct RedisConn {
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    db: RwLock<i64>,
    conn: RwLock<MultiplexedConnection>,
}

#[derive(Serialize)]
pub struct KeyInfo {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub ttl: i64,
}

#[derive(Serialize)]
pub struct ScanPage {
    pub cursor: u64,
    pub keys: Vec<KeyInfo>,
}

#[derive(Serialize)]
pub struct KeyValue {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub ttl: i64,
    /// Element count (strings: byte length).
    pub size: i64,
    pub value: Value,
    pub truncated: bool,
}

async fn open(host: &str, port: u16, user: &str, password: &Option<String>, db: i64) -> Result<MultiplexedConnection> {
    let mut rinfo = RedisConnectionInfo::default().set_db(db);
    if !user.is_empty() {
        rinfo = rinfo.set_username(user);
    }
    if let Some(pw) = password.as_ref().filter(|p| !p.is_empty()) {
        rinfo = rinfo.set_password(pw);
    }
    let info = ConnectionAddr::Tcp(host.to_string(), port)
        .into_connection_info()?
        .set_redis_settings(rinfo);
    let client = redis::Client::open(info)?;
    let conn = tokio::time::timeout(Duration::from_secs(15), client.get_multiplexed_async_connection())
        .await
        .context("Redis connect timed out")??;
    Ok(conn)
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

pub fn to_json(v: RValue) -> Value {
    match v {
        RValue::Nil => Value::Null,
        RValue::Int(i) => json!(i),
        RValue::BulkString(b) => Value::String(text(&b)),
        RValue::SimpleString(s) => Value::String(s),
        RValue::Okay => Value::String("OK".into()),
        RValue::Array(a) | RValue::Set(a) => Value::Array(a.into_iter().map(to_json).collect()),
        RValue::Map(m) => Value::Array(
            m.into_iter()
                .map(|(k, v)| Value::Array(vec![to_json(k), to_json(v)]))
                .collect(),
        ),
        RValue::Double(d) => json!(d),
        RValue::Boolean(b) => Value::Bool(b),
        RValue::VerbatimString { text, .. } => Value::String(text),
        other => Value::String(format!("{other:?}")),
    }
}

impl RedisConn {
    pub async fn connect(host: &str, port: u16, user: &str, password: Option<String>, db: i64) -> Result<Self> {
        let port = if port == 0 { 6379 } else { port };
        let conn = open(host, port, user, &password, db).await?;
        Ok(Self {
            host: host.to_string(),
            port,
            user: user.to_string(),
            password,
            db: RwLock::new(db),
            conn: RwLock::new(conn),
        })
    }

    async fn c(&self) -> MultiplexedConnection {
        self.conn.read().await.clone()
    }

    pub async fn db(&self) -> i64 {
        *self.db.read().await
    }

    /// SELECT is per-connection, so switch by reconnecting.
    pub async fn select(&self, db: i64) -> Result<()> {
        let conn = open(&self.host, self.port, &self.user, &self.password, db).await?;
        *self.conn.write().await = conn;
        *self.db.write().await = db;
        Ok(())
    }

    pub async fn server_version(&self) -> Result<String> {
        let info: String = redis::cmd("INFO").arg("server").query_async(&mut self.c().await).await?;
        let v = info
            .lines()
            .find_map(|l| l.strip_prefix("redis_version:"))
            .unwrap_or("?")
            .trim()
            .to_string();
        Ok(format!("Redis {v}"))
    }

    pub async fn dbsize(&self) -> Result<i64> {
        Ok(redis::cmd("DBSIZE").query_async(&mut self.c().await).await?)
    }

    pub async fn scan(&self, cursor: u64, pattern: &str, count: u32) -> Result<ScanPage> {
        let mut c = self.c().await;
        let pattern = if pattern.is_empty() { "*" } else { pattern };
        let (next, keys): (u64, Vec<Vec<u8>>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(count)
            .query_async(&mut c)
            .await?;
        let mut pipe = redis::pipe();
        for k in &keys {
            pipe.cmd("TYPE").arg(k).cmd("PTTL").arg(k);
        }
        let meta: Vec<RValue> = if keys.is_empty() { vec![] } else { pipe.query_async(&mut c).await? };
        let mut out = Vec::with_capacity(keys.len());
        for (i, k) in keys.iter().enumerate() {
            let kind = match meta.get(i * 2) {
                Some(RValue::SimpleString(s)) => s.clone(),
                Some(RValue::Okay) => "ok".into(),
                Some(other) => crate::sql::value_to_string(to_json(other.clone())),
                None => "?".into(),
            };
            let ttl = match meta.get(i * 2 + 1) {
                Some(RValue::Int(t)) => *t,
                _ => -1,
            };
            out.push(KeyInfo { key: text(k), kind, ttl });
        }
        Ok(ScanPage { cursor: next, keys: out })
    }

    pub async fn get(&self, key: &str) -> Result<KeyValue> {
        let mut c = self.c().await;
        let (kind, ttl): (String, i64) = redis::pipe()
            .cmd("TYPE")
            .arg(key)
            .cmd("PTTL")
            .arg(key)
            .query_async(&mut c)
            .await?;
        let q = |name: &str| {
            let mut cmd = redis::cmd(name);
            cmd.arg(key);
            cmd
        };
        let (size, value): (i64, Value) = match kind.as_str() {
            "string" => {
                let v: Vec<u8> = q("GET").query_async(&mut c).await?;
                (v.len() as i64, crate::sql::bytes_preview(v))
            }
            "list" => {
                let n: i64 = q("LLEN").query_async(&mut c).await?;
                let v: Vec<Vec<u8>> = q("LRANGE").arg(0).arg(PREVIEW - 1).query_async(&mut c).await?;
                (n, json!(v.iter().map(|b| text(b)).collect::<Vec<_>>()))
            }
            "hash" => {
                let n: i64 = q("HLEN").query_async(&mut c).await?;
                let (_, v): (u64, Vec<(Vec<u8>, Vec<u8>)>) =
                    q("HSCAN").arg(0).arg("COUNT").arg(PREVIEW).query_async(&mut c).await?;
                (n, json!(v.iter().map(|(f, x)| [text(f), text(x)]).collect::<Vec<_>>()))
            }
            "set" => {
                let n: i64 = q("SCARD").query_async(&mut c).await?;
                let (_, v): (u64, Vec<Vec<u8>>) =
                    q("SSCAN").arg(0).arg("COUNT").arg(PREVIEW).query_async(&mut c).await?;
                (n, json!(v.iter().map(|b| text(b)).collect::<Vec<_>>()))
            }
            "zset" => {
                let n: i64 = q("ZCARD").query_async(&mut c).await?;
                let v: Vec<(Vec<u8>, f64)> =
                    q("ZRANGE").arg(0).arg(PREVIEW - 1).arg("WITHSCORES").query_async(&mut c).await?;
                (n, json!(v.iter().map(|(m, s)| json!([text(m), s])).collect::<Vec<_>>()))
            }
            "stream" => {
                let n: i64 = q("XLEN").query_async(&mut c).await?;
                let v: RValue = q("XREVRANGE").arg("+").arg("-").arg("COUNT").arg(200).query_async(&mut c).await?;
                (n, to_json(v))
            }
            "none" => anyhow::bail!("key {key} does not exist"),
            other => (0, Value::String(format!("type {other} not previewable; use the console"))),
        };
        let truncated = match &value {
            Value::Array(a) => (a.len() as i64) < size,
            _ => false,
        };
        Ok(KeyValue { key: key.to_string(), kind, ttl, size, value, truncated })
    }

    pub async fn delete(&self, key: &str) -> Result<i64> {
        Ok(redis::cmd("DEL").arg(key).query_async(&mut self.c().await).await?)
    }

    pub async fn command(&self, line: &str) -> Result<Value> {
        let parts = shell_words::split(line).context("cannot parse command line")?;
        let Some((name, args)) = parts.split_first() else {
            anyhow::bail!("empty command");
        };
        if name.eq_ignore_ascii_case("select") {
            let db: i64 = args.first().context("SELECT needs a db index")?.parse()?;
            self.select(db).await?;
            return Ok(Value::String("OK".into()));
        }
        let mut cmd = redis::cmd(name);
        for a in args {
            cmd.arg(a);
        }
        let v: RValue = cmd.query_async(&mut self.c().await).await?;
        Ok(to_json(v))
    }
}
