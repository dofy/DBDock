mod d1;
mod groups;
mod menu;
mod import;
mod mongo_db;
mod redis_db;
mod sql;
mod sources;
mod ssh;
mod ssh_config;
mod ssh_config_edit;
mod store;
mod transfer;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::{Manager, State};

use redis_db::{KeyValue, RedisConn, ScanPage};
use sql::{Change, QueryResult, SqlConn, SqlPool, TableData, TableInfo};
use ssh::Tunnel;
use store::{ConnectionConfig, Kind, Secrets, SecretsInput, Store};

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
    // Dropped after `conn`, so the pool closes before the tunnel.
    _tunnel: Option<Tunnel>,
}

struct AppState {
    store: Store,
    groups: groups::Groups,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
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
    Ok((Session { conn, _tunnel: tunnel }, version, schema))
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
async fn test_connection(config: ConnectionConfig, secrets: SecretsInput) -> CmdResult<String> {
    let resolved = secrets.resolve(&config.id);
    let (_session, version, _) = open_session(&config, resolved).await.map_err(err)?;
    Ok(version)
}

#[tauri::command]
async fn connect(state: State<'_, AppState>, id: String) -> CmdResult<SessionInfo> {
    let cfg = state.store.get(&id).map_err(err)?;
    let (session, server_version, default_schema) =
        open_session(&cfg, store::load_secrets(&id)).await.map_err(err)?;
    let session_id = uuid::Uuid::new_v4().to_string();
    state.sessions.lock().unwrap().insert(session_id.clone(), Arc::new(session));
    Ok(SessionInfo { session_id, kind: cfg.kind, server_version, default_schema })
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
fn open_github() {
    menu::open_github();
}

/// Host aliases from ~/.ssh/config, offered in the SSH host field.
#[tauri::command]
fn ssh_config_hosts() -> Vec<ssh_config::HostEntry> {
    ssh_config::hosts()
}

// ---------- SQL ----------

#[tauri::command]
async fn sql_schemas(state: State<'_, AppState>, session_id: String) -> CmdResult<Vec<String>> {
    let s = state.sql(&session_id)?;
    pool(&s).schemas().await.map_err(err)
}

#[tauri::command]
async fn sql_tables(state: State<'_, AppState>, session_id: String, schema: String) -> CmdResult<Vec<TableInfo>> {
    let s = state.sql(&session_id)?;
    pool(&s).tables(&schema).await.map_err(err)
}

#[tauri::command]
async fn sql_structure(state: State<'_, AppState>, session_id: String, schema: String, table: String) -> CmdResult<QueryResult> {
    let s = state.sql(&session_id)?;
    pool(&s).structure(&schema, &table).await.map_err(err)
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
) -> CmdResult<TableData> {
    let s = state.sql(&session_id)?;
    pool(&s)
        .table_data(&schema, &table, limit, offset, order_by, order_desc, filter)
        .await
        .map_err(err)
}

#[tauri::command]
async fn sql_execute(state: State<'_, AppState>, session_id: String, sql: String) -> CmdResult<Vec<QueryResult>> {
    let s = state.sql(&session_id)?;
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
    pool(&s).columns(&schema).await.map_err(err)
}

#[tauri::command]
fn sql_preview_changes(state: State<'_, AppState>, session_id: String, schema: String, table: String, changes: Vec<Change>) -> CmdResult<Vec<String>> {
    let s = state.sql(&session_id)?;
    pool(&s).change_sql(&schema, &table, &changes).map_err(err)
}

#[tauri::command]
async fn sql_apply_changes(state: State<'_, AppState>, session_id: String, schema: String, table: String, changes: Vec<Change>) -> CmdResult<usize> {
    let s = state.sql(&session_id)?;
    pool(&s).apply(&schema, &table, &changes).await.map_err(err)
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
        .menu(|app| menu::build(app))
        .on_menu_event(|app, e| menu::handle(app, e.id().as_ref()))
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            migrate_legacy_data(&dir);
            let store = Store::new(dir.clone());
            app.manage(AppState { store, groups: groups::Groups::new(dir), sessions: Mutex::new(HashMap::new()) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_connections,
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
            ssh_hosts_list,
            ssh_host_save,
            ssh_host_delete,
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
            connect,
            disconnect,
            sql_schemas,
            sql_tables,
            sql_structure,
            sql_table_data,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
        let d = p.table_data(schema, table, 1, 0, Some("id".into()), false, None).await.unwrap();
        println!("data {} more={} cols={:?}\n  rows={}", d.sql, d.has_more, d.result.columns, serde_json::to_string(&d.result.rows).unwrap());
        let r = p.execute(format!("SELECT 1 AS one; SELECT * FROM {}.{} WHERE 1=0", p.quote_ident(schema), p.quote_ident(table))).await.unwrap();
        println!("multi {}", serde_json::to_string(&r).unwrap());
        if let Err(e) = p.execute("SELEC oops".into()).await { println!("err ok: {e:#}") }
    }

    #[tokio::test]
    async fn smoke() {
        if std::env::var("DBDOCK_IT").is_err() { return; }
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
            println!("get {}", r.get(k).await.map(|v| serde_json::to_string(&v).unwrap()).unwrap_or_else(|e| e.to_string()));
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
        let ch = vec![
            Change::Update { key: m(&[("id", 1.into())]), set: m(&[("n", "42".into()), ("name", "x\\y".into())]) },
            Change::Delete { key: m(&[("id", 2.into())]) },
        ];
        println!("sql {:?}", p.change_sql(schema, "dbdock_edit", &ch).unwrap());
        p.apply(schema, "dbdock_edit", &ch).await.unwrap();
        let bad = vec![Change::Delete { key: m(&[("id", 99.into())]) }];
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
    async fn d1() {
        let (Ok(token), Ok(acct)) = (std::env::var("DBDOCK_D1_TOKEN"), std::env::var("DBDOCK_D1_ACCOUNT")) else { return };
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
            let d = p.table_data("main", "Book", 2, 0, Some("id".into()), true, None).await.unwrap();
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
            let ok = vec![
                Change::Update { key: m(&[("id", 1.into())]), set: m(&[("body", "edited".into())]) },
                Change::Insert { values: m(&[("body", "new".into())]) },
                Change::Delete { key: m(&[("id", 2.into())]) },
            ];
            p.apply("main", "notes", &ok).await.unwrap();
            let bad = vec![
                Change::Update { key: m(&[("id", 1.into())]), set: m(&[("body", "SHOULD ROLL BACK".into())]) },
                Change::Delete { key: m(&[("id", 999.into())]) },
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
    async fn mongo() {
        if std::env::var("DBDOCK_IT").is_err() { return; }
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
    async fn edit() {
        if std::env::var("DBDOCK_IT").is_err() { return; }
        edit_and_cancel(&cfg(Kind::Mysql, "127.0.0.1", 13306, "root", "shop"), pw("rootpw"), "shop", "SELECT SLEEP(10)").await;
        edit_and_cancel(&cfg(Kind::Postgres, "127.0.0.1", 15432, "postgres", "shop"), pw("pgpw"), "public", "SELECT pg_sleep(10)").await;
        let mut lite = cfg(Kind::Sqlite, "", 0, "", "");
        lite.file = "/tmp/dbdock-test.sqlite".into();
        edit_and_cancel(&lite, Secrets::default(), "main", "").await;
    }
}
