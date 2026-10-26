//! Status-only lifecycle intent and exact response capture. IDs are not replay keys.
use crate::mission_brief::Source;
use serde_json::Value;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub(crate) title: String,
    pub(crate) status: String,
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
    let title = v["title"]
        .as_str()
        .filter(|s| s.encode_utf16().count() <= 200)
        .ok_or("Invalid mission title.")?;
    Ok(Snapshot {
        title: title.into(),
        status: status.into(),
    })
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Archive,
    Reopen,
}
impl Action {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Archive => "Archive mission",
            Self::Reopen => "Reopen mission",
        }
    }
    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::Archive => "archive",
            Self::Reopen => "reopen",
        }
    }
    pub(crate) fn status(self) -> &'static str {
        match self {
            Self::Archive => "archived",
            Self::Reopen => "active",
        }
    }
    pub(crate) fn allowed(self, status: &str) -> bool {
        match self {
            Self::Archive => ["active", "done"].contains(&status),
            Self::Reopen => ["done", "archived"].contains(&status),
        }
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
        if !source.valid() || !action.allowed(&before.status) {
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
