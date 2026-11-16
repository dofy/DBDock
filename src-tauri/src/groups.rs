//! Connection groups ("folders"). A group is a path such as "Acme / AI"; the
//! connections carry it in `group`. Empty groups are kept in `groups.json` so a
//! freshly created folder survives until something is moved into it.

use std::collections::BTreeSet;
use std::path::PathBuf;

use anyhow::{bail, Result};

use crate::store::Store;

pub const SEP: &str = " / ";

/// Trim each segment and drop empty ones: " a /  b/" -> "a / b".
pub fn normalize(path: &str) -> String {
    path.split('/').map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(SEP)
}

fn is_within(group: &str, root: &str) -> bool {
    group == root || group.starts_with(&format!("{root}{SEP}"))
}

fn reparent(group: &str, from: &str, to: &str) -> String {
    normalize(&format!("{to}{}", &group[from.len()..]))
}

pub struct Groups {
    path: PathBuf,
}

impl Groups {
    pub fn new(dir: PathBuf) -> Self {
        Self { path: dir.join("groups.json") }
    }

    fn explicit(&self) -> BTreeSet<String> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
            .unwrap_or_default()
            .into_iter()
            .collect()
    }

    fn write(&self, set: &BTreeSet<String>) -> Result<()> {
        if let Some(d) = self.path.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::write(&self.path, serde_json::to_string_pretty(&set.iter().collect::<Vec<_>>())?)?;
        Ok(())
    }

    /// Every group, including the parents of nested ones, sorted.
    pub fn list(&self, store: &Store) -> Result<Vec<String>> {
        let mut all = self.explicit();
        for c in store.list()? {
            if !c.group.is_empty() {
                all.insert(normalize(&c.group));
            }
        }
        let mut out = BTreeSet::new();
        for g in all {
            let parts: Vec<&str> = g.split(SEP).collect();
            for i in 1..=parts.len() {
                out.insert(parts[..i].join(SEP));
            }
        }
        Ok(out.into_iter().collect())
    }

    pub fn create(&self, path: &str) -> Result<String> {
        let p = normalize(path);
        if p.is_empty() {
            bail!("group name is empty");
        }
        let mut set = self.explicit();
        set.insert(p.clone());
        self.write(&set)?;
        Ok(p)
    }

    /// Rename or move a group with its subgroups and connections; returns connections moved.
    pub fn rename(&self, store: &Store, from: &str, to: &str) -> Result<usize> {
        let (from, to) = (normalize(from), normalize(to));
        if from.is_empty() || to.is_empty() {
            bail!("group name is empty");
        }
        if is_within(&to, &from) && to != from {
            bail!("cannot move a group into itself");
        }
        let set: BTreeSet<String> = self.explicit().into_iter().map(|g| if is_within(&g, &from) { reparent(&g, &from, &to) } else { g }).collect();
        let mut set = set;
        set.insert(to.clone());
        self.write(&set)?;
        store.update_groups(|g| is_within(g, &from).then(|| reparent(g, &from, &to)))
    }

    /// Delete a group and its subgroups; their connections move to `move_to` ("" = ungrouped).
    pub fn delete(&self, store: &Store, path: &str, move_to: &str) -> Result<usize> {
        let (path, move_to) = (normalize(path), normalize(move_to));
        if is_within(&move_to, &path) {
            bail!("pick a target outside the group being deleted");
        }
        let set: BTreeSet<String> = self.explicit().into_iter().filter(|g| !is_within(g, &path)).collect();
        self.write(&set)?;
        store.update_groups(|g| is_within(g, &path).then(|| move_to.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(normalize(" Acme /AI/ "), "Acme / AI");
        assert!(is_within("Acme / AI", "Acme"));
        assert!(!is_within("Acmex", "Acme"));
        assert_eq!(reparent("Acme / AI / x", "Acme / AI", "Work"), "Work / x");
    }

    #[test]
    fn rename_delete_move() {
        let dir = std::env::temp_dir().join(format!("dbdock-groups-{}", uuid::Uuid::new_v4()));
        let store = Store::new(dir.clone());
        let groups = Groups::new(dir.clone());
        let mk = |id: &str, g: &str| -> crate::store::ConnectionConfig {
            serde_json::from_value(serde_json::json!({"id": id, "name": id, "kind": "sqlite", "group": g})).unwrap()
        };
        store.upsert_many(vec![mk("a", "Acme / AI"), mk("b", "Acme"), mk("c", "Other"), mk("d", "")]).unwrap();
        groups.create("Empty / Sub").unwrap();
        assert_eq!(groups.list(&store).unwrap(), ["Acme", "Acme / AI", "Empty", "Empty / Sub", "Other"]);
        assert_eq!(groups.rename(&store, "Acme", "Work / Acme").unwrap(), 2);
        assert!(groups.rename(&store, "Work", "Work / Acme / x").is_err());
        let g = |id: &str| store.get(id).unwrap().group;
        assert_eq!((g("a"), g("b")), ("Work / Acme / AI".to_string(), "Work / Acme".to_string()));
        assert_eq!(groups.delete(&store, "Work", "Other").unwrap(), 2);
        assert_eq!((g("a"), g("b")), ("Other".to_string(), "Other".to_string()));
        assert_eq!(store.move_to_group(&["c".into(), "d".into()], " New/ x ").unwrap(), 2);
        assert_eq!(g("d"), "New / x");
        assert_eq!(groups.list(&store).unwrap(), ["Empty", "Empty / Sub", "New", "New / x", "Other"]);
        std::fs::remove_dir_all(dir).ok();
    }
}
