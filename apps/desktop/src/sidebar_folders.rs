//! Project folders (e.g. Work, Personal): your own grouping of projects, kept
//! in the private sidebar memory on this machine only. A folder is a scope in
//! the sidebar's project picker; it never changes a project or chat.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use unicode_segmentation::UnicodeSegmentation;

/// Longest folder name, in user-perceived characters.
pub(crate) const NAME_MAX: usize = 60;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Folders {
    /// Folder names in your order.
    #[serde(default)]
    pub(crate) names: Vec<String>,
    /// Each filed project's folder, by project id. A project sits in one folder.
    #[serde(default)]
    pub(crate) projects: HashMap<String, String>,
}

/// A folder name with whitespace collapsed, at most NAME_MAX characters.
pub(crate) fn clean(name: &str) -> Option<String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    (!name.is_empty()).then(|| name.graphemes(true).take(NAME_MAX).collect())
}

impl Folders {
    fn find(&self, name: &str) -> Option<usize> {
        let name = name.to_lowercase();
        self.names.iter().position(|n| n.to_lowercase() == name)
    }
    pub(crate) fn contains(&self, name: &str) -> bool {
        self.names.iter().any(|n| n == name)
    }
    /// Add a folder; None when the name is empty or already used.
    pub(crate) fn add(&mut self, name: &str) -> Option<String> {
        let name = clean(name)?;
        if self.find(&name).is_some() {
            return None;
        }
        self.names.push(name.clone());
        Some(name)
    }
    /// Rename a folder, keeping its projects. False when the new name is empty
    /// or another folder's.
    pub(crate) fn rename(&mut self, old: &str, new: &str) -> bool {
        let (Some(ix), Some(new)) = (self.names.iter().position(|n| n == old), clean(new)) else {
            return false;
        };
        if self.find(&new).is_some_and(|other| other != ix) {
            return false;
        }
        for folder in self.projects.values_mut().filter(|f| *f == old) {
            *folder = new.clone();
        }
        self.names[ix] = new;
        true
    }
    /// Remove a folder; its projects become unfiled.
    pub(crate) fn remove(&mut self, name: &str) {
        self.names.retain(|n| n != name);
        self.projects.retain(|_, f| f != name);
    }
    /// File a project in a folder, or unfile it with None.
    pub(crate) fn assign(&mut self, project: &str, folder: Option<&str>) {
        match folder.filter(|f| self.contains(f)) {
            Some(folder) => {
                self.projects.insert(project.to_owned(), folder.to_owned());
            }
            None => {
                self.projects.remove(project);
            }
        }
    }
    pub(crate) fn folder_of(&self, project: &str) -> Option<&str> {
        self.projects.get(project).map(String::as_str)
    }
    pub(crate) fn holds(&self, folder: &str, project: Option<&str>) -> bool {
        project.is_some_and(|p| self.folder_of(p) == Some(folder))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_add_rename_assign_and_remove() {
        let mut f = Folders::default();
        assert_eq!(f.add("  Work   stuff "), Some("Work stuff".into()));
        assert_eq!(f.add("work STUFF"), None, "names are unique, ignoring case");
        assert_eq!(f.add("   "), None);
        assert_eq!(f.add("Personal"), Some("Personal".into()));
        f.assign("pilot", Some("Personal"));
        f.assign("infra", Some("Work stuff"));
        f.assign("ghost", Some("Missing"));
        assert_eq!(
            f.folder_of("ghost"),
            None,
            "only existing folders hold projects"
        );
        assert!(f.rename("Work stuff", "Work"));
        assert_eq!(f.folder_of("infra"), Some("Work"));
        assert!(!f.rename("Work", "personal"), "another folder's name");
        assert!(f.rename("Work", "WORK"), "a case change of the same folder");
        assert_eq!(f.names, ["WORK", "Personal"]);
        f.remove("Personal");
        assert_eq!(f.folder_of("pilot"), None);
        assert!(f.holds("WORK", Some("infra")));
        assert!(!f.holds("WORK", None));
        f.assign("infra", None);
        assert!(f.projects.is_empty());
    }

    #[test]
    fn long_unicode_names_keep_whole_characters() {
        let name = "👩‍💻".repeat(NAME_MAX + 5);
        let clean = clean(&name).unwrap();
        assert_eq!(clean.graphemes(true).count(), NAME_MAX);
        assert!(clean.graphemes(true).all(|g| g == "👩‍💻"));
    }
}
