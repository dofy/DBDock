use crate::store::{SshAuth, SshConfig};
use crate::{CmdResult, err, ssh, ssh_config, ssh_config_edit, ssh_terminal};

#[tauri::command]
pub(crate) fn ssh_hosts_list() -> CmdResult<Vec<ssh_config_edit::HostBlock>> {
    ssh_config_edit::list().map_err(err)
}

#[tauri::command]
pub(crate) fn ssh_host_save(
    original: Option<String>,
    form: ssh_config_edit::HostForm,
) -> CmdResult<()> {
    ssh_config_edit::save(original, form).map_err(err)
}

#[tauri::command]
pub(crate) fn ssh_host_delete(alias: String) -> CmdResult<()> {
    ssh_config_edit::delete(&alias).map_err(err)
}

#[tauri::command]
pub(crate) async fn ssh_host_open_terminal(alias: String, terminal: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || ssh_terminal::open(&alias, &terminal).map_err(err))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn ssh_config_raw() -> CmdResult<String> {
    ssh_config_edit::raw().map_err(err)
}

#[tauri::command]
pub(crate) fn ssh_config_write(text: String) -> CmdResult<()> {
    ssh_config_edit::write_raw(&text).map_err(err)
}

/// Log in to an SSH host (no tunnel) to check address, user and key.
#[tauri::command]
pub(crate) async fn ssh_host_test(alias: String, password: Option<String>) -> CmdResult<String> {
    let cfg = SshConfig {
        enabled: true,
        host: alias,
        port: 22,
        user: String::new(),
        auth: if password.is_some() {
            SshAuth::Password
        } else {
            SshAuth::Key
        },
        key_path: String::new(),
    };
    let t = ssh::open(&cfg, password, None, "127.0.0.1".into(), 22)
        .await
        .map_err(err)?;
    drop(t);
    Ok("SSH login OK".into())
}

/// Host aliases from ~/.ssh/config, offered in the SSH host field.
#[tauri::command]
pub(crate) fn ssh_config_hosts() -> Vec<ssh_config::HostEntry> {
    ssh_config::hosts()
}
