//! Slack triage in the Inbox: the classified Slack messages of the projects in scope, read
//! through the existing tracked-items contract. Triage values are local overrides kept by
//! pilotd. The board never posts to Slack; see docs/slack-triage.md for the exact routes.
use crate::local_model::valid_id;
use serde_json::{Value, json};
use std::collections::HashMap;

/// Swift's `SlackTriageModel` bounds: pages of 100 and at most 500 messages per project and list.
pub(crate) const PAGE: usize = 100;
pub(crate) const PROJECT_ITEMS: usize = 500;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Status {
    Open,
    InProgress,
    Waiting,
    Done,
    Dismissed,
}
impl Status {
    pub(crate) const ALL: [Self; 5] = [
        Self::Open,
        Self::InProgress,
        Self::Waiting,
        Self::Done,
        Self::Dismissed,
    ];
    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::InProgress => "in_progress",
            Self::Waiting => "waiting",
            Self::Done => "done",
            Self::Dismissed => "dismissed",
        }
    }
    fn parse(value: &Value) -> Option<Self> {
        Self::ALL.into_iter().find(|s| value == s.wire())
    }
    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::Open => "Open",
            Self::InProgress => "In progress",
            Self::Waiting => "Waiting",
            Self::Done => "Done",
            Self::Dismissed => "Dismissed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Bug,
    Question,
    Request,
    Unknown,
}
impl Kind {
    pub(crate) const ALL: [Self; 4] = [Self::Bug, Self::Question, Self::Request, Self::Unknown];
    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::Bug => "bug",
            Self::Question => "question",
            Self::Request => "request",
            Self::Unknown => "unknown",
        }
    }
    fn parse(value: &Value) -> Option<Self> {
        Self::ALL.into_iter().find(|k| value == k.wire())
    }
    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::Bug => "Bug",
            Self::Question => "Question",
            Self::Request => "Request",
            Self::Unknown => "Unknown",
        }
    }
}

/// Most urgent first: the declaration order is the sort rank.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Severity {
    Critical,
    High,
    Medium,
    Low,
}
impl Severity {
    pub(crate) const ALL: [Self; 4] = [Self::Critical, Self::High, Self::Medium, Self::Low];
    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::Critical => "critical",
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
        }
    }
    fn parse(value: &Value) -> Option<Self> {
        Self::ALL.into_iter().find(|s| value == s.wire())
    }
    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::Critical => "Critical",
            Self::High => "High",
            Self::Medium => "Medium",
            Self::Low => "Low",
        }
    }
}

/// What a project label does: `hide` keeps its messages behind Show hidden; `close` lets
/// pilotd dismiss them. The board only reads the effect; project settings own it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Effect {
    None,
    Hide,
    Close,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Label {
    pub(crate) name: String,
    pub(crate) effect: Effect,
}

/// The Slack part of one project's tracking configuration.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Project {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) channels: Vec<String>,
    pub(crate) labels: Vec<Label>,
}
impl Project {
    pub(crate) fn parse(value: &Value) -> Option<Self> {
        let id = value["id"].as_str().filter(|id| valid_id(id))?.to_owned();
        let name = value["name"].as_str()?.to_owned();
        let tracking = &value["tracking"];
        let channels = tracking["slackChannels"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let labels = tracking["slackLabels"]
            .as_array()
            .map(|labels| {
                labels
                    .iter()
                    .filter_map(|l| {
                        Some(Label {
                            name: l["name"].as_str()?.to_owned(),
                            effect: match l["effect"].as_str() {
                                Some("hide") => Effect::Hide,
                                Some("close") => Effect::Close,
                                // pilotd reads an older hideFromInbox as hide.
                                _ if l["hideFromInbox"] == true => Effect::Hide,
                                _ => Effect::None,
                            },
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            id,
            name,
            channels,
            labels,
        })
    }
    pub(crate) fn tracks_slack(&self) -> bool {
        !self.channels.is_empty()
    }
    fn hides(&self, label: &str) -> bool {
        self.labels
            .iter()
            .any(|l| l.name == label && l.effect == Effect::Hide)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Overridden {
    pub(crate) kind: bool,
    pub(crate) label: bool,
    pub(crate) severity: bool,
}

/// Effective values after pilotd applied the user's durable overrides.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Triage {
    pub(crate) kind: Kind,
    pub(crate) label: Option<String>,
    pub(crate) severity: Severity,
    pub(crate) status: Status,
    pub(crate) overridden: Overridden,
    pub(crate) closed_by_label: Option<String>,
    pub(crate) done_reason: Option<String>,
    pub(crate) waiting_reason: Option<String>,
}
impl Triage {
    /// "Closed · Product" while a close label keeps it dismissed, a Done or Waiting reason,
    /// else the status.
    pub(crate) fn status_title(&self) -> String {
        match (
            self.status,
            &self.closed_by_label,
            &self.done_reason,
            &self.waiting_reason,
        ) {
            (Status::Dismissed, Some(label), _, _) => format!("Closed · {label}"),
            (Status::Done, _, Some(reason), _) => format!("Done · {reason}"),
            (Status::Waiting, _, _, Some(reason)) => format!("Waiting · {reason}"),
            _ => self.status.title().to_owned(),
        }
    }
    /// "You changed the type and label." once the user overrode the classifier.
    pub(crate) fn overridden_note(&self) -> Option<String> {
        let fields: Vec<&str> = [
            (self.overridden.kind, "type"),
            (self.overridden.label, "label"),
            (self.overridden.severity, "severity"),
        ]
        .into_iter()
        .filter_map(|(set, name)| set.then_some(name))
        .collect();
        let (last, rest) = fields.split_last()?;
        let list = if rest.is_empty() {
            (*last).to_owned()
        } else {
            format!("{} and {last}", rest.join(", "))
        };
        Some(format!("You changed the {list}. Pilot keeps your choice."))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Item {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) title: String,
    /// pilotd's canonical message link, opened and copied exactly.
    pub(crate) url: String,
    pub(crate) channel_name: Option<String>,
    pub(crate) replies: Option<u64>,
    pub(crate) updated_at: u64,
    pub(crate) triage: Triage,
    /// The latest chat started from or linked to the message.
    pub(crate) session_id: Option<String>,
    /// Pilot reacted with eyes when work started; marking it Done then adds a done reaction.
    pub(crate) started: bool,
}
impl Item {
    pub(crate) fn parse(value: &Value) -> Option<Self> {
        if value["kind"] != "slack" {
            return None;
        }
        let id = value["id"].as_str().filter(|id| valid_id(id))?.to_owned();
        let project_id = value["projectId"]
            .as_str()
            .filter(|id| valid_id(id))?
            .to_owned();
        let metadata = &value["metadata"];
        let slack = &value["slack"];
        let dismissed = value["dismissed"] == true;
        let text = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned);
        let triage = if slack.is_object() {
            let overrides = &slack["overrides"];
            Triage {
                kind: Kind::parse(&slack["type"]).unwrap_or(Kind::Unknown),
                label: text(&slack["label"]),
                severity: Severity::parse(&slack["severity"]).unwrap_or(Severity::Low),
                status: Status::parse(&slack["status"])?,
                overridden: Overridden {
                    kind: !overrides["type"].is_null(),
                    label: overrides.get("label").is_some(),
                    severity: !overrides["severity"].is_null(),
                },
                closed_by_label: text(&slack["closedByLabel"]),
                done_reason: text(&slack["doneReason"]),
                waiting_reason: text(&slack["waitingReason"]),
            }
        } else {
            // Items without triage values fall back to their stored classification, as in Swift.
            Triage {
                kind: Kind::parse(&metadata["type"]).unwrap_or(Kind::Unknown),
                label: text(&metadata["label"]),
                severity: Severity::parse(&metadata["severity"]).unwrap_or(Severity::Low),
                status: if dismissed {
                    Status::Dismissed
                } else {
                    Status::Open
                },
                overridden: Overridden::default(),
                closed_by_label: None,
                done_reason: None,
                waiting_reason: None,
            }
        };
        let session_id = value["sessionIds"]
            .as_array()
            .and_then(|ids| ids.last())
            .or(Some(&value["sessionId"]))
            .and_then(Value::as_str)
            .filter(|id| valid_id(id))
            .map(str::to_owned);
        Some(Self {
            id,
            project_id,
            title: value["title"].as_str()?.to_owned(),
            url: value["url"].as_str()?.to_owned(),
            channel_name: text(&metadata["channelName"]),
            replies: metadata["replies"].as_u64(),
            updated_at: value["updatedAt"].as_u64()?,
            triage,
            session_id,
            started: metadata["slackStart"]["outcome"] == "reacted",
        })
    }
    pub(crate) fn channel(&self) -> String {
        self.channel_name
            .as_ref()
            .map_or_else(|| "Slack".to_owned(), |name| format!("#{name}"))
    }
    /// "Atlas · #bugs · Bug · High · 2h ago · 7 replies". The project leads only when the
    /// list spans several projects.
    pub(crate) fn meta(&self, project: Option<&str>, now: u64) -> String {
        let mut parts: Vec<String> = project.map(str::to_owned).into_iter().collect();
        parts.push(self.channel());
        parts.push(self.triage.kind.title().to_owned());
        parts.push(self.triage.severity.title().to_owned());
        parts.push(ago(self.updated_at, now));
        match self.replies {
            Some(1) => parts.push("1 reply".to_owned()),
            Some(n) if n > 1 => parts.push(format!("{n} replies")),
            _ => {}
        }
        parts.join(" · ")
    }
}

pub(crate) fn ago(at: u64, now: u64) -> String {
    match now.saturating_sub(at) / 1000 {
        0..60 => "Just now".into(),
        s @ 60..3600 => format!("{}m ago", s / 60),
        s @ 3600..86400 => format!("{}h ago", s / 3600),
        s => format!("{}d ago", s / 86400),
    }
}

/// Health of a project's Slack source, as pilotd reports it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Source {
    pub(crate) status: String,
    pub(crate) error: Option<String>,
    pub(crate) budget_limited: bool,
}
impl Source {
    pub(crate) fn parse(value: &Value) -> Option<Self> {
        (value["kind"] == "slack").then(|| Self {
            status: value["status"].as_str().unwrap_or("").to_owned(),
            error: value["error"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            budget_limited: value["budgetLimited"] == true,
        })
    }
    pub(crate) fn syncing(&self) -> bool {
        self.status == "syncing"
    }
    /// Only what says something: a sync, sign-in, the hourly budget or an error. The flag
    /// marks a problem rather than routine progress.
    pub(crate) fn notice(&self) -> Option<(String, bool)> {
        match self.status.as_str() {
            "syncing" => Some(("Syncing Slack…".into(), false)),
            "sign_in_required" => Some((
                "Sign in to Slack again to sync new messages. These are from the last sync.".into(),
                true,
            )),
            "error" if self.budget_limited => Some((
                self.error
                    .clone()
                    .unwrap_or_else(|| "Slack hourly budget reached.".into()),
                false,
            )),
            "error" => Some((
                self.error
                    .clone()
                    .unwrap_or_else(|| "Slack couldn't be synced.".into()),
                true,
            )),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ProjectBoard {
    pub(crate) project: Project,
    pub(crate) source: Option<Source>,
    pub(crate) items: Vec<Item>,
    /// Active (not dismissed) messages pilotd holds, which can exceed the loaded rows.
    pub(crate) active_total: u64,
}
impl ProjectBoard {
    pub(crate) fn truncated(&self) -> bool {
        self.active_total > PROJECT_ITEMS as u64
    }
}

/// One read of every project in scope.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Board {
    pub(crate) projects: Vec<ProjectBoard>,
}
impl Board {
    pub(crate) fn item(&self, id: &str) -> Option<&Item> {
        self.projects
            .iter()
            .flat_map(|p| &p.items)
            .find(|i| i.id == id)
    }
    pub(crate) fn project(&self, id: &str) -> Option<&ProjectBoard> {
        self.projects.iter().find(|p| p.project.id == id)
    }
    /// Replaces one message with pilotd's saved copy. False when it is not on the board.
    pub(crate) fn replace(&mut self, item: Item) -> bool {
        for project in &mut self.projects {
            if let Some(slot) = project.items.iter_mut().find(|i| i.id == item.id) {
                if slot.project_id != item.project_id {
                    return false;
                }
                *slot = item;
                return true;
            }
        }
        false
    }
    pub(crate) fn tracking(&self) -> impl Iterator<Item = &ProjectBoard> {
        self.projects.iter().filter(|p| p.project.tracks_slack())
    }
    /// Project names keyed by ID when the board spans several projects, else empty.
    pub(crate) fn names(&self) -> HashMap<String, String> {
        if self.tracking().count() < 2 {
            return HashMap::new();
        }
        self.projects
            .iter()
            .map(|p| (p.project.id.clone(), p.project.name.clone()))
            .collect()
    }
    /// Filters applied, then severity (most urgent first), newest first, then ID.
    pub(crate) fn visible(&self, filter: &Filter) -> Vec<Item> {
        let mut out: Vec<Item> = self
            .projects
            .iter()
            .flat_map(|p| p.items.iter().map(move |i| (&p.project, i)))
            .filter(|(project, item)| filter.admits(project, item))
            .map(|(_, item)| item.clone())
            .collect();
        out.sort_by(|a, b| {
            a.triage
                .severity
                .cmp(&b.triage.severity)
                .then(b.updated_at.cmp(&a.updated_at))
                .then(a.id.cmp(&b.id))
        });
        out
    }
    /// Messages behind Show hidden: a hiding label's, or ones a close label dismissed.
    pub(crate) fn hidden_count(&self, show_dismissed: bool) -> usize {
        self.projects
            .iter()
            .flat_map(|p| p.items.iter().map(move |i| (&p.project, i)))
            .filter(|(project, item)| {
                let t = &item.triage;
                (t.status == Status::Dismissed && t.closed_by_label.is_some())
                    || ((show_dismissed || t.status != Status::Dismissed)
                        && t.label.as_deref().is_some_and(|l| project.hides(l)))
            })
            .count()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Filter {
    pub(crate) status: Option<Status>,
    pub(crate) show_hidden: bool,
    pub(crate) show_dismissed: bool,
}
impl Filter {
    fn admits(&self, project: &Project, item: &Item) -> bool {
        let t = &item.triage;
        // Label-closed messages are dismissed and hidden: either toggle shows them.
        if t.status == Status::Dismissed
            && !self.show_dismissed
            && !(self.show_hidden && t.closed_by_label.is_some())
        {
            return false;
        }
        if !self.show_hidden && t.label.as_deref().is_some_and(|l| project.hides(l)) {
            return false;
        }
        self.status.is_none_or(|s| s == t.status)
    }
    pub(crate) fn title(&self) -> &'static str {
        self.status.map_or("All statuses", Status::title)
    }
    /// Status groups in board order. Dismissed shows with Show dismissed, or while the list
    /// holds label-closed messages.
    pub(crate) fn statuses(&self, visible: &[Item]) -> Vec<Status> {
        if let Some(status) = self.status {
            return vec![status];
        }
        let dismissed =
            self.show_dismissed || visible.iter().any(|i| i.triage.status == Status::Dismissed);
        Status::ALL
            .into_iter()
            .filter(|s| *s != Status::Dismissed || dismissed)
            .collect()
    }
}

/// Item indices of `visible` per status, in board order.
pub(crate) fn columns(visible: &[Item], statuses: &[Status]) -> Vec<(Status, Vec<usize>)> {
    statuses
        .iter()
        .map(|s| {
            (
                *s,
                visible
                    .iter()
                    .enumerate()
                    .filter(|(_, i)| i.triage.status == *s)
                    .map(|(ix, _)| ix)
                    .collect(),
            )
        })
        .collect()
}

/// IDs per column, for keyboard moves.
pub(crate) fn ids(visible: &[Item], columns: &[(Status, Vec<usize>)]) -> Vec<Vec<String>> {
    columns
        .iter()
        .map(|(_, ix)| ix.iter().map(|i| visible[*i].id.clone()).collect())
        .collect()
}

/// Left and right move to the nearest row of the next non-empty column, as in Swift.
pub(crate) fn sideways(
    columns: &[Vec<String>],
    selected: &str,
    dx: isize,
) -> Option<(usize, usize)> {
    let column = columns
        .iter()
        .position(|c| c.iter().any(|id| id == selected))?;
    let row = columns[column].iter().position(|id| id == selected)?;
    let mut target = column as isize + dx;
    while target >= 0 && (target as usize) < columns.len() {
        let c = &columns[target as usize];
        if !c.is_empty() {
            return Some((target as usize, row.min(c.len() - 1)));
        }
        target += dx;
    }
    None
}

/// The message to select once the selected one leaves the list: the next one in its column,
/// else the previous.
pub(crate) fn successor(columns: &[Vec<String>], selected: &str) -> Option<String> {
    let column = columns.iter().find(|c| c.iter().any(|id| id == selected))?;
    let row = column.iter().position(|id| id == selected)?;
    column
        .get(row + 1)
        .or_else(|| row.checked_sub(1).and_then(|r| column.get(r)))
        .cloned()
}

/// One explicit triage change, saved as a local override. Nothing is written to Slack, except
/// that pilotd itself may add a done reaction for a message whose work Pilot started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Change {
    Status(Status),
    Kind(Kind),
    Severity(Severity),
    /// None clears the label.
    Label(Option<String>),
}
impl Change {
    pub(crate) fn body(&self) -> Value {
        let slack = match self {
            Self::Status(s) => json!({"status": s.wire()}),
            Self::Kind(k) => json!({"type": k.wire()}),
            Self::Severity(s) => json!({"severity": s.wire()}),
            Self::Label(label) => json!({"label": label}),
        };
        json!({"slack": slack})
    }
    /// Whether pilotd's returned item carries this change.
    pub(crate) fn applied(&self, triage: &Triage) -> bool {
        match self {
            Self::Status(s) => triage.status == *s,
            Self::Kind(k) => triage.kind == *k,
            Self::Severity(s) => triage.severity == *s,
            Self::Label(label) => triage.label == *label,
        }
    }
}

/// The inspector's quote of the message, read on demand and never stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Excerpt {
    pub(crate) author: Option<String>,
    pub(crate) text: String,
    pub(crate) truncated: bool,
}
impl Excerpt {
    pub(crate) fn parse(value: &Value, id: &str) -> Option<Self> {
        if value["itemId"] != id {
            return None;
        }
        Some(Self {
            author: value["author"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            text: value["text"].as_str()?.to_owned(),
            truncated: value["truncated"] == true,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ExcerptState {
    Loading,
    Loaded(Excerpt),
    Unavailable(String),
}

/// A bounded in-memory cache of the latest excerpts, as Swift's `SlackExcerptStore`.
#[derive(Default)]
pub(crate) struct Excerpts {
    states: HashMap<String, ExcerptState>,
    recent: Vec<String>,
}
impl Excerpts {
    pub(crate) const LIMIT: usize = 40;
    pub(crate) fn get(&self, id: &str) -> Option<&ExcerptState> {
        self.states.get(id)
    }
    pub(crate) fn set(&mut self, id: &str, state: ExcerptState) {
        self.recent.retain(|r| r != id);
        self.recent.push(id.to_owned());
        self.states.insert(id.to_owned(), state);
        while self.recent.len() > Self::LIMIT {
            let old = self.recent.remove(0);
            self.states.remove(&old);
        }
    }
    /// Not read yet, or the last read failed.
    pub(crate) fn needs_read(&self, id: &str) -> bool {
        !matches!(
            self.states.get(id),
            Some(ExcerptState::Loaded(_) | ExcerptState::Loading)
        )
    }
}

/// A change in flight or what became of it. Unknown is never resent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Save {
    Pending(Change),
    NotSent(String),
    Unknown(String),
}

#[cfg(test)]
#[path = "slack_triage_tests.rs"]
mod tests;
