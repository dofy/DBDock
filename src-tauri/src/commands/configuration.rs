use std::path::Path;

use serde::Serialize;
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

#[derive(Serialize)]
pub(crate) struct ParsedConnectionUrl {
    config: ConnectionConfig,
    password: Option<String>,
}

#[tauri::command]
pub(crate) fn parse_connection_url(url: String) -> CmdResult<ParsedConnectionUrl> {
    let url = url.trim();
    let invalid = "Enter one supported connection URL.";
    if url.is_empty() || url.contains(char::is_whitespace) {
        return Err(invalid.into());
    }
    // The underlying parser also serves bulk imports and may include the input in errors.
    let (mut config, password) = sources::from_url(url, None).map_err(|_| invalid.to_string())?;
    config.id.clear();
    Ok(ParsedConnectionUrl { config, password })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connection_url_creates_an_unsaved_draft() {
        let draft = parse_connection_url("postgres://user:p%40ss@localhost:6543/lab".into())
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(draft.config.id.is_empty() && draft.config.group.is_empty());
        assert_eq!(draft.config.database, "lab");
        assert_eq!(draft.config.port, 6543);
        assert_eq!(draft.password.as_deref(), Some("p@ss"));
    }

    #[test]
    fn connection_url_errors_do_not_echo_credentials_or_accept_batches() {
        for url in [
            "postgres://user:example@host:invalid/lab",
            "postgres://host/first\npostgres://host/second",
            "DATABASE_URL=postgres://host/lab",
            "rediss://host:6380",
        ] {
            assert_eq!(
                parse_connection_url(url.into()).err().as_deref(),
                Some("Enter one supported connection URL.")
            );
        }
    }
}
