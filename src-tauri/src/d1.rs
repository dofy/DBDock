//! Cloudflare D1 over the REST API (`/accounts/{account}/d1/database/{db}/raw`).
//!
//! Observed behaviour this module relies on (checked against a live database):
//! - several `;`-separated statements in one request run as one batch, and a
//!   runtime error in any of them rolls the whole batch back;
//! - `BEGIN` / `SAVEPOINT` are rejected, as are table-valued pragma functions
//!   (`pragma_table_info(...)`) and `sqlite_version()`; `PRAGMA table_info(t)` works.

use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::Value;

use crate::sql::QueryResult;

const API: &str = "https://api.cloudflare.com/client/v4";

pub struct D1Client {
    http: reqwest::Client,
    account: String,
    database: String,
    token: String,
}

#[derive(Deserialize)]
struct Envelope<T> {
    success: bool,
    #[serde(default)]
    errors: Vec<ApiError>,
    result: Option<T>,
}

#[derive(Deserialize)]
struct ApiError {
    #[serde(default)]
    code: i64,
    message: String,
}

#[derive(Deserialize)]
struct RawResult {
    results: Option<RawRows>,
    #[serde(default)]
    meta: Option<Meta>,
}

#[derive(Deserialize)]
struct RawRows {
    #[serde(default)]
    columns: Vec<String>,
    #[serde(default)]
    rows: Vec<Vec<Value>>,
}

#[derive(Deserialize, Default)]
struct Meta {
    #[serde(default)]
    changes: u64,
    #[serde(default)]
    duration: f64,
}

#[derive(Deserialize)]
struct DbInfo {
    name: String,
    #[serde(default)]
    version: String,
}

/// JS-safe numbers and readable blobs, matching the other drivers.
fn cell(v: Value, full_blobs: bool) -> Value {
    match v {
        Value::Number(n) => match n.as_i64() {
            Some(i) if i.unsigned_abs() > (1u64 << 53) => Value::String(i.to_string()),
            _ => Value::Number(n),
        },
        // BLOBs come back as arrays of byte values.
        Value::Array(a) if a.iter().all(|x| x.as_u64().is_some_and(|b| b < 256)) => {
            let bytes: Vec<u8> = a.iter().filter_map(|x| x.as_u64().map(|b| b as u8)).collect();
            if full_blobs {
                Value::String(crate::sql_transfer::blob_hex(bytes))
            } else {
                crate::sql::bytes_preview(bytes)
            }
        }
        other => other,
    }
}

impl D1Client {
    pub fn new(account: &str, database: &str, token: Option<String>) -> Result<Self> {
        let token = token.filter(|t| !t.is_empty()).context("Cloudflare API token is empty")?;
        if account.trim().is_empty() || database.trim().is_empty() {
            bail!("Account ID and Database ID are required");
        }
        Ok(Self {
            http: reqwest::Client::builder().timeout(Duration::from_secs(60)).build()?,
            account: account.trim().to_string(),
            database: database.trim().to_string(),
            token,
        })
    }

    fn url(&self, tail: &str) -> String {
        format!("{API}/accounts/{}/d1/database/{}{tail}", self.account, self.database)
    }

    async fn send<T: for<'de> Deserialize<'de>>(&self, req: reqwest::RequestBuilder) -> Result<T> {
        let resp = req.bearer_auth(&self.token).send().await.context("Cloudflare API request failed")?;
        let status = resp.status();
        let text = resp.text().await?;
        let env: Envelope<T> = serde_json::from_str(&text).with_context(|| format!("HTTP {status}: {}", &text[..text.len().min(300)]))?;
        if !env.success || env.result.is_none() {
            let msg = env.errors.iter().map(|e| format!("{} ({})", e.message, e.code)).collect::<Vec<_>>().join("; ");
            if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
                bail!("Cloudflare rejected the token (HTTP {status}): {msg}. It needs the D1 Edit permission for this account.");
            }
            bail!("{}", if msg.is_empty() { format!("HTTP {status}") } else { msg });
        }
        Ok(env.result.unwrap())
    }

    pub async fn version(&self) -> Result<String> {
        let info: DbInfo = self.send(self.http.get(self.url(""))).await?;
        Ok(format!("Cloudflare D1 · {}{}", info.name, if info.version.is_empty() { String::new() } else { format!(" ({})", info.version) }))
    }

    /// One QueryResult per statement, in order.
    pub async fn query(&self, sql: &str) -> Result<Vec<QueryResult>> {
        self.query_mode(sql, false).await
    }

    pub async fn export_data(&self, sql: &str) -> Result<Vec<QueryResult>> {
        self.query_mode(sql, true).await
    }

    async fn query_mode(&self, sql: &str, full_blobs: bool) -> Result<Vec<QueryResult>> {
        let started = Instant::now();
        let res: Vec<RawResult> = self.send(self.http.post(self.url("/raw")).json(&serde_json::json!({ "sql": sql }))).await?;
        let wall = started.elapsed().as_millis() as u64;
        let n = res.len().max(1) as u64;
        Ok(res
            .into_iter()
            .map(|r| {
                let meta = r.meta.unwrap_or_default();
                let rows = r.results.unwrap_or(RawRows { columns: vec![], rows: vec![] });
                let truncated = rows.rows.len() > crate::sql::MAX_ROWS;
                QueryResult {
                    columns: rows.columns,
                    rows: rows.rows.into_iter().take(crate::sql::MAX_ROWS).map(|r| r.into_iter().map(|v| cell(v, full_blobs)).collect()).collect(),
                    rows_affected: Some(meta.changes),
                    truncated,
                    // Server time when reported, else an even share of the round trip.
                    elapsed_ms: if meta.duration > 0.0 { meta.duration.ceil() as u64 } else { wall / n },
                }
            })
            .collect())
    }
}
