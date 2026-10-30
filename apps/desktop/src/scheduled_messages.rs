//! Existing one-shot schedule records. Time passing is not delivery evidence.
use serde::Deserialize;
use serde_json::Value;

fn timestamp(at: u64) -> String {
    format!(
        "{} {:02}:{:02}:{:02}.{:03} UTC",
        crate::usage_overview::date(at),
        at / 3_600_000 % 24,
        at / 60_000 % 60,
        at / 1000 % 60,
        at % 1000
    )
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
    pub(crate) sleep_observed: Option<bool>,
    pub(crate) wake_observed: Option<bool>,
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
impl Item {
    pub(crate) fn status(&self) -> &str {
        match self.state.as_str() {
            "pending" => "Pending",
            "dispatching" => "Dispatching · delivery not confirmed",
            "fired" => "Dispatched · not agent completion",
            "failed" => "Failed · delivery may be uncertain",
            "cancelled" => "Cancelled",
            _ => "Unknown",
        }
    }
    pub(crate) fn when(&self, read_at: u64) -> String {
        match self.trigger.as_str() {
            "at" => self.at.map_or_else(
                || "Time not reported".into(),
                |at| {
                    format!(
                        "{}{}",
                        timestamp(at),
                        if self.state == "pending" && at < read_at {
                            " · overdue at last read, not dispatched"
                        } else {
                            ""
                        }
                    )
                },
            ),
            "on_wake" => "After sleep, on full wake".into(),
            "on_online" => "When back online".into(),
            "on_back" => "After sleep, full wake and online".into(),
            "removed" => "Removed trigger".into(),
            _ => format!("Unknown trigger: {}", self.trigger),
        }
    }
    pub(crate) fn target_label(&self) -> String {
        match &self.target {
            Target::Message { session_id, .. } => format!("Message to chat {session_id}"),
            Target::Chat { .. } => "New chat (not an existing chat)".into(),
        }
    }
    pub(crate) fn details(&self, read_at: u64) -> String {
        let target = match &self.target {
            Target::Message {
                session_id,
                message,
            } => format!("Target chat: {session_id}\nMessage:\n{message}"),
            Target::Chat {
                spawn,
                tracked_item_id,
            } => format!(
                "New-chat request:\n{}\nTracked item: {}",
                serde_json::to_string_pretty(spawn).unwrap_or_default(),
                tracked_item_id.as_deref().unwrap_or("Not reported")
            ),
        };
        format!(
            "{}\n{}\n{}\nProject ID: {}\nSchedule ID: {}\nRevision: {}\nReported state: {}\nTrigger: {}\nCreated: {}\nUpdated: {}\nClaimed: {}\nDispatched: {}\nResult/target chat ID: {}\nSleep observed: {}\nFull wake observed: {}\n{}",
            self.title,
            self.status(),
            self.when(read_at),
            self.project_id.as_deref().unwrap_or("Not reported"),
            self.id,
            self.revision,
            self.state,
            self.trigger,
            timestamp(self.created_at),
            timestamp(self.updated_at),
            self.claimed_at
                .map_or_else(|| "Not reported".into(), timestamp),
            self.fired_at
                .map_or_else(|| "Not reported".into(), timestamp),
            self.session_id.as_deref().unwrap_or("Not reported"),
            self.sleep_observed
                .map_or("Not reported", |v| if v { "Yes" } else { "No" }),
            self.wake_observed
                .map_or("Not reported", |v| if v { "Yes" } else { "No" }),
            target
        )
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
        if items.len() > 1000
            || items.iter().any(|s| {
                s.id.is_empty()
                    || !ids.insert(&s.id)
                    || s.revision == 0
                    || s.revision > 9_007_199_254_740_991
                    || [
                        Some(s.created_at),
                        Some(s.updated_at),
                        s.at,
                        s.claimed_at,
                        s.fired_at,
                    ]
                    .into_iter()
                    .flatten()
                    .any(|at| at > 8_640_000_000_000_000)
                    || (s.trigger == "at" && s.at.is_none())
                    || match &s.target {
                        Target::Message { session_id, .. } => {
                            session_id.is_empty()
                                || s.session_id.as_ref().is_some_and(|id| id != session_id)
                        }
                        Target::Chat { spawn, .. } => {
                            !spawn.is_object() || !spawn["message"].is_string()
                        }
                    }
            })
        {
            return Err(
                "Local returned invalid or duplicate scheduled items. No partial list shown.",
            );
        }
        Ok(Self { items })
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
