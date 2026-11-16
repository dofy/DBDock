//! Import connections from TablePlus (`Data/Connections.plist`).
//!
//! Passwords are not imported: TablePlus keeps them in the data-protection
//! keychain, which other apps cannot read. Each connection asks once on first use.

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use plist::{Dictionary, Value};

use crate::store::{expand_tilde, ConnectionConfig, Kind, SshAuth, SshConfig};


/// Setapp build first, then the standalone build.
fn data_dirs() -> Vec<PathBuf> {
    ["com.tinyapp.TablePlus-setapp", "com.tinyapp.TablePlus"]
        .iter()
        .map(|b| expand_tilde(&format!("~/Library/Application Support/{b}/Data")))
        .collect()
}

fn s(d: &Dictionary, k: &str) -> String {
    match d.get(k) {
        Some(Value::String(v)) => v.trim().to_string(),
        Some(Value::Integer(i)) => i.to_string(),
        Some(Value::Real(r)) => r.to_string(),
        Some(Value::Boolean(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn b(d: &Dictionary, k: &str) -> bool {
    match d.get(k) {
        Some(Value::Boolean(v)) => *v,
        Some(Value::Integer(i)) => i.as_signed() == Some(1),
        Some(Value::String(v)) => v == "1" || v.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn env_tag(v: &str) -> String {
    match v.trim().to_ascii_lowercase().as_str() {
        "" | "none" => String::new(),
        "dev" | "development" => "development".into(),
        "test" | "testing" => "testing".into(),
        "prod" | "production" => "production".into(),
        other => other.to_string(),
    }
}

fn port(v: &str) -> u16 {
    v.parse().unwrap_or(0)
}

/// TablePlus greys mean "no color"; give those the neutral default.
fn color(c: &str) -> String {
    match c.to_ascii_uppercase().as_str() {
        "" | "#F8F8F8" | "#C2C2C2" | "#686B6F" | "#FFFFFF" => "#8a8f98".into(),
        _ => c.to_string(),
    }
}

/// Redis host fields sometimes hold a URL such as `redis://user@host:6380/2`.
fn split_redis_url(host: &str) -> Option<(String, u16, Option<String>, Option<i64>)> {
    let rest = host.strip_prefix("redis://").or_else(|| host.strip_prefix("rediss://"))?;
    let (auth, hostpart) = match rest.rsplit_once('@') {
        Some((a, h)) => (Some(a), h),
        None => (None, rest),
    };
    let (hostport, db) = match hostpart.split_once('/') {
        Some((h, d)) => (h, d.parse().ok()),
        None => (hostpart, None),
    };
    let (h, p) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), port(p)),
        None => (hostport.to_string(), 0),
    };
    let user = auth.and_then(|a| a.split(':').next()).filter(|u| !u.is_empty()).map(String::from);
    Some((h, p, user, db))
}

fn group_paths(dir: &PathBuf) -> HashMap<String, String> {
    let Ok(Value::Array(items)) = Value::from_file(dir.join("ConnectionGroups.plist")) else {
        return HashMap::new();
    };
    let raw: HashMap<String, (String, String)> = items
        .iter()
        .filter_map(Value::as_dictionary)
        .map(|g| (s(g, "ID"), (s(g, "Name"), s(g, "GroupID"))))
        .collect();
    raw.keys()
        .map(|id| {
            let mut parts = vec![];
            let mut cur = id.clone();
            // Bounded walk in case of a parent cycle.
            for _ in 0..16 {
                let Some((name, parent)) = raw.get(&cur) else { break };
                parts.push(name.clone());
                if parent.is_empty() {
                    break;
                }
                cur = parent.clone();
            }
            parts.reverse();
            (id.clone(), parts.join(" / "))
        })
        .collect()
}

/// Connections.plist of the installed TablePlus (Setapp build first), if any.
pub fn tableplus_file() -> Option<PathBuf> {
    data_dirs().into_iter().map(|d| d.join("Connections.plist")).find(|f| f.exists())
}

/// True when the plist looks like TablePlus's Connections.plist.
pub fn is_tableplus_plist(path: &std::path::Path) -> bool {
    Value::from_file(path)
        .ok()
        .and_then(|v| v.as_array().map(|a| a.iter().filter_map(Value::as_dictionary).any(|d| d.contains_key("Driver") && d.contains_key("ConnectionName"))))
        .unwrap_or(false)
}

/// Read a TablePlus Connections.plist; ConnectionGroups.plist next to it supplies folders.
pub fn read_tableplus_file(file: &std::path::Path) -> Result<(Vec<ConnectionConfig>, Vec<String>, String)> {
    let dir = file.parent().map(PathBuf::from).unwrap_or_default();
    let root = Value::from_file(file).with_context(|| format!("read {}", file.display()))?;
    let items = root.as_array().context("Connections.plist is not an array")?;
    let groups = group_paths(&dir);

    let mut out = vec![];
    let mut skipped = vec![];
    for d in items.iter().filter_map(Value::as_dictionary) {
        let driver = s(d, "Driver");
        let kind = match driver.as_str() {
            "PostgreSQL" | "CockroachDB" | "Redshift" | "Greenplum" => Kind::Postgres,
            "MySQL" | "MariaDB" => Kind::Mysql,
            "SQLite" => Kind::Sqlite,
            "Redis" => Kind::Redis,
            "MongoDB" | "Mongo" => Kind::Mongodb,
            _ => {
                skipped.push(format!("{} ({driver})", s(d, "ConnectionName")));
                continue;
            }
        };
        let mut host = s(d, "DatabaseHost");
        let mut db_port = port(&s(d, "DatabasePort"));
        let mut user = s(d, "DatabaseUser");
        let mut database = s(d, "DatabaseName");
        let mut redis_db = 0;
        let mut file = String::new();
        match kind {
            Kind::Sqlite => {
                file = s(d, "DatabasePath");
                if file.is_empty() {
                    file = host.clone();
                }
                host.clear();
                db_port = 0;
                database.clear();
            }
            Kind::Redis => {
                if let Some((h, p, u, n)) = split_redis_url(&host) {
                    host = h;
                    if p != 0 {
                        db_port = p;
                    }
                    if let Some(u) = u {
                        user = u;
                    }
                    redis_db = n.unwrap_or(0);
                } else {
                    redis_db = database.parse().unwrap_or(0);
                }
                database.clear();
            }
            _ => {}
        }
        if kind != Kind::Sqlite {
            if host.is_empty() {
                host = "127.0.0.1".into();
            }
            if db_port == 0 {
                db_port = crate::default_port(kind);
            }
        }
        let key = s(d, "ServerPrivateKeyName");
        let ssh = SshConfig {
            enabled: b(d, "isOverSSH") && kind != Kind::Sqlite,
            host: s(d, "ServerAddress"),
            port: match port(&s(d, "ServerPort")) {
                0 => 22,
                p => p,
            },
            user: s(d, "ServerUser"),
            auth: if b(d, "isUsePrivateKey") { SshAuth::Key } else { SshAuth::Password },
            // Unset keys show a localized "Import a private key..." label.
            key_path: if key.contains('/') { key } else { String::new() },
        };
        let name = match s(d, "ConnectionName") {
            n if !n.is_empty() => n,
            _ if kind == Kind::Sqlite => file.rsplit('/').next().unwrap_or("SQLite").to_string(),
            _ => format!("{host}:{db_port}"),
        };
        out.push(ConnectionConfig {
            id: match s(d, "ID") {
                id if !id.is_empty() => id,
                _ => uuid::Uuid::new_v4().to_string(),
            },
            name,
            kind,
            host,
            port: db_port,
            user,
            database,
            file,
            redis_db,
            cf_account_id: String::new(),
            options: String::new(),
            color: color(&s(d, "statusColor")),
            // TablePlus spells the key "Enviroment".
            env: env_tag(&s(d, "Enviroment")),
            group: groups.get(&s(d, "GroupID")).cloned().unwrap_or_default(),
            ssh,
        });
    }
    Ok((out, skipped, file.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redis_url() {
        assert_eq!(split_redis_url("redis://localhost:6380"), Some(("localhost".into(), 6380, None, None)));
        assert_eq!(
            split_redis_url("redis://bob:pw@h:1/3"),
            Some(("h".into(), 1, Some("bob".into()), Some(3)))
        );
        assert_eq!(split_redis_url("10.0.0.1"), None);
    }

    /// Prints the mapping of the real TablePlus file (no secrets live there).
    #[test]
    fn real_file() {
        if std::env::var("DBDOCK_IT").is_err() {
            return;
        }
        let (items, skipped, src) = read_tableplus_file(&tableplus_file().unwrap()).unwrap();
        println!("{src}: {} items, skipped {skipped:?}", items.len());
        for c in items {
            println!(
                "{:?} [{}] {} | {}@{}:{} db={} file={} rdb={} | ssh={} {}@{}:{} {:?} key={}",
                c.kind, c.group, c.name, c.user, c.host, c.port, c.database, c.file, c.redis_db,
                c.ssh.enabled, c.ssh.user, c.ssh.host, c.ssh.port, c.ssh.auth, c.ssh.key_path
            );
        }
    }
}

