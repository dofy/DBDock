use std::path::Path;

use tauri::State;

use crate::store::{ConnectionConfig, SecretsInput};
use crate::{AppState, CmdResult, err, import, sources, transfer};

#[tauri::command]
pub(crate) fn list_connections(state: State<'_, AppState>) -> CmdResult<Vec<ConnectionConfig>> {
    state.store.list().map_err(err)
}

#[tauri::command]
pub(crate) fn save_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    secrets: SecretsInput,
) -> CmdResult<ConnectionConfig> {
    state.store.save(config, &secrets).map_err(err)
}

#[tauri::command]
pub(crate) fn delete_connection(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.store.delete(&id).map_err(err)
}

#[tauri::command]
pub(crate) fn delete_connections(state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<usize> {
    for id in &ids {
        state.store.delete(id).map_err(err)?;
    }
    Ok(ids.len())
}

#[tauri::command]
pub(crate) fn detect_import_file(path: String) -> CmdResult<sources::Detected> {
    sources::detect(Path::new(&path)).map_err(err)
}

#[tauri::command]
pub(crate) fn import_file(
    state: State<'_, AppState>,
    path: String,
    passphrase: Option<String>,
) -> CmdResult<sources::Report> {
    sources::import_file(&state.store, Path::new(&path), passphrase).map_err(err)
}

#[tauri::command]
pub(crate) fn import_text(state: State<'_, AppState>, text: String) -> CmdResult<sources::Report> {
    sources::import_text(&state.store, &text).map_err(err)
}

/// Connections.plist of an installed TablePlus, offered as a one-click source.
#[tauri::command]
pub(crate) fn tableplus_file() -> Option<String> {
    import::tableplus_file().map(|p| p.display().to_string())
}

#[tauri::command]
pub(crate) fn export_connections(
    state: State<'_, AppState>,
    path: String,
    ids: Option<Vec<String>>,
    include_secrets: bool,
    passphrase: Option<String>,
) -> CmdResult<usize> {
    transfer::export(
        &state.store,
        Path::new(&path),
        ids,
        include_secrets,
        passphrase,
    )
    .map_err(err)
}

#[tauri::command]
pub(crate) fn inspect_connections_file(path: String) -> CmdResult<transfer::FileInfo> {
    transfer::inspect(Path::new(&path)).map_err(err)
}

#[tauri::command]
pub(crate) fn import_connections(
    state: State<'_, AppState>,
    path: String,
    passphrase: Option<String>,
) -> CmdResult<transfer::TransferReport> {
    transfer::import(&state.store, Path::new(&path), passphrase).map_err(err)
}
