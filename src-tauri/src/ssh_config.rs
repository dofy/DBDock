//! Minimal ~/.ssh/config reader: Host blocks with HostName, User, Port and
//! IdentityFile. Like OpenSSH, the first value found for a key wins, and Host
//! patterns may use `*`, `?` and `!negation`. Include and Match are ignored.

use std::path::PathBuf;

use crate::store::expand_tilde;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Resolved {
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_files: Vec<String>,
}

struct Block {
    patterns: Vec<String>,
    entries: Vec<(String, String)>,
}

fn path() -> PathBuf {
    expand_tilde("~/.ssh/config")
}

fn parse(text: &str) -> Vec<Block> {
    let mut blocks = vec![Block { patterns: vec!["*".into()], entries: vec![] }];
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.trim().to_ascii_lowercase(), v.trim().trim_start_matches('=').trim().trim_matches('"').to_string()),
            None => continue,
        };
        match key.as_str() {
            "host" => blocks.push(Block { patterns: value.split_whitespace().map(String::from).collect(), entries: vec![] }),
            // Match blocks are not evaluated; skip their contents.
            "match" => blocks.push(Block { patterns: vec![], entries: vec![] }),
            _ => blocks.last_mut().unwrap().entries.push((key, value)),
        }
    }
    blocks
}

fn glob(pattern: &str, s: &str) -> bool {
    fn rec(p: &[u8], s: &[u8]) -> bool {
        match (p.first(), s.first()) {
            (None, None) => true,
            (Some(b'*'), _) => rec(&p[1..], s) || (!s.is_empty() && rec(p, &s[1..])),
            (Some(b'?'), Some(_)) => rec(&p[1..], &s[1..]),
            (Some(a), Some(b)) if a.eq_ignore_ascii_case(b) => rec(&p[1..], &s[1..]),
            _ => false,
        }
    }
    rec(pattern.as_bytes(), s.as_bytes())
}

fn block_matches(patterns: &[String], host: &str) -> bool {
    let mut hit = false;
    for p in patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if glob(neg, host) {
                return false;
            }
        } else if glob(p, host) {
            hit = true;
        }
    }
    hit
}

fn resolve_in(text: &str, alias: &str) -> Resolved {
    let mut r = Resolved::default();
    for b in parse(text).iter().filter(|b| block_matches(&b.patterns, alias)) {
        for (k, v) in &b.entries {
            match k.as_str() {
                "hostname" if r.host_name.is_none() => r.host_name = Some(v.replace("%h", alias)),
                "user" if r.user.is_none() => r.user = Some(v.clone()),
                "port" if r.port.is_none() => r.port = v.parse().ok(),
                "identityfile" => r.identity_files.push(v.clone()),
                _ => {}
            }
        }
    }
    r
}

pub fn resolve(alias: &str) -> Resolved {
    std::fs::read_to_string(path()).map(|t| resolve_in(&t, alias)).unwrap_or_default()
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HostEntry {
    pub alias: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

/// Concrete Host aliases (no wildcards) with what each resolves to.
pub fn hosts() -> Vec<HostEntry> {
    let Ok(text) = std::fs::read_to_string(path()) else { return vec![] };
    let mut seen = std::collections::HashSet::new();
    parse(&text)
        .into_iter()
        .flat_map(|b| b.patterns)
        .filter(|p| !p.contains(['*', '?', '!']) && seen.insert(p.clone()))
        .map(|alias| {
            let r = resolve_in(&text, &alias);
            HostEntry { host_name: r.host_name, user: r.user, port: r.port, identity_file: r.identity_files.into_iter().next(), alias }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CFG: &str = "
Host bastion
    User deploy
    HostName 203.0.113.10
    ForwardAgent yes

Host bastion-*
    Port 2222
    IdentityFile ~/.ssh/bastion

Host *
    User fallback
    IdentityFile ~/.ssh/id_rsa
";

    #[test]
    fn resolves_alias_and_wildcards() {
        let r = resolve_in(CFG, "bastion");
        assert_eq!(r.host_name.as_deref(), Some("203.0.113.10"));
        assert_eq!(r.user.as_deref(), Some("deploy"));
        assert_eq!(r.port, None);
        let r = resolve_in(CFG, "bastion-eu");
        assert_eq!((r.port, r.user.as_deref()), (Some(2222), Some("fallback")));
        assert_eq!(r.identity_files, vec!["~/.ssh/bastion", "~/.ssh/id_rsa"]);
        assert_eq!(resolve_in(CFG, "10.0.0.1").host_name, None);
    }
}
