//! One entry point for every import: detect the file format, read connections
//! (and any passwords the source carries), then upsert them.
//!
//! Supported: dbdock export (plain or encrypted), TablePlus `Connections.plist`,
//! DBeaver `data-sources.json`, and text holding connection URLs — a `.env`
//! file, a list, or pasted text (`postgres://`, `mysql://`, `mariadb://`,
//! `redis://`, `rediss://`, `mongodb://`, `mongodb+srv://`, `sqlite:///path`,
//! optionally prefixed with `jdbc:`).

use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;

use crate::store::{ConnectionConfig, Kind, SecretsInput, SshAuth, SshConfig, Store};

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    Dbdock,
    Tableplus,
    Dbeaver,
    Urls,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub format: Format,
    pub label: &'static str,
    /// Encrypted dbdock export: ask for the passphrase first.
    pub encrypted: bool,
    pub count: Option<usize>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub source: String,
    pub added: usize,
    pub updated: usize,
    pub with_secrets: usize,
    pub skipped: Vec<String>,
    /// Passwords stay behind in the source (TablePlus keychain, DBeaver credentials).
    pub passwords_not_imported: bool,
}

fn label(f: Format) -> &'static str {
    match f {
        Format::Dbdock => "dbdock export",
        Format::Tableplus => "TablePlus",
        Format::Dbeaver => "DBeaver",
        Format::Urls => "connection URLs",
    }
}

pub fn detect(path: &Path) -> Result<Detected> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_ascii_lowercase();
    if name.ends_with(".plist") || crate::import::is_tableplus_plist(path) {
        if crate::import::is_tableplus_plist(path) {
            return Ok(Detected { format: Format::Tableplus, label: label(Format::Tableplus), encrypted: false, count: None });
        }
        bail!("this plist is not a TablePlus Connections.plist");
    }
    let text = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    if let Ok(v) = serde_json::from_str::<Value>(&text) {
        if v.get("format").and_then(Value::as_str) == Some("dbdock.connections") {
            let info = crate::transfer::inspect(path)?;
            return Ok(Detected { format: Format::Dbdock, label: label(Format::Dbdock), encrypted: info.encrypted, count: info.count });
        }
        if v.get("connections").is_some_and(Value::is_object) {
            let n = v["connections"].as_object().map(|o| o.len());
            return Ok(Detected { format: Format::Dbeaver, label: label(Format::Dbeaver), encrypted: false, count: n });
        }
    }
    let n = parse_urls(&text).0.len();
    if n == 0 {
        bail!("no connections found; supported: dbdock export, TablePlus Connections.plist, DBeaver data-sources.json, or text / .env with connection URLs");
    }
    Ok(Detected { format: Format::Urls, label: label(Format::Urls), encrypted: false, count: Some(n) })
}

/// Stable id per source key, so importing the same thing twice updates instead of duplicating.
fn stable_id(prefix: &str, key: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{prefix}-{h:016x}")
}

fn blank(kind: Kind, name: String) -> ConnectionConfig {
    ConnectionConfig {
        id: String::new(),
        name,
        kind,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: String::new(),
        file: String::new(),
        redis_db: 0,
        cf_account_id: String::new(),
        options: String::new(),
        color: "#8a8f98".into(),
        env: String::new(),
        group: String::new(),
        ssh: SshConfig::default(),
    }
}

fn decode(s: &str) -> String {
    url::form_urlencoded::parse(format!("x={}", s.replace('+', "%2B")).as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())
        .unwrap_or_else(|| s.to_string())
}

/// One URL → config + password. `name_hint` is the .env key, if any.
pub fn from_url(raw: &str, name_hint: Option<&str>) -> Result<(ConnectionConfig, Option<String>)> {
    let raw = raw.trim().trim_matches(|c| c == '"' || c == '\'');
    let s = raw.strip_prefix("jdbc:").unwrap_or(raw);
    let scheme = s.split("://").next().unwrap_or("").to_ascii_lowercase();
    let kind = match scheme.as_str() {
        "mysql" | "mariadb" | "mysql2" => Kind::Mysql,
        "postgres" | "postgresql" | "pg" => Kind::Postgres,
        "redis" => Kind::Redis,
        "rediss" => bail!("TLS Redis URLs are not supported; refusing to connect without TLS"),
        "mongodb" | "mongodb+srv" => Kind::Mongodb,
        "sqlite" | "sqlite3" | "file" => Kind::Sqlite,
        other => bail!("unsupported scheme {other:?}"),
    };
    if kind == Kind::Sqlite {
        // sqlite:///abs/path, sqlite:/abs/path, sqlite:relative.db, file:/path
        let path = s.split_once(':').map(|(_, p)| p).unwrap_or("").trim_start_matches("//");
        let path = path.split('?').next().unwrap_or(path);
        if path.is_empty() {
            bail!("SQLite URL without a path");
        }
        let mut c = blank(Kind::Sqlite, name_hint.map(String::from).unwrap_or_else(|| path.rsplit('/').next().unwrap_or(path).to_string()));
        c.file = path.to_string();
        c.id = stable_id("url", &format!("sqlite:{path}"));
        return Ok((c, None));
    }
    if kind == Kind::Mongodb {
        // Keep the URI (replica sets, +srv); move the password to the keychain.
        let u = url::Url::parse(s).context("invalid MongoDB URL")?;
        let password = u.password().map(decode);
        let mut clean = u.clone();
        let _ = clean.set_password(None);
        let user = decode(u.username());
        let host = u.host_str().unwrap_or("").to_string();
        let mut c = blank(Kind::Mongodb, name_hint.map(String::from).unwrap_or_else(|| format!("{}{host}", if user.is_empty() { String::new() } else { format!("{user}@") })));
        c.host = clean.to_string();
        c.id = stable_id("url", &c.host);
        return Ok((c, password));
    }
    let u = url::Url::parse(s).with_context(|| format!("invalid URL {s:?}"))?;
    let mut c = blank(kind, String::new());
    c.host = u.host_str().unwrap_or("127.0.0.1").trim_matches(|ch| ch == '[' || ch == ']').to_string();
    c.port = u.port().unwrap_or(crate::default_port(kind));
    c.user = decode(u.username());
    let path = u.path().trim_start_matches('/');
    if kind == Kind::Redis {
        c.redis_db = path.parse().unwrap_or(0);
    } else {
        c.database = decode(path);
    }
    c.name = name_hint.map(String::from).unwrap_or_else(|| {
        let db = if c.database.is_empty() { String::new() } else { format!("/{}", c.database) };
        format!("{}{db}", c.host)
    });
    c.id = stable_id("url", &format!("{scheme}://{}@{}:{}/{path}", c.user, c.host, c.port));
    Ok((c, u.password().map(decode).filter(|p| !p.is_empty())))
}

/// Every URL in the text; `.env` lines (`KEY=url`) name the connection after the key.
pub fn parse_urls(text: &str) -> (Vec<(ConnectionConfig, Option<String>)>, Vec<String>) {
    let re = regex_lite::Regex::new(r#"(?i)(?:jdbc:)?(?:postgres(?:ql)?|pg|mysql2?|mariadb|rediss?|mongodb(?:\+srv)?|sqlite3?):[^\s"'`<>]+"#).unwrap();
    let (mut out, mut skipped) = (Vec::new(), Vec::new());
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let key = t
            .strip_prefix("export ")
            .unwrap_or(t)
            .split_once('=')
            .map(|(k, _)| k.trim())
            .filter(|k| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
        for m in re.find_iter(t) {
            match from_url(m.as_str(), key) {
                Ok(x) => out.push(x),
                Err(e) => skipped.push(format!("{}: {e}", m.as_str().split('@').next_back().unwrap_or(""))),
            }
        }
    }
    (out, skipped)
}

/// DBeaver `data-sources.json` (passwords live in the encrypted credentials file).
fn read_dbeaver(v: &Value) -> (Vec<ConnectionConfig>, Vec<String>) {
    let (mut out, mut skipped) = (Vec::new(), Vec::new());
    let Some(conns) = v.get("connections").and_then(Value::as_object) else { return (out, skipped) };
    for (id, c) in conns {
        let str_of = |v: &Value, k: &str| v.get(k).map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).unwrap_or_default();
        let name = str_of(c, "name");
        let provider = format!("{} {}", str_of(c, "provider"), str_of(c, "driver")).to_ascii_lowercase();
        let kind = if provider.contains("postgres") || provider.contains("redshift") || provider.contains("cockroach") {
            Kind::Postgres
        } else if provider.contains("mysql") || provider.contains("mariadb") {
            Kind::Mysql
        } else if provider.contains("sqlite") {
            Kind::Sqlite
        } else if provider.contains("mongo") {
            Kind::Mongodb
        } else if provider.contains("redis") {
            Kind::Redis
        } else {
            skipped.push(format!("{name} ({})", provider.trim()));
            continue;
        };
        let cfg = c.get("configuration").cloned().unwrap_or(Value::Null);
        let mut x = blank(kind, name);
        x.id = stable_id("dbeaver", id);
        x.host = str_of(&cfg, "host");
        x.port = str_of(&cfg, "port").parse().unwrap_or(crate::default_port(kind));
        x.user = str_of(&cfg, "user");
        x.database = str_of(&cfg, "database");
        if kind == Kind::Sqlite {
            x.file = if x.database.is_empty() { str_of(&cfg, "url").trim_start_matches("jdbc:sqlite:").to_string() } else { x.database.clone() };
            x.database.clear();
            x.host.clear();
        }
        x.group = str_of(c, "folder").replace('/', " / ");
        x.env = match str_of(&cfg, "type").as_str() {
            "prod" => "production".into(),
            "test" => "testing".into(),
            "dev" => "development".into(),
            _ => String::new(),
        };
        // SSH tunnel handler
        if let Some(h) = cfg.get("handlers").and_then(|h| h.get("ssh_tunnel")).filter(|h| h.get("enabled").and_then(Value::as_bool).unwrap_or(false)) {
            let p = h.get("properties").cloned().unwrap_or(Value::Null);
            x.ssh = SshConfig {
                enabled: true,
                host: str_of(&p, "host"),
                port: str_of(&p, "port").parse().unwrap_or(22),
                user: str_of(&p, "user"),
                auth: if str_of(&p, "authType").eq_ignore_ascii_case("password") { SshAuth::Password } else { SshAuth::Key },
                key_path: str_of(&p, "keyPath"),
            };
        }
        out.push(x);
    }
    (out, skipped)
}

fn upsert(store: &Store, items: Vec<(ConnectionConfig, Option<String>)>, source: String, skipped: Vec<String>, passwords_not_imported: bool) -> Result<Report> {
    let with_secrets = items.iter().filter(|(_, p)| p.is_some()).count();
    let (added, updated) = store.upsert_with_secrets(items.into_iter().map(|(c, password)| (c, SecretsInput { password, ..Default::default() })).collect())?;
    Ok(Report { source, added, updated, with_secrets, skipped, passwords_not_imported })
}

pub fn import_file(store: &Store, path: &Path, passphrase: Option<String>) -> Result<Report> {
    let d = detect(path)?;
    let source = format!("{} · {}", d.label, path.display());
    match d.format {
        Format::Dbdock => {
            let r = crate::transfer::import(store, path, passphrase)?;
            Ok(Report { source, added: r.added, updated: r.updated, with_secrets: r.with_secrets, ..Default::default() })
        }
        Format::Tableplus => {
            let (items, skipped, _) = crate::import::read_tableplus_file(path)?;
            upsert(store, items.into_iter().map(|c| (c, None)).collect(), source, skipped, true)
        }
        Format::Dbeaver => {
            let v: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
            let (items, skipped) = read_dbeaver(&v);
            upsert(store, items.into_iter().map(|c| (c, None)).collect(), source, skipped, true)
        }
        Format::Urls => {
            let (items, skipped) = parse_urls(&std::fs::read_to_string(path)?);
            upsert(store, with_group(items, "Imported"), source, skipped, false)
        }
    }
}

fn with_group(items: Vec<(ConnectionConfig, Option<String>)>, group: &str) -> Vec<(ConnectionConfig, Option<String>)> {
    items
        .into_iter()
        .map(|(mut c, p)| {
            if c.group.is_empty() {
                c.group = group.into();
            }
            (c, p)
        })
        .collect()
}

pub fn import_text(store: &Store, text: &str) -> Result<Report> {
    let (items, skipped) = parse_urls(text);
    if items.is_empty() {
        bail!("no connection URLs found");
    }
    upsert(store, with_group(items, "Imported"), "pasted URLs".into(), skipped, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        let (c, p) = from_url("postgres://u%40x:p%2Fw@db.example.com:6543/app?sslmode=require", None).unwrap();
        assert_eq!((c.kind, c.host.as_str(), c.port, c.user.as_str(), c.database.as_str()), (Kind::Postgres, "db.example.com", 6543, "u@x", "app"));
        assert_eq!(p.as_deref(), Some("p/w"));
        let (c, _) = from_url("jdbc:mysql://root@127.0.0.1/shop", None).unwrap();
        assert_eq!((c.kind, c.port), (Kind::Mysql, 3306));
        assert!(from_url("rediss://default:secret@cache:6380/2", None).is_err());
        let (c, p) = from_url("mongodb+srv://me:pw@cluster0.abc.mongodb.net/shop?retryWrites=true", None).unwrap();
        assert!(c.host.starts_with("mongodb+srv://me@cluster0") && !c.host.contains("pw"));
        assert_eq!(p.as_deref(), Some("pw"));
        let (c, _) = from_url("sqlite:///Users/x/app.db", None).unwrap();
        assert_eq!(c.file, "/Users/x/app.db");
        let text = "# comment\nexport DATABASE_URL=\"postgresql://a:b@h/db\"\nREDIS_URL=redis://h:6379\nOTHER=1\nmysql://x@y/z\n";
        let (items, skipped) = parse_urls(text);
        assert_eq!(items.len(), 3, "{skipped:?}");
        assert_eq!(items[0].0.name, "DATABASE_URL");
        assert_eq!(items[0].0.id, from_url("postgresql://a:b@h/db", None).unwrap().0.id, "same id on re-import");
    }

    #[test]
    fn detects_real_tableplus() {
        let Some(f) = crate::import::tableplus_file() else { return };
        let d = detect(&f).unwrap();
        assert_eq!(d.format, Format::Tableplus);
        let (items, _, _) = crate::import::read_tableplus_file(&f).unwrap();
        assert!(!items.is_empty());
    }

    #[test]
    fn dbeaver() {
        let v = serde_json::json!({"folders": {}, "connections": {
            "postgres-jdbc-1": {"provider": "postgresql", "driver": "postgres-jdbc", "name": "prod pg", "folder": "Work/Prod",
                "configuration": {"host": "pg.internal", "port": "5433", "database": "app", "user": "me", "type": "prod",
                "handlers": {"ssh_tunnel": {"enabled": true, "properties": {"host": "bastion", "port": "22", "user": "ops", "authType": "PUBLIC_KEY"}}}}},
            "oracle-1": {"provider": "oracle", "name": "legacy", "configuration": {}}
        }});
        let (items, skipped) = read_dbeaver(&v);
        assert_eq!(items.len(), 1);
        let c = &items[0];
        assert_eq!((c.port, c.group.as_str(), c.env.as_str(), c.ssh.host.as_str()), (5433, "Work / Prod", "production", "bastion"));
        assert_eq!(skipped, vec!["legacy (oracle)"]);
    }
}
