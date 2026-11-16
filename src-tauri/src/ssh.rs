//! SSH tunnel: listen on 127.0.0.1:<random> and forward each accepted socket
//! through a `direct-tcpip` channel to the database host as seen from the SSH server.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use russh::client;
use russh::keys::agent::client::AgentClient;
use russh::keys::{
    check_known_hosts, known_hosts::learn_known_hosts, load_secret_key, PrivateKeyWithHashAlg,
    PublicKeyOrCertificate,
};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::store::{expand_tilde, SshAuth, SshConfig};

pub struct Tunnel {
    pub local_port: u16,
    task: JoinHandle<()>,
    _handle: Arc<client::Handle<HostCheck>>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub struct HostCheck {
    host: String,
    port: u16,
}

impl client::Handler for HostCheck {
    type Error = russh::Error;

    /// Trust on first use against ~/.ssh/known_hosts; refuse a changed key.
    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            return Ok(true);
        };
        match check_known_hosts(&self.host, self.port, key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                let _ = learn_known_hosts(&self.host, self.port, key);
                Ok(true)
            }
            Err(russh::keys::Error::KeyChanged { line }) => {
                eprintln!(
                    "host key for {}:{} changed (known_hosts line {line}); refusing",
                    self.host, self.port
                );
                Ok(false)
            }
            // Unreadable known_hosts: do not block the connection.
            Err(_) => Ok(true),
        }
    }
}

/// Offer every agent identity; false when there is no agent or none is accepted.
async fn try_agent(handle: &mut client::Handle<HostCheck>, user: &str) -> bool {
    let Ok(mut agent) = AgentClient::connect_env().await else { return false };
    let Ok(ids) = agent.request_identities().await else { return false };
    let hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
    for id in ids {
        let key = id.public_key().into_owned();
        if let Ok(res) = handle.authenticate_publickey_with(user, key, hash, &mut agent).await {
            if res.success() {
                return true;
            }
        }
    }
    false
}

fn default_keys() -> Vec<String> {
    ["~/.ssh/id_ed25519", "~/.ssh/id_ecdsa", "~/.ssh/id_rsa"]
        .iter()
        .map(|s| s.to_string())
        .filter(|p| expand_tilde(p).exists())
        .collect()
}

pub async fn open(
    cfg: &SshConfig,
    password: Option<String>,
    passphrase: Option<String>,
    target_host: String,
    target_port: u16,
) -> Result<Tunnel> {
    // The host may be a ~/.ssh/config alias; explicit form values win over the file.
    let rc = crate::ssh_config::resolve(cfg.host.trim());
    let host = rc.host_name.clone().unwrap_or_else(|| cfg.host.trim().to_string());
    let port = match cfg.port {
        0 | 22 => rc.port.unwrap_or(22),
        p => p,
    };
    let user = match cfg.user.trim() {
        "" => rc.user.clone().unwrap_or_default(),
        u => u.to_string(),
    };
    if user.is_empty() {
        bail!("SSH user is empty (set it here or in ~/.ssh/config)");
    }
    let cfg = &SshConfig { host: host.clone(), port, user, ..cfg.clone() };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let handler = HostCheck { host: cfg.host.clone(), port };
    let mut handle = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(config, (cfg.host.as_str(), port), handler),
    )
    .await
    .context("SSH connect timed out")?
    .with_context(|| format!("SSH connect to {}:{port} failed (host key rejected?)", cfg.host))?;

    let authed = match cfg.auth {
        SshAuth::Password => handle
            .authenticate_password(cfg.user.clone(), password.unwrap_or_default())
            .await?
            .success(),
        SshAuth::Key => {
            let explicit = !cfg.key_path.trim().is_empty();
            // No key file chosen: ssh-agent first (covers ForwardAgent-style setups
            // and keychain-held passphrases), then the default key files.
            let mut ok = !explicit && try_agent(&mut handle, &cfg.user).await;
            let paths = if explicit {
                vec![cfg.key_path.trim().to_string()]
            } else {
                // IdentityFile entries from ~/.ssh/config first, then the usual defaults.
                let mut p: Vec<String> = rc.identity_files.iter().filter(|f| expand_tilde(f).exists()).cloned().collect();
                for d in default_keys() {
                    if !p.contains(&d) {
                        p.push(d);
                    }
                }
                p
            };
            let mut last_err = None;
            for p in paths {
                if ok {
                    break;
                }
                let key = match load_secret_key(expand_tilde(&p), passphrase.as_deref()) {
                    Ok(k) => k,
                    Err(e) => {
                        last_err = Some(format!("{p}: {e}"));
                        continue;
                    }
                };
                let hash = handle.best_supported_rsa_hash().await?.flatten();
                ok = handle
                    .authenticate_publickey(cfg.user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                    .await?
                    .success();
            }
            if let (false, Some(e)) = (ok, last_err) {
                bail!("SSH key auth failed ({e})");
            }
            ok
        }
    };
    if !authed {
        bail!("SSH authentication failed for {}@{}", cfg.user, cfg.host);
    }

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let local_port = listener.local_addr()?.port();
    let handle = Arc::new(handle);
    let h = handle.clone();
    let task = tokio::spawn(async move {
        while let Ok((mut sock, peer)) = listener.accept().await {
            let h = h.clone();
            let host = target_host.clone();
            tokio::spawn(async move {
                match h
                    .channel_open_direct_tcpip(
                        host,
                        target_port as u32,
                        peer.ip().to_string(),
                        peer.port() as u32,
                    )
                    .await
                {
                    Ok(ch) => {
                        let mut stream = ch.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                    }
                    Err(e) => eprintln!("ssh direct-tcpip failed: {e}"),
                }
            });
        }
    });

    Ok(Tunnel { local_port, task, _handle: handle })
}
