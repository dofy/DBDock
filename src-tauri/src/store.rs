//! Saved connection configs (JSON on disk) and their secrets (OS keychain).

use std::path::PathBuf;

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

fn secret_put(id: &str, field: &str, value: &Option<String>) -> Result<()> {
    let Some(value) = value else { return Ok(()) };
    let e = entry(id, field)?;
    if value.is_empty() {
        // Missing entry is fine.
        let _ = e.delete_credential();
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
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { path: dir.join("connections.json") }
    }

    pub fn list(&self) -> Result<Vec<ConnectionConfig>> {
        if !self.path.exists() {
            return Ok(vec![]);
        }
        let text = std::fs::read_to_string(&self.path)
            .with_context(|| format!("read {}", self.path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("parse {}", self.path.display()))
    }

    fn write(&self, list: &[ConnectionConfig]) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(list)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<ConnectionConfig> {
        self.list()?
            .into_iter()
            .find(|c| c.id == id)
            .with_context(|| format!("connection {id} not found"))
    }

    pub fn save(&self, mut cfg: ConnectionConfig, secrets: &SecretsInput) -> Result<ConnectionConfig> {
        if cfg.id.is_empty() {
            cfg.id = uuid::Uuid::new_v4().to_string();
        }
        cfg.group = crate::groups::normalize(&cfg.group);
        for (field, value) in FIELDS.iter().zip(secrets.as_array()) {
            secret_put(&cfg.id, field, value)?;
        }
        let mut list = self.list()?;
        match list.iter_mut().find(|c| c.id == cfg.id) {
            Some(slot) => *slot = cfg.clone(),
            None => list.push(cfg.clone()),
        }
        self.write(&list)?;
        Ok(cfg)
    }

    /// Insert or replace by id; secrets in the keychain are untouched.
    pub fn upsert_many(&self, items: Vec<ConnectionConfig>) -> Result<(usize, usize)> {
        let mut list = self.list()?;
        let (mut added, mut updated) = (0, 0);
        for cfg in items {
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
        self.write(&list)?;
        Ok((added, updated))
    }

    /// Apply `f` to every connection's group; `Some(new)` replaces it. Returns how many changed.
    pub fn update_groups(&self, f: impl Fn(&str) -> Option<String>) -> Result<usize> {
        let mut list = self.list()?;
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
        let group = crate::groups::normalize(group);
        let mut list = self.list()?;
        let mut n = 0;
        for c in list.iter_mut().filter(|c| ids.contains(&c.id)) {
            c.group = group.clone();
            n += 1;
        }
        self.write(&list)?;
        Ok(n)
    }

    pub fn set_secrets(&self, id: &str, secrets: &SecretsInput) -> Result<()> {
        for (field, value) in FIELDS.iter().zip(secrets.as_array()) {
            secret_put(id, field, value)?;
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let mut list = self.list()?;
        list.retain(|c| c.id != id);
        self.write(&list)?;
        for field in FIELDS {
            secret_put(id, field, &Some(String::new()))?;
        }
        Ok(())
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

