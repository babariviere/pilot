//! Pure bounded jump catalog. No transport, actions, private review marks or history.
use crate::local_model::{Chat, Project};
use std::sync::{Arc, Weak};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};
pub(crate) const GROUP_LIMIT: usize = 6;
// Retain only summary association metadata, never PR titles or opener targets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PullRequest {
    number: u64,
    repository: String,
}
fn number(text: &str) -> Option<u64> {
    (!text.is_empty() && text.len() <= 9 && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse::<u64>().ok().filter(|n| *n > 0))
        .flatten()
}
fn pr_query(text: &str) -> Option<u64> {
    let text = text.strip_prefix("pr").unwrap_or(text).trim_start();
    number(text.strip_prefix('#').unwrap_or(text))
}
fn pr_url(text: &str) -> Option<PullRequest> {
    let url = reqwest::Url::parse(text).ok()?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let host = url.host_str()?;
    let parts: Vec<_> = url.path_segments()?.collect();
    if parts.len() < 4
        || parts[2] != "pull"
        || parts[..2].iter().any(|s| {
            s.is_empty()
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return None;
    }
    Some(PullRequest {
        number: number(parts[3])?,
        repository: if host == "github.com" {
            format!("{}/{}", parts[0], parts[1])
        } else {
            format!("{host}/{}/{}", parts[0], parts[1])
        },
    })
}
pub(crate) fn pull_requests(value: &serde_json::Value) -> Vec<PullRequest> {
    let mut result = Vec::new();
    // Lists and legacy primary are both authoritative; bound URLs may precede
    // health lookup metadata. Never inspect titles, branches or message text.
    let objects = value["pullRequests"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(std::iter::once(&value["pullRequest"]));
    for object in objects {
        if let Some(pr) = object["url"]
            .as_str()
            .and_then(pr_url)
            .filter(|pr| object["number"].as_u64() == Some(pr.number))
            && !result.contains(&pr)
        {
            result.push(pr);
        }
    }
    for url in value["boundPullRequests"].as_array().into_iter().flatten() {
        if let Some(pr) = url.as_str().and_then(pr_url)
            && !result.contains(&pr)
        {
            result.push(pr);
        }
    }
    result
}
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
    folded_title: String,
    keywords: Vec<String>,
    suggested: bool,
    pull_requests: Vec<PullRequest>,
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
            pull_requests: Vec::new(),
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
                "Everything at a glance".into(),
                vec!["overview".into()],
                true,
            ),
            Entry::new(
                "page:inbox".into(),
                Destination::Inbox,
                Kind::Page,
                "Inbox".into(),
                "What needs you".into(),
                vec!["attention".into(), "needs you".into()],
                true,
            ),
            Entry::new(
                "page:chats".into(),
                Destination::Chats,
                Kind::Page,
                "All chats".into(),
                "Every chat, newest first".into(),
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
                "This project".into(),
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
                "Show this project's chats".into(),
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
                // Same words as sidebar rows: a plain idle chat says nothing.
                c.row_reason().unwrap_or("")
            };
            let suggested =
                !c.archived && c.writable && s.selected.as_ref() != Some(&c.id) && recent < 3;
            recent += usize::from(suggested);
            let mut entry = Entry::new(
                format!("chat:{}", c.id),
                Destination::Chat(c.id.clone()),
                Kind::Chat,
                c.title.clone(),
                if state.is_empty() {
                    project.to_string()
                } else {
                    format!("{project} · {state}")
                },
                vec![project.into(), state.into()],
                suggested,
            );
            entry.pull_requests = c.pull_requests.clone();
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
    pub(crate) fn detail(&self, entry: &Entry, query: &Query) -> String {
        let n = pr_query(&fold(query.text.trim()));
        let pr = entry
            .pull_requests
            .iter()
            .find(|pr| Some(pr.number) == n)
            .or_else(|| entry.pull_requests.first());
        match pr {
            Some(pr) => format!("PR #{} · {} · {}", pr.number, pr.repository, entry.detail),
            None => entry.detail.clone(),
        }
    }
    pub(crate) fn search(&self, query: &Query) -> Matches {
        if query.too_long {
            return Matches {
                groups: vec![],
                suggested: false,
                error: Some("Use up to 240 search characters."),
            };
        }
        let query = fold(query.text.trim());
        let pr_number = pr_query(&query);
        let tokens: Vec<_> = query.split_whitespace().collect();
        if tokens.len() > 32 {
            return Matches {
                groups: vec![],
                suggested: false,
                error: Some("Use up to 32 search words."),
            };
        }
        let suggested = tokens.is_empty();
        let mut groups: Vec<(Kind, Vec<(usize, i32)>)> = vec![];
        let mut exact_pr = Vec::new();
        for (ix, e) in self.entries.iter().enumerate() {
            if pr_number.is_some_and(|n| e.pull_requests.iter().any(|pr| pr.number == n)) {
                exact_pr.push(ix);
                continue;
            }
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
        let mut matched_groups: Vec<_> = groups
            .into_iter()
            .map(|(kind, rows)| Group {
                kind,
                rows: rows
                    .into_iter()
                    .take(GROUP_LIMIT)
                    .map(|(ix, _)| ix)
                    .collect(),
            })
            .collect();
        if !exact_pr.is_empty() {
            matched_groups.insert(
                0,
                Group {
                    kind: Kind::Chat,
                    rows: exact_pr,
                },
            );
        }
        Matches {
            groups: matched_groups,
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
    fn exact_pr_metadata_and_text_search_remain_independent() {
        let mut s = snapshot();
        let mut values = vec![
            json!({"id":"title","title":"123 title only","state":"idle"}),
            json!({"id":"longer","title":"Unrelated","pullRequest":{"number":1234,"url":"https://github.com/o/r/pull/1234"}}),
            json!({"id":"bad","title":"Malformed","pullRequests":[{"number":"123","url":"https://github.com/o/r/pull/123"},{"number":123,"url":"https://github.com/o/r/pull/999"},{"number":123,"url":"not a URL"}]}),
        ];
        for i in 0..8 {
            values.push(json!({"id":format!("pr{i}"),"title":"Same title 👩‍💻","projectId":"a","archivedAt":if i==7 {Some(1)} else {None},"pullRequests":[{"number":123,"url":format!("https://github.com/o/repo{}/pull/123",i%2)}]}));
        }
        values.push(json!({"id":"legacy","title":"Legacy","pullRequest":{"number":123,"url":"https://github.com/o/old/pull/123"}}));
        values.push(json!({"id":"bound","title":"Bound","boundPullRequests":["https://git.example/o/bound/pull/123","https://git.example/o/bound/pull/123"]}));
        s.chats = Arc::new(
            values
                .iter()
                .map(|v| crate::local_model::chat(v).unwrap())
                .collect(),
        );
        let c = Catalog::new(&s);
        for q in [
            "123",
            "#123",
            "PR123",
            "pr #123",
            "PR 123",
            " ＰＲ＃１２３ ",
        ] {
            let query = Query::new(q);
            let m = c.search(&query);
            assert_eq!(m.groups[0].rows.len(), 10, "{q}");
            for ix in &m.groups[0].rows {
                let e = &c.entries[*ix];
                assert!(e.pull_requests.iter().any(|pr| pr.number == 123));
                assert!(c.detail(e, &query).starts_with("PR #123 · "));
                assert!(
                    matches!(&e.destination,Destination::Chat(id) if e.id==format!("chat:{id}"))
                );
            }
            assert!(
                m.groups
                    .iter()
                    .flat_map(|g| &g.rows)
                    .all(|ix| c.entries[*ix].id != "chat:longer")
            );
        }
        let m = c.search(&Query::new("123"));
        assert!(
            m.groups
                .iter()
                .skip(1)
                .flat_map(|g| &g.rows)
                .any(|ix| c.entries[*ix].id == "chat:title")
        );
        assert!(c.search(&Query::new("#12")).groups.is_empty());
        assert!(
            c.search(&Query::new("PR1234")).groups[0]
                .rows
                .iter()
                .all(|ix| c.entries[*ix].id == "chat:longer")
        );
        assert!(
            c.detail(&c.entries[m.groups[0].rows[0]], &Query::new("123"))
                .contains("repo0")
        );
        assert!(
            c.detail(&c.entries[m.groups[0].rows[1]], &Query::new("123"))
                .contains("repo1")
        );
        assert_eq!(s.chats.last().unwrap().pull_requests.len(), 1);
        assert!(s.chats[2].pull_requests.is_empty());
        assert!(
            c.entries
                .iter()
                .find(|e| e.id == "chat:title")
                .unwrap()
                .pull_requests
                .is_empty()
        );
        for q in [
            "0",
            "#0",
            "pr",
            "#",
            "-123",
            "#123x",
            "pr # 123",
            "9999999999",
        ] {
            assert_eq!(pr_query(q), None, "{q}");
        }
    }
    #[test]
    fn summary_pr_projection_refuses_malformed_links_and_numbers() {
        for raw in [
            serde_json::Value::Null,
            json!({}),
            json!({"pullRequests":{}}),
            json!({"pullRequest":{"number":-123,"url":"https://github.com/o/r/pull/123"}}),
            json!({"boundPullRequests":["file:///o/r/pull/123","https://user@github.com/o/r/pull/123","https://github.com/o/r/issues/123","https://github.com/o/r/pull/0",123]}),
        ] {
            assert!(crate::local_model::chat(&json!({"id":"test","pullRequest":raw["pullRequest"],"pullRequests":raw["pullRequests"],"boundPullRequests":raw["boundPullRequests"]})).unwrap().pull_requests.is_empty());
        }
        let raw = json!({"id":"test","pullRequest":{"number":123,"url":"https://github.com/o/r/pull/123"},"pullRequests":[{"number":123,"url":"https://github.com/o/r/pull/123"},{"number":124,"url":"https://github.com/o/r/pull/124"}]});
        assert_eq!(
            crate::local_model::chat(&raw).unwrap().pull_requests.len(),
            2
        );
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
