use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::redis_db::{KeyValue, RedisConn, ScanPage};
use crate::{AppState, CmdResult, Conn, Session, err};

fn redis(s: &Session) -> CmdResult<&RedisConn> {
    match &s.conn {
        Conn::Redis(r) => Ok(r),
        _ => Err("not a Redis session".into()),
    }
}

#[tauri::command]
pub(crate) async fn redis_scan(
    state: State<'_, AppState>,
    session_id: String,
    cursor: u64,
    pattern: String,
    count: u32,
) -> CmdResult<ScanPage> {
    let s = state.session(&session_id)?;
    redis(&s)?.scan(cursor, &pattern, count).await.map_err(err)
}

#[tauri::command]
pub(crate) async fn redis_get(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
) -> CmdResult<KeyValue> {
    let s = state.session(&session_id)?;
    redis(&s)?.get(&key).await.map_err(err)
}

#[tauri::command]
pub(crate) async fn redis_delete(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
) -> CmdResult<i64> {
    let s = state.session(&session_id)?;
    redis(&s)?.delete(&key).await.map_err(err)
}

#[tauri::command]
pub(crate) async fn redis_command(
    state: State<'_, AppState>,
    session_id: String,
    line: String,
) -> CmdResult<Value> {
    let s = state.session(&session_id)?;
    redis(&s)?.command(&line).await.map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RedisDbInfo {
    db: i64,
    dbsize: i64,
}

#[tauri::command]
pub(crate) async fn redis_select(
    state: State<'_, AppState>,
    session_id: String,
    db: Option<i64>,
) -> CmdResult<RedisDbInfo> {
    let s = state.session(&session_id)?;
    let r = redis(&s)?;
    if let Some(db) = db {
        r.select(db).await.map_err(err)?;
    }
    Ok(RedisDbInfo {
        db: r.db().await,
        dbsize: r.dbsize().await.map_err(err)?,
    })
}
