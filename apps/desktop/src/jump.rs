//! Pure bounded jump catalog. No transport, actions, private review marks or history.
use crate::local_model::{Chat, Project};
use std::sync::{Arc, Weak};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};
pub(crate) const GROUP_LIMIT: usize = 6;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Destination {
    Home,
    Inbox,
    Chats,
    Overview(String),
    Project(String),
    Chat(String),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Kind {
    Page,
    Project,
    Chat,
}
impl Kind {
    pub(crate) fn title(self, suggested: bool) -> &'static str {
        match self {
            Self::Page => "Pages",
            Self::Project => "Projects",
            Self::Chat if suggested => "Recent chats",
            Self::Chat => "Chats",
        }
    }
}
#[derive(Clone)]
pub(crate) struct Snapshot {
    pub(crate) chats: Arc<Vec<Chat>>,
    pub(crate) projects: Arc<Vec<Project>>,
    pub(crate) scope: Option<String>,
    pub(crate) selected: Option<String>,
    pub(crate) loaded: bool,
    pub(crate) projects_error: bool,
}
impl Snapshot {
    pub(crate) fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.chats, &other.chats)
            && Arc::ptr_eq(&self.projects, &other.projects)
            && self.scope == other.scope
            && self.selected == other.selected
            && self.loaded == other.loaded
            && self.projects_error == other.projects_error
    }
}
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Query {
    pub(crate) text: String,
    too_long: bool,
}
impl Query {
    pub(crate) fn new(value: &str) -> Self {
        Self {
            text: crate::navigation::bounded_query(value),
            too_long: value.chars().take(241).count() > 240,
        }
    }
}
pub(crate) struct Entry {
    pub(crate) id: String,
    pub(crate) destination: Destination,
    pub(crate) kind: Kind,
    pub(crate) title: String,
    pub(crate) detail: String,
    pub(crate) attention: bool,
    folded_title: String,
    keywords: Vec<String>,
    suggested: bool,
}
impl Entry {
    fn new(
        id: String,
        destination: Destination,
        kind: Kind,
        title: String,
        detail: String,
        keywords: Vec<String>,
        suggested: bool,
    ) -> Self {
        Self {
            id,
            destination,
            kind,
            folded_title: fold(&title),
            keywords: keywords.iter().map(|s| fold(s)).collect(),
            title,
            detail,
            suggested,
            attention: false,
        }
    }
}
pub(crate) struct Catalog {
    pub(crate) entries: Vec<Entry>,
    chats: Weak<Vec<Chat>>,
    projects: Weak<Vec<Project>>,
    scope: Option<String>,
    selected: Option<String>,
}
pub(crate) struct Group {
    pub(crate) kind: Kind,
    pub(crate) rows: Vec<usize>,
}
pub(crate) struct Matches {
    pub(crate) groups: Vec<Group>,
    pub(crate) suggested: bool,
    pub(crate) error: Option<&'static str>,
}
impl Catalog {
    pub(crate) fn same(&self, s: &Snapshot) -> bool {
        self.chats.ptr_eq(&Arc::downgrade(&s.chats))
            && self.projects.ptr_eq(&Arc::downgrade(&s.projects))
            && self.scope == s.scope
            && self.selected == s.selected
    }
    // Invoked off the UI thread. Weak allocation identities cannot alias a reused
    // address and do not retain the full summary/cwd payload in the catalog.
    pub(crate) fn new(s: &Snapshot) -> Self {
        let mut entries = vec![
            Entry::new(
                "page:home".into(),
                Destination::Home,
                Kind::Page,
                "Home".into(),
                "All projects · overview".into(),
                vec!["overview".into()],
                true,
            ),
            Entry::new(
                "page:inbox".into(),
                Destination::Inbox,
                Kind::Page,
                "Inbox".into(),
                "Loaded Local attention".into(),
                vec!["attention".into(), "needs you".into()],
                true,
            ),
            Entry::new(
                "page:chats".into(),
                Destination::Chats,
                Kind::Page,
                "All chats".into(),
                "Global loaded chat browser".into(),
                vec!["conversations".into()],
                true,
            ),
        ];
        if let Some(p) = s
            .projects
            .iter()
            .take(256)
            .find(|p| Some(&p.id) == s.scope.as_ref())
        {
            entries.push(Entry::new(
                format!("page:overview:{}", p.id),
                Destination::Overview(p.id.clone()),
                Kind::Page,
                format!("{} overview", p.name),
                "Current project overview".into(),
                vec!["project".into()],
                true,
            ));
        }
        for p in s
            .projects
            .iter()
            .take(256)
            .filter(|p| Some(&p.id) != s.scope.as_ref())
        {
            entries.push(Entry::new(
                format!("project:{}", p.id),
                Destination::Project(p.id.clone()),
                Kind::Project,
                p.name.clone(),
                "Switch project scope".into(),
                vec!["project".into()],
                true,
            ));
        }
        let mut recent = 0;
        for c in s.chats.iter().take(1000).filter(|c| !c.local_draft) {
            let project = c
                .project_id
                .as_ref()
                .and_then(|id| s.projects.iter().take(256).find(|p| &p.id == id))
                .map(|p| p.name.as_str())
                .unwrap_or(if c.project_id.is_some() {
                    "Project unavailable"
                } else {
                    "No project"
                });
            let state = if c.archived {
                "Archived"
            } else if !c.writable {
                "Read-only"
            } else {
                c.signal_label()
            };
            let suggested =
                !c.archived && c.writable && s.selected.as_ref() != Some(&c.id) && recent < 3;
            recent += usize::from(suggested);
            let mut entry = Entry::new(
                format!("chat:{}", c.id),
                Destination::Chat(c.id.clone()),
                Kind::Chat,
                c.title.clone(),
                format!("{project} · {state}"),
                vec![project.into(), state.into()],
                suggested,
            );
            entry.attention = !c.archived
                && matches!(
                    c.signal,
                    Some(crate::dither::Signal::Failed | crate::dither::Signal::NeedsYou)
                );
            entries.push(entry);
        }
        Self {
            entries,
            chats: Arc::downgrade(&s.chats),
            projects: Arc::downgrade(&s.projects),
            scope: s.scope.clone(),
            selected: s.selected.clone(),
        }
    }
    pub(crate) fn search(&self, query: &Query) -> Matches {
        if query.too_long {
            return Matches {
                groups: vec![],
                suggested: false,
                error: Some("Use up to240 search characters."),
            };
        }
        let query = fold(query.text.trim());
        let tokens: Vec<_> = query.split_whitespace().collect();
        if tokens.len() > 32 {
            return Matches {
                groups: vec![],
                suggested: false,
                error: Some("Use up to32 search words."),
            };
        }
        let suggested = tokens.is_empty();
        let mut groups: Vec<(Kind, Vec<(usize, i32)>)> = vec![];
        for (ix, e) in self.entries.iter().enumerate() {
            let score = if suggested {
                e.suggested.then_some(0)
            } else {
                tokens
                    .iter()
                    .try_fold(0, |total, token| {
                        let mut best = level(token, &e.folded_title) * 2;
                        for word in &e.keywords {
                            best = best.max(level(token, word));
                        }
                        (best > 0).then_some(total + best)
                    })
                    .map(|score| score + if e.folded_title == query { 4 } else { 0 })
            };
            let Some(score) = score else { continue };
            if let Some((_, rows)) = groups.iter_mut().find(|(kind, _)| *kind == e.kind) {
                rows.push((ix, score));
            } else {
                groups.push((e.kind, vec![(ix, score)]));
            }
        }
        for (_, rows) in &mut groups {
            rows.sort_by_key(|(ix, score)| (std::cmp::Reverse(*score), *ix));
        }
        let group_score = |(kind, rows): &(Kind, Vec<(usize, i32)>)| {
            let (ix, score) = rows[0];
            score
                - i32::from(
                    !suggested && *kind == Kind::Chat && self.entries[ix].folded_title != query,
                )
        };
        groups.sort_by_key(|group| (std::cmp::Reverse(group_score(group)), group.0));
        Matches {
            groups: groups
                .into_iter()
                .map(|(kind, rows)| Group {
                    kind,
                    rows: rows
                        .into_iter()
                        .take(GROUP_LIMIT)
                        .map(|(ix, _)| ix)
                        .collect(),
                })
                .collect(),
            suggested,
            error: None,
        }
    }
}
fn fold(text: &str) -> String {
    text.nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .collect()
}
fn level(token: &str, text: &str) -> i32 {
    let mut best = 0;
    for (ix, _) in text.match_indices(token) {
        if ix == 0 {
            return 3;
        }
        if !text[..ix]
            .chars()
            .next_back()
            .is_some_and(char::is_alphanumeric)
        {
            return 2;
        }
        best = 1;
    }
    best
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn snapshot() -> Snapshot {
        Snapshot {projects:Arc::new(crate::local_model::projects(&json!([{"id":"a","name":"Résumé","path":"/same"},{"id":"b","name":"Atlas","path":"/same"}])).unwrap()),chats:Arc::new([
            json!({"id":"current","title":"Current","state":"idle"}),
            json!({"id":"prefix","title":"Atlas notes","state":"idle","projectId":"a"}),
            json!({"id":"exact","title":"Atlas","state":"idle"}),
            json!({"id":"archived","title":"Old notes","state":"idle","archivedAt":1}),
        ].iter().map(|v|crate::local_model::chat(v).unwrap()).collect()),scope:None,selected:Some("current".into()),loaded:true,projects_error:false}
    }
    #[test]
    fn resource_priority_exact_chat_unicode_and_archives() {
        let s = snapshot();
        let c = Catalog::new(&s);
        let empty = c.search(&Query::new(""));
        assert_eq!(empty.groups[0].kind, Kind::Page);
        assert_eq!(empty.groups[1].kind, Kind::Project);
        assert!(
            empty
                .groups
                .iter()
                .flat_map(|g| &g.rows)
                .all(|ix| c.entries[*ix].id != "chat:archived"
                    && c.entries[*ix].id != "chat:current")
        );
        let atlas = c.search(&Query::new("Atlas"));
        assert_eq!(
            atlas.groups[0].kind,
            Kind::Project,
            "equally exact resource precedes chat"
        );
        assert_eq!(c.entries[atlas.groups[1].rows[0]].id, "chat:exact");
        let prefix = c.search(&Query::new("Atlas no"));
        assert_eq!(c.entries[prefix.groups[0].rows[0]].id, "chat:prefix");
        let unicode = c.search(&Query::new("ＲＥＳＵＭＥ"));
        assert_eq!(c.entries[unicode.groups[0].rows[0]].id, "project:a");
        let archive = c.search(&Query::new("archived notes"));
        assert_eq!(c.entries[archive.groups[0].rows[0]].id, "chat:archived");
        assert!(c.search(&Query::new(&"x".repeat(241))).error.is_some());
        assert!(c.search(&Query::new(&"a ".repeat(33))).error.is_some());
    }
    #[test]
    fn bounded_catalog_matches_and_weak_source_fences() {
        let mut s = snapshot();
        s.projects = Arc::new(
            (0..256)
                .map(|i| Project {
                    id: format!("p{i}"),
                    name: format!("Project {i}"),
                    path: "/same".into(),
                })
                .collect(),
        );
        s.chats=Arc::new((0..1000).map(|i|crate::local_model::chat(&json!({"id":format!("c{i}"),"title":format!("Conversation {i}"),"state":"idle"})).unwrap()).collect());
        let c = Catalog::new(&s);
        assert_eq!(c.entries.len(), 1259);
        assert!(c.same(&s));
        let results = c.search(&Query::new(""));
        assert!(results.groups.iter().all(|g| g.rows.len() <= 6));
        let old = Arc::downgrade(&s.chats);
        s.chats = Arc::new(vec![]);
        assert!(!c.same(&s));
        assert!(
            old.upgrade().is_none(),
            "catalog must not retain summary/cwd payloads"
        );
        assert_eq!(c.entries[3].destination, Destination::Project("p0".into()));
    }
}
