pub(crate) mod browser;
pub(crate) mod files;

use tauri::State;

use crate::sql::{CompletionColumn, CompletionSession, QueryExecution, SqlConn};
use crate::sql_browser::CompletionForeignKey;
use crate::sql_plan::{ExecutionPlan, PlanMode};
use crate::store::SqlProtection;
use crate::{AppState, CmdResult, Conn, Session, err, sql_protection};

fn sql_connection(session: &Session) -> &SqlConn {
    let Conn::Sql(connection) = &session.conn else {
        unreachable!()
    };
    connection
}

#[tauri::command]
pub(crate) fn sql_needs_confirmation(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
) -> CmdResult<bool> {
    let s = state.sql(&session_id)?;
    Ok(s.sql_protection == SqlProtection::Confirm
        && sql_protection::needs_confirmation(&sql, sql_connection(&s).pool.dialect()))
}

#[tauri::command]
pub(crate) async fn sql_execute(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    confirmed: bool,
) -> CmdResult<QueryExecution> {
    let s = state.sql(&session_id)?;
    let pool = &sql_connection(&s).pool;
    let metadata_changed = sql_protection::needs_confirmation(&sql, pool.dialect());
    if s.sql_protection != SqlProtection::Confirm || (!confirmed && metadata_changed) {
        s.sql_protection.check_execution(confirmed).map_err(err)?;
    }
    let results = pool.execute(sql).await.map_err(err)?;
    Ok(QueryExecution {
        results,
        metadata_changed,
    })
}

#[tauri::command]
pub(crate) async fn sql_execution_plan(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    mode: PlanMode,
    confirmed: bool,
) -> CmdResult<ExecutionPlan> {
    let s = state.sql(&session_id)?;
    sql_connection(&s)
        .pool
        .execution_plan(&sql, mode, s.sql_protection, confirmed)
        .await
        .map_err(err)
}

#[tauri::command]
pub(crate) async fn sql_cancel(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    let s = state.sql(&session_id)?;
    sql_connection(&s).cancel().await.map_err(err)
}

#[tauri::command]
pub(crate) async fn sql_completion_session(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<CompletionSession> {
    let s = state.sql(&session_id)?;
    sql_connection(&s)
        .pool
        .completion_session()
        .await
        .map_err(err)
}

#[tauri::command]
pub(crate) async fn sql_columns(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
) -> CmdResult<std::collections::BTreeMap<String, Vec<CompletionColumn>>> {
    let s = state.sql(&session_id)?;
    sql_connection(&s).pool.columns(&schema).await.map_err(err)
}

#[tauri::command]
pub(crate) async fn sql_completion_foreign_keys(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
) -> CmdResult<Vec<CompletionForeignKey>> {
    let s = state.sql(&session_id)?;
    sql_connection(&s)
        .pool
        .completion_foreign_keys(&schema, &table)
        .await
        .map_err(err)
}
