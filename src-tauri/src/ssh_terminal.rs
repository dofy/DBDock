//! Open an SSH config alias in a supported macOS terminal.
use anyhow::{bail, Context, Result};

fn script(terminal: &str) -> Result<&'static str> {
    match terminal {
        "terminal" => Ok(r#"on run argv
set sshCommand to "/usr/bin/ssh -- " & quoted form of (item 1 of argv)
tell application id "com.apple.Terminal"
    activate
    do script sshCommand
end tell
end run"#),
        "iterm" => Ok(r#"on run argv
set sshCommand to "/usr/bin/ssh -- " & quoted form of (item 1 of argv)
tell application id "com.googlecode.iterm2"
    activate
    create window with default profile command sshCommand
end tell
end run"#),
        _ => bail!("Unsupported terminal application"),
    }
}

fn validate_alias(alias: &str, hosts: &[crate::ssh_config_edit::HostBlock]) -> Result<()> {
    if alias.is_empty() || alias.starts_with('-') || alias.chars().any(char::is_control)
        || !hosts.iter().any(|host| !host.pattern && host.form.alias == alias)
    {
        bail!("SSH host is not a saved single-host alias");
    }
    Ok(())
}

pub fn open(alias: &str, terminal: &str) -> Result<()> {
    let script = script(terminal)?;
    validate_alias(alias, &crate::ssh_config_edit::list()?)?;
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/osascript")
            .args(["-e", script, "--", alias])
            .output().context("Could not open terminal")?;
        if !output.status.success() {
            bail!("Could not open terminal: {}", String::from_utf8_lossy(&output.stderr).trim());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = script;
        bail!("Opening an SSH terminal is only supported on macOS")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh_config_edit::{HostBlock, HostForm};

    fn host(alias: &str, pattern: bool) -> HostBlock {
        HostBlock { form: HostForm { alias: alias.into(), ..Default::default() }, pattern, other: vec![], comments: vec![] }
    }

    #[test]
    fn only_saved_single_aliases_are_accepted() {
        let hosts = vec![host("example", false), host("*.example", true), host("-oBad", false), host("bad\nname", false)];
        assert!(validate_alias("example", &hosts).is_ok());
        for alias in ["missing", "*.example", "-oBad", "bad\nname", ""] {
            assert!(validate_alias(alias, &hosts).is_err());
        }
    }

    #[test]
    fn scripts_quote_the_argument_and_reject_unknown_terminals() {
        for terminal in ["terminal", "iterm"] {
            let script = script(terminal).unwrap();
            assert!(script.contains("quoted form of (item 1 of argv)"));
            assert!(script.contains("/usr/bin/ssh -- "));
        }
        assert!(script("other").is_err());
    }
}
