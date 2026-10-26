//! Exact-source title/goal editing. Client capture IDs are not replay keys.
use crate::mission_brief::Source;
use serde_json::Value;
#[cfg(test)]
#[path = "mission_metadata_tests.rs"]
mod tests;
pub(crate) const TITLE_UNITS: usize = 200;
pub(crate) const GOAL_UNITS: usize = 4000;
pub(crate) const WIRE_BYTES: usize = 2 * 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Metadata {
    pub(crate) title: String,
    pub(crate) goal: String,
}
impl Metadata {
    pub(crate) fn capture(title: &str, goal: &str) -> Result<Self, &'static str> {
        // Daemon checks raw JS length before returning trimmed text.
        if title.encode_utf16().count() > TITLE_UNITS || goal.encode_utf16().count() > GOAL_UNITS {
            return Err("Title is limited to 200 UTF-16 units; goal to 4000. Nothing was saved.");
        }
        let title = crate::mission_conversion::trim_text(title);
        if title.is_empty() {
            return Err("A mission title is required.");
        }
        Ok(Self {
            title: title.into(),
            goal: crate::mission_conversion::trim_text(goal).into(),
        })
    }
}
pub(crate) fn parse(source: &Source, v: &Value) -> Result<Metadata, &'static str> {
    if !source.valid()
        || v["id"].as_str() != Some(&source.key.id)
        || v["projectId"].as_str() != Some(&source.project)
    {
        return Err("Metadata response belongs to another canonical mission.");
    }
    Metadata::capture(
        v["title"].as_str().ok_or("Invalid mission title.")?,
        v["goal"].as_str().ok_or("Invalid mission goal.")?,
    )
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Save {
    pub(crate) id: String,
    pub(crate) source: Source,
    pub(crate) value: Metadata,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Pending,
    NotSent(&'static str),
    Unknown(&'static str),
    Saved(Metadata),
}
#[derive(Default)]
pub(crate) struct State {
    pub(crate) attempt: Option<(Save, Outcome)>,
}
impl State {
    pub(crate) fn blocked(&self) -> bool {
        self.attempt
            .as_ref()
            .is_some_and(|(_, o)| !matches!(o, Outcome::NotSent(_)))
    }
    pub(crate) fn begin(
        &mut self,
        source: &Source,
        title: &str,
        goal: &str,
    ) -> Result<Save, &'static str> {
        if self.blocked() {
            return Err("This save is pending, acknowledged or uncertain. It cannot be replayed.");
        }
        if !source.valid() {
            return Err("Invalid canonical mission source.");
        }
        let s = Save {
            id: uuid::Uuid::new_v4().to_string(),
            source: source.clone(),
            value: Metadata::capture(title, goal)?,
        };
        self.attempt = Some((s.clone(), Outcome::Pending));
        Ok(s)
    }
    pub(crate) fn finish(&mut self, s: &Save, outcome: Outcome) -> bool {
        let Some((save, current)) = self
            .attempt
            .as_mut()
            .filter(|(save, o)| save == s && matches!(o, Outcome::Pending))
        else {
            return false;
        };
        *current = match outcome {
            Outcome::Saved(m) if m != save.value => {
                Outcome::Unknown("Save response did not match the captured metadata.")
            }
            o => o,
        };
        true
    }
}
