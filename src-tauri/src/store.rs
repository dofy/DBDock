//! Saved connection configs (JSON on disk) and their secrets (OS keychain).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// The legacy per-field entries and the consolidated vault share this service.
/// macOS may require authorization when legacy entries were written by another build.
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
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Secrets {
    pub password: Option<String>,
    pub ssh_password: Option<String>,
    pub ssh_passphrase: Option<String>,
}

const FIELDS: [&str; 3] = ["password", "ssh_password", "ssh_passphrase"];

const VAULT_ACCOUNT: &str = "__dbdock_vault_v1";

trait Credentials: Send + Sync {
    fn read(&self, account: &str) -> Result<Option<String>>;
    fn write(&self, account: &str, value: Option<&str>) -> Result<()>;
}

struct Keychain;
impl Credentials for Keychain {
    fn read(&self, account: &str) -> Result<Option<String>> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, account)
            .map_err(|e| anyhow::anyhow!("keychain unavailable: {e}"))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(anyhow::anyhow!("keychain read failed: {e}")),
        }
    }
    fn write(&self, account: &str, value: Option<&str>) -> Result<()> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, account)
            .map_err(|e| anyhow::anyhow!("keychain unavailable: {e}"))?;
        match value {
            Some(value) => entry.set_password(value)
                .map_err(|e| anyhow::anyhow!("keychain write failed: {e}")),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(anyhow::anyhow!("keychain delete failed: {e}")),
            },
        }
    }
}

#[derive(Serialize, Deserialize, PartialEq, Eq, Debug)]
struct Vault {
    version: u32,
    secrets: BTreeMap<String, Secrets>,
}

impl SecretsInput {
    fn as_array(&self) -> [&Option<String>; 3] {
        [&self.password, &self.ssh_password, &self.ssh_passphrase]
    }

    fn apply(&self, secrets: &mut Secrets) {
        for (value, target) in self.as_array().into_iter().zip([
            &mut secrets.password, &mut secrets.ssh_password, &mut secrets.ssh_passphrase,
        ]) {
            if let Some(value) = value {
                *target = (!value.is_empty()).then(|| value.clone());
            }
        }
    }
}

pub struct Store {
    path: PathBuf,
    lock: Mutex<()>,
    credentials: Box<dyn Credentials>,
}

struct StoreGuard<'a> {
    _mutex: std::sync::MutexGuard<'a, ()>,
    #[cfg(unix)]
    _file: std::fs::File,
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
        Self { path: dir.join("connections.json"), lock: Mutex::new(()), credentials: Box::new(Keychain) }
    }

    fn acquire(&self) -> Result<StoreGuard<'_>> {
        let mutex = self.lock.lock().map_err(|_| anyhow::anyhow!("connection store lock poisoned"))?;
        #[cfg(unix)]
        let file = {
            use std::os::fd::AsRawFd;
            let dir = self.path.parent().context("connection store has no parent")?;
            std::fs::create_dir_all(dir)?;
            let file = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(dir.join("connections.lock"))?;
            // Closing this descriptor releases the advisory process lock.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            file
        };
        Ok(StoreGuard { _mutex: mutex, #[cfg(unix)] _file: file })
    }

    pub fn list(&self) -> Result<Vec<ConnectionConfig>> {
        let _guard = self.acquire()?;
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

    fn vault(&self) -> Result<Option<Vault>> {
        let Some(raw) = self.credentials.read(VAULT_ACCOUNT)? else { return Ok(None) };
        let vault: Vault = serde_json::from_str(&raw).context("invalid credential vault")?;
        anyhow::ensure!(vault.version == 1, "unsupported credential vault version");
        Ok(Some(vault))
    }

    fn legacy_secrets(&self, id: &str) -> Result<Secrets> {
        let read = |field| self.credentials.read(&format!("{id}:{field}"));
        Ok(Secrets { password: read(FIELDS[0])?, ssh_password: read(FIELDS[1])?, ssh_passphrase: read(FIELDS[2])? })
    }

    fn save_vault(&self, vault: &Vault) -> Result<()> {
        let raw = serde_json::to_string(vault)?;
        self.credentials.write(VAULT_ACCOUNT, Some(&raw))?;
        anyhow::ensure!(self.vault()?.as_ref() == Some(vault), "credential vault verification failed");
        Ok(())
    }

    /// Called under the store lock. Legacy entries remain untouched even on success.
    fn migrate_vault(&self, configs: &[ConnectionConfig], ids: Option<&[String]>) -> Result<Vault> {
        let mut vault = self.vault()?.unwrap_or_else(|| Vault { version: 1, secrets: BTreeMap::new() });
        let mut changed = false;
        for config in configs.iter().filter(|c| ids.is_none_or(|ids| ids.contains(&c.id))) {
            if !vault.secrets.contains_key(&config.id) {
                vault.secrets.insert(config.id.clone(), self.legacy_secrets(&config.id)?);
                changed = true;
            }
        }
        if changed { self.save_vault(&vault)?; }
        Ok(vault)
    }

    pub fn resolve_secrets(&self, id: &str, input: &SecretsInput) -> Result<Secrets> {
        let _guard = self.acquire()?;
        let needs_saved = !id.is_empty() && input.as_array().iter().any(|value| value.is_none());
        let mut secrets = if !needs_saved { Secrets::default() } else if let Some(vault) = self.vault()? {
            match vault.secrets.get(id) { Some(secrets) => secrets.clone(), None => self.legacy_secrets(id)? }
        } else { self.legacy_secrets(id)? };
        input.apply(&mut secrets);
        Ok(secrets)
    }

    /// Take a consistent snapshot while preventing concurrent credential updates.
    pub fn export_snapshot(&self, include_secrets: bool, ids: Option<&[String]>) -> Result<(Vec<ConnectionConfig>, BTreeMap<String, Secrets>)> {
        let _guard = self.acquire()?;
        let configs = self.list_locked()?;
        let secrets = if include_secrets { self.migrate_vault(&configs, ids)?.secrets } else { BTreeMap::new() };
        Ok((configs, secrets))
    }

    fn write_with_secrets(&self, list: &[ConnectionConfig], updates: &[(String, SecretsInput)]) -> Result<()> {
        if !updates.iter().any(|(_, input)| input.as_array().iter().any(|value| value.is_some())) {
            return self.write(list);
        }
        if let Some(mut vault) = self.vault()? {
            let previous = serde_json::to_string(&vault)?;
            for (id, input) in updates {
                if !input.as_array().iter().any(|value| value.is_some()) { continue; }
                if !vault.secrets.contains_key(id) {
                    vault.secrets.insert(id.clone(), self.legacy_secrets(id)?);
                }
                input.apply(vault.secrets.entry(id.clone()).or_default());
            }
            let result = self.save_vault(&vault).and_then(|()| self.write(list));
            if let Err(error) = result {
                if let Err(rollback) = self.credentials.write(VAULT_ACCOUNT, Some(&previous)) {
                    anyhow::bail!("{error:#}; Keychain rollback failed: {rollback}");
                }
                return Err(error);
            }
            return Ok(());
        }
        let mut previous = Vec::new();
        for (id, input) in updates {
            for (field, value) in FIELDS.iter().zip(input.as_array()) {
                let account = format!("{id}:{field}");
                if value.is_some() && !previous.iter().any(|(a, _): &(String, Option<String>)| *a == account) {
                    previous.push((account.clone(), self.credentials.read(&account)?));
                }
            }
        }
        let result = (|| -> Result<()> {
            for (id, input) in updates {
                for (field, value) in FIELDS.iter().zip(input.as_array()) {
                    if let Some(value) = value {
                        self.credentials.write(&format!("{id}:{field}"), (!value.is_empty()).then_some(value.as_str()))?;
                    }
                }
            }
            self.write(list)
        })();
        if let Err(error) = result {
            let mut rollback_errors = Vec::new();
            for (account, old) in previous.into_iter().rev() {
                if let Err(e) = self.credentials.write(&account, old.as_deref()) { rollback_errors.push(e.to_string()); }
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
        let _guard = self.acquire()?;
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
        let _guard = self.acquire()?;
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
        let _guard = self.acquire()?;
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
        let _guard = self.acquire()?;
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
        let _guard = self.acquire()?;
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
    use std::sync::Arc;

    #[derive(Default)]
    struct MemoryCredentials {
        values: Mutex<BTreeMap<String, String>>,
        reads: Mutex<Vec<String>>,
        fail_read: Mutex<Option<String>>,
        fail_write: Mutex<bool>,
    }

    impl Credentials for Arc<MemoryCredentials> {
        fn read(&self, account: &str) -> Result<Option<String>> {
            self.reads.lock().unwrap().push(account.to_string());
            if self.fail_read.lock().unwrap().as_deref() == Some(account) { anyhow::bail!("access denied"); }
            Ok(self.values.lock().unwrap().get(account).cloned())
        }
        fn write(&self, account: &str, value: Option<&str>) -> Result<()> {
            if *self.fail_write.lock().unwrap() { anyhow::bail!("write denied"); }
            let mut values = self.values.lock().unwrap();
            match value { Some(value) => { values.insert(account.into(), value.into()); }, None => { values.remove(account); } }
            Ok(())
        }
    }

    fn memory_store() -> (Store, Arc<MemoryCredentials>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("dbdock-vault-{}", uuid::Uuid::new_v4()));
        let credentials = Arc::new(MemoryCredentials::default());
        let store = Store { path: dir.join("connections.json"), lock: Mutex::new(()), credentials: Box::new(credentials.clone()) };
        let configs = ["one", "two"].into_iter().map(|id| serde_json::from_value(serde_json::json!({"id":id,"name":id,"kind":"postgres"})).unwrap()).collect();
        store.upsert_many(configs).unwrap();
        credentials.values.lock().unwrap().extend([
            ("one:password".into(), "first".into()),
            ("one:ssh_password".into(), "ssh".into()),
            ("two:password".into(), "second".into()),
        ]);
        (store, credentials, dir)
    }

    #[test]
    fn migration_is_scoped_and_subsequent_reads_use_vault() {
        let (store, credentials, dir) = memory_store();
        let (_, snapshot) = store.export_snapshot(true, Some(&["one".into()])).unwrap();
        assert_eq!(snapshot["one"].password.as_deref(), Some("first"));
        assert_eq!(snapshot["one"].ssh_password.as_deref(), Some("ssh"));
        assert!(!credentials.reads.lock().unwrap().iter().any(|s| s.starts_with("two:")));
        credentials.reads.lock().unwrap().clear();
        store.export_snapshot(true, Some(&["one".into()])).unwrap();
        assert!(!credentials.reads.lock().unwrap().iter().any(|s| s.starts_with("one:")));
        assert_eq!(credentials.values.lock().unwrap().get("one:password").unwrap(), "first");
        let (_, snapshot) = store.export_snapshot(true, None).unwrap();
        assert_eq!(snapshot["two"].password.as_deref(), Some("second"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migration_failure_preserves_legacy_and_retry_succeeds() {
        let (store, credentials, dir) = memory_store();
        *credentials.fail_read.lock().unwrap() = Some("two:password".into());
        assert!(store.export_snapshot(true, None).is_err());
        assert!(!credentials.values.lock().unwrap().contains_key(VAULT_ACCOUNT));
        assert_eq!(credentials.values.lock().unwrap().get("one:password").unwrap(), "first");
        *credentials.fail_read.lock().unwrap() = None;
        *credentials.fail_write.lock().unwrap() = true;
        assert!(store.export_snapshot(true, None).is_err());
        assert!(!credentials.values.lock().unwrap().contains_key(VAULT_ACCOUNT));
        *credentials.fail_write.lock().unwrap() = false;
        let (_, secrets) = store.export_snapshot(true, None).unwrap();
        assert_eq!(secrets["one"].password.as_deref(), Some("first"));
        assert_eq!(secrets["two"].password.as_deref(), Some("second"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn updates_and_deletion_do_not_resurrect_legacy_values() {
        let (store, credentials, dir) = memory_store();
        store.export_snapshot(true, Some(&["one".into()])).unwrap();
        let config = store.get("one").unwrap();
        store.save(config, &SecretsInput { password: Some("updated".into()), ..Default::default() }).unwrap();
        let got = store.resolve_secrets("one", &SecretsInput::default()).unwrap();
        assert_eq!(got.password.as_deref(), Some("updated"));
        assert_eq!(got.ssh_password.as_deref(), Some("ssh"));
        store.delete("one").unwrap();
        assert_eq!(store.resolve_secrets("one", &SecretsInput::default()).unwrap(), Secrets::default());
        assert_eq!(credentials.values.lock().unwrap().get("one:password").unwrap(), "first");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn incremental_migration_failure_keeps_existing_vault_unchanged() {
        let (store, credentials, dir) = memory_store();
        store.export_snapshot(true, Some(&["one".into()])).unwrap();
        let previous = credentials.values.lock().unwrap()[VAULT_ACCOUNT].clone();
        *credentials.fail_read.lock().unwrap() = Some("two:password".into());
        assert!(store.export_snapshot(true, None).is_err());
        assert_eq!(credentials.values.lock().unwrap()[VAULT_ACCOUNT], previous);
        assert_eq!(store.resolve_secrets("one", &SecretsInput::default()).unwrap().password.as_deref(), Some("first"));
        *credentials.fail_read.lock().unwrap() = None;
        assert_eq!(store.export_snapshot(true, None).unwrap().1["two"].password.as_deref(), Some("second"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn vault_update_rolls_back_if_config_write_fails() {
        let (mut store, credentials, dir) = memory_store();
        store.export_snapshot(true, None).unwrap();
        let configs = store.list().unwrap();
        let previous = credentials.values.lock().unwrap()[VAULT_ACCOUNT].clone();
        // A directory at the target path makes the atomic rename fail.
        store.path = dir.join("unwritable-target");
        std::fs::create_dir(&store.path).unwrap();
        let result = store.write_with_secrets(&configs, &[("one".into(), SecretsInput { password: Some("new".into()), ..Default::default() })]);
        assert!(result.is_err());
        assert_eq!(credentials.values.lock().unwrap()[VAULT_ACCOUNT], previous);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn malformed_vault_never_falls_back_to_stale_legacy_data() {
        let (store, credentials, dir) = memory_store();
        credentials.values.lock().unwrap().insert(VAULT_ACCOUNT.into(), "invalid".into());
        assert!(store.resolve_secrets("one", &SecretsInput::default()).is_err());
        assert!(store.export_snapshot(true, None).is_err());
        assert_eq!(credentials.values.lock().unwrap().get("one:password").unwrap(), "first");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn separate_stores_serialize_credential_updates() {
        let (store, credentials, dir) = memory_store();
        store.export_snapshot(true, None).unwrap();
        let other = Store { path: store.path.clone(), lock: Mutex::new(()), credentials: Box::new(credentials.clone()) };
        let first = std::thread::spawn(move || {
            for i in 0..20 {
                let cfg = store.get("one").unwrap();
                store.save(cfg, &SecretsInput { password: Some(format!("first-{i}")), ..Default::default() }).unwrap();
            }
            store
        });
        let second = std::thread::spawn(move || {
            for i in 0..20 {
                let cfg = other.get("two").unwrap();
                other.save(cfg, &SecretsInput { password: Some(format!("second-{i}")), ..Default::default() }).unwrap();
            }
        });
        let store = first.join().unwrap();
        second.join().unwrap();
        let (_, secrets) = store.export_snapshot(true, None).unwrap();
        assert_eq!(secrets["one"].password.as_deref(), Some("first-19"));
        assert_eq!(secrets["two"].password.as_deref(), Some("second-19"));
        std::fs::remove_dir_all(dir).unwrap();
    }

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

