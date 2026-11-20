use tauri::State;

use crate::sessions::{SessionInfo, open_session};
use crate::store::{ConnectionConfig, Kind, SecretsInput};
use crate::{AppState, CmdResult, err, sql};

#[tauri::command]
pub(crate) async fn test_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    secrets: SecretsInput,
) -> CmdResult<String> {
    let resolved = state
        .store
        .resolve_secrets(&config.id, &secrets)
        .map_err(err)?;
    let (_session, version, _) = open_session(&config, resolved).await.map_err(err)?;
    Ok(version)
}

/// Test a saved connection without creating a workspace session.
#[tauri::command]
pub(crate) async fn check_saved_connection(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<()> {
    let cfg = state.store.get(&id).map_err(err)?;
    if cfg.kind == Kind::Sqlite {
        return tokio::time::timeout(
            std::time::Duration::from_secs(30),
            sql::check_sqlite_readonly(&cfg.file),
        )
        .await
        .map_err(|_| "connection check timed out".to_string())?
        .map_err(err);
    }
    let secrets = state
        .store
        .resolve_secrets(&id, &SecretsInput::default())
        .map_err(err)?;
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        open_session(&cfg, secrets),
    )
    .await
    .map_err(|_| "connection check timed out".to_string())?
    .map_err(err)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn begin_connect(state: State<'_, AppState>, attempt_id: String) -> CmdResult<()> {
    state.sessions.begin_connect(attempt_id)
}

#[tauri::command]
pub(crate) fn cancel_connect(state: State<'_, AppState>, attempt_id: String) {
    state.sessions.cancel_connect(&attempt_id);
}

#[tauri::command]
pub(crate) async fn connect(
    state: State<'_, AppState>,
    id: String,
    attempt_id: String,
    database: Option<String>,
) -> CmdResult<SessionInfo> {
    state
        .sessions
        .connect(&state.store, &id, &attempt_id, database)
        .await
}

#[tauri::command]
pub(crate) fn disconnect(state: State<'_, AppState>, session_id: String) {
    state.sessions.disconnect(&session_id);
}
