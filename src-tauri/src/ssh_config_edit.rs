//! Line-preserving editor for ~/.ssh/config.
//!
//! Only the lines of the managed keys (Host, HostName, User, Port, IdentityFile,
//! ProxyJump) inside the target block change; comments, unknown directives,
//! indentation and every other block stay byte-for-byte. Each write first copies
//! the current file to `~/.ssh/config.dbdock-<timestamp>.bak` and keeps its mode.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::store::expand_tilde;

const MANAGED: [&str; 5] = ["hostname", "user", "port", "identityfile", "proxyjump"];

fn path() -> PathBuf {
    expand_tilde("~/.ssh/config")
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HostForm {
    pub alias: String,
    pub host_name: String,
    pub user: String,
    pub port: String,
    pub identity_file: String,
    pub proxy_jump: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostBlock {
    #[serde(flatten)]
    pub form: HostForm,
    /// `Host a b` or contains wildcards: shown, editable only as raw text.
    pub pattern: bool,
    /// Directives dbdock does not manage, shown read-only (`ForwardAgent yes`, …).
    pub other: Vec<String>,
    /// Comment lines inside the block.
    pub comments: Vec<String>,
}

/// A `Host` block's line range [start, end) in the file.
struct Span {
    patterns: Vec<String>,
    start: usize,
    end: usize,
}

fn key_of(line: &str) -> Option<(String, String)> {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') {
        return None;
    }
    let (k, v) = t.split_once(|c: char| c.is_whitespace() || c == '=')?;
    Some((k.to_ascii_lowercase(), v.trim().trim_start_matches('=').trim().trim_matches('"').to_string()))
}

fn spans(lines: &[&str]) -> Vec<Span> {
    let mut out: Vec<Span> = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        if let Some((k, v)) = key_of(l) {
            if k == "host" || k == "match" {
                if let Some(last) = out.last_mut() {
                    last.end = i;
                }
                out.push(Span { patterns: if k == "host" { v.split_whitespace().map(String::from).collect() } else { vec![] }, start: i, end: lines.len() });
            }
        }
    }
    // Trailing blank / comment lines belong to the gap before the next block.
    for s in out.iter_mut() {
        while s.end > s.start + 1 && lines[s.end - 1].trim().is_empty() {
            s.end -= 1;
        }
    }
    out
}

fn read() -> Result<String> {
    match std::fs::read_to_string(path()) {
        Ok(t) => Ok(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e).context("read ~/.ssh/config"),
    }
}

pub fn raw() -> Result<String> {
    read()
}

pub fn list() -> Result<Vec<HostBlock>> {
    let text = read()?;
    let lines: Vec<&str> = text.lines().collect();
    Ok(spans(&lines)
        .into_iter()
        .filter(|s| !s.patterns.is_empty())
        .map(|s| {
            let mut form = HostForm { alias: s.patterns.join(" "), ..Default::default() };
            let (mut other, mut comments) = (vec![], vec![]);
            for l in &lines[s.start + 1..s.end] {
                let t = l.trim();
                if t.starts_with('#') {
                    comments.push(t.to_string());
                    continue;
                }
                let Some((k, v)) = key_of(l) else { continue };
                let slot = match k.as_str() {
                    "hostname" => &mut form.host_name,
                    "user" => &mut form.user,
                    "port" => &mut form.port,
                    "identityfile" => &mut form.identity_file,
                    "proxyjump" => &mut form.proxy_jump,
                    _ => {
                        other.push(t.to_string());
                        continue;
                    }
                };
                // First value wins, like ssh.
                if slot.is_empty() {
                    *slot = v;
                }
            }
            let pattern = s.patterns.len() > 1 || s.patterns.iter().any(|p| p.contains(['*', '?', '!']));
            HostBlock { form, pattern, other, comments }
        })
        .collect())
}

fn backup_and_write(new_text: &str) -> Result<()> {
    let p = path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&p).map(|m| {
        #[cfg(unix)]
        {
            m.permissions().mode()
        }
        #[cfg(not(unix))]
        {
            let _ = m;
            0o600
        }
    });
    if p.exists() {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let bak = p.with_file_name(format!("config.dbdock-{stamp}.bak"));
        std::fs::copy(&p, &bak).with_context(|| format!("backup to {}", bak.display()))?;
    }
    let tmp = p.with_file_name("config.dbdock-tmp");
    std::fs::write(&tmp, new_text)?;
    #[cfg(unix)]
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode.unwrap_or(0o600) & 0o777))?;
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

pub fn write_raw(text: &str) -> Result<()> {
    backup_and_write(text)
}

fn validate(f: &HostForm) -> Result<()> {
    let a = f.alias.trim();
    if a.is_empty() || a.contains(char::is_whitespace) || a.contains(['*', '?', '!', '#']) {
        bail!("alias must be one word without wildcards");
    }
    if !f.port.trim().is_empty() && f.port.trim().parse::<u16>().is_err() {
        bail!("port must be a number");
    }
    for v in [&f.host_name, &f.user, &f.identity_file, &f.proxy_jump] {
        if v.contains('\n') {
            bail!("values cannot contain line breaks");
        }
    }
    Ok(())
}

fn value_of<'a>(f: &'a HostForm, key: &str) -> &'a str {
    match key {
        "hostname" => f.host_name.trim(),
        "user" => f.user.trim(),
        "port" => f.port.trim(),
        "identityfile" => f.identity_file.trim(),
        "proxyjump" => f.proxy_jump.trim(),
        _ => "",
    }
}

fn display_key(key: &str) -> &'static str {
    match key {
        "hostname" => "HostName",
        "user" => "User",
        "port" => "Port",
        "identityfile" => "IdentityFile",
        _ => "ProxyJump",
    }
}

fn quote(v: &str) -> String {
    if v.contains(' ') { format!("\"{v}\"") } else { v.to_string() }
}

/// Create (`original` = None) or update a block; returns the new file text.
pub fn apply_save(text: &str, original: Option<&str>, f: &HostForm) -> Result<String> {
    validate(f)?;
    let lines: Vec<&str> = text.lines().collect();
    let sp = spans(&lines);
    let alias = f.alias.trim();
    let clash = sp.iter().any(|s| s.patterns.len() == 1 && s.patterns[0] == alias && Some(alias) != original);
    if clash {
        bail!("a Host named {alias} already exists");
    }
    let Some(orig) = original else {
        // New block at the end.
        let mut out = text.trim_end_matches('\n').to_string();
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&format!("Host {alias}\n"));
        for k in MANAGED {
            let v = value_of(f, k);
            if !v.is_empty() {
                out.push_str(&format!("    {} {}\n", display_key(k), quote(v)));
            }
        }
        return Ok(out);
    };
    let Some(s) = sp.iter().find(|s| s.patterns.len() == 1 && s.patterns[0] == orig) else {
        bail!("Host {orig} not found (the file changed?)");
    };
    let indent = lines[s.start + 1..s.end]
        .iter()
        .find(|l| key_of(l).is_some())
        .map(|l| l[..l.len() - l.trim_start().len()].to_string())
        .unwrap_or_else(|| "    ".into());
    let mut block: Vec<String> = Vec::new();
    // Host line: keep its indentation and any trailing comment-free form.
    let host_line = lines[s.start];
    let lead = &host_line[..host_line.len() - host_line.trim_start().len()];
    let kw = host_line.trim_start().split(|c: char| c.is_whitespace() || c == '=').next().unwrap_or("Host");
    block.push(format!("{lead}{kw} {alias}"));
    let mut done = std::collections::HashSet::new();
    for l in &lines[s.start + 1..s.end] {
        match key_of(l) {
            Some((k, _)) if MANAGED.contains(&k.as_str()) => {
                if done.contains(&k) {
                    // Later duplicates are ignored by ssh; keep them untouched.
                    block.push((*l).to_string());
                    continue;
                }
                done.insert(k.clone());
                let v = value_of(f, &k);
                if v.is_empty() {
                    continue; // cleared → drop the line
                }
                let l_indent = &l[..l.len() - l.trim_start().len()];
                let l_kw = l.trim_start().split(|c: char| c.is_whitespace() || c == '=').next().unwrap_or(display_key(&k));
                block.push(format!("{l_indent}{l_kw} {}", quote(v)));
            }
            _ => block.push((*l).to_string()),
        }
    }
    // Keys that were not in the block yet go right after the last directive line.
    let insert_at = block.iter().rposition(|l| key_of(l).is_some()).map(|i| i + 1).unwrap_or(block.len());
    let mut extra = Vec::new();
    for k in MANAGED {
        let v = value_of(f, k);
        if !v.is_empty() && !done.contains(k) {
            extra.push(format!("{indent}{} {}", display_key(k), quote(v)));
        }
    }
    block.splice(insert_at..insert_at, extra);
    let mut out: Vec<String> = lines[..s.start].iter().map(|l| l.to_string()).collect();
    out.extend(block);
    out.extend(lines[s.end..].iter().map(|l| l.to_string()));
    let mut t = out.join("\n");
    if text.ends_with('\n') {
        t.push('\n');
    }
    Ok(t)
}

pub fn apply_delete(text: &str, alias: &str) -> Result<String> {
    let lines: Vec<&str> = text.lines().collect();
    let sp = spans(&lines);
    let Some(s) = sp.iter().find(|s| s.patterns.len() == 1 && s.patterns[0] == alias) else {
        bail!("Host {alias} not found");
    };
    // Drop the block and the blank lines that followed it.
    let mut end = s.end;
    while end < lines.len() && lines[end].trim().is_empty() {
        end += 1;
    }
    let mut out: Vec<&str> = lines[..s.start].to_vec();
    out.extend(&lines[end..]);
    let mut t = out.join("\n");
    if text.ends_with('\n') && !t.is_empty() {
        t.push('\n');
    }
    Ok(t)
}

pub fn save(original: Option<String>, form: HostForm) -> Result<()> {
    let text = read()?;
    backup_and_write(&apply_save(&text, original.as_deref(), &form)?)
}

pub fn delete(alias: &str) -> Result<()> {
    let text = read()?;
    backup_and_write(&apply_delete(&text, alias)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CFG: &str = "# global\nServerAliveInterval 30\n\nHost bastion\n\tUser deploy\n\tHostName 203.0.113.10\n\tForwardAgent yes\n\t#SCETags Green\n\nHost web-*\n    User www\n\nHost Nano nano\n    HostName 192.168.1.1\n";

    /// Read-only: saving every Host unchanged must reproduce the real file exactly.
    #[test]
    fn real_config_roundtrip() {
        let text = read().unwrap();
        for h in list().unwrap().into_iter().filter(|h| !h.pattern) {
            let out = apply_save(&text, Some(&h.form.alias), &h.form).unwrap();
            println!("{:<14} other={} comments={} identical={}", h.form.alias, h.other.len(), h.comments.len(), out == text);
            assert_eq!(out, text, "round-trip changed {}", h.form.alias);
        }
    }

    #[test]
    fn list_and_edit_preserve_other_lines() {
        let f = HostForm { alias: "bastion".into(), host_name: "10.0.0.9".into(), user: "".into(), port: "2222".into(), identity_file: "~/.ssh/id rsa".into(), proxy_jump: "".into() };
        let out = apply_save(CFG, Some("bastion"), &f).unwrap();
        assert!(out.contains("\tHostName 10.0.0.9\n"), "{out}");
        assert!(!out.contains("User deploy"), "cleared user removed");
        // Other lines kept; new keys go after the last directive, before the block's trailing comment.
        assert!(out.contains("\tForwardAgent yes\n\tPort 2222\n\tIdentityFile \"~/.ssh/id rsa\"\n\t#SCETags Green\n"), "{out}");
        assert!(out.starts_with("# global\nServerAliveInterval 30\n\nHost bastion\n"));
        assert!(out.ends_with("Host Nano nano\n    HostName 192.168.1.1\n"));

        let renamed = apply_save(CFG, Some("bastion"), &HostForm { alias: "Flow".into(), host_name: "203.0.113.10".into(), user: "deploy".into(), ..Default::default() }).unwrap();
        assert!(renamed.contains("Host Flow\n\tUser deploy\n\tHostName 203.0.113.10\n\tForwardAgent yes"), "{renamed}");

        let added = apply_save(CFG, None, &HostForm { alias: "box".into(), host_name: "box.example.com".into(), user: "me".into(), ..Default::default() }).unwrap();
        assert!(added.ends_with("    HostName 192.168.1.1\n\nHost box\n    HostName box.example.com\n    User me\n"), "{added}");
        assert!(apply_save(CFG, None, &HostForm { alias: "bastion".into(), ..Default::default() }).is_err(), "duplicate alias");
        assert!(apply_save(CFG, None, &HostForm { alias: "a b".into(), ..Default::default() }).is_err());

        let del = apply_delete(CFG, "bastion").unwrap();
        assert_eq!(del, "# global\nServerAliveInterval 30\n\nHost web-*\n    User www\n\nHost Nano nano\n    HostName 192.168.1.1\n");
        assert!(apply_delete(CFG, "nano").is_err(), "multi-pattern blocks are raw-edit only");
    }
}
