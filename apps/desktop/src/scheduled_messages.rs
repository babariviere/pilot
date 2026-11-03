//! Schedule records (one-time messages and recurring rules), as the Automations page presents them.
//! Time passing is not delivery evidence; a dispatched message is not agent completion.
use serde::{Deserialize, Serialize};
use serde_json::Value;

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

/// Splits a time in words into a clock over a day for a row's right column:
/// "Today at 18:00" → ("18:00", "Today"), "Fri at 09:00" → ("09:00", "Friday"),
/// "Yesterday 14:00" → ("14:00", "Yesterday"), "13 Nov at 09:00" → ("09:00", "13 Nov").
pub(crate) fn clock_and_day(words: &str) -> (String, String) {
    let Some((day, clock)) = words.rsplit_once(' ') else {
        return (words.to_owned(), String::new());
    };
    let day = day.strip_suffix(" at").unwrap_or(day);
    let day = match day {
        "Mon" => "Monday",
        "Tue" => "Tuesday",
        "Wed" => "Wednesday",
        "Thu" => "Thursday",
        "Fri" => "Friday",
        "Sat" => "Saturday",
        "Sun" => "Sunday",
        day => day,
    };
    (clock.to_owned(), day.to_owned())
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
    /// Recurring rules only.
    pub(crate) recurrence: Option<Recurrence>,
    #[serde(default)]
    pub(crate) runs: Vec<Run>,
    pub(crate) notice: Option<Run>,
    #[serde(default)]
    pub(crate) paused: bool,
}
/// A recurring rule's calendar, in its own stored time zone.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Recurrence {
    /// "day", "week" or "month".
    pub(crate) every: String,
    /// "HH:MM", 24-hour local wall time.
    pub(crate) time: String,
    pub(crate) time_zone: String,
    /// Daily: 1 = Monday … 7 = Sunday. Omitted means every day.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) weekdays: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) weekday: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) day_of_month: Option<u8>,
}
/// One handled occurrence of a recurring rule.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Run {
    pub(crate) due: u64,
    pub(crate) at: u64,
    /// "started", "sent", "skipped_running", "missed" or "failed".
    pub(crate) outcome: String,
    #[serde(default)]
    pub(crate) late: bool,
    pub(crate) session_id: Option<String>,
    pub(crate) count: Option<u64>,
    pub(crate) error: Option<String>,
}
impl Run {
    /// Skipped, missed and failed runs need a look; late successes are only shown.
    pub(crate) fn needs_attention(&self) -> bool {
        matches!(
            self.outcome.as_str(),
            "skipped_running" | "missed" | "failed"
        )
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Target {
    #[serde(rename_all = "camelCase")]
    Message { session_id: String, message: String },
    #[serde(rename_all = "camelCase")]
    Chat { spawn: Value },
}
/// Where a record appears. Sent and cancelled records are history and stay off the page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Section {
    Attention,
    Recurring,
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
    /// Pending one-time: Local marks it cancelled.
    Cancel,
    /// Failed one-time: Local deletes the record.
    Dismiss,
    /// Pending recurring rule: Local marks it cancelled, so it never runs again.
    Delete,
    /// Recurring notice: cleared with a revision-checked PATCH; runs stay.
    DismissNotice,
    Pause,
    Resume,
}
impl RowAction {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Cancel => "Cancel",
            Self::Dismiss | Self::DismissNotice => "Dismiss",
            Self::Delete => "Delete",
            Self::Pause => "Pause",
            Self::Resume => "Resume",
        }
    }
    /// The reported state Local must still have before the request is sent.
    pub(crate) fn state(self) -> &'static str {
        match self {
            Self::Dismiss => "failed",
            _ => "pending",
        }
    }
    /// The revision-checked PATCH body, for actions that edit a recurring rule.
    pub(crate) fn patch(self) -> Option<Value> {
        match self {
            Self::DismissNotice => Some(serde_json::json!({"dismissNotice": true})),
            Self::Pause => Some(serde_json::json!({"paused": true})),
            Self::Resume => Some(serde_json::json!({"paused": false})),
            Self::Cancel | Self::Dismiss | Self::Delete => None,
        }
    }
}
impl Item {
    pub(crate) fn recurring(&self) -> bool {
        self.trigger == "recurring"
    }
    fn active(&self) -> bool {
        matches!(self.state.as_str(), "pending" | "dispatching")
    }
    /// A recurring rule with a skipped, missed or failed run is listed twice:
    /// under Needs attention and under Recurring.
    pub(crate) fn in_section(&self, section: Section) -> bool {
        match (section, self.trigger.as_str()) {
            (Section::OneTime, "at") | (Section::Recurring, "recurring") => self.active(),
            (Section::Attention, "at") => self.state == "failed",
            (Section::Attention, "recurring") => {
                self.active() && self.notice.as_ref().is_some_and(Run::needs_attention)
            }
            _ => false,
        }
    }
    /// Listed anywhere on the page. Sent and cancelled records are history.
    #[cfg(test)]
    pub(crate) fn shown(&self) -> bool {
        [Section::Attention, Section::Recurring, Section::OneTime]
            .into_iter()
            .any(|s| self.in_section(s))
    }
    pub(crate) fn status(&self, read_at: u64) -> Option<Status> {
        match self.state.as_str() {
            "pending" if self.at.is_some_and(|at| at <= read_at) => Some(Status::Overdue),
            "dispatching" => Some(Status::Sending),
            "failed" => Some(Status::Failed),
            _ => None,
        }
    }
    /// The one row action a section offers. Recurring rows use their pause switch instead.
    pub(crate) fn action(&self, section: Section) -> Option<RowAction> {
        match (section, self.recurring(), self.state.as_str()) {
            (Section::OneTime, false, "pending") => Some(RowAction::Cancel),
            (Section::Attention, false, "failed") => Some(RowAction::Dismiss),
            (Section::Attention, true, "pending") => Some(RowAction::DismissNotice),
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
            && (self.trigger == "recurring") == self.recurrence.is_some()
            && self.runs.len() <= 100
            && self
                .runs
                .iter()
                .chain(&self.notice)
                .all(|r| r.due.max(r.at) <= 8_640_000_000_000_000)
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
        Self::accept(items)
    }
    /// The control stream's `schedules` index, validated like a read.
    pub(crate) fn from_value(value: &Value) -> Result<Self, &'static str> {
        let items = Vec::<Item>::deserialize(value)
            .map_err(|_| "Local returned malformed scheduled items.")?;
        Self::accept(items)
    }
    fn accept(items: Vec<Item>) -> Result<Self, &'static str> {
        let mut ids = std::collections::HashSet::new();
        if items.len() > 1000 || items.iter().any(|s| !ids.insert(&s.id) || !s.valid()) {
            return Err(
                "Local returned invalid or duplicate scheduled items. No partial list shown.",
            );
        }
        Ok(Self { items })
    }
    /// One section's rows: one-time and active recurring rules by due time (paused
    /// rules last), needing attention newest first.
    pub(crate) fn section(&self, section: Section) -> Vec<&Item> {
        let mut rows: Vec<&Item> = self
            .items
            .iter()
            .filter(|s| s.in_section(section))
            .collect();
        match section {
            Section::OneTime => rows.sort_by_key(|s| (s.at.unwrap_or(u64::MAX), s.created_at)),
            Section::Recurring => {
                rows.sort_by_key(|s| (s.paused, s.at.unwrap_or(u64::MAX), s.created_at))
            }
            Section::Attention => rows.sort_by_key(|s| {
                std::cmp::Reverse(s.notice.as_ref().map_or(s.updated_at, |n| n.at))
            }),
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
