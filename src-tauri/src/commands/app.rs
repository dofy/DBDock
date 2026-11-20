use crate::{CmdResult, menu};

#[tauri::command]
pub(crate) fn open_help(app: tauri::AppHandle, section: Option<String>) -> CmdResult<()> {
    menu::open_help(&app, section.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn confirm_quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub(crate) fn set_menu_language(app: tauri::AppHandle, language: String) -> CmdResult<()> {
    let menu = menu::build(&app, &language).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn open_github() {
    menu::open_github();
}
