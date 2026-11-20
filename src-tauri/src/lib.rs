mod commands;
mod d1;
mod groups;
mod menu;
mod import;
mod mongo_db;
mod redis_db;
mod sql;
mod sql_browser;
mod sql_plan;
mod sql_protection;
mod sql_schema;
mod sql_transfer;
mod sessions;
mod sources;
mod ssh;
mod ssh_config;
mod ssh_config_edit;
mod ssh_terminal;
mod store;
mod transfer;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{Emitter, Manager};

use sessions::Sessions;
use store::{Kind, Store};

type CmdResult<T> = Result<T, String>;

/// Join the error chain, skipping causes already repeated in the outer message
/// (sqlx errors embed their source in Display).
fn err(e: anyhow::Error) -> String {
    let mut out = String::new();
    for cause in e.chain() {
        let msg = cause.to_string();
        if out.contains(&msg) {
            continue;
        }
        if !out.is_empty() {
            out.push_str(": ");
        }
        out.push_str(&msg);
    }
    out
}

pub(crate) fn default_port(kind: Kind) -> u16 {
    match kind {
        Kind::Mysql => 3306,
        Kind::Postgres => 5432,
        Kind::Redis => 6379,
        Kind::Mongodb => 27017,
        Kind::Sqlite | Kind::D1 => 0,
    }
}

struct AppState {
    store: Store,
    groups: groups::Groups,
    sessions: Sessions,
    browser_requests: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
}

/// Before the rename to DBDock (xyz.phpz.app.dbdock) data lived under net.yahaha.dbdock.
/// Copy connections and groups once; passwords are re-imported (Keychain entries are
/// bound to the old signature and would prompt on every read).
fn migrate_legacy_data(dir: &std::path::Path) {
    let old = store::expand_tilde("~/Library/Application Support/net.yahaha.dbdock");
    if dir.join("connections.json").exists() || !old.join("connections.json").exists() {
        return;
    }
    let _ = std::fs::create_dir_all(dir);
    for f in ["connections.json", "groups.json"] {
        if old.join(f).exists() {
            let _ = std::fs::copy(old.join(f), dir.join(f));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .menu(|app| menu::build(app, "en"))
        .on_menu_event(|app, e| menu::handle(app, e.id().as_ref()))
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            migrate_legacy_data(&dir);
            let store = Store::new(dir.clone());
            app.manage(AppState { store, groups: groups::Groups::new(dir), sessions: Sessions::default(), browser_requests: Mutex::new(HashMap::new()) });
            #[cfg(target_os = "macos")]
            menu::observe_tab_modifiers(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::configuration::list_connections,
            commands::connections::check_saved_connection,
            commands::configuration::save_connection,
            commands::configuration::delete_connection,
            commands::configuration::detect_import_file,
            commands::configuration::import_file,
            commands::configuration::import_text,
            commands::configuration::tableplus_file,
            commands::configuration::export_connections,
            commands::configuration::inspect_connections_file,
            commands::configuration::import_connections,
            commands::ssh::ssh_config_hosts,
            commands::app::open_help,
            commands::app::open_github,
            commands::app::set_menu_language,
            commands::app::confirm_quit,
            commands::ssh::ssh_hosts_list,
            commands::ssh::ssh_host_save,
            commands::ssh::ssh_host_delete,
            commands::ssh::ssh_host_open_terminal,
            commands::ssh::ssh_config_raw,
            commands::ssh::ssh_config_write,
            commands::ssh::ssh_host_test,
            commands::groups::list_groups,
            commands::groups::create_group,
            commands::groups::rename_group,
            commands::groups::delete_group,
            commands::groups::move_connections,
            commands::configuration::delete_connections,
            commands::connections::test_connection,
            commands::connections::begin_connect,
            commands::connections::cancel_connect,
            commands::connections::connect,
            commands::connections::disconnect,
            commands::sql::files::read_sql_file,
            commands::sql::files::read_table_file,
            commands::sql::files::write_sql_file,
            commands::sql::browser::sql_schemas,
            commands::sql::browser::sql_databases,
            commands::sql::browser::sql_tables,
            commands::sql::browser::begin_browser_request,
            commands::sql::browser::cancel_browser_request,
            commands::sql::browser::sql_structure,
            commands::sql::browser::sql_table_metadata,
            commands::sql::browser::sql_table_data,
            commands::sql::sql_needs_confirmation,
            commands::sql::sql_execute,
            commands::sql::sql_execution_plan,
            commands::sql::sql_completion_session,
            commands::sql::sql_cancel,
            commands::sql::sql_columns,
            commands::sql::sql_completion_foreign_keys,
            commands::sql::browser::sql_preview_changes,
            commands::sql::browser::sql_apply_changes,
            commands::sql::browser::sql_preview_schema,
            commands::sql::browser::sql_apply_schema,
            commands::sql::browser::sql_import_rows,
            commands::sql::browser::sql_export_table,
            commands::redis::redis_scan,
            commands::redis::redis_get,
            commands::redis::redis_delete,
            commands::redis::redis_command,
            commands::redis::redis_select,
            commands::mongo::mongo_databases,
            commands::mongo::mongo_collections,
            commands::mongo::mongo_find,
            commands::mongo::mongo_count,
            commands::mongo::mongo_insert,
            commands::mongo::mongo_replace,
            commands::mongo::mongo_delete,
            commands::mongo::mongo_indexes,
            commands::mongo::mongo_shell,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                if app.get_webview_window("main").is_some() {
                    api.prevent_exit();
                    let _ = app.emit("menu", "quit-app");
                }
            }
        });
}

#[cfg(test)]
mod it;
