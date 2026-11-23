//! Native app menu. Items with an id are forwarded to the UI as a `menu` event
//! carrying that id; a few (editing ~/.ssh/config) are handled here.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

pub const GITHUB: &str = "https://github.com/dofy/DBDock";

#[cfg(target_os = "macos")]
fn numbered_tab_action(key_code: u16, command: bool, control: bool, shift: bool, option: bool) -> Option<String> {
    if shift || option || command == control { return None; }
    let slot = match key_code {
        18 => 1, 19 => 2, 20 => 3, 21 => 4, 23 => 5, 22 => 6, 26 => 7, 28 => 8, 25 => 9,
        _ => return None,
    };
    Some(format!("{}-slot-{slot}", if control { "session" } else { "database" }))
}

/// Observe modifier flags and numbered shortcuts before AppKit dispatches them.
/// WKWebView may not receive modifier events or key presses when focus changes.
#[cfg(target_os = "macos")]
pub fn observe_tab_modifiers<R: Runtime>(app: &AppHandle<R>) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    use std::ptr::NonNull;
    use tauri::Manager;

    let app = app.clone();
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let e = unsafe { event.as_ref() };
        let flags = e.modifierFlags();
        let command = flags.contains(NSEventModifierFlags::Command);
        let control = flags.contains(NSEventModifierFlags::Control);
        if e.r#type() == NSEventType::FlagsChanged {
            let modifier = match (command, control) {
                (true, false) => "cmd",
                (false, true) => "ctrl",
                _ => "none",
            };
            let _ = app.emit("tab-modifier", modifier);
        } else if e.r#type() == NSEventType::KeyDown
            && app.get_webview_window("main").is_some_and(|w| w.is_focused().unwrap_or(false))
        {
            let action = numbered_tab_action(e.keyCode(), command, control,
                flags.contains(NSEventModifierFlags::Shift), flags.contains(NSEventModifierFlags::Option));
            if let Some(action) = action {
                let _ = app.emit("menu", action);
                return std::ptr::null_mut();
            }
        }
        event.as_ptr()
    });
    // AppKit copies the block and keeps the monitor active until app exit.
    if let Some(monitor) = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::FlagsChanged | NSEventMask::KeyDown, &block) } {
        std::mem::forget(monitor);
    }
}

fn item<R: Runtime>(app: &AppHandle<R>, id: &str, text: &str, accel: Option<&str>) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, text, true, accel)
}

fn label<'a>(language: &str, english: &'a str) -> &'a str {
    let texts = match english {
        "About DBDock" => ["关于 DBDock", "關於 DBDock", "DBDock について"],
        "Settings…" => ["设置…", "設定…", "設定…"],
        "File" => ["文件", "檔案", "ファイル"],
        "New Connection…" => ["新建连接…", "新增連線…", "新規接続…"],
        "Format SQL" => ["格式化 SQL", "格式化 SQL", "SQL を整形"],
        "Focus SQL Editor" => ["聚焦 SQL 编辑器", "聚焦 SQL 編輯器", "SQL エディターにフォーカス"],
        "New SQL Tab" => ["新建 SQL 标签页", "新增 SQL 分頁", "SQL タブを新規作成"],
        "Close Tab or Connection" => ["关闭标签页或连接", "關閉分頁或連線", "タブまたは接続を閉じる"],
        "New Group…" => ["新建分组…", "新增群組…", "新規グループ…"],
        "Import…" => ["导入…", "匯入…", "インポート…"],
        "New Connection from URL…" => ["从 URL 新增连接…", "從 URL 新增連線…", "URL から新規接続…"],
        "Export…" => ["导出…", "匯出…", "エクスポート…"],
        "SSH Hosts…" => ["SSH 主机…", "SSH 主機…", "SSH ホスト…"],
        "Close Connection" => ["关闭连接", "關閉連線", "接続を閉じる"],
        "Edit" => ["编辑", "編輯", "編集"], "View" => ["显示", "顯示", "表示"],
        "Connections" => ["连接", "連線", "接続"],
        "Quick Switch…" => ["快速切换…", "快速切換…", "クイック切替…"],
        "Command Palette…" => ["命令面板…", "命令面板…", "コマンドパレット…"],
        "Search Connections" => ["搜索连接", "搜尋連線", "接続を検索"],
        "Reload" => ["重新加载", "重新載入", "再読み込み"],
        "Next Session" => ["下一个会话", "下一個工作階段", "次のセッション"],
        "Next Database Tab" => ["下一个数据库标签页", "下一個資料庫分頁", "次のデータベースタブ"],
        "Previous Database Tab" => ["上一个数据库标签页", "上一個資料庫分頁", "前のデータベースタブ"],
        "Previous Session" => ["上一个会话", "上一個工作階段", "前のセッション"],
        "Window" => ["窗口", "視窗", "ウインドウ"],
        "Close Window" => ["关闭窗口", "關閉視窗", "ウインドウを閉じる"],
        "Help" => ["帮助", "說明", "ヘルプ"],
        "DBDock Help" => ["DBDock 帮助", "DBDock 說明", "DBDock ヘルプ"],
        "DBDock on GitHub" => ["DBDock 的 GitHub 页面", "DBDock 的 GitHub 頁面", "GitHub の DBDock"],
        "Hide DBDock" => ["隐藏 DBDock", "隱藏 DBDock", "DBDock を隠す"],
        "Hide Others" => ["隐藏其他应用", "隱藏其他應用程式", "ほかを隠す"],
        "Show All" => ["显示全部", "顯示全部", "すべてを表示"],
        "Quit DBDock" => ["退出 DBDock", "結束 DBDock", "DBDock を終了"],
        "Undo" => ["撤销", "復原", "取り消す"], "Redo" => ["重做", "重做", "やり直す"],
        "Cut" => ["剪切", "剪下", "カット"], "Copy" => ["复制", "複製", "コピー"],
        "Paste" => ["粘贴", "貼上", "ペースト"], "Select All" => ["全选", "全選", "すべてを選択"],
        "Enter Full Screen" => ["进入全屏幕", "進入全螢幕", "フルスクリーンにする"],
        "Minimize" => ["最小化", "最小化", "しまう"], "Zoom" => ["缩放", "縮放", "拡大／縮小"],
        _ => return english,
    };
    match language { "zh-CN" => texts[0], "zh-TW" => texts[1], "ja" => texts[2], _ => english }
}

pub fn build<R: Runtime>(app: &AppHandle<R>, language: &str) -> tauri::Result<Menu<R>> {
    let sep = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        "DBDock",
        true,
        &[
            &item(app, "about", label(language, "About DBDock"), None)?,
            &sep()?,
            &item(app, "settings", label(language, "Settings…"), Some("CmdOrCtrl+,"))?,
            &sep()?,
            &PredefinedMenuItem::hide(app, Some(label(language, "Hide DBDock")))?,
            &PredefinedMenuItem::hide_others(app, Some(label(language, "Hide Others")))?,
            &PredefinedMenuItem::show_all(app, Some(label(language, "Show All")))?,
            &sep()?,
            &item(app, "quit-app", label(language, "Quit DBDock"), Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        label(language, "File"),
        true,
        &[
            &item(app, "new-connection", label(language, "New Connection…"), Some("CmdOrCtrl+N"))?,
            &item(app, "new-connection-url", label(language, "New Connection from URL…"), Some("CmdOrCtrl+Shift+I"))?,
            &item(app, "new-group", label(language, "New Group…"), Some("CmdOrCtrl+Shift+N"))?,
            &item(app, "new-sql-tab", label(language, "New SQL Tab"), Some("CmdOrCtrl+T"))?,
            &item(app, "focus-sql-editor", label(language, "Focus SQL Editor"), Some("CmdOrCtrl+L"))?,
            &item(app, "close-database-tab", label(language, "Close Tab or Connection"), Some("CmdOrCtrl+W"))?,
            &sep()?,
            &item(app, "import", label(language, "Import…"), Some("CmdOrCtrl+O"))?,
            &item(app, "export", label(language, "Export…"), Some("CmdOrCtrl+Shift+E"))?,
            &sep()?,
            &item(app, "ssh-hosts", label(language, "SSH Hosts…"), Some("CmdOrCtrl+Shift+H"))?,
            &sep()?,
            &item(app, "close-tab", label(language, "Close Connection"), Some("CmdOrCtrl+Alt+W"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        label(language, "Edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(label(language, "Undo")))?,
            &PredefinedMenuItem::redo(app, Some(label(language, "Redo")))?,
            &sep()?,
            &PredefinedMenuItem::cut(app, Some(label(language, "Cut")))?,
            &PredefinedMenuItem::copy(app, Some(label(language, "Copy")))?,
            &PredefinedMenuItem::paste(app, Some(label(language, "Paste")))?,
            &PredefinedMenuItem::select_all(app, Some(label(language, "Select All")))?,
            &sep()?,
            &item(app, "format-sql", label(language, "Format SQL"), Some("CmdOrCtrl+I"))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        label(language, "View"),
        true,
        &[
            &item(app, "quick-switch", label(language, "Quick Switch…"), Some("CmdOrCtrl+K"))?,
            &item(app, "command-palette", label(language, "Command Palette…"), Some("CmdOrCtrl+Shift+P"))?,
            &sep()?,
            &item(app, "home", label(language, "Connections"), None)?,
            &item(app, "find", label(language, "Search Connections"), Some("CmdOrCtrl+F"))?,
            &item(app, "reload", label(language, "Reload"), Some("CmdOrCtrl+R"))?,
            &sep()?,
            &item(app, "next-tab", label(language, "Next Session"), Some("Ctrl+Tab"))?,
            &item(app, "prev-tab", label(language, "Previous Session"), Some("Ctrl+Shift+Tab"))?,
            &item(app, "next-database-tab", label(language, "Next Database Tab"), Some("CmdOrCtrl+Alt+Right"))?,
            &item(app, "prev-database-tab", label(language, "Previous Database Tab"), Some("CmdOrCtrl+Alt+Left"))?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, Some(label(language, "Enter Full Screen")))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        label(language, "Window"),
        true,
        &[&PredefinedMenuItem::minimize(app, Some(label(language, "Minimize")))?, &PredefinedMenuItem::maximize(app, Some(label(language, "Zoom")))?, &sep()?, &PredefinedMenuItem::close_window(app, Some(label(language, "Close Window")))?],
    )?;
    let help = Submenu::with_items(
        app,
        label(language, "Help"),
        true,
        &[&item(app, "help", label(language, "DBDock Help"), Some("CmdOrCtrl+?"))?, &sep()?, &item(app, "github", label(language, "DBDock on GitHub"), None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "github" => open_github(),
        "help" => {
            let _ = open_help(app, None);
        }
        "command-palette" | "quick-switch" | "new-sql-tab" | "focus-sql-editor" | "format-sql" | "close-tab" => {
            use tauri::Manager;
            if app.get_webview_window("main").is_some_and(|w| w.is_focused().unwrap_or(false)) {
                let _ = app.emit("menu", id);
            }
        }
        // ⌘W closes a focused secondary window or delegates to the main workspace.
        "close-database-tab" => {
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

#[cfg(test)]
mod tests {
    use super::label;

    #[test]
    fn menu_labels_follow_selected_language() {
        assert_eq!(label("en", "File"), "File");
        assert_eq!(label("zh-CN", "File"), "文件");
        assert_eq!(label("zh-TW", "File"), "檔案");
        assert_eq!(label("ja", "File"), "ファイル");
        assert_eq!(label("unknown", "File"), "File");
        assert_eq!(label("ja", "custom"), "custom");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn numbered_shortcuts_use_only_the_requested_modifier() {
        use super::numbered_tab_action;
        assert_eq!(numbered_tab_action(18, false, true, false, false).as_deref(), Some("session-slot-1"));
        assert_eq!(numbered_tab_action(19, true, false, false, false).as_deref(), Some("database-slot-2"));
        assert_eq!(numbered_tab_action(25, false, true, false, false).as_deref(), Some("session-slot-9"));
        assert_eq!(numbered_tab_action(18, true, false, true, false), None);
        assert_eq!(numbered_tab_action(18, true, true, false, false), None);
        assert_eq!(numbered_tab_action(0, true, false, false, false), None);
    }
}
