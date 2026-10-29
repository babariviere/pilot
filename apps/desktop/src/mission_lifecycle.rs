//! Status-only lifecycle intent and exact response capture. IDs are not replay keys.
use crate::mission_brief::Source;
use serde_json::Value;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) finished: Option<Finished>,
}
/// Derived from the unfiltered whole task catalog, never a rendered task preview.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Finished {
    pub(crate) done: usize,
    pub(crate) dropped: usize,
}
pub(crate) fn finished(v: &Value) -> Option<Finished> {
    if v["truncated"] == true {
        return None;
    }
    let tasks = v["tasks"].as_array()?;
    let mut ids = std::collections::HashSet::new();
    let mut done = 0;
    let mut dropped = 0;
    for t in tasks {
        let id = t["id"]
            .as_str()
            .filter(|s| crate::local_model::valid_id(s))?;
        if !ids.insert(id) {
            return None;
        }
        match if t["storedStatus"].is_null() {
            t["status"].as_str()?
        } else {
            t["storedStatus"].as_str()?
        } {
            "done" => done += 1,
            "dropped" => dropped += 1,
            _ => return None,
        }
    }
    // Detail GET is unpaged. Cross-check its independently reported non-dropped totals.
    (done > 0
        && v["mission"]["tasksTotal"].as_u64() == Some(done as u64)
        && v["mission"]["tasksDone"].as_u64() == Some(done as u64))
    .then_some(Finished { done, dropped })
}
pub(crate) fn detail(s: &Source, v: &Value) -> Result<Snapshot, &'static str> {
    let mut snapshot = parse(s, &v["mission"])?;
    snapshot.finished = finished(v);
    Ok(snapshot)
}
pub(crate) fn parse(s: &Source, v: &Value) -> Result<Snapshot, &'static str> {
    if !s.valid()
        || v["id"].as_str() != Some(&s.key.id)
        || v["projectId"].as_str() != Some(&s.project)
    {
        return Err("Response does not identify the captured canonical mission.");
    }
    let status = v["status"]
        .as_str()
        .filter(|s| ["active", "done", "archived"].contains(s))
        .ok_or("Invalid mission status.")?;
    let title = v["title"].as_str().ok_or("Invalid mission title.")?;
    Ok(Snapshot {
        title: title.into(),
        status: status.into(),
        finished: None,
    })
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Complete,
    Archive,
    Reopen,
}
impl Action {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Complete => "Mark done",
            Self::Archive => "Archive mission",
            Self::Reopen => "Reopen mission",
        }
    }
    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Archive => "archive",
            Self::Reopen => "reopen",
        }
    }
    pub(crate) fn status(self) -> &'static str {
        match self {
            Self::Complete => "done",
            Self::Archive => "archived",
            Self::Reopen => "active",
        }
    }
    pub(crate) fn allowed(self, status: &str) -> bool {
        match self {
            Self::Complete => status == "active",
            Self::Archive => ["active", "done"].contains(&status),
            Self::Reopen => ["done", "archived"].contains(&status),
        }
    }
    pub(crate) fn eligible(self, snapshot: &Snapshot) -> bool {
        self.allowed(&snapshot.status) && (self != Self::Complete || snapshot.finished.is_some())
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Send {
    pub(crate) id: String,
    pub(crate) source: Source,
    pub(crate) before: Snapshot,
    pub(crate) action: Action,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Pending,
    NotSent(&'static str),
    Unknown(&'static str),
    Ack,
}
#[derive(Default)]
pub(crate) struct State {
    pub(crate) attempt: Option<(Send, Outcome)>,
}
impl State {
    pub(crate) fn begin(
        &mut self,
        source: &Source,
        before: &Snapshot,
        action: Action,
    ) -> Result<Send, &'static str> {
        if self.attempt.is_some() {
            return Err(
                "This captured action cannot be replayed. Close and inspect its retained outcome.",
            );
        }
        if !source.valid() || !action.eligible(before) {
            return Err("Lifecycle transition is unavailable.");
        }
        let send = Send {
            id: uuid::Uuid::new_v4().to_string(),
            source: source.clone(),
            before: before.clone(),
            action,
        };
        self.attempt = Some((send.clone(), Outcome::Pending));
        Ok(send)
    }
    pub(crate) fn finish(&mut self, send: &Send, outcome: Outcome) -> bool {
        let Some((_, current)) = self
            .attempt
            .as_mut()
            .filter(|(s, o)| s == send && matches!(o, Outcome::Pending))
        else {
            return false;
        };
        *current = outcome;
        true
    }
}
#[cfg(test)]
#[path = "mission_lifecycle_tests.rs"]
mod tests;
