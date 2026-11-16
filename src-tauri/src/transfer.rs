//! Export / import of saved connections, optionally with their secrets.
//!
//! File format (`dbdock.connections`, version 1):
//! - plain: `{ format, version, exportedAt, encrypted: false, connections: [...] }`
//! - encrypted: `{ format, version, exportedAt, encrypted: true, kdf, nonce, ciphertext }`,
//!   where the ciphertext is AES-256-GCM over the JSON `connections` array and the key
//!   comes from Argon2id over the passphrase.

use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{bail, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::store::{load_secrets, ConnectionConfig, SecretsInput, Store};

const FORMAT: &str = "dbdock.connections";
const VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportSecrets {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_passphrase: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ExportItem {
    #[serde(flatten)]
    pub config: ConnectionConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secrets: Option<ExportSecrets>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Kdf {
    name: String,
    salt: String,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    format: String,
    version: u32,
    #[serde(default)]
    exported_at: String,
    #[serde(default)]
    encrypted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    connections: Option<Vec<ExportItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kdf: Option<Kdf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ciphertext: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub encrypted: bool,
    /// Unknown until decrypted.
    pub count: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferReport {
    pub added: usize,
    pub updated: usize,
    pub with_secrets: usize,
}

fn derive_key(passphrase: &str, kdf: &Kdf) -> Result<[u8; 32]> {
    let salt = B64.decode(&kdf.salt).context("bad salt")?;
    let params = Params::new(kdf.m_cost, kdf.t_cost, kdf.p_cost, Some(32)).map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), &salt, &mut key)
        .map_err(|e| anyhow::anyhow!("key derivation failed: {e}"))?;
    Ok(key)
}

fn encrypt(items: &[ExportItem], passphrase: &str) -> Result<Envelope> {
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);
    let kdf = Kdf {
        name: "argon2id".into(),
        salt: B64.encode(salt),
        m_cost: 64 * 1024,
        t_cost: 3,
        p_cost: 1,
    };
    let key = derive_key(passphrase, &kdf)?;
    let cipher = Aes256Gcm::new_from_slice(&key).expect("32-byte key");
    let plain = serde_json::to_vec(items)?;
    let ct = cipher
        .encrypt(&Nonce::from(nonce), plain.as_ref())
        .map_err(|_| anyhow::anyhow!("encryption failed"))?;
    Ok(Envelope {
        format: FORMAT.into(),
        version: VERSION,
        exported_at: chrono::Utc::now().to_rfc3339(),
        encrypted: true,
        connections: None,
        kdf: Some(kdf),
        nonce: Some(B64.encode(nonce)),
        ciphertext: Some(B64.encode(ct)),
    })
}

fn read_envelope(path: &Path) -> Result<Envelope> {
    let text = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let env: Envelope = serde_json::from_str(&text).context("not a dbdock connections file")?;
    if env.format != FORMAT {
        bail!("not a dbdock connections file (format {:?})", env.format);
    }
    if env.version > VERSION {
        bail!("file version {} is newer than this app supports", env.version);
    }
    Ok(env)
}

fn decrypt(env: Envelope, passphrase: Option<&str>) -> Result<Vec<ExportItem>> {
    if !env.encrypted {
        return Ok(env.connections.unwrap_or_default());
    }
    let Some(passphrase) = passphrase.filter(|p| !p.is_empty()) else {
        bail!("this file is encrypted; enter its passphrase");
    };
    let kdf = env.kdf.context("missing kdf")?;
    let key = derive_key(passphrase, &kdf)?;
    let nonce: [u8; 12] = B64
        .decode(env.nonce.context("missing nonce")?)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("bad nonce"))?;
    let ct = B64.decode(env.ciphertext.context("missing ciphertext")?)?;
    let plain = Aes256Gcm::new_from_slice(&key)
        .expect("32-byte key")
        .decrypt(&Nonce::from(nonce), ct.as_ref())
        .map_err(|_| anyhow::anyhow!("wrong passphrase, or the file is damaged"))?;
    Ok(serde_json::from_slice(&plain)?)
}

pub fn inspect(path: &Path) -> Result<FileInfo> {
    let env = read_envelope(path)?;
    Ok(FileInfo { encrypted: env.encrypted, count: env.connections.map(|c| c.len()) })
}

fn nonempty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.is_empty())
}

pub fn export(
    store: &Store,
    path: &Path,
    ids: Option<Vec<String>>,
    include_secrets: bool,
    passphrase: Option<String>,
) -> Result<usize> {
    let items: Vec<ExportItem> = store
        .list()?
        .into_iter()
        .filter(|c| ids.as_ref().is_none_or(|ids| ids.contains(&c.id)))
        .map(|config| {
            let secrets = include_secrets.then(|| {
                let s = load_secrets(&config.id);
                ExportSecrets {
                    password: nonempty(s.password),
                    ssh_password: nonempty(s.ssh_password),
                    ssh_passphrase: nonempty(s.ssh_passphrase),
                }
            });
            ExportItem { config, secrets }
        })
        .collect();
    let n = items.len();
    let env = match passphrase.filter(|p| !p.is_empty()) {
        Some(p) => encrypt(&items, &p)?,
        None => Envelope {
            format: FORMAT.into(),
            version: VERSION,
            exported_at: chrono::Utc::now().to_rfc3339(),
            encrypted: false,
            connections: Some(items),
            kdf: None,
            nonce: None,
            ciphertext: None,
        },
    };
    write_private(path, &serde_json::to_string_pretty(&env)?)?;
    Ok(n)
}

/// Owner-only permissions: the file may hold passwords.
fn write_private(path: &Path, text: &str) -> Result<()> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    opts.mode(0o600);
    let tmp = path.with_extension(format!("dbdock-{}.tmp", uuid::Uuid::new_v4()));
    let mut f = opts.open(&tmp).with_context(|| format!("write {}", tmp.display()))?;
    f.write_all(text.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn import(store: &Store, path: &Path, passphrase: Option<String>) -> Result<TransferReport> {
    let items = decrypt(read_envelope(path)?, passphrase.as_deref())?;
    let mut with_secrets = 0;
    let mut configs = Vec::with_capacity(items.len());
    for mut it in items {
        if it.config.id.is_empty() {
            it.config.id = uuid::Uuid::new_v4().to_string();
        }
        let input = if let Some(s) = it.secrets {
            // Only set what the file carries; absent fields keep the stored value.
            let input = SecretsInput {
                password: nonempty(s.password),
                ssh_password: nonempty(s.ssh_password),
                ssh_passphrase: nonempty(s.ssh_passphrase),
            };
            if input.password.is_some() || input.ssh_password.is_some() || input.ssh_passphrase.is_some() {
                with_secrets += 1;
            }
            input
        } else { SecretsInput::default() };
        configs.push((it.config, input));
    }
    let (added, updated) = store.upsert_with_secrets(configs)?;
    Ok(TransferReport { added, updated, with_secrets })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str) -> ExportItem {
        let config: ConnectionConfig =
            serde_json::from_value(serde_json::json!({"id": "x1", "name": name, "kind": "postgres"})).unwrap();
        ExportItem { config, secrets: Some(ExportSecrets { password: Some("p@ss'w".into()), ..Default::default() }) }
    }

    #[test]
    fn encrypt_roundtrip() {
        let env = encrypt(&[item("a")], "correct horse").unwrap();
        let text = serde_json::to_string(&env).unwrap();
        assert!(!text.contains("p@ss"));
        let env: Envelope = serde_json::from_str(&text).unwrap();
        let back = decrypt(env, Some("correct horse")).unwrap();
        assert_eq!(back[0].config.name, "a");
        assert_eq!(back[0].secrets.as_ref().unwrap().password.as_deref(), Some("p@ss'w"));

        let env: Envelope = serde_json::from_str(&text).unwrap();
        assert!(decrypt(env, Some("wrong")).unwrap_err().to_string().contains("wrong passphrase"));
        let env: Envelope = serde_json::from_str(&text).unwrap();
        assert!(decrypt(env, None).is_err());
    }
}
