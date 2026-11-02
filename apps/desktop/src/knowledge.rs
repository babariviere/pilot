//! Project knowledge catalog: passive GET contracts, parsed and checked against the exact request.
use serde::Deserialize;
use serde_json::Value;

/// One page holds at most 50 rows, each with a bounded title/synopsis.
pub(crate) const PAGE_MAX: usize = 50;
/// A revision is at most 64 KiB of content plus metadata; bound the wire generously.
pub(crate) const WIRE_CAP: usize = 512 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind {
    Investigation,
    Component,
}
impl Kind {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Investigation => "Investigation",
            Self::Component => "Component",
        }
    }
    fn query(self) -> &'static str {
        match self {
            Self::Investigation => "investigation",
            Self::Component => "component",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub(crate) struct Checked {
    pub(crate) at: u64,
    pub(crate) checker: String,
    pub(crate) coverage: String,
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pending {
    pub(crate) since: u64,
    #[serde(default)]
    pub(crate) reasons: Vec<String>,
    #[serde(default)]
    pub(crate) task_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub(crate) struct Failure {
    pub(crate) at: u64,
    pub(crate) reason: String,
}
/// Stored check state, never a claim that saved content is current.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub(crate) struct Freshness {
    pub(crate) state: String,
    pub(crate) checked: Option<Checked>,
    pub(crate) pending: Option<Pending>,
    pub(crate) failure: Option<Failure>,
}
impl Freshness {
    pub(crate) fn needs_check(&self) -> bool {
        self.state == "needs_check"
    }
    /// Short row label: honest about unchecked and unknown state.
    pub(crate) fn label(&self) -> String {
        match (self.state.as_str(), &self.checked) {
            ("needs_check", _) => "Needs a check".into(),
            ("checked", Some(c)) => format!("Checked {}", crate::usage_overview::date(c.at)),
            ("not_checked", _) => "Not checked".into(),
            _ => "Check state unknown".into(),
        }
    }
    /// Sentence for the reading view.
    pub(crate) fn detail(&self) -> String {
        match (self.state.as_str(), &self.checked) {
            ("needs_check", _) => {
                let reasons = self
                    .pending
                    .as_ref()
                    .map(|p| p.reasons.join("; "))
                    .filter(|r| !r.is_empty())
                    .unwrap_or_else(|| "A source changed.".into());
                let reasons = if reasons.ends_with(['.', '!', '?']) {
                    reasons
                } else {
                    format!("{reasons}.")
                };
                let task = self
                    .pending
                    .as_ref()
                    .and_then(|p| p.task_id.as_ref())
                    .map_or(String::new(), |t| format!(" Pending task {t}."));
                format!("{reasons}{task} The saved content may still be correct.")
            }
            ("checked", Some(c)) => format!(
                "Checked {} by {} against {}. Not a guarantee beyond that coverage.",
                crate::usage_overview::date(c.at),
                c.checker,
                if c.coverage.is_empty() {
                    "unstated sources"
                } else {
                    c.coverage.as_str()
                }
            ),
            ("not_checked", _) => {
                "Not checked against current sources. Saving an entry does not check it.".into()
            }
            _ => "This daemon reported a check state this app does not know.".into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Origin {
    pub(crate) mission_id: Option<String>,
    pub(crate) task_id: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) recorded_at: u64,
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Link {
    pub(crate) link_revision: u64,
    pub(crate) pinned_revision: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) kind: Kind,
    pub(crate) title: String,
    pub(crate) synopsis: String,
    pub(crate) revision: u64,
    pub(crate) created_at: u64,
    pub(crate) origin: Origin,
    pub(crate) freshness: Freshness,
    pub(crate) link: Option<Link>,
}
impl Summary {
    /// "Component · revision 3 · Needs a check"
    pub(crate) fn meta(&self) -> String {
        let pinned = self
            .link
            .as_ref()
            .and_then(|l| l.pinned_revision)
            .map_or(String::new(), |r| format!(" · pinned to {r}"));
        format!(
            "{} · revision {}{pinned} · {}",
            self.kind.label(),
            self.revision,
            self.freshness.label()
        )
    }
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub(crate) struct Page {
    pub(crate) entries: Vec<Summary>,
    pub(crate) more: bool,
    pub(crate) cursor: Option<String>,
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Author {
    #[serde(rename = "type")]
    pub(crate) kind: String,
    pub(crate) session_id: Option<String>,
}
impl Author {
    pub(crate) fn label(&self) -> String {
        match (self.kind.as_str(), &self.session_id) {
            ("user", _) => "You".into(),
            ("session", Some(id)) => format!("Chat {id}"),
            _ => "Unknown author".into(),
        }
    }
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevisionSummary {
    pub(crate) revision: u64,
    pub(crate) title: String,
    pub(crate) synopsis: String,
    pub(crate) reason: Option<String>,
    pub(crate) author: Author,
    pub(crate) recorded_at: u64,
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Revision {
    pub(crate) knowledge_id: String,
    #[serde(flatten)]
    pub(crate) summary: RevisionSummary,
    pub(crate) body: String,
    #[serde(default)]
    pub(crate) sources: Vec<Value>,
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub(crate) struct Detail {
    pub(crate) entry: Summary,
    pub(crate) revision: Revision,
    pub(crate) freshness: Freshness,
}
impl Detail {
    pub(crate) fn historical(&self) -> bool {
        self.revision.summary.revision != self.entry.revision
    }
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub(crate) struct History {
    pub(crate) revisions: Vec<RevisionSummary>,
    pub(crate) more: bool,
    pub(crate) cursor: Option<String>,
}

/// One cited source, described from its stored locator only. Nothing is fetched.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Source {
    pub(crate) title: String,
    pub(crate) locator: String,
    /// Only explicit web sources open, through the existing link opener.
    pub(crate) web: Option<String>,
}
pub(crate) fn source(v: &Value) -> Source {
    let s = |k: &str| v[k].as_str().unwrap_or_default().to_owned();
    let n = |k: &str| v[k].as_u64();
    let label = v["label"].as_str().map(str::to_owned);
    let (kind, locator, web) = match v["type"].as_str() {
        Some("repository") => {
            let at = match (v["commit"].as_str(), v["dirty"].as_bool()) {
                (Some(c), _) => format!(" at {c}"),
                (None, Some(true)) => " (uncommitted observation)".into(),
                _ => " (no commit recorded)".into(),
            };
            ("Repository file", format!("{}{at}", s("path")), None)
        }
        Some("artifact") => (
            "Artifact",
            format!(
                "{} revision {} in chat {}",
                s("artifactId"),
                n("revision").unwrap_or_default(),
                s("sessionId")
            ),
            None,
        ),
        Some("mission") => {
            let record = if let Some(d) = v["decisionId"].as_str() {
                format!("decision {d}")
            } else if let Some(t) = v["taskId"].as_str() {
                format!("task {t}")
            } else if let Some(e) = n("eventId") {
                format!("event {e}")
            } else if let Some(b) = n("briefRevision") {
                format!("brief revision {b}")
            } else {
                "mission".into()
            };
            (
                "Mission record",
                format!("{record} in mission {}", s("missionId")),
                None,
            )
        }
        Some("web") => (
            "Web page",
            format!("{} · accessed {}", s("url"), s("accessedAt")),
            crate::external_links::web(&s("url")).map(|u| u.to_string()),
        ),
        Some("knowledge") => (
            "Knowledge",
            format!(
                "{} {} revision {}{}",
                s("relation"),
                s("knowledgeId"),
                n("revision").unwrap_or_default(),
                v["finding"]
                    .as_str()
                    .map_or(String::new(), |f| format!(", finding {f}"))
            ),
            None,
        ),
        _ => (
            "Unknown source",
            "This app cannot describe this source.".into(),
            None,
        ),
    };
    Source {
        title: label.unwrap_or_else(|| kind.into()),
        locator,
        web,
    }
}

/// The exact read a view asked for. Responses are accepted only for the same route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Route {
    List(Query),
    Detail { id: String, revision: Option<u64> },
    History { id: String, cursor: Option<String> },
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Query {
    pub(crate) kind: Option<Kind>,
    pub(crate) needs_check: bool,
    pub(crate) q: String,
    pub(crate) mission: Option<String>,
    pub(crate) cursor: Option<String>,
}
#[derive(Clone, Debug)]
pub(crate) enum Data {
    Page(Page),
    Detail(Box<Detail>),
    History(History),
}

fn bounded(s: &str, max: usize) -> bool {
    s.chars().count() <= max
}
pub(crate) fn path(project: &str, route: &Route) -> Result<String, &'static str> {
    if !crate::local_model::valid_id(project) {
        return Err("Invalid Local project knowledge scope.");
    }
    let mut url = reqwest::Url::parse("http://local/").map_err(|_| "Invalid knowledge route.")?;
    match route {
        Route::List(q) => {
            url.set_path(&format!("/api/projects/{project}/knowledge"));
            let mut pairs = url.query_pairs_mut();
            if let Some(k) = q.kind {
                pairs.append_pair("kind", k.query());
            }
            if let Some(m) = &q.mission {
                if !crate::local_model::valid_id(m) {
                    return Err("Invalid Local mission scope.");
                }
                pairs.append_pair("missionId", m);
            }
            if q.needs_check {
                pairs.append_pair("check", "needs_check");
            }
            if !q.q.is_empty() {
                if !bounded(&q.q, 200) {
                    return Err("Filter text is longer than 200 characters.");
                }
                pairs.append_pair("q", &q.q);
            }
            if let Some(c) = &q.cursor {
                pairs.append_pair("cursor", c);
            }
            pairs.append_pair("limit", &PAGE_MAX.to_string());
        }
        Route::Detail { id, revision } => {
            if !crate::local_model::valid_id(id) {
                return Err("Invalid knowledge entry.");
            }
            url.set_path(&format!("/api/projects/{project}/knowledge/{id}"));
            if let Some(r) = revision {
                url.query_pairs_mut()
                    .append_pair("revision", &r.to_string());
            }
        }
        Route::History { id, cursor } => {
            if !crate::local_model::valid_id(id) {
                return Err("Invalid knowledge entry.");
            }
            url.set_path(&format!("/api/projects/{project}/knowledge/{id}/revisions"));
            let mut pairs = url.query_pairs_mut();
            if let Some(c) = cursor {
                pairs.append_pair("cursor", c);
            }
            pairs.append_pair("limit", &PAGE_MAX.to_string());
        }
    }
    Ok(match url.query() {
        Some(q) if !q.is_empty() => format!("{}?{q}", url.path()),
        _ => url.path().to_owned(),
    })
}

fn summary_ok(project: &str, s: &Summary) -> bool {
    s.project_id == project
        && crate::local_model::valid_id(&s.id)
        && s.revision > 0
        && bounded(&s.title, 200)
        && bounded(&s.synopsis, 1000)
}

/// Rejects responses that do not belong to the exact request, never shows them as empty.
pub(crate) fn parse(project: &str, route: &Route, value: Value) -> Result<Data, &'static str> {
    match route {
        Route::List(q) => {
            let page: Page = serde_json::from_value(value)
                .map_err(|_| "Local returned malformed project knowledge.")?;
            let mut ids = std::collections::HashSet::new();
            if page.entries.len() > PAGE_MAX
                || page.more != page.cursor.is_some()
                || page.entries.iter().any(|s| {
                    !summary_ok(project, s)
                        || !ids.insert(s.id.clone())
                        || q.kind.is_some_and(|k| k != s.kind)
                        || (q.mission.is_some() && s.link.is_none())
                })
            {
                return Err("Local returned knowledge outside this project or filter.");
            }
            Ok(Data::Page(page))
        }
        Route::Detail { id, revision } => {
            let d: Detail = serde_json::from_value(value)
                .map_err(|_| "Local returned a malformed knowledge entry.")?;
            let r = d.revision.summary.revision;
            if !summary_ok(project, &d.entry)
                || &d.entry.id != id
                || &d.revision.knowledge_id != id
                || r == 0
                || r > d.entry.revision
                || revision.is_some_and(|want| want != r)
                || (revision.is_none() && r != d.entry.revision)
                || d.revision.sources.len() > 64
            {
                return Err("Local returned a different knowledge entry or revision.");
            }
            Ok(Data::Detail(Box::new(d)))
        }
        Route::History { .. } => {
            let h: History = serde_json::from_value(value)
                .map_err(|_| "Local returned malformed knowledge history.")?;
            if h.revisions.len() > PAGE_MAX
                || h.more != h.cursor.is_some()
                || h.revisions
                    .windows(2)
                    .any(|w| w[0].revision <= w[1].revision)
                || h.revisions.iter().any(|r| r.revision == 0)
            {
                return Err("Local returned out-of-order knowledge history.");
            }
            Ok(Data::History(h))
        }
    }
}
