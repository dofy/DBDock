use tauri::State;

use crate::{AppState, CmdResult, err};

#[tauri::command]
pub(crate) fn list_groups(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    state.groups.list(&state.store).map_err(err)
}

#[tauri::command]
pub(crate) fn create_group(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    state.groups.create(&path).map_err(err)
}

#[tauri::command]
pub(crate) fn rename_group(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> CmdResult<usize> {
    state.groups.rename(&state.store, &from, &to).map_err(err)
}

#[tauri::command]
pub(crate) fn delete_group(
    state: State<'_, AppState>,
    path: String,
    move_to: String,
) -> CmdResult<usize> {
    state
        .groups
        .delete(&state.store, &path, &move_to)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn move_connections(
    state: State<'_, AppState>,
    ids: Vec<String>,
    group: String,
) -> CmdResult<usize> {
    state.store.move_to_group(&ids, &group).map_err(err)
}
