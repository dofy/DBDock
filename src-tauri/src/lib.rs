mod d1;
mod groups;
mod menu;
mod import;
mod mongo_db;
mod redis_db;
mod sql;
mod sql_browser;
mod sql_protection;
mod sources;
mod ssh;
mod ssh_config;
mod ssh_config_edit;
mod ssh_terminal;
mod store;
mod transfer;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager, State};

use redis_db::{KeyValue, RedisConn, ScanPage};
use sql::{Change, QueryResult, SqlConn, SqlPool, TableData, TableInfo};
use sql_browser::{TableFilter, TableMetadata};
use ssh::Tunnel;
use store::{ConnectionConfig, Kind, Secrets, SecretsInput, SqlProtection, Store};

type CmdResult<T> = Result<T, String>;

/// Join the error chain, skipping causes already repeated in the outer message
/// (sqlx errors embed their source in Display).
fn err(e: anyhow::Error) -> String {
    let mut out = String::new();
    for cause in e.chain() {
        let msg = cause.to_string();
        if out.contains(&msg) {
            continue;
        }
        if !out.is_empty() {
            out.push_str(": ");
        }
        out.push_str(&msg);
    }
    out
}

pub(crate) fn default_port(kind: Kind) -> u16 {
    match kind {
        Kind::Mysql => 3306,
        Kind::Postgres => 5432,
        Kind::Redis => 6379,
        Kind::Mongodb => 27017,
        Kind::Sqlite | Kind::D1 => 0,
    }
}

enum Conn {
    Sql(SqlConn),
    Redis(RedisConn),
    Mongo(mongo_db::MongoConn),
}

struct Session {
    conn: Conn,
    sql_protection: SqlProtection,
    // Dropped after `conn`, so the pool closes before the tunnel.
    _tunnel: Option<Tunnel>,
}

struct AppState {
    store: Store,
    groups: groups::Groups,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    pending_connections: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
    browser_requests: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
}

impl AppState {
    fn session(&self, id: &str) -> CmdResult<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "session closed; reconnect".to_string())
    }

    fn sql(&self, id: &str) -> CmdResult<Arc<Session>> {
        let s = self.session(id)?;
        match s.conn {
            Conn::Sql(_) => Ok(s),
            _ => Err("not a SQL session".into()),
        }
    }
}

fn pool(s: &Session) -> &SqlPool {
    match &s.conn {
        Conn::Sql(c) => &c.pool,
        _ => unreachable!(),
    }
}

fn browser_pool(s: &Session) -> &SqlPool {
    match &s.conn {
        Conn::Sql(c) => c.browser.as_ref().unwrap_or(&c.pool),
        _ => unreachable!(),
    }
}

fn mongo(s: &Session) -> CmdResult<&mongo_db::MongoConn> {
    match &s.conn {
        Conn::Mongo(m) => Ok(m),
        _ => Err("not a MongoDB session".into()),
    }
}

fn redis(s: &Session) -> CmdResult<&RedisConn> {
    match &s.conn {
        Conn::Redis(r) => Ok(r),
        _ => Err("not a Redis session".into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    session_id: String,
    kind: Kind,
    server_version: String,
    /// SQL: current database/schema. Redis: selected db index.
    default_schema: String,
    sql_protection: SqlProtection,
}

async fn open_session(cfg: &ConnectionConfig, secrets: Secrets) -> anyhow::Result<(Session, String, String)> {
    let mut tunnel = None;
    let (mut host, mut port) = (cfg.host.clone(), cfg.port);
    if host.is_empty() {
        host = "127.0.0.1".into();
    }
    let tunnelable = !matches!(cfg.kind, Kind::Sqlite | Kind::D1);
    if cfg.ssh.enabled && tunnelable && host.starts_with("mongodb") {
        anyhow::bail!("with SSH, enter the MongoDB host and port separately instead of a connection string");
    }
    if cfg.ssh.enabled && tunnelable {
        let target_port = if port == 0 { default_port(cfg.kind) } else { port };
        let t = ssh::open(&cfg.ssh, secrets.ssh_password, secrets.ssh_passphrase, host, target_port).await?;
        host = "127.0.0.1".into();
        port = t.local_port;
        tunnel = Some(t);
    }
    let conn = match cfg.kind {
        Kind::Redis => Conn::Redis(RedisConn::connect(&host, port, &cfg.user, secrets.password, cfg.redis_db).await?),
        Kind::Mongodb => Conn::Mongo(mongo_db::MongoConn::connect(cfg, &host, port, secrets.password, tunnel.is_some()).await?),
        _ => Conn::Sql(sql::connect(cfg, &host, port, secrets.password).await?),
    };
    let (version, schema) = match &conn {
        Conn::Sql(c) => (c.pool.server_version().await?, c.pool.current_schema().await.unwrap_or_default()),
        Conn::Redis(r) => (r.server_version().await?, r.db().await.to_string()),
        Conn::Mongo(m) => (m.version().await?, m.default_db.clone()),
    };
    Ok((Session { conn, sql_protection: cfg.sql_protection.effective(&cfg.env), _tunnel: tunnel }, version, schema))
}

// ---------- connections ----------

#[tauri::command]
fn list_connections(state: State<'_, AppState>) -> CmdResult<Vec<ConnectionConfig>> {
    state.store.list().map_err(err)
}

#[tauri::command]
fn save_connection(state: State<'_, AppState>, config: ConnectionConfig, secrets: SecretsInput) -> CmdResult<ConnectionConfig> {
    state.store.save(config, &secrets).map_err(err)
}

#[tauri::command]
fn delete_connection(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.store.delete(&id).map_err(err)
}

#[tauri::command]
async fn test_connection(state: State<'_, AppState>, config: ConnectionConfig, secrets: SecretsInput) -> CmdResult<String> {
    let resolved = state.store.resolve_secrets(&config.id, &secrets).map_err(err)?;
    let (_session, version, _) = open_session(&config, resolved).await.map_err(err)?;
    Ok(version)
}

/// Test a saved connection without creating a workspace session.
#[tauri::command]
async fn check_saved_connection(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let cfg = state.store.get(&id).map_err(err)?;
    if cfg.kind == Kind::Sqlite {
        return tokio::time::timeout(std::time::Duration::from_secs(30), sql::check_sqlite_readonly(&cfg.file))
            .await.map_err(|_| "connection check timed out".to_string())?.map_err(err);
    }
    let secrets = state.store.resolve_secrets(&id, &SecretsInput::default()).map_err(err)?;
    tokio::time::timeout(std::time::Duration::from_secs(30), open_session(&cfg, secrets))
        .await.map_err(|_| "connection check timed out".to_string())?.map_err(err)?;
    Ok(())
}

#[tauri::command]
fn begin_connect(state: State<'_, AppState>, attempt_id: String) -> CmdResult<()> {
    let mut pending = state.pending_connections.lock().unwrap();
    if pending.contains_key(&attempt_id) { return Err("connection attempt already exists".into()); }
    let (sender, _) = tokio::sync::watch::channel(false);
    pending.insert(attempt_id, sender);
    Ok(())
}

#[tauri::command]
fn cancel_connect(state: State<'_, AppState>, attempt_id: String) {
    if let Some(sender) = state.pending_connections.lock().unwrap().get(&attempt_id) {
        sender.send_replace(true);
    }
}

async fn wait_for_connection<T>(cancelled: &mut tokio::sync::watch::Receiver<bool>, operation: impl std::future::Future<Output = CmdResult<T>>) -> CmdResult<T> {
    if *cancelled.borrow() { return Err("connection cancelled".into()); }
    tokio::select! {
        biased;
        _ = cancelled.changed() => Err("connection cancelled".into()),
        result = operation => result,
    }
}

#[tauri::command]
async fn connect(state: State<'_, AppState>, id: String, attempt_id: String) -> CmdResult<SessionInfo> {
    let mut cancelled = {
        let pending = state.pending_connections.lock().unwrap();
        pending.get(&attempt_id).ok_or("connection attempt not found")?.subscribe()
    };
    let result = async {
        if *cancelled.borrow() { return Err("connection cancelled".into()); }
        let cfg = state.store.get(&id).map_err(err)?;
        let secrets = state.store.resolve_secrets(&id, &SecretsInput::default()).map_err(err)?;
        let opened = wait_for_connection(&mut cancelled, async { open_session(&cfg, secrets).await.map_err(err) }).await?;
        let (session, server_version, default_schema) = opened;
        // Serialize the final cancellation check and session insertion with cancel_connect.
        let pending = state.pending_connections.lock().unwrap();
        if pending.get(&attempt_id).is_none_or(|sender| *sender.borrow()) {
            return Err("connection cancelled".into());
        }
        let session_id = uuid::Uuid::new_v4().to_string();
        let sql_protection = session.sql_protection;
        state.sessions.lock().unwrap().insert(session_id.clone(), Arc::new(session));
        Ok(SessionInfo { session_id, kind: cfg.kind, server_version, default_schema, sql_protection })
    }.await;
    state.pending_connections.lock().unwrap().remove(&attempt_id);
    result
}

#[tauri::command]
fn disconnect(state: State<'_, AppState>, session_id: String) {
    state.sessions.lock().unwrap().remove(&session_id);
}

#[tauri::command]
fn detect_import_file(path: String) -> CmdResult<sources::Detected> {
    sources::detect(std::path::Path::new(&path)).map_err(err)
}

#[tauri::command]
fn import_file(state: State<'_, AppState>, path: String, passphrase: Option<String>) -> CmdResult<sources::Report> {
    sources::import_file(&state.store, std::path::Path::new(&path), passphrase).map_err(err)
}

#[tauri::command]
fn import_text(state: State<'_, AppState>, text: String) -> CmdResult<sources::Report> {
    sources::import_text(&state.store, &text).map_err(err)
}

/// Connections.plist of an installed TablePlus, offered as a one-click source.
#[tauri::command]
fn tableplus_file() -> Option<String> {
    import::tableplus_file().map(|p| p.display().to_string())
}

#[tauri::command]
fn export_connections(
    state: State<'_, AppState>,
    path: String,
    ids: Option<Vec<String>>,
    include_secrets: bool,
    passphrase: Option<String>,
) -> CmdResult<usize> {
    transfer::export(&state.store, std::path::Path::new(&path), ids, include_secrets, passphrase).map_err(err)
}

#[tauri::command]
fn inspect_connections_file(path: String) -> CmdResult<transfer::FileInfo> {
    transfer::inspect(std::path::Path::new(&path)).map_err(err)
}

#[tauri::command]
fn import_connections(state: State<'_, AppState>, path: String, passphrase: Option<String>) -> CmdResult<transfer::TransferReport> {
    transfer::import(&state.store, std::path::Path::new(&path), passphrase).map_err(err)
}

#[tauri::command]
fn list_groups(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    state.groups.list(&state.store).map_err(err)
}

#[tauri::command]
fn create_group(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    state.groups.create(&path).map_err(err)
}

#[tauri::command]
fn rename_group(state: State<'_, AppState>, from: String, to: String) -> CmdResult<usize> {
    state.groups.rename(&state.store, &from, &to).map_err(err)
}

#[tauri::command]
fn delete_group(state: State<'_, AppState>, path: String, move_to: String) -> CmdResult<usize> {
    state.groups.delete(&state.store, &path, &move_to).map_err(err)
}

#[tauri::command]
fn move_connections(state: State<'_, AppState>, ids: Vec<String>, group: String) -> CmdResult<usize> {
    state.store.move_to_group(&ids, &group).map_err(err)
}

#[tauri::command]
fn delete_connections(state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<usize> {
    for id in &ids {
        state.store.delete(id).map_err(err)?;
    }
    Ok(ids.len())
}

#[tauri::command]
fn ssh_hosts_list() -> CmdResult<Vec<ssh_config_edit::HostBlock>> {
    ssh_config_edit::list().map_err(err)
}

#[tauri::command]
fn ssh_host_save(original: Option<String>, form: ssh_config_edit::HostForm) -> CmdResult<()> {
    ssh_config_edit::save(original, form).map_err(err)
}

#[tauri::command]
fn ssh_host_delete(alias: String) -> CmdResult<()> {
    ssh_config_edit::delete(&alias).map_err(err)
}

#[tauri::command]
async fn ssh_host_open_terminal(alias: String, terminal: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || ssh_terminal::open(&alias, &terminal).map_err(err))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn ssh_config_raw() -> CmdResult<String> {
    ssh_config_edit::raw().map_err(err)
}

#[tauri::command]
fn ssh_config_write(text: String) -> CmdResult<()> {
    ssh_config_edit::write_raw(&text).map_err(err)
}

/// Log in to an SSH host (no tunnel) to check address, user and key.
#[tauri::command]
async fn ssh_host_test(alias: String, password: Option<String>) -> CmdResult<String> {
    let cfg = store::SshConfig { enabled: true, host: alias, port: 22, user: String::new(), auth: if password.is_some() { store::SshAuth::Password } else { store::SshAuth::Key }, key_path: String::new() };
    let t = ssh::open(&cfg, password, None, "127.0.0.1".into(), 22).await.map_err(err)?;
    drop(t);
    Ok("SSH login OK".into())
}

#[tauri::command]
fn open_help(app: tauri::AppHandle, section: Option<String>) -> CmdResult<()> {
    menu::open_help(&app, section.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn confirm_quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn set_menu_language(app: tauri::AppHandle, language: String) -> CmdResult<()> {
    let menu = menu::build(&app, &language).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_github() {
    menu::open_github();
}

/// Host aliases from ~/.ssh/config, offered in the SSH host field.
#[tauri::command]
fn ssh_config_hosts() -> Vec<ssh_config::HostEntry> {
    ssh_config::hosts()
}

// SQL files are chosen explicitly using the native open/save dialog.
#[tauri::command]
fn read_sql_file(path: String) -> CmdResult<String> {
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 5 * 1024 * 1024 { return Err("SQL file is larger than 5 MiB".into()); }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 5 * 1024 * 1024 { return Err("SQL file is larger than 5 MiB".into()); }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_sql_file(path: String, contents: String) -> CmdResult<()> {
    use std::io::Write;
    let path = std::path::Path::new(&path);
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| std::path::Path::new("."));
    let temporary = parent.join(format!(".dbdock-sql-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        if let Ok(meta) = std::fs::metadata(path) { file.set_permissions(meta.permissions())?; }
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result.map_err(|e| e.to_string())
}

// ---------- SQL ----------

// Each table read has its own cancellation token; closing one tab must not
// interrupt another tab or the SQL editor.
#[tauri::command]
fn begin_browser_request(state: State<'_, AppState>, request_id: String) -> CmdResult<()> {
    let mut requests = state.browser_requests.lock().unwrap();
    if requests.contains_key(&request_id) { return Err("browser request already exists".into()); }
    let (sender, _) = tokio::sync::watch::channel(false);
    requests.insert(request_id, sender);
    Ok(())
}

#[tauri::command]
fn cancel_browser_request(state: State<'_, AppState>, request_id: String) {
    if let Some(sender) = state.browser_requests.lock().unwrap().remove(&request_id) {
        sender.send_replace(true);
    }
}

async fn browser_request<T>(state: &AppState, request_id: &str, operation: impl std::future::Future<Output = CmdResult<T>>) -> CmdResult<T> {
    let mut cancelled = {
        let requests = state.browser_requests.lock().unwrap();
        requests.get(request_id).ok_or("browser request cancelled")?.subscribe()
    };
    let result = wait_for_browser_request(&mut cancelled, operation).await;
    state.browser_requests.lock().unwrap().remove(request_id);
    result
}


async fn wait_for_browser_request<T>(cancelled: &mut tokio::sync::watch::Receiver<bool>, operation: impl std::future::Future<Output = CmdResult<T>>) -> CmdResult<T> {
    if *cancelled.borrow() { return Err("browser request cancelled".into()); }
    tokio::select! {
        biased;
        _ = cancelled.changed() => Err("browser request cancelled".into()),
        result = operation => result,
    }
}

#[tauri::command]
async fn sql_schemas(state: State<'_, AppState>, session_id: String) -> CmdResult<Vec<String>> {
    let s = state.sql(&session_id)?;
    browser_pool(&s).schemas().await.map_err(err)
}

#[tauri::command]
async fn sql_tables(state: State<'_, AppState>, session_id: String, schema: String) -> CmdResult<Vec<TableInfo>> {
    let s = state.sql(&session_id)?;
    browser_pool(&s).tables(&schema).await.map_err(err)
}

#[tauri::command]
async fn sql_structure(state: State<'_, AppState>, session_id: String, schema: String, table: String, request_id: String) -> CmdResult<QueryResult> {
    browser_request(&state, &request_id, async {
        let s = state.sql(&session_id)?;
        browser_pool(&s).structure(&schema, &table).await.map_err(err)
    }).await
}

#[tauri::command]
async fn sql_table_metadata(state: State<'_, AppState>, session_id: String, schema: String, table: String, kind: TableMetadata, request_id: String) -> CmdResult<QueryResult> {
    browser_request(&state, &request_id, async {
        let s = state.sql(&session_id)?;
        browser_pool(&s).metadata(&schema, &table, kind).await.map_err(err)
    }).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn sql_table_data(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    limit: u32,
    offset: u64,
    order_by: Option<String>,
    order_desc: bool,
    filter: Option<String>,
    visual_filter: Option<TableFilter>,
    capture_versions: bool,
    request_id: String,
) -> CmdResult<TableData> {
    browser_request(&state, &request_id, async {
        let s = state.sql(&session_id)?;
        if filter.as_ref().is_some_and(|f| !f.trim().is_empty()) && s.sql_protection != SqlProtection::Automatic {
            return Err("Use visual filters on protected connections".into());
        }
        let capture_versions = capture_versions && s.sql_protection != SqlProtection::BrowseOnly;
        browser_pool(&s).table_data(&schema, &table, limit, offset, order_by, order_desc, filter, visual_filter, capture_versions).await.map_err(err)
    }).await
}

#[tauri::command]
fn sql_needs_confirmation(state: State<'_, AppState>, session_id: String, sql: String) -> CmdResult<bool> {
    let s = state.sql(&session_id)?;
    Ok(s.sql_protection == SqlProtection::Confirm && sql_protection::needs_confirmation(&sql, pool(&s).dialect()))
}

#[tauri::command]
async fn sql_execute(state: State<'_, AppState>, session_id: String, sql: String, confirmed: bool) -> CmdResult<Vec<QueryResult>> {
    let s = state.sql(&session_id)?;
    if s.sql_protection != SqlProtection::Confirm || (!confirmed && sql_protection::needs_confirmation(&sql, pool(&s).dialect())) {
        s.sql_protection.check_execution(confirmed).map_err(err)?;
    }
    pool(&s).execute(sql).await.map_err(err)
}

#[tauri::command]
async fn sql_cancel(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    let s = state.sql(&session_id)?;
    let Conn::Sql(c) = &s.conn else { unreachable!() };
    c.cancel().await.map_err(err)
}

#[tauri::command]
async fn sql_columns(state: State<'_, AppState>, session_id: String, schema: String) -> CmdResult<std::collections::BTreeMap<String, Vec<String>>> {
    let s = state.sql(&session_id)?;
    browser_pool(&s).columns(&schema).await.map_err(err)
}

#[tauri::command]
async fn sql_preview_changes(state: State<'_, AppState>, session_id: String, schema: String, table: String, changes: Vec<Change>) -> CmdResult<Vec<String>> {
    let s = state.sql(&session_id)?;
    browser_pool(&s).change_sql(&schema, &table, &changes).await.map_err(err)
}

#[tauri::command]
async fn sql_apply_changes(state: State<'_, AppState>, session_id: String, schema: String, table: String, changes: Vec<Change>, confirmed: bool) -> CmdResult<usize> {
    let s = state.sql(&session_id)?;
    s.sql_protection.check_execution(confirmed).map_err(err)?;
    browser_pool(&s).apply(&schema, &table, &changes).await.map_err(err)
}

// ---------- Redis ----------

#[tauri::command]
async fn redis_scan(state: State<'_, AppState>, session_id: String, cursor: u64, pattern: String, count: u32) -> CmdResult<ScanPage> {
    let s = state.session(&session_id)?;
    redis(&s)?.scan(cursor, &pattern, count).await.map_err(err)
}

#[tauri::command]
async fn redis_get(state: State<'_, AppState>, session_id: String, key: String) -> CmdResult<KeyValue> {
    let s = state.session(&session_id)?;
    redis(&s)?.get(&key).await.map_err(err)
}

#[tauri::command]
async fn redis_delete(state: State<'_, AppState>, session_id: String, key: String) -> CmdResult<i64> {
    let s = state.session(&session_id)?;
    redis(&s)?.delete(&key).await.map_err(err)
}

#[tauri::command]
async fn redis_command(state: State<'_, AppState>, session_id: String, line: String) -> CmdResult<Value> {
    let s = state.session(&session_id)?;
    redis(&s)?.command(&line).await.map_err(err)
}

// ---------- MongoDB ----------

#[tauri::command]
async fn mongo_databases(state: State<'_, AppState>, session_id: String) -> CmdResult<Vec<String>> {
    let s = state.session(&session_id)?;
    mongo(&s)?.databases().await.map_err(err)
}

#[tauri::command]
async fn mongo_collections(state: State<'_, AppState>, session_id: String, db: String) -> CmdResult<Vec<String>> {
    let s = state.session(&session_id)?;
    mongo(&s)?.collections(&db).await.map_err(err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn mongo_find(
    state: State<'_, AppState>,
    session_id: String,
    db: String,
    coll: String,
    filter: Option<Value>,
    sort: Option<Value>,
    projection: Option<Value>,
    skip: u64,
    limit: i64,
) -> CmdResult<mongo_db::FindPage> {
    let s = state.session(&session_id)?;
    mongo(&s)?.find(&db, &coll, filter, sort, projection, skip, limit).await.map_err(err)
}

#[tauri::command]
async fn mongo_count(state: State<'_, AppState>, session_id: String, db: String, coll: String, filter: Option<Value>) -> CmdResult<u64> {
    let s = state.session(&session_id)?;
    mongo(&s)?.count(&db, &coll, filter).await.map_err(err)
}

#[tauri::command]
async fn mongo_insert(state: State<'_, AppState>, session_id: String, db: String, coll: String, doc: Value) -> CmdResult<Value> {
    let s = state.session(&session_id)?;
    mongo(&s)?.insert(&db, &coll, doc).await.map_err(err)
}

#[tauri::command]
async fn mongo_replace(state: State<'_, AppState>, session_id: String, db: String, coll: String, id: Value, doc: Value) -> CmdResult<()> {
    let s = state.session(&session_id)?;
    mongo(&s)?.replace(&db, &coll, id, doc).await.map_err(err)
}

#[tauri::command]
async fn mongo_delete(state: State<'_, AppState>, session_id: String, db: String, coll: String, ids: Vec<Value>) -> CmdResult<u64> {
    let s = state.session(&session_id)?;
    mongo(&s)?.delete(&db, &coll, ids).await.map_err(err)
}

#[tauri::command]
async fn mongo_indexes(state: State<'_, AppState>, session_id: String, db: String, coll: String) -> CmdResult<Vec<Value>> {
    let s = state.session(&session_id)?;
    mongo(&s)?.indexes(&db, &coll).await.map_err(err)
}

#[tauri::command]
async fn mongo_shell(state: State<'_, AppState>, session_id: String, db: String, line: String) -> CmdResult<mongo_db::ShellResult> {
    let s = state.session(&session_id)?;
    mongo(&s)?.shell(&db, &line).await.map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RedisDbInfo {
    db: i64,
    dbsize: i64,
}

#[tauri::command]
async fn redis_select(state: State<'_, AppState>, session_id: String, db: Option<i64>) -> CmdResult<RedisDbInfo> {
    let s = state.session(&session_id)?;
    let r = redis(&s)?;
    if let Some(db) = db {
        r.select(db).await.map_err(err)?;
    }
    Ok(RedisDbInfo { db: r.db().await, dbsize: r.dbsize().await.map_err(err)? })
}

/// Before the rename to DBDock (xyz.phpz.app.dbdock) data lived under net.yahaha.dbdock.
/// Copy connections and groups once; passwords are re-imported (Keychain entries are
/// bound to the old signature and would prompt on every read).
fn migrate_legacy_data(dir: &std::path::Path) {
    let old = store::expand_tilde("~/Library/Application Support/net.yahaha.dbdock");
    if dir.join("connections.json").exists() || !old.join("connections.json").exists() {
        return;
    }
    let _ = std::fs::create_dir_all(dir);
    for f in ["connections.json", "groups.json"] {
        if old.join(f).exists() {
            let _ = std::fs::copy(old.join(f), dir.join(f));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .menu(|app| menu::build(app, "en"))
        .on_menu_event(|app, e| menu::handle(app, e.id().as_ref()))
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            migrate_legacy_data(&dir);
            let store = Store::new(dir.clone());
            app.manage(AppState { store, groups: groups::Groups::new(dir), sessions: Mutex::new(HashMap::new()), pending_connections: Mutex::new(HashMap::new()), browser_requests: Mutex::new(HashMap::new()) });
            #[cfg(target_os = "macos")]
            menu::observe_tab_modifiers(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_connections,
            check_saved_connection,
            save_connection,
            delete_connection,
            detect_import_file,
            import_file,
            import_text,
            tableplus_file,
            export_connections,
            inspect_connections_file,
            import_connections,
            ssh_config_hosts,
            open_help,
            open_github,
            set_menu_language,
            confirm_quit,
            ssh_hosts_list,
            ssh_host_save,
            ssh_host_delete,
            ssh_host_open_terminal,
            ssh_config_raw,
            ssh_config_write,
            ssh_host_test,
            list_groups,
            create_group,
            rename_group,
            delete_group,
            move_connections,
            delete_connections,
            test_connection,
            begin_connect,
            cancel_connect,
            connect,
            disconnect,
            read_sql_file,
            write_sql_file,
            sql_schemas,
            sql_tables,
            begin_browser_request,
            cancel_browser_request,
            sql_structure,
            sql_table_metadata,
            sql_table_data,
            sql_needs_confirmation,
            sql_execute,
            sql_cancel,
            sql_columns,
            sql_preview_changes,
            sql_apply_changes,
            redis_scan,
            redis_get,
            redis_delete,
            redis_command,
            redis_select,
            mongo_databases,
            mongo_collections,
            mongo_find,
            mongo_count,
            mongo_insert,
            mongo_replace,
            mongo_delete,
            mongo_indexes,
            mongo_shell,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                if app.get_webview_window("main").is_some() {
                    api.prevent_exit();
                    let _ = app.emit("menu", "quit-app");
                }
            }
        });
}

/// Integration smoke test against live servers; run with `DBDOCK_IT=1 cargo test -- --nocapture`.
#[cfg(test)]
mod it {
    use super::*;
    use store::{SshAuth, SshConfig};

    fn cfg(kind: Kind, host: &str, port: u16, user: &str, db: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: String::new(),
            name: "t".into(),
            kind,
            host: host.into(),
            port,
            user: user.into(),
            database: db.into(),
            file: String::new(),
            redis_db: 0,
            cf_account_id: String::new(),
            options: String::new(),
            color: String::new(),
            env: String::new(),
            sql_protection: Default::default(),
            group: String::new(),
            ssh: SshConfig::default(),
        }
    }

    fn pw(p: &str) -> Secrets {
        Secrets { password: Some(p.into()), ..Default::default() }
    }

    fn tunnel(mut c: ConnectionConfig, host: &str, auth: SshAuth) -> ConnectionConfig {
        c.host = host.into();
        c.ssh = SshConfig {
            enabled: true,
            host: "127.0.0.1".into(),
            port: 12222,
            user: "tunnel".into(),
            auth,
            key_path: std::env::var("DBDOCK_IT_KEY").unwrap_or_default(),
        };
        c
    }

    async fn dump_sql(c: &ConnectionConfig, s: Secrets, schema: &str, table: &str) {
        let (sess, v, cur) = open_session(c, s).await.expect("connect");
        let Conn::Sql(c) = &sess.conn else { panic!() };
        let p = &c.pool;
        println!("== {v} current={cur}");
        println!("schemas {:?}", p.schemas().await.unwrap());
        println!("tables {:?}", p.tables(schema).await.unwrap());
        let st = p.structure(schema, table).await.unwrap();
        println!("structure {:?}", st.rows);
        let d = p.table_data(schema, table, 1, 0, Some("id".into()), false, None, None, true).await.unwrap();
        println!("data {} more={} cols={:?}\n  rows={}", d.sql, d.has_more, d.result.columns, serde_json::to_string(&d.result.rows).unwrap());
        let r = p.execute(format!("SELECT 1 AS one; SELECT * FROM {}.{} WHERE 1=0", p.quote_ident(schema), p.quote_ident(table))).await.unwrap();
        println!("multi {}", serde_json::to_string(&r).unwrap());
        if let Err(e) = p.execute("SELEC oops".into()).await { println!("err ok: {e:#}") }
    }

    #[tokio::test]
    #[ignore = "requires throwaway live database servers; set DBDOCK_IT=1"]
    async fn smoke() {
        assert!(std::env::var("DBDOCK_IT").is_ok(), "set DBDOCK_IT=1");
        dump_sql(&cfg(Kind::Mysql, "127.0.0.1", 13306, "root", "shop"), pw("rootpw"), "shop", "products").await;
        dump_sql(&cfg(Kind::Postgres, "127.0.0.1", 15432, "postgres", "shop"), pw("pgpw"), "public", "users").await;
        let mut lite = cfg(Kind::Sqlite, "", 0, "", "");
        lite.file = "/tmp/dbdock-test.sqlite".into();
        dump_sql(&lite, Secrets::default(), "main", "notes").await;

        let (sess, v, _) = open_session(&cfg(Kind::Redis, "127.0.0.1", 16379, "", ""), pw("redispw")).await.unwrap();
        let Conn::Redis(r) = &sess.conn else { panic!() };
        println!("== {v} dbsize={}", r.dbsize().await.unwrap());
        let page = r.scan(0, "*", 100).await.unwrap();
        println!("scan {}", serde_json::to_string(&page).unwrap());
        for k in ["greeting", "q", "user:1", "tags", "board", "ev", "temp"] {
            use base64::Engine;
            let id = base64::engine::general_purpose::STANDARD.encode(k);
            println!("get {}", r.get(&id).await.map(|v| serde_json::to_string(&v).unwrap()).unwrap_or_else(|e| e.to_string()));
        }
        println!("cmd {:?}", r.command("hgetall user:1").await.unwrap());
        println!("cmd err {:?}", r.command("nosuch").await.map_err(|e| e.to_string()));
        r.select(2).await.unwrap();
        println!("db2 {}", serde_json::to_string(&r.scan(0, "", 10).await.unwrap()).unwrap());

        // Through the SSH container to the servers' docker-network hostnames.
        let ssh_pw = Secrets { password: Some("pgpw".into()), ssh_password: Some("sshpw".into()), ..Default::default() };
        let (_, v, _) = open_session(&tunnel(cfg(Kind::Postgres, "", 5432, "postgres", "shop"), "dbdock-test-pg", SshAuth::Password), ssh_pw).await.unwrap();
        println!("ssh(password) pg: {v}");
        let (_, v, _) = open_session(&tunnel(cfg(Kind::Mysql, "", 3306, "root", "shop"), "dbdock-test-mysql", SshAuth::Key), pw("rootpw")).await.unwrap();
        println!("ssh(key) mysql: {v}");
        let (_, v, _) = open_session(&tunnel(cfg(Kind::Redis, "", 6379, "", ""), "dbdock-test-redis", SshAuth::Key), pw("redispw")).await.unwrap();
        println!("ssh(key) redis: {v}");
        let bad = Secrets { password: Some("pgpw".into()), ssh_password: Some("wrong".into()), ..Default::default() };
        let e = open_session(&tunnel(cfg(Kind::Postgres, "", 5432, "postgres", "shop"), "dbdock-test-pg", SshAuth::Password), bad).await.err().unwrap();
        println!("ssh bad pw: {e:#}");

        // Key auth with no key path and an empty HOME: only ssh-agent can succeed.
        let mut c = tunnel(cfg(Kind::Redis, "", 6379, "", ""), "dbdock-test-redis", SshAuth::Key);
        c.ssh.key_path.clear();
        let (_, v, _) = open_session(&c, pw("redispw")).await.expect("agent auth");
        println!("ssh(agent) redis: {v}");
    }

    async fn edit_and_cancel(c: &ConnectionConfig, s: Secrets, schema: &str, sleep_sql: &str) {
        use sql::Change;
        use std::collections::BTreeMap;
        let (sess, v, _) = open_session(c, s).await.unwrap();
        let Conn::Sql(conn) = &sess.conn else { panic!() };
        let p = &conn.pool;
        let cols = p.columns(schema).await.unwrap();
        println!("== {v} columns: {:?}", cols.iter().map(|(t, c)| format!("{t}({})", c.len())).collect::<Vec<_>>());
        p.execute("DROP TABLE IF EXISTS dbdock_edit; CREATE TABLE dbdock_edit (id INTEGER PRIMARY KEY, name VARCHAR(20), n INTEGER)".into()).await.unwrap();
        let m = |pairs: &[(&str, serde_json::Value)]| pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect::<BTreeMap<_, _>>();
        let ch = vec![
            Change::Insert { values: m(&[("id", 1.into()), ("name", "it's".into()), ("n", serde_json::Value::Null)]) },
            Change::Insert { values: m(&[("id", 2.into()), ("name", "b".into())]) },
        ];
        p.apply(schema, "dbdock_edit", &ch).await.unwrap();
        let page = p.table_data(schema, "dbdock_edit", 2, 0, Some("id".into()), false, None, None, true).await.unwrap();
        let ch = vec![
            Change::Update { key: m(&[("id", 1.into())]), set: m(&[("n", "42".into()), ("name", "x\\y".into())]), version: page.row_versions[0].clone() },
            Change::Delete { key: m(&[("id", 2.into())]), version: page.row_versions[1].clone() },
        ];
        println!("sql {:?}", p.change_sql(schema, "dbdock_edit", &ch).await.unwrap());
        p.apply(schema, "dbdock_edit", &ch).await.unwrap();
        let bad = vec![Change::Delete { key: m(&[("id", 99.into())]), version: "missing".into() }];
        println!("missing row: {}", p.apply(schema, "dbdock_edit", &bad).await.unwrap_err());
        let r = p.execute("SELECT * FROM dbdock_edit".into()).await.unwrap();
        println!("after {}", serde_json::to_string(&r[0].rows).unwrap());

        if !sleep_sql.is_empty() {
            let t0 = std::time::Instant::now();
            let fut = p.execute(sleep_sql.into());
            let cancel = async {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                conn.cancel().await
            };
            let (r, c) = tokio::join!(fut, cancel);
            println!("cancel: {:?} -> {:?} after {:?}", c.map_err(|e| e.to_string()), r.map(|_| ()).map_err(|e| format!("{e:#}")), t0.elapsed());
            println!("usable after cancel: {:?}", p.execute("SELECT 1".into()).await.map(|r| r.len()));
        }
        p.execute("DROP TABLE dbdock_edit".into()).await.unwrap();
    }

    /// DBDOCK_D1_TOKEN, DBDOCK_D1_ACCOUNT, DBDOCK_D1_RO (read-only db), DBDOCK_D1_RW (scratch db).
    #[tokio::test]
    #[ignore = "requires a scratch Cloudflare D1 database and credentials"]
    async fn d1() {
        let token = std::env::var("DBDOCK_D1_TOKEN").expect("set DBDOCK_D1_TOKEN");
        let acct = std::env::var("DBDOCK_D1_ACCOUNT").expect("set DBDOCK_D1_ACCOUNT");
        let mk = |db: &str| {
            let mut c = cfg(Kind::D1, "", 0, "", db);
            c.cf_account_id = acct.clone();
            c
        };
        let tok = Secrets { password: Some(token.clone()), ..Default::default() };
        if let Ok(ro) = std::env::var("DBDOCK_D1_RO") {
            let (sess, v, _) = open_session(&mk(&ro), tok.clone()).await.expect("d1 connect");
            let Conn::Sql(c) = &sess.conn else { panic!() };
            let p = &c.pool;
            let tables = p.tables("main").await.unwrap();
            println!("== {v}: {} tables, first {:?}", tables.len(), tables.iter().take(4).map(|t| &t.name).collect::<Vec<_>>());
            let cols = p.columns("main").await.unwrap();
            println!("columns for {} tables; Book: {:?}", cols.len(), cols.get("Book").map(|c| c.len()));
            let st = p.structure("main", "Book").await.unwrap();
            println!("structure cols={:?} first={:?}", st.columns, st.rows.first());
            let d = p.table_data("main", "Book", 2, 0, Some("id".into()), true, None, None, true).await.unwrap();
            println!("data {} more={} cols={}", d.sql, d.has_more, d.result.columns.len());
        }
        if let Ok(rw) = std::env::var("DBDOCK_D1_RW") {
            use sql::Change;
            use std::collections::BTreeMap;
            let (sess, _, _) = open_session(&mk(&rw), tok.clone()).await.unwrap();
            let Conn::Sql(c) = &sess.conn else { panic!() };
            let p = &c.pool;
            println!("rw tables {:?}", p.tables("main").await.unwrap().iter().map(|t| format!("{}:{}", t.name, t.kind)).collect::<Vec<_>>());
            println!("rw rows {}", serde_json::to_string(&p.execute("SELECT * FROM notes ORDER BY id".into()).await.unwrap()[0].rows).unwrap());
            let m = |pairs: &[(&str, serde_json::Value)]| pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect::<BTreeMap<_, _>>();
            let page = p.table_data("main", "notes", 2, 0, Some("id".into()), false, None, None, true).await.unwrap();
            let ok = vec![
                Change::Update { key: m(&[("id", 1.into())]), set: m(&[("body", "edited".into())]), version: page.row_versions[0].clone() },
                Change::Insert { values: m(&[("body", "new".into())]) },
                Change::Delete { key: m(&[("id", 2.into())]), version: page.row_versions[1].clone() },
            ];
            p.apply("main", "notes", &ok).await.unwrap();
            let page = p.table_data("main", "notes", 2, 0, Some("id".into()), false, None, None, true).await.unwrap();
            let bad = vec![
                Change::Update { key: m(&[("id", 1.into())]), set: m(&[("body", "SHOULD ROLL BACK".into())]), version: page.row_versions[0].clone() },
                Change::Delete { key: m(&[("id", 999.into())]), version: "missing".into() },
            ];
            println!("bad batch: {}", p.apply("main", "notes", &bad).await.unwrap_err());
            println!("after {}", serde_json::to_string(&p.execute("SELECT id, body FROM notes ORDER BY id".into()).await.unwrap()[0].rows).unwrap());
            println!("cancel: {}", c.cancel().await.unwrap_err());
        }
        let mut bad = mk(&std::env::var("DBDOCK_D1_RO").unwrap_or_default());
        bad.cf_account_id = acct.clone();
        let e = open_session(&bad, Secrets { password: Some("nope".into()), ..Default::default() }).await.err().unwrap();
        println!("bad token: {}", err(e));
    }

    #[tokio::test]
    #[ignore = "requires a throwaway MongoDB server; set DBDOCK_IT=1"]
    async fn mongo() {
        assert!(std::env::var("DBDOCK_IT").is_ok(), "set DBDOCK_IT=1");
        let mut c = cfg(Kind::Mongodb, "127.0.0.1", 17017, "root", "shop");
        c.options = "authSource=admin".into();
        let (sess, v, db) = open_session(&c, pw("mongo p@ss")).await.expect("mongo connect");
        let Conn::Mongo(m) = &sess.conn else { panic!() };
        println!("== {v} default db={db}");
        for line in [
            "db.users.deleteMany({})",
            r#"db.users.insertMany([{name: 'alice', age: 30, at: ISODate("2026-01-02T03:04:05Z")}, {name: "bob", age: 17, tags: ['a','b']}, {name: 'carol', age: 45}])"#,
            "db.users.find({age: {$gt: 18}}, {name: 1}).sort({age: -1}).limit(5)",
            "db.users.countDocuments({})",
            "db.users.distinct('name')",
            "db.users.aggregate([{$group: {_id: null, avg: {$avg: '$age'}}}])",
            "db.users.updateOne({name: 'bob'}, {$set: {age: 18}})",
            "db.runCommand({ping: 1})",
            "show collections",
            "db.users.bogus()",
        ] {
            match m.shell("shop", line).await {
                Ok(r) => println!("{line}\n  -> {} docs={} value={}", r.kind, serde_json::to_string(&r.docs).unwrap(), r.value.map(|v| v.to_string()).unwrap_or_default()),
                Err(e) => println!("{line}\n  -> ERR {e:#}"),
            }
        }
        println!("dbs {:?} colls {:?}", m.databases().await.unwrap(), m.collections("shop").await.unwrap());
        let page = m.find("shop", "users", Some(serde_json::json!("{age: {$gte: 18}}")), Some(serde_json::json!({"name": 1})), None, 0, 2).await.unwrap();
        println!("find page more={} {}", page.has_more, serde_json::to_string(&page.docs).unwrap());
        let first = page.docs[0].clone();
        let id = first["_id"].clone();
        let mut edited = first.clone();
        edited["age"] = serde_json::json!(31);
        m.replace("shop", "users", id.clone(), edited).await.unwrap();
        let mut bad = first.clone();
        bad["_id"] = serde_json::json!({"$oid": "000000000000000000000000"});
        println!("change _id: {}", m.replace("shop", "users", id.clone(), bad).await.unwrap_err());
        println!("count filtered {}", m.count("shop", "users", Some(serde_json::json!("{age: 31}"))).await.unwrap());
        let new_id = m.insert("shop", "users", serde_json::json!({"name": "dave"})).await.unwrap();
        println!("deleted {}", m.delete("shop", "users", vec![new_id]).await.unwrap());
        println!("indexes {}", serde_json::to_string(&m.indexes("shop", "users").await.unwrap()).unwrap());

        // Through the SSH container to mongo's docker-network hostname.
        let mut t = tunnel(cfg(Kind::Mongodb, "", 27017, "root", "shop"), "dbdock-test-mongo", SshAuth::Key);
        t.options = "authSource=admin".into();
        let (_, v, _) = open_session(&t, pw("mongo p@ss")).await.expect("mongo over ssh");
        println!("ssh mongo: {v}");
        // Connection string form.
        let mut u = cfg(Kind::Mongodb, "mongodb://root@127.0.0.1:17017/shop?authSource=admin", 0, "", "");
        u.host = "mongodb://root@127.0.0.1:17017/shop?authSource=admin".into();
        let (_, v, db) = open_session(&u, pw("mongo p@ss")).await.expect("mongo uri");
        println!("uri mongo: {v} db={db}");
        let e = open_session(&c, pw("wrong")).await.err().unwrap();
        println!("bad pw: {}", err(e));
    }

    #[tokio::test]
    #[ignore = "requires throwaway live database servers; set DBDOCK_IT=1"]
    async fn edit() {
        assert!(std::env::var("DBDOCK_IT").is_ok(), "set DBDOCK_IT=1");
        edit_and_cancel(&cfg(Kind::Mysql, "127.0.0.1", 13306, "root", "shop"), pw("rootpw"), "shop", "SELECT SLEEP(10)").await;
        edit_and_cancel(&cfg(Kind::Postgres, "127.0.0.1", 15432, "postgres", "shop"), pw("pgpw"), "public", "SELECT pg_sleep(10)").await;
        let mut lite = cfg(Kind::Sqlite, "", 0, "", "");
        lite.file = "/tmp/dbdock-test.sqlite".into();
        edit_and_cancel(&lite, Secrets::default(), "main", "").await;
    }
}

#[cfg(test)]
mod connection_cancel_tests {
    #[tokio::test]
    async fn browser_cancellation_drops_only_its_own_read() {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        struct DropFlag(Arc<AtomicBool>);
        impl Drop for DropFlag { fn drop(&mut self) { self.0.store(true, Ordering::SeqCst); } }
        let (sender, mut receiver) = tokio::sync::watch::channel(false);
        let (_other_sender, mut other_receiver) = tokio::sync::watch::channel(false);
        let dropped = Arc::new(AtomicBool::new(false));
        let flag = DropFlag(dropped.clone());
        let task = tokio::spawn(async move {
            super::wait_for_browser_request(&mut receiver, async move {
                let _flag = flag;
                std::future::pending::<super::CmdResult<()>>().await
            }).await
        });
        tokio::task::yield_now().await;
        sender.send_replace(true);
        assert_eq!(task.await.unwrap().unwrap_err(), "browser request cancelled");
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(super::wait_for_browser_request(&mut other_receiver, async { Ok(42) }).await.unwrap(), 42);
        let mut already_cancelled = sender.subscribe();
        assert!(super::wait_for_browser_request(&mut already_cancelled, async { Ok(()) }).await.is_err());
    }

    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn sql_file_roundtrip_and_reject_large_file() {
        let dir = std::env::temp_dir().join(format!("dbdock-sql-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("query.sql");
        let name = path.to_str().unwrap().to_string();
        let sql = "SELECT '日本語';\nSELECT 2;";
        write_sql_file(name.clone(), sql.into()).unwrap();
        assert_eq!(read_sql_file(name.clone()).unwrap(), sql);
        std::fs::write(&path, vec![b'x'; 5 * 1024 * 1024 + 1]).unwrap();
        assert!(read_sql_file(name).unwrap_err().contains("5 MiB"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn cancelling_drops_an_in_progress_connection_and_pre_cancel_is_safe() {
        struct Guard(Arc<AtomicBool>);
        impl Drop for Guard { fn drop(&mut self) { self.0.store(true, Ordering::SeqCst); } }
        let (sender, mut receiver) = tokio::sync::watch::channel(false);
        let dropped = Arc::new(AtomicBool::new(false));
        let guard = Guard(dropped.clone());
        let task = tokio::spawn(async move {
            wait_for_connection(&mut receiver, async move {
                let _guard = guard;
                std::future::pending::<CmdResult<()>>().await
            }).await
        });
        tokio::task::yield_now().await;
        sender.send_replace(true);
        assert_eq!(task.await.unwrap().unwrap_err(), "connection cancelled");
        assert!(dropped.load(Ordering::SeqCst));
        let mut already_cancelled = sender.subscribe();
        assert_eq!(wait_for_connection(&mut already_cancelled, async { Ok(()) }).await.unwrap_err(), "connection cancelled");
    }
}
