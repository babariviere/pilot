//! Explicit status intent, never a claim/release or a replayable operation.
use crate::{local_model::valid_id, mission_browser::Key};
use serde_json::Value;
#[cfg(test)]
#[path = "task_status_tests.rs"]
mod tests;

pub(crate) const STATUSES: [&str; 7] = [
    "todo",
    "in_progress",
    "blocked",
    "in_review",
    "delegated",
    "done",
    "dropped",
];
pub(crate) fn label(status: &str) -> &'static str {
    match status {
        "todo" => "To do",
        "in_progress" => "In progress",
        "blocked" => "Blocked",
        "in_review" => "In review",
        "delegated" => "Delegated",
        "done" => "Done",
        "dropped" => "Dropped",
        _ => "Unsupported status",
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) key: Key,
    pub(crate) task: String,
    pub(crate) number: u64,
    pub(crate) title: String,
    pub(crate) current: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Submission {
    pub(crate) id: String,
    pub(crate) target: Target,
    pub(crate) chosen: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Pending,
    NotSent(&'static str),
    Unknown(&'static str),
    Acknowledged,
}
pub(crate) fn valid(t: &Target, chosen: &str) -> bool {
    t.key.valid()
        && valid_id(&t.task)
        && t.number > 0
        && STATUSES.contains(&t.current.as_str())
        && STATUSES.contains(&chosen)
        && t.current != chosen
}
pub(crate) fn backward(current: &str, chosen: &str) -> bool {
    fn rank(s: &str) -> u8 {
        match s {
            "todo" => 0,
            "in_review" => 2,
            "done" | "dropped" => 3,
            _ => 1,
        }
    }
    rank(chosen) < rank(current)
}
pub(crate) fn acknowledge(s: &Submission, v: &Value) -> bool {
    // task() may project a phase-gated status over the stored value.
    (v["storedStatus"].is_null()
        || v["storedStatus"]
            .as_str()
            .is_some_and(|s| STATUSES.contains(&s)))
        && v["status"].as_str().is_some_and(|s| STATUSES.contains(&s))
        && v["id"] == s.target.task
        && v["number"].as_u64() == Some(s.target.number)
        && v["title"] == s.target.title
        && v["storedStatus"]
            .as_str()
            .unwrap_or_else(|| v["status"].as_str().unwrap_or(""))
            == s.chosen
        && (v["missionId"].is_null() || v["missionId"] == s.target.key.id)
        && v["updatedAt"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n >= 0.)
}
#[derive(Default)]
pub(crate) struct State {
    pub(crate) attempt: Option<(Submission, Outcome)>,
}
impl State {
    pub(crate) fn blocked(&self) -> bool {
        self.attempt
            .as_ref()
            .is_some_and(|(_, o)| !matches!(o, Outcome::NotSent(_)))
    }
    pub(crate) fn begin(
        &mut self,
        target: &Target,
        chosen: &str,
    ) -> Result<Submission, &'static str> {
        if self.blocked() {
            return Err("Already submitted. No retry was sent.");
        }
        if !valid(target, chosen) {
            return Err("Choose a different supported status for this exact task.");
        }
        let s = Submission {
            id: uuid::Uuid::new_v4().to_string(),
            target: target.clone(),
            chosen: chosen.into(),
        };
        self.attempt = Some((s.clone(), Outcome::Pending));
        Ok(s)
    }
    pub(crate) fn finish(&mut self, s: &Submission, outcome: Outcome) -> bool {
        let Some((pending, current)) = &mut self.attempt else {
            return false;
        };
        if pending != s || !matches!(current, Outcome::Pending) {
            return false;
        }
        *current = outcome;
        true
    }
}
