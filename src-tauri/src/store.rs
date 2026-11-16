//! Saved connection configs (JSON on disk) and their secrets (OS keychain).

use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Entries are bound to the app that wrote them, so the app never reads entries
/// written by another build or service name: that would prompt on every read.
const KEYRING_SERVICE: &str = "xyz.phpz.app.dbdock";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Mysql,
    Postgres,
    Sqlite,
    Redis,
    /// Cloudflare D1 over the REST API: `cf_account_id` + `database` (the database UUID),
    /// API token as the password.
    D1,
    Mongodb,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SshAuth {
    #[default]
    Password,
    Key,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SshConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    /// Private key path; empty means try ~/.ssh/id_ed25519, id_ecdsa, id_rsa.
    pub key_path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub kind: Kind,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub database: String,
    /// SQLite database file.
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub redis_db: i64,
    /// Cloudflare account ID (D1 only).
    #[serde(default)]
    pub cf_account_id: String,
    /// Extra connection options as a query string, e.g. `authSource=admin&tls=true` (MongoDB).
    #[serde(default)]
    pub options: String,
    #[serde(default)]
    pub color: String,
    /// Environment tag: local, development, testing, staging, production, or empty.
    #[serde(default)]
    pub env: String,
    /// Folder path shown in the list, e.g. "Acme / AI".
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub ssh: SshConfig,
}

/// Secrets sent from the UI. `None` keeps the stored value, `Some("")` deletes it.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SecretsInput {
    pub password: Option<String>,
    pub ssh_password: Option<String>,
    pub ssh_passphrase: Option<String>,
}

/// Resolved secrets used to open a connection.
#[derive(Clone, Debug, Default)]
pub struct Secrets {
    pub password: Option<String>,
    pub ssh_password: Option<String>,
    pub ssh_passphrase: Option<String>,
}

const FIELDS: [&str; 3] = ["password", "ssh_password", "ssh_passphrase"];

fn entry_in(service: &str, id: &str, field: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(service, &format!("{id}:{field}")).map_err(|e| anyhow::anyhow!("keychain unavailable: {e}"))
}

fn entry(id: &str, field: &str) -> Result<keyring::Entry> {
    entry_in(KEYRING_SERVICE, id, field)
}

fn secret_get(id: &str, field: &str) -> Option<String> {
    entry(id, field).ok()?.get_password().ok()
}

fn secret_read(id: &str, field: &str) -> Result<Option<String>> {
    match entry(id, field)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow::anyhow!("keychain read failed: {e}")),
    }
}

fn secret_put(id: &str, field: &str, value: &Option<String>) -> Result<()> {
    let Some(value) = value else { return Ok(()) };
    let e = entry(id, field)?;
    if value.is_empty() {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {},
            Err(err) => return Err(anyhow::anyhow!("keychain delete failed: {err}")),
        }
    } else {
        e.set_password(value)
            .map_err(|err| anyhow::anyhow!("keychain write failed: {err}"))?;
    }
    Ok(())
}

impl SecretsInput {
    fn as_array(&self) -> [&Option<String>; 3] {
        [&self.password, &self.ssh_password, &self.ssh_passphrase]
    }

    /// Prefer non-empty values from the form; fall back to the keychain.
    pub fn resolve(&self, id: &str) -> Secrets {
        let pick = |input: &Option<String>, field: &str| match input {
            Some(v) if !v.is_empty() => Some(v.clone()),
            Some(_) => None,
            None if id.is_empty() => None,
            None => secret_get(id, field),
        };
        Secrets {
            password: pick(&self.password, FIELDS[0]),
            ssh_password: pick(&self.ssh_password, FIELDS[1]),
            ssh_passphrase: pick(&self.ssh_passphrase, FIELDS[2]),
        }
    }
}

pub fn load_secrets(id: &str) -> Secrets {
    SecretsInput::default().resolve(id)
}

pub struct Store {
    path: PathBuf,
    lock: Mutex<()>,
}

/// Remove userinfo passwords without parsing the host list as a URL (MongoDB URIs
/// can contain multiple hosts). Never include the original URI in errors.
pub fn strip_mongo_password(cfg: &mut ConnectionConfig) -> Result<Option<String>> {
    if cfg.kind != Kind::Mongodb { return Ok(None); }
    let Some((scheme, rest)) = cfg.host.split_once("://") else { return Ok(None) };
    if scheme != "mongodb" && scheme != "mongodb+srv" { return Ok(None); }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let Some((userinfo, hosts)) = authority.rsplit_once('@') else { return Ok(None) };
    let Some((user, password)) = userinfo.split_once(':') else { return Ok(None) };
    let password = url::form_urlencoded::parse(format!("x={}", password.replace('+', "%2B")).as_bytes())
        .next().map(|(_, v)| v.into_owned()).unwrap_or_default();
    let sanitized = format!("{scheme}://{user}@{hosts}{}", &rest[end..]);
    // The form's default name can contain the original host verbatim.
    cfg.name = cfg.name.replace(&cfg.host, &sanitized);
    cfg.host = sanitized;
    Ok(Some(password))
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { path: dir.join("connections.json"), lock: Mutex::new(()) }
    }

    pub fn list(&self) -> Result<Vec<ConnectionConfig>> {
        let _guard = self.lock.lock().map_err(|_| anyhow::anyhow!("connection store lock poisoned"))?;
        self.list_locked()
    }

    fn list_locked(&self) -> Result<Vec<ConnectionConfig>> {
        if !self.path.exists() {
            return Ok(vec![]);
        }
        let text = std::fs::read_to_string(&self.path)
            .with_context(|| format!("read {}", self.path.display()))?;
        let mut list: Vec<ConnectionConfig> = serde_json::from_str(&text).with_context(|| format!("parse {}", self.path.display()))?;
        let mut updates = Vec::new();
        for cfg in &mut list {
            if let Some(password) = strip_mongo_password(cfg)? {
                updates.push((cfg.id.clone(), SecretsInput { password: Some(password), ..Default::default() }));
            }
        }
        if !updates.is_empty() { self.write_with_secrets(&list, &updates)?; }
        Ok(list)
    }

    fn write(&self, list: &[ConnectionConfig]) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, serde_json::to_string_pretty(list)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    fn write_with_secrets(&self, list: &[ConnectionConfig], updates: &[(String, SecretsInput)]) -> Result<()> {
        let mut previous = Vec::new();
        for (id, secrets) in updates {
            for (field, value) in FIELDS.iter().zip(secrets.as_array()) {
                if value.is_some() && !previous.iter().any(|(i, f, _): &(String, &str, Option<String>)| i == id && f == field) {
                    previous.push((id.clone(), *field, secret_read(id, field)?));
                }
            }
        }
        let result = (|| -> Result<()> {
            for (id, secrets) in updates {
                for (field, value) in FIELDS.iter().zip(secrets.as_array()) { secret_put(id, field, value)?; }
            }
            self.write(list)
        })();
        if let Err(error) = result {
            let mut rollback_errors = Vec::new();
            for (id, field, old) in previous.into_iter().rev() {
                if let Err(e) = secret_put(&id, field, &Some(old.unwrap_or_default())) { rollback_errors.push(e.to_string()); }
            }
            if !rollback_errors.is_empty() { anyhow::bail!("{error:#}; Keychain rollback failed: {}", rollback_errors.join("; ")); }
            return Err(error);
        }
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<ConnectionConfig> {
        self.list()?
            .into_iter()
            .find(|c| c.id == id)
            .with_context(|| format!("connection {id} not found"))
    }

    pub fn save(&self, mut cfg: ConnectionConfig, secrets: &SecretsInput) -> Result<ConnectionConfig> {
        let _guard = self.lock.lock().map_err(|_| anyhow::anyhow!("connection store lock poisoned"))?;
        if cfg.id.is_empty() {
            cfg.id = uuid::Uuid::new_v4().to_string();
        }
        let mut list = self.list_locked()?;
        cfg.group = crate::groups::normalize(&cfg.group);
        let mut secrets = secrets.clone();
        if let Some(password) = strip_mongo_password(&mut cfg)? {
            if secrets.password.is_none() { secrets.password = Some(password); }
        }
        match list.iter_mut().find(|c| c.id == cfg.id) {
            Some(slot) => *slot = cfg.clone(),
            None => list.push(cfg.clone()),
        }
        self.write_with_secrets(&list, &[(cfg.id.clone(), secrets)])?;
        Ok(cfg)
    }

    /// Insert or replace by id; secrets in the keychain are untouched.
    #[cfg(test)]
    pub fn upsert_many(&self, items: Vec<ConnectionConfig>) -> Result<(usize, usize)> {
        self.upsert_with_secrets(items.into_iter().map(|c| (c, SecretsInput::default())).collect())
    }

    pub fn upsert_with_secrets(&self, items: Vec<(ConnectionConfig, SecretsInput)>) -> Result<(usize, usize)> {
        let _guard = self.lock.lock().map_err(|_| anyhow::anyhow!("connection store lock poisoned"))?;
        let mut list = self.list_locked()?;
        let (mut added, mut updated) = (0, 0);
        let mut updates = Vec::new();
        for (mut cfg, mut secrets) in items {
            if let Some(password) = strip_mongo_password(&mut cfg)? {
                if secrets.password.is_none() { secrets.password = Some(password); }
            }
            updates.push((cfg.id.clone(), secrets));
            match list.iter_mut().find(|c| c.id == cfg.id) {
                Some(slot) => {
                    *slot = cfg;
                    updated += 1;
                }
                None => {
                    list.push(cfg);
                    added += 1;
                }
            }
        }
        self.write_with_secrets(&list, &updates)?;
        Ok((added, updated))
    }

    /// Apply `f` to every connection's group; `Some(new)` replaces it. Returns how many changed.
    pub fn update_groups(&self, f: impl Fn(&str) -> Option<String>) -> Result<usize> {
        let _guard = self.lock.lock().map_err(|_| anyhow::anyhow!("connection store lock poisoned"))?;
        let mut list = self.list_locked()?;
        let mut n = 0;
        for c in list.iter_mut() {
            if let Some(g) = f(&crate::groups::normalize(&c.group)) {
                if g != c.group {
                    c.group = g;
                    n += 1;
                }
            }
        }
        self.write(&list)?;
        Ok(n)
    }

    pub fn move_to_group(&self, ids: &[String], group: &str) -> Result<usize> {
        let _guard = self.lock.lock().map_err(|_| anyhow::anyhow!("connection store lock poisoned"))?;
        let group = crate::groups::normalize(group);
        let mut list = self.list_locked()?;
        let mut n = 0;
        for c in list.iter_mut().filter(|c| ids.contains(&c.id)) {
            c.group = group.clone();
            n += 1;
        }
        self.write(&list)?;
        Ok(n)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let _guard = self.lock.lock().map_err(|_| anyhow::anyhow!("connection store lock poisoned"))?;
        let mut list = self.list_locked()?;
        list.retain(|c| c.id != id);
        self.write_with_secrets(&list, &[(id.to_string(), SecretsInput {
            password: Some(String::new()), ssh_password: Some(String::new()), ssh_passphrase: Some(String::new()),
        })])
    }
}

pub fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_password_from_mongo_multi_host_uri() {
        let mut cfg: ConnectionConfig = serde_json::from_value(serde_json::json!({"name":"mongodb://alice:p%40ss%2Bword@host1:27017,host2:27017/db?replicaSet=rs:27017", "kind":"mongodb", "host":"mongodb://alice:p%40ss%2Bword@host1:27017,host2:27017/db?replicaSet=rs"})).unwrap();
        assert_eq!(strip_mongo_password(&mut cfg).unwrap().as_deref(), Some("p@ss+word"));
        assert_eq!(cfg.host, "mongodb://alice@host1:27017,host2:27017/db?replicaSet=rs");
        assert!(!cfg.name.contains("p%40ss"));
        assert!(strip_mongo_password(&mut cfg).unwrap().is_none());
    }

    #[test]
    fn concurrent_updates_do_not_lose_connections() {
        let dir = std::env::temp_dir().join(format!("dbdock-store-{}", uuid::Uuid::new_v4()));
        let store = std::sync::Arc::new(Store::new(dir.clone()));
        let threads: Vec<_> = (0..20).map(|i| {
            let store = store.clone();
            std::thread::spawn(move || {
                let cfg = serde_json::from_value(serde_json::json!({"id":i.to_string(), "name":i.to_string(), "kind":"sqlite"})).unwrap();
                store.upsert_many(vec![cfg]).unwrap();
            })
        }).collect();
        for t in threads { t.join().unwrap(); }
        assert_eq!(store.list().unwrap().len(), 20);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

