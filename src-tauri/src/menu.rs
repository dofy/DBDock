//! Native app menu. Items with an id are forwarded to the UI as a `menu` event
//! carrying that id; a few (editing ~/.ssh/config) are handled here.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

pub const GITHUB: &str = "https://github.com/dofy/DBDock";

fn item<R: Runtime>(app: &AppHandle<R>, id: &str, text: &str, accel: Option<&str>) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, text, true, accel)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let sep = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        "DBDock",
        true,
        &[
            &item(app, "about", "About DBDock", None)?,
            &sep()?,
            &item(app, "settings", "Settings…", Some("CmdOrCtrl+,"))?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item(app, "new-connection", "New Connection…", Some("CmdOrCtrl+N"))?,
            &item(app, "new-group", "New Group…", Some("CmdOrCtrl+Shift+N"))?,
            &sep()?,
            &item(app, "import", "Import…", Some("CmdOrCtrl+O"))?,
            &item(app, "import-urls", "Paste Connection URLs…", Some("CmdOrCtrl+Shift+I"))?,
            &item(app, "export", "Export…", Some("CmdOrCtrl+Shift+E"))?,
            &sep()?,
            &item(app, "ssh-hosts", "SSH Hosts…", Some("CmdOrCtrl+Shift+H"))?,
            &sep()?,
            &item(app, "close-tab", "Close Tab", Some("CmdOrCtrl+W"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item(app, "home", "Connections", Some("CmdOrCtrl+1"))?,
            &item(app, "find", "Search Connections", Some("CmdOrCtrl+F"))?,
            &item(app, "reload", "Reload", Some("CmdOrCtrl+R"))?,
            &sep()?,
            &item(app, "next-tab", "Next Session", Some("CmdOrCtrl+Alt+Right"))?,
            &item(app, "prev-tab", "Previous Session", Some("CmdOrCtrl+Alt+Left"))?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?, &sep()?, &PredefinedMenuItem::close_window(app, Some("Close Window"))?],
    )?;
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[&item(app, "help", "DBDock Help", Some("CmdOrCtrl+?"))?, &sep()?, &item(app, "github", "DBDock on GitHub", None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "github" => open_github(),
        "help" => {
            let _ = open_help(app, None);
        }
        // ⌘W closes a secondary window (Help) when it has focus; in the main window it
        // closes the current session tab.
        "close-tab" => {
            use tauri::Manager;
            if let Some(w) = app.webview_windows().into_values().find(|w| w.label() != "main" && w.is_focused().unwrap_or(false)) {
                let _ = w.close();
            } else {
                let _ = app.emit("menu", id);
            }
        }
        _ => {
            let _ = app.emit("menu", id);
        }
    }
}

pub fn open_github() {
    let _ = std::process::Command::new("open").arg(GITHUB).spawn();
}

/// The bundled help page (dist/help.html) in its own window; `section` is an anchor.
pub fn open_help<R: Runtime>(app: &AppHandle<R>, section: Option<&str>) -> tauri::Result<()> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    let page = match section.filter(|s| s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')) {
        Some(s) if !s.is_empty() => format!("help.html#{s}"),
        _ => "help.html".into(),
    };
    if let Some(w) = app.get_webview_window("help") {
        if section.is_some() {
            let _ = w.eval(&format!("location.hash = {:?}", section.unwrap_or_default()));
        }
        w.show()?;
        return w.set_focus();
    }
    WebviewWindowBuilder::new(app, "help", WebviewUrl::App(page.into()))
        .title("DBDock Help")
        .inner_size(980.0, 760.0)
        .min_inner_size(640.0, 480.0)
        .build()?;
    Ok(())
}
