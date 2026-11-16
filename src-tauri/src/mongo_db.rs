//! MongoDB: browse databases / collections, find with filter / sort / projection,
//! edit documents by `_id`, and a small mongo-shell-style console.
//!
//! Documents travel to the UI as relaxed Extended JSON (`{"$oid": …}`, `{"$date": …}`)
//! and come back the same way, so ObjectIds and dates survive an edit.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};
use mongodb::options::{ClientOptions, FindOptions};
use mongodb::Client;
use serde::Serialize;
use serde_json::Value;

use crate::store::ConnectionConfig;

const MAX_DOCS: i64 = 1000;

pub struct MongoConn {
    client: Client,
    pub default_db: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindPage {
    pub docs: Vec<Value>,
    pub has_more: bool,
    pub elapsed_ms: u64,
}

/// What the console returns: documents for queries, a plain value otherwise.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub kind: String,
    pub docs: Vec<Value>,
    pub value: Option<Value>,
    pub elapsed_ms: u64,
    /// When the console switched database with `use x`.
    pub db: Option<String>,
}

/// The driver's Display repeats the whole error chain; keep the server's message.
pub fn short_err(e: &mongodb::error::Error) -> String {
    let full = e.to_string();
    let re = regex_lite::Regex::new(r"Error code (\d+) \((\w+)\): ([^,]+)").unwrap();
    if let Some(c) = re.captures(&full) {
        return format!("{} ({} {})", c[3].trim_end_matches('.'), &c[2], &c[1]);
    }
    full.split(", labels:").next().unwrap_or(&full).replace("Kind: ", "")
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn to_json(d: Document) -> Value {
    Bson::Document(d).into_relaxed_extjson()
}

/// Parse Extended JSON into a document; `what` names the field in errors.
pub fn to_doc(v: Value, what: &str) -> Result<Document> {
    match Bson::try_from(v).with_context(|| format!("{what}: not valid Extended JSON"))? {
        Bson::Document(d) => Ok(d),
        Bson::Null => Ok(Document::new()),
        other => bail!("{what} must be an object, got {other}"),
    }
}

fn opt_doc(v: Option<Value>, what: &str) -> Result<Option<Document>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(to_doc(parse_shell_value(&s)?, what)?)),
        Some(v) => Ok(Some(to_doc(v, what)?)).map(|d| d.filter(|d: &Document| !d.is_empty())),
    }
}

fn id_filter(id: Value) -> Result<Document> {
    let id = Bson::try_from(id).context("bad _id")?;
    Ok(doc! { "_id": id })
}

/// mongo-shell helpers → Extended JSON, so json5 can parse the rest.
fn rewrite_helpers(s: &str) -> String {
    let re_oid = regex_lite::Regex::new(r#"ObjectId\(\s*["']([0-9a-fA-F]{24})["']\s*\)"#).unwrap();
    let re_date = regex_lite::Regex::new(r#"(?:ISODate|new Date)\(\s*["']([^"']+)["']\s*\)"#).unwrap();
    let re_num = regex_lite::Regex::new(r#"NumberLong\(\s*["']?(-?\d+)["']?\s*\)"#).unwrap();
    // `$$` is a literal `$` in the replacement; `${1}` is the capture.
    let s = re_oid.replace_all(s, r#"{"$$oid":"${1}"}"#);
    let s = re_date.replace_all(&s, r#"{"$$date":"${1}"}"#);
    re_num.replace_all(&s, r#"{"$$numberLong":"${1}"}"#).into_owned()
}

/// Relaxed JSON (unquoted keys, single quotes, trailing commas) plus shell helpers.
pub fn parse_shell_value(s: &str) -> Result<Value> {
    json5::from_str::<Value>(&rewrite_helpers(s)).map_err(|e| anyhow::anyhow!("cannot parse {s:?}: {e}"))
}

async fn connection_options(cfg: &ConnectionConfig, host: &str, port: u16, password: Option<String>, tunnelled: bool) -> Result<ClientOptions> {
        let raw = cfg.host.trim();
        let is_uri = raw.starts_with("mongodb://") || raw.starts_with("mongodb+srv://");
        let uri = if is_uri && !tunnelled {
            raw.to_string()
        } else {
            let auth = match (cfg.user.trim(), password.as_deref().filter(|p| !p.is_empty())) {
                ("", _) => String::new(),
                (u, Some(p)) => format!("{}:{}@", enc(u), enc(p)),
                (u, None) => format!("{}@", enc(u)),
            };
            let mut opts = cfg.options.trim().trim_start_matches('?').to_string();
            // A tunnel exposes one member; do not follow replica-set discovery to hosts we cannot reach.
            if tunnelled && !opts.to_lowercase().contains("directconnection=") {
                opts = if opts.is_empty() { "directConnection=true".into() } else { format!("{opts}&directConnection=true") };
            }
            format!("mongodb://{auth}{host}:{}/{}?{opts}", if port == 0 { 27017 } else { port }, enc(cfg.database.trim()))
        };
        let mut options = ClientOptions::parse(&uri).await.context("invalid MongoDB connection settings")?;
        if is_uri && !tunnelled {
            if !cfg.user.trim().is_empty() || password.as_ref().is_some_and(|p| !p.is_empty()) {
                let cred = options.credential.get_or_insert_with(Default::default);
                if !cfg.user.trim().is_empty() { cred.username = Some(cfg.user.trim().to_string()); }
                if let Some(p) = password.filter(|p| !p.is_empty()) { cred.password = Some(p); }
            }
        }
        options.app_name = Some("DBDock".into());
        options.server_selection_timeout = Some(Duration::from_secs(12));
        options.connect_timeout = Some(Duration::from_secs(12));
        Ok(options)
}

impl MongoConn {
    pub async fn connect(cfg: &ConnectionConfig, host: &str, port: u16, password: Option<String>, tunnelled: bool) -> Result<Self> {
        let options = connection_options(cfg, host, port, password, tunnelled).await?;
        let default_db = options.default_database.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| "admin".into());
        let client = Client::with_options(options)?;
        client
            .database("admin")
            .run_command(doc! { "ping": 1 })
            .await
            .map_err(|e| anyhow::anyhow!("MongoDB: {}", short_err(&e)))?;
        Ok(Self { client, default_db })
    }

    pub async fn version(&self) -> Result<String> {
        let info = self.client.database("admin").run_command(doc! { "buildInfo": 1 }).await?;
        Ok(format!("MongoDB {}", info.get_str("version").unwrap_or("?")))
    }

    /// All databases when allowed; otherwise just the one from the connection.
    pub async fn databases(&self) -> Result<Vec<String>> {
        match self.client.list_database_names().await {
            Ok(mut v) => {
                if !v.contains(&self.default_db) && self.default_db != "admin" {
                    v.push(self.default_db.clone());
                }
                v.sort();
                Ok(v)
            }
            Err(_) => Ok(vec![self.default_db.clone()]),
        }
    }

    pub async fn collections(&self, db: &str) -> Result<Vec<String>> {
        let mut v = self.client.database(db).list_collection_names().await?;
        v.sort();
        Ok(v)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn find(
        &self,
        db: &str,
        coll: &str,
        filter: Option<Value>,
        sort: Option<Value>,
        projection: Option<Value>,
        skip: u64,
        limit: i64,
    ) -> Result<FindPage> {
        let started = std::time::Instant::now();
        let limit = limit.clamp(1, MAX_DOCS);
        let opts = FindOptions::builder()
            .sort(opt_doc(sort, "sort")?)
            .projection(opt_doc(projection, "projection")?)
            .skip(skip)
            .limit(limit + 1)
            .build();
        let mut cur = self
            .client
            .database(db)
            .collection::<Document>(coll)
            .find(opt_doc(filter, "filter")?.unwrap_or_default())
            .with_options(opts)
            .await?;
        let mut docs = Vec::new();
        while let Some(d) = cur.try_next().await? {
            docs.push(to_json(d));
        }
        let has_more = docs.len() as i64 > limit;
        docs.truncate(limit as usize);
        Ok(FindPage { docs, has_more, elapsed_ms: started.elapsed().as_millis() as u64 })
    }

    pub async fn count(&self, db: &str, coll: &str, filter: Option<Value>) -> Result<u64> {
        let c = self.client.database(db).collection::<Document>(coll);
        Ok(match opt_doc(filter, "filter")? {
            None => c.estimated_document_count().await?,
            Some(f) => c.count_documents(f).await?,
        })
    }

    pub async fn insert(&self, db: &str, coll: &str, doc: Value) -> Result<Value> {
        let r = self.client.database(db).collection::<Document>(coll).insert_one(to_doc(doc, "document")?).await?;
        Ok(r.inserted_id.into_relaxed_extjson())
    }

    /// Replace one document by `_id`; fails unless exactly one matched.
    pub async fn replace(&self, db: &str, coll: &str, id: Value, doc: Value) -> Result<()> {
        let mut d = to_doc(doc, "document")?;
        let filter = id_filter(id)?;
        match d.get("_id") {
            Some(new) if Some(new) != filter.get("_id") => bail!("_id cannot be changed; insert a new document instead"),
            _ => {
                d.remove("_id");
            }
        }
        let r = self.client.database(db).collection::<Document>(coll).replace_one(filter, d).await?;
        if r.matched_count != 1 {
            bail!("document not found (deleted elsewhere?)");
        }
        Ok(())
    }

    pub async fn delete(&self, db: &str, coll: &str, ids: Vec<Value>) -> Result<u64> {
        let ids: Vec<Bson> = ids.into_iter().map(Bson::try_from).collect::<Result<_, _>>().context("bad _id")?;
        let r = self.client.database(db).collection::<Document>(coll).delete_many(doc! { "_id": { "$in": ids } }).await?;
        Ok(r.deleted_count)
    }

    pub async fn indexes(&self, db: &str, coll: &str) -> Result<Vec<Value>> {
        let mut cur = self.client.database(db).collection::<Document>(coll).list_indexes().await?;
        let mut out = Vec::new();
        while let Some(ix) = cur.try_next().await? {
            out.push(serde_json::to_value(&ix).unwrap_or(Value::Null));
        }
        Ok(out)
    }

    async fn collect(cur: mongodb::Cursor<Document>) -> Result<Vec<Value>> {
        let docs: Vec<Document> = cur.try_collect().await?;
        Ok(docs.into_iter().take(MAX_DOCS as usize).map(to_json).collect())
    }

    /// A subset of mongo-shell syntax: `show dbs|collections`, `use x`,
    /// `db.runCommand({...})`, and `db.coll.method(args)` for find (with chained
    /// sort / limit / skip), findOne, aggregate, countDocuments, distinct,
    /// insertOne/Many, updateOne/Many, replaceOne, deleteOne/Many.
    pub async fn shell(&self, db: &str, line: &str) -> Result<ShellResult> {
        let started = std::time::Instant::now();
        let line = line.trim().trim_end_matches(';').trim();
        let done = |kind: &str, docs: Vec<Value>, value: Option<Value>, db: Option<String>| ShellResult {
            kind: kind.into(),
            docs,
            value,
            elapsed_ms: started.elapsed().as_millis() as u64,
            db,
        };
        let lower = line.to_ascii_lowercase();
        if lower == "show dbs" || lower == "show databases" {
            return Ok(done("value", vec![], Some(serde_json::json!(self.databases().await?)), None));
        }
        if lower == "show collections" || lower == "show tables" {
            return Ok(done("value", vec![], Some(serde_json::json!(self.collections(db).await?)), None));
        }
        if let Some(name) = line.strip_prefix("use ") {
            return Ok(done("value", vec![], Some(Value::String(format!("switched to db {}", name.trim()))), Some(name.trim().to_string())));
        }
        let database = self.client.database(db);
        if let Some(rest) = line.strip_prefix("db.runCommand(").and_then(|r| r.strip_suffix(')')) {
            let cmd = to_doc(parse_shell_value(rest)?, "command")?;
            let r = database.run_command(cmd).await?;
            return Ok(done("value", vec![], Some(to_json(r)), None));
        }
        let Some(rest) = line.strip_prefix("db.") else {
            bail!("expected db.<collection>.<method>(...), db.runCommand({{...}}), show dbs, show collections or use <db>");
        };
        let calls = split_calls(rest)?;
        let Some((coll, first)) = calls.first().and_then(|(head, args)| {
            let (c, m) = head.rsplit_once('.')?;
            Some((c.to_string(), (m.to_string(), args.clone())))
        }) else {
            bail!("expected db.<collection>.<method>(...)");
        };
        let coll = coll.trim_start_matches("getCollection(").trim_matches(|c| c == '"' || c == '\'' || c == ')').to_string();
        let c = database.collection::<Document>(&coll);
        let args = |a: &str| -> Result<Vec<Value>> {
            if a.trim().is_empty() {
                return Ok(vec![]);
            }
            match parse_shell_value(&format!("[{a}]"))? {
                Value::Array(v) => Ok(v),
                v => Ok(vec![v]),
            }
        };
        let arg_doc = |v: &[Value], i: usize, what: &str| -> Result<Document> { v.get(i).cloned().map(|x| to_doc(x, what)).transpose().map(|d| d.unwrap_or_default()) };
        let (method, a) = first;
        let a = args(&a)?;
        Ok(match method.as_str() {
            "find" => {
                let mut opts = FindOptions::builder().limit(Some(200)).build();
                if let Some(p) = a.get(1) {
                    opts.projection = Some(to_doc(p.clone(), "projection")?);
                }
                for (m, ca) in calls.iter().skip(1) {
                    let ca = args(ca)?;
                    match m.as_str() {
                        "sort" => opts.sort = Some(arg_doc(&ca, 0, "sort")?),
                        "limit" => opts.limit = ca.first().and_then(Value::as_i64).map(|n| n.min(MAX_DOCS)),
                        "skip" => opts.skip = ca.first().and_then(Value::as_u64),
                        "pretty" | "toArray" => {}
                        other => bail!("unsupported cursor method .{other}()"),
                    }
                }
                let cur = c.find(arg_doc(&a, 0, "filter")?).with_options(opts).await?;
                done("docs", Self::collect(cur).await?, None, None)
            }
            "findOne" => {
                let d = c.find_one(arg_doc(&a, 0, "filter")?).await?;
                done("docs", d.into_iter().map(to_json).collect(), None, None)
            }
            "aggregate" => {
                let pipeline: Vec<Document> = match a.first() {
                    Some(Value::Array(stages)) => stages.iter().cloned().map(|s| to_doc(s, "stage")).collect::<Result<_>>()?,
                    _ => bail!("aggregate expects an array of stages"),
                };
                let cur = c.aggregate(pipeline).await?;
                done("docs", Self::collect(cur).await?, None, None)
            }
            "countDocuments" | "count" => done("value", vec![], Some(serde_json::json!(c.count_documents(arg_doc(&a, 0, "filter")?).await?)), None),
            "estimatedDocumentCount" => done("value", vec![], Some(serde_json::json!(c.estimated_document_count().await?)), None),
            "distinct" => {
                let field = a.first().and_then(Value::as_str).context("distinct expects a field name")?;
                let v = c.distinct(field, arg_doc(&a, 1, "filter")?).await?;
                done("value", vec![], Some(Value::Array(v.into_iter().map(Bson::into_relaxed_extjson).collect())), None)
            }
            "insertOne" => {
                let r = c.insert_one(arg_doc(&a, 0, "document")?).await?;
                done("value", vec![], Some(serde_json::json!({ "insertedId": r.inserted_id.into_relaxed_extjson() })), None)
            }
            "insertMany" => {
                let docs: Vec<Document> = match a.first() {
                    Some(Value::Array(v)) => v.iter().cloned().map(|d| to_doc(d, "document")).collect::<Result<_>>()?,
                    _ => bail!("insertMany expects an array"),
                };
                let r = c.insert_many(docs).await?;
                done("value", vec![], Some(serde_json::json!({ "insertedCount": r.inserted_ids.len() })), None)
            }
            "updateOne" | "updateMany" => {
                let (f, u) = (arg_doc(&a, 0, "filter")?, arg_doc(&a, 1, "update")?);
                let r = if method == "updateOne" { c.update_one(f, u).await? } else { c.update_many(f, u).await? };
                done("value", vec![], Some(serde_json::json!({ "matchedCount": r.matched_count, "modifiedCount": r.modified_count })), None)
            }
            "replaceOne" => {
                let r = c.replace_one(arg_doc(&a, 0, "filter")?, arg_doc(&a, 1, "replacement")?).await?;
                done("value", vec![], Some(serde_json::json!({ "matchedCount": r.matched_count, "modifiedCount": r.modified_count })), None)
            }
            "deleteOne" | "deleteMany" => {
                let f = arg_doc(&a, 0, "filter")?;
                let r = if method == "deleteOne" { c.delete_one(f).await? } else { c.delete_many(f).await? };
                done("value", vec![], Some(serde_json::json!({ "deletedCount": r.deleted_count })), None)
            }
            "getIndexes" => done("docs", self.indexes(db, &coll).await?, None, None),
            other => bail!("unsupported method .{other}()"),
        })
    }
}

/// `users.find({a: 1}).sort({b: -1}).limit(5)` → [("users.find", "{a: 1}"), ("sort", "{b: -1}"), ("limit", "5")],
/// respecting nested brackets and quoted strings.
fn split_calls(s: &str) -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let start = i;
        while i < chars.len() && chars[i] != '(' {
            i += 1;
        }
        if i >= chars.len() {
            bail!("missing '(' after {:?}", chars[start..].iter().collect::<String>());
        }
        let name: String = chars[start..i].iter().collect::<String>().trim().trim_start_matches('.').to_string();
        i += 1;
        let arg_start = i;
        let (mut depth, mut quote) = (1, None::<char>);
        while i < chars.len() {
            let ch = chars[i];
            match quote {
                Some(_) if ch == '\\' => i += 1,
                Some(q) if ch == q => quote = None,
                Some(_) => {}
                None => match ch {
                    '"' | '\'' => quote = Some(ch),
                    '(' | '{' | '[' => depth += 1,
                    ')' | '}' | ']' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                },
            }
            i += 1;
        }
        if depth != 0 {
            bail!("unbalanced brackets");
        }
        out.push((name, chars[arg_start..i].iter().collect()));
        i += 1;
        while i < chars.len() && (chars[i].is_whitespace() || chars[i] == '.') {
            i += 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connection_options_preserve_discovery_and_override_uri_credentials() {
        let mut cfg: ConnectionConfig = serde_json::from_value(serde_json::json!({"name":"mongo", "kind":"mongodb", "host":"localhost", "user":"new"})).unwrap();
        let normal = connection_options(&cfg, "localhost", 27017, Some("pass".into()), false).await.unwrap();
        assert_ne!(normal.direct_connection, Some(true));
        let tunnel = connection_options(&cfg, "localhost", 27017, Some("pass".into()), true).await.unwrap();
        assert_eq!(tunnel.direct_connection, Some(true));
        cfg.host = "mongodb://old:oldpass@localhost/db".into();
        let uri = connection_options(&cfg, "localhost", 27017, Some("newpass".into()), false).await.unwrap();
        let cred = uri.credential.unwrap();
        assert_eq!(cred.username.as_deref(), Some("new"));
        assert_eq!(cred.password.as_deref(), Some("newpass"));
    }

    #[test]
    fn shell_parsing() {
        let c = split_calls(r#"users.find({name: "a(b)", age: {$gt: 1}}, {name: 1}).sort({_id: -1}).limit(5)"#).unwrap();
        assert_eq!(c[0].0, "users.find");
        assert_eq!(c[0].1, r#"{name: "a(b)", age: {$gt: 1}}, {name: 1}"#);
        assert_eq!((c[1].0.as_str(), c[2].0.as_str(), c[2].1.as_str()), ("sort", "limit", "5"));
        let v = parse_shell_value(r#"{_id: ObjectId("65a1b2c3d4e5f60718293a4b"), at: ISODate("2026-01-02T00:00:00Z"), n: 1,}"#).unwrap();
        let d = to_doc(v, "x").unwrap();
        assert!(matches!(d.get("_id"), Some(Bson::ObjectId(_))));
        assert!(matches!(d.get("at"), Some(Bson::DateTime(_))));
    }
}
