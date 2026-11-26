use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    reconnect: Option<ReconnectConfig>,
    // Dropped after `conn`, so the pool closes before the tunnel.
    _tunnel: Option<Tunnel>,
}

#[derive(Clone)]
struct ReconnectConfig {
    config: ConnectionConfig,
    secrets: Secrets,
}

struct ActiveSession {
    session: Arc<Session>,
    reconnect_gate: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Default)]
pub(crate) struct Sessions {
    active: Mutex<HashMap<String, ActiveSession>>,
    pending: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
}

impl Sessions {
    pub(crate) fn get(&self, id: &str) -> CmdResult<Arc<Session>> {
        let active = self.active.lock().unwrap();
        let entry = active.get(id).ok_or("session closed; reconnect")?;
        let _guard = entry
            .reconnect_gate
            .try_lock()
            .map_err(|_| "Connection is reconnecting")?;
        Ok(entry.session.clone())
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
            self.active.lock().unwrap().insert(
                session_id.clone(),
                ActiveSession {
                    session: Arc::new(session),
                    reconnect_gate: Arc::new(tokio::sync::Mutex::new(())),
                },
            );
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

    pub(crate) async fn reconnect_sql(&self, id: &str) -> CmdResult<()> {
        self.reconnect_sql_with(id, open_replacement).await
    }

    async fn reconnect_sql_with<F>(
        &self,
        id: &str,
        open: impl FnOnce(ReconnectConfig) -> F,
    ) -> CmdResult<()>
    where
        F: std::future::Future<Output = CmdResult<Session>>,
    {
        let (config, _guard) = {
            let active = self.active.lock().unwrap();
            let entry = active.get(id).ok_or("session closed; reconnect")?;
            let config = entry
                .session
                .reconnect
                .as_ref()
                .ok_or("Reconnection is only available for PostgreSQL and MySQL sessions")?;
            let guard = entry
                .reconnect_gate
                .clone()
                .try_lock_owned()
                .map_err(|_| "Connection is reconnecting")?;
            // All IPC operations share this Arc until their database work ends.
            // Check under the same lock that admits new operations in get().
            if Arc::strong_count(&entry.session) != 1 {
                return Err("Wait for database operations to finish before reconnecting".into());
            }
            (config.clone(), guard)
        };

        let session = tokio::time::timeout(Duration::from_secs(45), open(config))
            .await
            .map_err(|_| "Reconnection timed out")??;
        // A tab may have closed while the replacement was opening.
        let old = {
            let mut active = self.active.lock().unwrap();
            let entry = active.get_mut(id).ok_or("session closed; reconnect")?;
            std::mem::replace(&mut entry.session, Arc::new(session))
        };
        drop(old);
        Ok(())
    }
}

async fn open_replacement(setup: ReconnectConfig) -> CmdResult<Session> {
    let (session, _, _) = open_session(&setup.config, setup.secrets)
        .await
        .map_err(err)?;
    Ok(session)
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
    // Keep the route and its credentials together. An edited saved profile
    // must not send replacement credentials to the old session's host.
    let reconnect = matches!(cfg.kind, Kind::Postgres | Kind::Mysql).then(|| ReconnectConfig {
        config: cfg.clone(),
        secrets: secrets.clone(),
    });
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
            reconnect,
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

    #[tokio::test]
    #[ignore = "requires an isolated PostgreSQL test database"]
    async fn postgres_reconnect_recovers_a_broken_link_under_the_same_session_id() {
        use tokio::net::{TcpListener, TcpStream};
        use tokio::sync::{oneshot, watch};

        let url = std::env::var("DBDOCK_TEST_POSTGRES_URL").unwrap();
        let (mut cfg, password) = crate::sources::from_url(&url, None).unwrap();
        let upstream = (cfg.host.clone(), cfg.port);
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        cfg.host = "127.0.0.1".into();
        cfg.port = proxy.local_addr().unwrap().port();
        let secrets = Secrets {
            password,
            ..Default::default()
        };
        let (online, availability) = watch::channel(true);
        let forwarding = tokio::spawn(async move {
            while let Ok((mut client, _)) = proxy.accept().await {
                let mut availability = availability.clone();
                let upstream = upstream.clone();
                tokio::spawn(async move {
                    if !*availability.borrow_and_update() {
                        return;
                    }
                    let Ok(mut server) = TcpStream::connect(upstream).await else {
                        return;
                    };
                    tokio::select! {
                        _ = availability.changed() => {}
                        _ = tokio::io::copy_bidirectional(&mut client, &mut server) => {}
                    }
                });
            }
        });
        let open = open_replacement;
        let sessions = Sessions::default();
        let id = "workspace";
        let old = Arc::new(
            open(ReconnectConfig {
                config: cfg.clone(),
                secrets,
            })
            .await
            .unwrap(),
        );
        let previous = Arc::downgrade(&old);
        sessions.active.lock().unwrap().insert(
            id.into(),
            ActiveSession {
                session: old,
                reconnect_gate: Arc::new(tokio::sync::Mutex::new(())),
            },
        );
        async fn browse(session: &Session) -> anyhow::Result<Vec<crate::sql::QueryResult>> {
            let Conn::Sql(connection) = &session.conn else {
                unreachable!()
            };
            connection
                .browser
                .as_ref()
                .unwrap()
                .execute("SELECT 42".into())
                .await
        }

        let in_flight = sessions.sql(id).unwrap();
        browse(&in_flight).await.unwrap();
        assert_eq!(
            sessions.reconnect_sql_with(id, open).await.unwrap_err(),
            "Wait for database operations to finish before reconnecting",
        );
        online.send_replace(false);
        let result = tokio::time::timeout(Duration::from_millis(500), browse(&in_flight)).await;
        assert!(
            !matches!(result, Ok(Ok(_))),
            "The old link should be unusable"
        );
        drop(in_flight);

        let failure = sessions
            .reconnect_sql_with(id, |_| async { Err("unavailable".into()) })
            .await;
        assert_eq!(failure.unwrap_err(), "unavailable");
        assert!(Arc::ptr_eq(
            &previous.upgrade().unwrap(),
            &sessions.sql(id).unwrap()
        ));

        online.send_replace(true);
        let (started, wait_started) = oneshot::channel();
        let (proceed, wait_proceed) = oneshot::channel();
        let reconnect = sessions.reconnect_sql_with(id, |config| async {
            started.send(()).unwrap();
            wait_proceed.await.unwrap();
            open(config).await
        });
        let verify_exclusivity = async {
            wait_started.await.unwrap();
            assert!(
                matches!(sessions.sql(id), Err(message) if message == "Connection is reconnecting")
            );
            assert_eq!(
                sessions.reconnect_sql_with(id, open).await.unwrap_err(),
                "Connection is reconnecting"
            );
            proceed.send(()).unwrap();
        };
        let (result, ()) = tokio::join!(reconnect, verify_exclusivity);
        result.unwrap();
        assert!(
            previous.upgrade().is_none(),
            "The old pool should be dropped"
        );
        let restored = sessions.sql(id).unwrap();
        assert_eq!(
            restored.reconnect.as_ref().unwrap().config.database,
            cfg.database
        );
        assert_eq!(
            browse(&restored).await.unwrap()[0].rows[0][0],
            serde_json::json!(42)
        );
        drop(restored);

        let closed = sessions
            .reconnect_sql_with(id, |config| async {
                sessions.disconnect(id);
                open(config).await
            })
            .await;
        assert_eq!(closed.unwrap_err(), "session closed; reconnect");
        assert!(
            sessions.sql(id).is_err(),
            "Reconnection should not resurrect a closed session"
        );
        forwarding.abort();
    }
}
