//! Integration tests against live database servers.
//! From `src-tauri`, run a test with `DBDOCK_IT=1 cargo test it::smoke -- --ignored --nocapture`.

use std::collections::BTreeMap;

use crate::err;
use crate::sessions::{Conn, open_session};
use crate::sql::Change;
use crate::store::{ConnectionConfig, Kind, Secrets, SshAuth, SshConfig};

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
