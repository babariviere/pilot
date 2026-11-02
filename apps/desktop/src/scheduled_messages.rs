//! One-time schedule records, as the Automations page presents them.
//! Time passing is not delivery evidence; a dispatched message is not agent completion.
use serde::Deserialize;
use serde_json::Value;

/// Exact UTC, for the technical details only.
fn timestamp(at: u64) -> String {
    format!(
        "{} {:02}:{:02}:{:02} UTC",
        crate::usage_overview::date(at),
        at / 3_600_000 % 24,
        at / 60_000 % 60,
        at / 1000 % 60
    )
}

/// Local time in words: "Today at 18:00", "Tomorrow at 08:00", "Tue at 06:34", "20 Oct at 06:34".
pub(crate) fn words(at: u64, now: u64, offset: impl Fn(i64) -> i64) -> String {
    let clock =
        crate::subscription_pause::clock_with((at / 1000) as i64, (now / 1000) as i64, offset);
    if let Some(rest) = clock.strip_prefix("tomorrow ") {
        format!("Tomorrow {rest}")
    } else if let Some(rest) = clock.strip_prefix("on ") {
        rest.to_owned()
    } else {
        format!("Today {clock}")
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Item {
    pub(crate) id: String,
    pub(crate) revision: u64,
    pub(crate) title: String,
    pub(crate) project_id: Option<String>,
    pub(crate) trigger: String,
    pub(crate) at: Option<u64>,
    pub(crate) target: Target,
    pub(crate) state: String,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
    pub(crate) claimed_at: Option<u64>,
    pub(crate) fired_at: Option<u64>,
    pub(crate) session_id: Option<String>,
    pub(crate) error: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Target {
    #[serde(rename_all = "camelCase")]
    Message { session_id: String, message: String },
    #[serde(rename_all = "camelCase")]
    Chat {
        spawn: Value,
        tracked_item_id: Option<String>,
    },
}
/// Where a record appears. Sent and cancelled records are history and stay off the page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Section {
    Attention,
    OneTime,
}
/// The row's right-hand status. Pending rows on time show none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Status {
    /// Pending past its time at the last read: Local hasn't sent it yet.
    Overdue,
    /// Claimed; delivery isn't confirmed.
    Sending,
    Failed,
}
impl Status {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Overdue => "Overdue",
            Self::Sending => "Sending",
            Self::Failed => "Couldn’t send",
        }
    }
}
/// The one row action Local offers for this state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RowAction {
    /// Pending: Local marks it cancelled.
    Cancel,
    /// Failed: Local deletes the record.
    Dismiss,
}
impl RowAction {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Cancel => "Cancel",
            Self::Dismiss => "Dismiss",
        }
    }
    /// The reported state Local must still have before the request is sent.
    pub(crate) fn state(self) -> &'static str {
        match self {
            Self::Cancel => "pending",
            Self::Dismiss => "failed",
        }
    }
}
impl Item {
    pub(crate) fn section(&self) -> Option<Section> {
        // Recurring rules belong to their own section, not One-time.
        if self.trigger != "at" {
            return None;
        }
        match self.state.as_str() {
            "pending" | "dispatching" => Some(Section::OneTime),
            "failed" => Some(Section::Attention),
            _ => None,
        }
    }
    pub(crate) fn status(&self, read_at: u64) -> Option<Status> {
        match self.state.as_str() {
            "pending" if self.at.is_some_and(|at| at <= read_at) => Some(Status::Overdue),
            "dispatching" => Some(Status::Sending),
            "failed" => Some(Status::Failed),
            _ => None,
        }
    }
    pub(crate) fn action(&self) -> Option<RowAction> {
        match self.state.as_str() {
            "pending" => Some(RowAction::Cancel),
            "failed" => Some(RowAction::Dismiss),
            _ => None,
        }
    }
    pub(crate) fn when(&self, now: u64) -> String {
        match (self.trigger.as_str(), self.at) {
            ("at", Some(at)) => words(at, now, crate::subscription_pause::local_offset),
            _ => "No time".into(),
        }
    }
    /// The text Local will send, or the new chat's first message.
    pub(crate) fn message(&self) -> &str {
        match &self.target {
            Target::Message { message, .. } => message,
            Target::Chat { spawn, .. } => spawn["message"].as_str().unwrap_or_default(),
        }
    }
    /// Project of a new-chat request, falling back to the record's own project.
    pub(crate) fn new_chat_project(&self) -> Option<&str> {
        match &self.target {
            Target::Chat { spawn, .. } => {
                spawn["projectId"].as_str().or(self.project_id.as_deref())
            }
            Target::Message { .. } => None,
        }
    }
    /// IDs, revision and exact UTC times, collapsed under Details.
    pub(crate) fn technical(&self) -> String {
        let or = |v: Option<&str>| v.unwrap_or("Not reported").to_owned();
        let time = |v: Option<u64>| v.map_or_else(|| "Not reported".into(), timestamp);
        let mut lines = vec![
            format!("Title: {}", self.title),
            format!("Schedule ID: {}", self.id),
            format!("Revision: {}", self.revision),
            format!("State: {}", self.state),
            format!("Trigger: {}", self.trigger),
            format!("Scheduled: {}", time(self.at)),
            format!("Project ID: {}", or(self.project_id.as_deref())),
        ];
        match &self.target {
            Target::Message { session_id, .. } => {
                lines.push(format!("Target chat ID: {session_id}"))
            }
            Target::Chat {
                spawn,
                tracked_item_id,
            } => {
                lines.push(format!(
                    "New-chat request: {}",
                    serde_json::to_string(spawn).unwrap_or_default()
                ));
                lines.push(format!("Tracked item: {}", or(tracked_item_id.as_deref())));
                lines.push(format!(
                    "Created chat ID: {}",
                    or(self.session_id.as_deref())
                ));
            }
        }
        lines.push(format!("Created: {}", time(Some(self.created_at))));
        lines.push(format!("Updated: {}", time(Some(self.updated_at))));
        if self.claimed_at.is_some() {
            lines.push(format!("Claimed: {}", time(self.claimed_at)));
        }
        if self.fired_at.is_some() {
            lines.push(format!("Dispatched: {}", time(self.fired_at)));
        }
        lines.join("\n")
    }
    pub(crate) fn valid(&self) -> bool {
        !self.id.is_empty()
            && self.revision != 0
            && self.revision <= 9_007_199_254_740_991
            && ![
                Some(self.created_at),
                Some(self.updated_at),
                self.at,
                self.claimed_at,
                self.fired_at,
            ]
            .into_iter()
            .flatten()
            .any(|at| at > 8_640_000_000_000_000)
            && !(self.trigger == "at" && self.at.is_none())
            && match &self.target {
                Target::Message { session_id, .. } => {
                    !session_id.is_empty()
                        && self.session_id.as_ref().is_none_or(|id| id == session_id)
                }
                Target::Chat { spawn, .. } => spawn.is_object() && spawn["message"].is_string(),
            }
    }
}
#[derive(Clone, Debug)]
pub(crate) struct Snapshot {
    pub(crate) items: Vec<Item>,
}
impl Snapshot {
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self, &'static str> {
        let items: Vec<Item> = serde_json::from_slice(bytes)
            .map_err(|_| "Local returned malformed scheduled items.")?;
        let mut ids = std::collections::HashSet::new();
        if items.len() > 1000 || items.iter().any(|s| !ids.insert(&s.id) || !s.valid()) {
            return Err(
                "Local returned invalid or duplicate scheduled items. No partial list shown.",
            );
        }
        Ok(Self { items })
    }
    /// One section's rows: one-time by due time, needing attention newest first.
    pub(crate) fn section(&self, section: Section) -> Vec<&Item> {
        let mut rows: Vec<&Item> = self
            .items
            .iter()
            .filter(|s| s.section() == Some(section))
            .collect();
        match section {
            Section::OneTime => rows.sort_by_key(|s| (s.at.unwrap_or(u64::MAX), s.created_at)),
            Section::Attention => rows.sort_by_key(|s| std::cmp::Reverse(s.updated_at)),
        }
        rows
    }
}
#[derive(Default)]
pub(crate) struct State {
    pub(crate) generation: u64,
    pub(crate) snapshot: Option<Snapshot>,
    pub(crate) busy: bool,
    pub(crate) error: Option<&'static str>,
    pub(crate) read_at: Option<u64>,
}
impl State {
    pub(crate) fn begin(&mut self) -> u64 {
        self.generation += 1;
        self.busy = true;
        self.error = None;
        self.generation
    }
    pub(crate) fn accept(
        &mut self,
        generation: u64,
        result: Result<Snapshot, &'static str>,
        at: u64,
    ) -> bool {
        if generation != self.generation {
            return false;
        }
        self.busy = false;
        match result {
            Ok(snapshot) => {
                self.snapshot = Some(snapshot);
                self.error = None;
                self.read_at = Some(at);
            }
            Err(error) => self.error = Some(error),
        }
        true
    }
}
