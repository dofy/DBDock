use serde_json::Value;
use tauri::State;

use crate::sessions::Session;
use crate::sql::{Change, QueryResult, SqlPool, TableData, TableInfo};
use crate::sql_browser::{TableFilter, TableMetadata};
use crate::sql_schema::SchemaChange;
use crate::sql_transfer::ExportFormat;
use crate::store::SqlProtection;
use crate::{AppState, CmdResult, err};

use super::sql_connection;

fn browser_pool(s: &Session) -> &SqlPool {
    let connection = sql_connection(s);
    connection.browser.as_ref().unwrap_or(&connection.pool)
}

fn check_browser_filter(s: &Session, filter: Option<&str>) -> CmdResult<()> {
    if filter.is_some_and(|f| !f.trim().is_empty()) && s.sql_protection != SqlProtection::Automatic {
        return Err("Use visual filters on protected connections".into());
    }
    Ok(())
}

// Each table read has its own cancellation token; closing one tab must not
// interrupt another tab or the SQL editor.
#[tauri::command]
pub(crate) fn begin_browser_request(
    state: State<'_, AppState>,
    request_id: String,
) -> CmdResult<()> {
    let mut requests = state.browser_requests.lock().unwrap();
    if requests.contains_key(&request_id) {
        return Err("browser request already exists".into());
    }
    let (sender, _) = tokio::sync::watch::channel(false);
    requests.insert(request_id, sender);
    Ok(())
}

#[tauri::command]
pub(crate) fn cancel_browser_request(state: State<'_, AppState>, request_id: String) {
    if let Some(sender) = state.browser_requests.lock().unwrap().remove(&request_id) {
        sender.send_replace(true);
    }
}

async fn browser_request<T>(
    state: &AppState,
    request_id: &str,
    operation: impl std::future::Future<Output = CmdResult<T>>,
) -> CmdResult<T> {
    let mut cancelled = {
        let requests = state.browser_requests.lock().unwrap();
        requests
            .get(request_id)
            .ok_or("browser request cancelled")?
            .subscribe()
    };
    let result = wait_for_browser_request(&mut cancelled, operation).await;
    state.browser_requests.lock().unwrap().remove(request_id);
    result
}

async fn wait_for_browser_request<T>(
    cancelled: &mut tokio::sync::watch::Receiver<bool>,
    operation: impl std::future::Future<Output = CmdResult<T>>,
) -> CmdResult<T> {
    if *cancelled.borrow() {
        return Err("browser request cancelled".into());
    }
    tokio::select! {
        biased;
        _ = cancelled.changed() => Err("browser request cancelled".into()),
        result = operation => result,
    }
}

#[tauri::command]
pub(crate) async fn sql_schemas(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<Vec<String>> {
    let s = state.sessions.sql(&session_id)?;
    browser_pool(&s).schemas().await.map_err(err)
}

#[tauri::command]
pub(crate) async fn sql_databases(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<Vec<String>> {
    let s = state.sessions.sql(&session_id)?;
    browser_pool(&s).databases().await.map_err(err)
}

#[tauri::command]
pub(crate) async fn sql_tables(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
) -> CmdResult<Vec<TableInfo>> {
    let s = state.sessions.sql(&session_id)?;
    browser_pool(&s).tables(&schema).await.map_err(err)
}

#[tauri::command]
pub(crate) async fn sql_structure(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    request_id: String,
) -> CmdResult<QueryResult> {
    browser_request(&state, &request_id, async {
        let s = state.sessions.sql(&session_id)?;
        browser_pool(&s)
            .structure(&schema, &table)
            .await
            .map_err(err)
    })
    .await
}

#[tauri::command]
pub(crate) async fn sql_table_metadata(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    kind: TableMetadata,
    request_id: String,
) -> CmdResult<QueryResult> {
    browser_request(&state, &request_id, async {
        let s = state.sessions.sql(&session_id)?;
        browser_pool(&s)
            .metadata(&schema, &table, kind)
            .await
            .map_err(err)
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn sql_table_data(
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
        let s = state.sessions.sql(&session_id)?;
        check_browser_filter(&s, filter.as_deref())?;
        let capture_versions = capture_versions && s.sql_protection != SqlProtection::BrowseOnly;
        browser_pool(&s)
            .table_data(
                &schema,
                &table,
                limit,
                offset,
                order_by,
                order_desc,
                filter,
                visual_filter,
                capture_versions,
            )
            .await
            .map_err(err)
    })
    .await
}

#[tauri::command]
pub(crate) async fn sql_table_count(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    filter: Option<String>,
    visual_filter: Option<TableFilter>,
    request_id: String,
) -> CmdResult<String> {
    browser_request(&state, &request_id, async {
        let s = state.sessions.sql(&session_id)?;
        check_browser_filter(&s, filter.as_deref())?;
        browser_pool(&s)
            .table_count(&schema, &table, filter, visual_filter)
            .await
            .map_err(err)
    })
    .await
}

#[tauri::command]
pub(crate) async fn sql_preview_changes(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    changes: Vec<Change>,
) -> CmdResult<Vec<String>> {
    let s = state.sessions.sql(&session_id)?;
    browser_pool(&s)
        .change_sql(&schema, &table, &changes)
        .await
        .map_err(err)
}

#[tauri::command]
pub(crate) async fn sql_apply_changes(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    changes: Vec<Change>,
    confirmed: bool,
) -> CmdResult<usize> {
    let s = state.sessions.sql(&session_id)?;
    s.sql_protection.check_execution(confirmed).map_err(err)?;
    browser_pool(&s)
        .apply(&schema, &table, &changes)
        .await
        .map_err(err)
}

#[tauri::command]
pub(crate) fn sql_preview_schema(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    change: SchemaChange,
) -> CmdResult<String> {
    let s = state.sessions.sql(&session_id)?;
    browser_pool(&s)
        .schema_sql(&schema, &table, &change)
        .map_err(err)
}

#[tauri::command]
pub(crate) async fn sql_apply_schema(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    change: SchemaChange,
    confirmed: bool,
) -> CmdResult<()> {
    let s = state.sessions.sql(&session_id)?;
    s.sql_protection.check_execution(confirmed).map_err(err)?;
    if matches!(&change, SchemaChange::Drop { .. }) && !confirmed {
        return Err("Confirm this SQL operation first".into());
    }
    let db = browser_pool(&s);
    let sql = db.schema_sql(&schema, &table, &change).map_err(err)?;
    db.apply_schema(sql).await.map_err(err)
}

#[tauri::command]
pub(crate) async fn sql_import_rows(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    confirmed: bool,
) -> CmdResult<usize> {
    let s = state.sessions.sql(&session_id)?;
    s.sql_protection.check_execution(confirmed).map_err(err)?;
    if !confirmed {
        return Err("Confirm this SQL operation first".into());
    }
    browser_pool(&s)
        .import_rows(&schema, &table, columns, rows)
        .await
        .map_err(err)
}

#[tauri::command]
pub(crate) async fn sql_export_table(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    path: String,
    format: ExportFormat,
    request_id: String,
) -> CmdResult<u64> {
    browser_request(&state, &request_id, async {
        let s = state.sessions.sql(&session_id)?;
        browser_pool(&s)
            .export_table(&schema, &table, std::path::Path::new(&path), format)
            .await
            .map_err(err)
    })
    .await
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn browser_cancellation_drops_only_its_own_read() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        struct DropFlag(Arc<AtomicBool>);
        impl Drop for DropFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let (sender, mut receiver) = tokio::sync::watch::channel(false);
        let (_other_sender, mut other_receiver) = tokio::sync::watch::channel(false);
        let dropped = Arc::new(AtomicBool::new(false));
        let flag = DropFlag(dropped.clone());
        let task = tokio::spawn(async move {
            super::wait_for_browser_request(&mut receiver, async move {
                let _flag = flag;
                std::future::pending::<super::CmdResult<()>>().await
            })
            .await
        });
        tokio::task::yield_now().await;
        sender.send_replace(true);
        assert_eq!(
            task.await.unwrap().unwrap_err(),
            "browser request cancelled"
        );
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(
            super::wait_for_browser_request(&mut other_receiver, async { Ok(42) })
                .await
                .unwrap(),
            42
        );
        let mut already_cancelled = sender.subscribe();
        assert!(
            super::wait_for_browser_request(&mut already_cancelled, async { Ok(()) })
                .await
                .is_err()
        );
    }
}
