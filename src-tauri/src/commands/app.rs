use crate::{CmdResult, menu};

#[tauri::command]
pub(crate) fn open_help(app: tauri::AppHandle, section: Option<String>) -> CmdResult<()> {
    menu::open_help(&app, section.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn supports_app_updates() -> bool {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64", not(debug_assertions))) {
        return false;
    }
    std::env::current_exe().ok().is_some_and(|path| {
        path.ancestors().nth(3).is_some_and(|bundle| {
            bundle.extension().is_some_and(|extension| extension == "app")
                && bundle.join("Contents/Info.plist").is_file()
        })
    })
}

#[tauri::command]
pub(crate) fn confirm_quit(app: tauri::AppHandle, restart: Option<bool>) {
    if restart == Some(true) {
        app.request_restart();
    } else {
        app.exit(0);
    }
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
