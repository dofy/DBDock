use serde_json::Value;
use tauri::State;

use crate::sessions::{Conn, Session};
use crate::{AppState, CmdResult, err, mongo_db};

fn mongo(s: &Session) -> CmdResult<&mongo_db::MongoConn> {
    match &s.conn {
        Conn::Mongo(m) => Ok(m),
        _ => Err("not a MongoDB session".into()),
    }
}

#[tauri::command]
pub(crate) async fn mongo_databases(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<Vec<String>> {
    let s = state.sessions.get(&session_id)?;
    mongo(&s)?.databases().await.map_err(err)
}

#[tauri::command]
pub(crate) async fn mongo_collections(
    state: State<'_, AppState>,
    session_id: String,
    db: String,
) -> CmdResult<Vec<String>> {
    let s = state.sessions.get(&session_id)?;
    mongo(&s)?.collections(&db).await.map_err(err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn mongo_find(
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
    let s = state.sessions.get(&session_id)?;
    mongo(&s)?
        .find(&db, &coll, filter, sort, projection, skip, limit)
        .await
        .map_err(err)
}

#[tauri::command]
pub(crate) async fn mongo_count(
    state: State<'_, AppState>,
    session_id: String,
    db: String,
    coll: String,
    filter: Option<Value>,
) -> CmdResult<u64> {
    let s = state.sessions.get(&session_id)?;
    mongo(&s)?.count(&db, &coll, filter).await.map_err(err)
}

#[tauri::command]
pub(crate) async fn mongo_insert(
    state: State<'_, AppState>,
    session_id: String,
    db: String,
    coll: String,
    doc: Value,
) -> CmdResult<Value> {
    let s = state.sessions.get(&session_id)?;
    mongo(&s)?.insert(&db, &coll, doc).await.map_err(err)
}

#[tauri::command]
pub(crate) async fn mongo_replace(
    state: State<'_, AppState>,
    session_id: String,
    db: String,
    coll: String,
    id: Value,
    doc: Value,
) -> CmdResult<()> {
    let s = state.sessions.get(&session_id)?;
    mongo(&s)?.replace(&db, &coll, id, doc).await.map_err(err)
}

#[tauri::command]
pub(crate) async fn mongo_delete(
    state: State<'_, AppState>,
    session_id: String,
    db: String,
    coll: String,
    ids: Vec<Value>,
) -> CmdResult<u64> {
    let s = state.sessions.get(&session_id)?;
    mongo(&s)?.delete(&db, &coll, ids).await.map_err(err)
}

#[tauri::command]
pub(crate) async fn mongo_indexes(
    state: State<'_, AppState>,
    session_id: String,
    db: String,
    coll: String,
) -> CmdResult<Vec<Value>> {
    let s = state.sessions.get(&session_id)?;
    mongo(&s)?.indexes(&db, &coll).await.map_err(err)
}

#[tauri::command]
pub(crate) async fn mongo_shell(
    state: State<'_, AppState>,
    session_id: String,
    db: String,
    line: String,
) -> CmdResult<mongo_db::ShellResult> {
    let s = state.sessions.get(&session_id)?;
    mongo(&s)?.shell(&db, &line).await.map_err(err)
}
