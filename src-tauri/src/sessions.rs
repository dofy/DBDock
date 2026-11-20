use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::redis_db::RedisConn;
use crate::sql::SqlConn;
use crate::ssh::Tunnel;
use crate::store::{ConnectionConfig, Kind, Secrets, SecretsInput, SqlProtection, Store};
use crate::{CmdResult, default_port, err, mongo_db, sql, ssh};

pub(crate) enum Conn {
    Sql(SqlConn),
    Redis(RedisConn),
    Mongo(mongo_db::MongoConn),
}

pub(crate) struct Session {
    pub(crate) conn: Conn,
    pub(crate) sql_protection: SqlProtection,
    // Dropped after `conn`, so the pool closes before the tunnel.
    _tunnel: Option<Tunnel>,
}

#[derive(Default)]
pub(crate) struct Sessions {
    active: Mutex<HashMap<String, Arc<Session>>>,
    pending: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
}

impl Sessions {
    pub(crate) fn get(&self, id: &str) -> CmdResult<Arc<Session>> {
        self.active
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "session closed; reconnect".to_string())
    }

    pub(crate) fn sql(&self, id: &str) -> CmdResult<Arc<Session>> {
        let s = self.get(id)?;
        match s.conn {
            Conn::Sql(_) => Ok(s),
            _ => Err("not a SQL session".into()),
        }
    }

    pub(crate) fn begin_connect(&self, attempt_id: String) -> CmdResult<()> {
        let mut pending = self.pending.lock().unwrap();
        if pending.contains_key(&attempt_id) {
            return Err("connection attempt already exists".into());
        }
        let (sender, _) = tokio::sync::watch::channel(false);
        pending.insert(attempt_id, sender);
        Ok(())
    }

    pub(crate) fn cancel_connect(&self, attempt_id: &str) {
        if let Some(sender) = self.pending.lock().unwrap().get(attempt_id) {
            sender.send_replace(true);
        }
    }

    pub(crate) async fn connect(
        &self,
        store: &Store,
        id: &str,
        attempt_id: &str,
        database: Option<String>,
    ) -> CmdResult<SessionInfo> {
        let mut cancelled = {
            let pending = self.pending.lock().unwrap();
            pending
                .get(attempt_id)
                .ok_or("connection attempt not found")?
                .subscribe()
        };
        let result = async {
            if *cancelled.borrow() {
                return Err("connection cancelled".into());
            }
            let mut cfg = store.get(id).map_err(err)?;
            if let Some(database) = database {
                if !matches!(cfg.kind, Kind::Postgres | Kind::Mysql)
                    || database.is_empty()
                    || database.contains('\0')
                {
                    return Err("Invalid database for this connection".into());
                }
                // An alternate database is a separate session using the saved connection's credentials and protection.
                cfg.database = database;
            }
            let secrets = store
                .resolve_secrets(id, &SecretsInput::default())
                .map_err(err)?;
            let opened = wait_for_connection(&mut cancelled, async {
                open_session(&cfg, secrets).await.map_err(err)
            })
            .await?;
            let (session, server_version, default_schema) = opened;
            // Serialize the final cancellation check and session insertion with cancel_connect.
            let pending = self.pending.lock().unwrap();
            if pending
                .get(attempt_id)
                .is_none_or(|sender| *sender.borrow())
            {
                return Err("connection cancelled".into());
            }
            let session_id = uuid::Uuid::new_v4().to_string();
            let sql_protection = session.sql_protection;
            self.active
                .lock()
                .unwrap()
                .insert(session_id.clone(), Arc::new(session));
            Ok(SessionInfo {
                session_id,
                kind: cfg.kind,
                server_version,
                default_schema,
                sql_protection,
            })
        }
        .await;
        self.pending.lock().unwrap().remove(attempt_id);
        result
    }

    pub(crate) fn disconnect(&self, session_id: &str) {
        self.active.lock().unwrap().remove(session_id);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionInfo {
    session_id: String,
    kind: Kind,
    server_version: String,
    /// SQL: current database/schema. Redis: selected db index.
    default_schema: String,
    sql_protection: SqlProtection,
}

pub(crate) async fn open_session(
    cfg: &ConnectionConfig,
    secrets: Secrets,
) -> anyhow::Result<(Session, String, String)> {
    let mut tunnel = None;
    let (mut host, mut port) = (cfg.host.clone(), cfg.port);
    if host.is_empty() {
        host = "127.0.0.1".into();
    }
    let tunnelable = !matches!(cfg.kind, Kind::Sqlite | Kind::D1);
    if cfg.ssh.enabled && tunnelable && host.starts_with("mongodb") {
        anyhow::bail!(
            "with SSH, enter the MongoDB host and port separately instead of a connection string"
        );
    }
    if cfg.ssh.enabled && tunnelable {
        let target_port = if port == 0 {
            default_port(cfg.kind)
        } else {
            port
        };
        let t = ssh::open(
            &cfg.ssh,
            secrets.ssh_password,
            secrets.ssh_passphrase,
            host,
            target_port,
        )
        .await?;
        host = "127.0.0.1".into();
        port = t.local_port;
        tunnel = Some(t);
    }
    let conn = match cfg.kind {
        Kind::Redis => Conn::Redis(
            RedisConn::connect(&host, port, &cfg.user, secrets.password, cfg.redis_db).await?,
        ),
        Kind::Mongodb => Conn::Mongo(
            mongo_db::MongoConn::connect(cfg, &host, port, secrets.password, tunnel.is_some())
                .await?,
        ),
        _ => Conn::Sql(sql::connect(cfg, &host, port, secrets.password).await?),
    };
    let (version, schema) = match &conn {
        Conn::Sql(c) => (
            c.pool.server_version().await?,
            c.pool.current_schema().await.unwrap_or_default(),
        ),
        Conn::Redis(r) => (r.server_version().await?, r.db().await.to_string()),
        Conn::Mongo(m) => (m.version().await?, m.default_db.clone()),
    };
    Ok((
        Session {
            conn,
            sql_protection: cfg.sql_protection.effective(&cfg.env),
            _tunnel: tunnel,
        },
        version,
        schema,
    ))
}

async fn wait_for_connection<T>(
    cancelled: &mut tokio::sync::watch::Receiver<bool>,
    operation: impl std::future::Future<Output = CmdResult<T>>,
) -> CmdResult<T> {
    if *cancelled.borrow() {
        return Err("connection cancelled".into());
    }
    tokio::select! {
        biased;
        _ = cancelled.changed() => Err("connection cancelled".into()),
        result = operation => result,
    }
}

#[cfg(test)]
mod connection_cancel_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[tokio::test]
    async fn cancelling_drops_an_in_progress_connection_and_pre_cancel_is_safe() {
        struct Guard(Arc<AtomicBool>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let (sender, mut receiver) = tokio::sync::watch::channel(false);
        let dropped = Arc::new(AtomicBool::new(false));
        let guard = Guard(dropped.clone());
        let task = tokio::spawn(async move {
            wait_for_connection(&mut receiver, async move {
                let _guard = guard;
                std::future::pending::<CmdResult<()>>().await
            })
            .await
        });
        tokio::task::yield_now().await;
        sender.send_replace(true);
        assert_eq!(task.await.unwrap().unwrap_err(), "connection cancelled");
        assert!(dropped.load(Ordering::SeqCst));
        let mut already_cancelled = sender.subscribe();
        assert_eq!(
            wait_for_connection(&mut already_cancelled, async { Ok(()) })
                .await
                .unwrap_err(),
            "connection cancelled"
        );
    }
}
