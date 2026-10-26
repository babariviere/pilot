//! Immutable explicit task submission. GETs never settle a lost creation ACK.
use crate::{local_model::valid_id, mission_browser::Key, mission_conversion::trim_text};
use serde_json::Value;

pub(crate) const TITLE_UNITS: usize = 200;
pub(crate) const BODY_UNITS: usize = 8_000;
pub(crate) const WIRE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Submission {
    pub(crate) id: String,
    pub(crate) key: Key,
    pub(crate) title: String,
    pub(crate) body: String,
}
pub(crate) fn validate(title: &str, body: &str) -> Result<(), &'static str> {
    // Daemon limits apply BEFORE ECMAScript trim, in UTF-16 code units.
    if trim_text(title).is_empty() || title.encode_utf16().count() > TITLE_UNITS {
        return Err("Enter a title of 1–200 characters (UTF-16 units).");
    }
    if body.encode_utf16().count() > BODY_UNITS {
        return Err("Description exceeds 8,000 characters (UTF-16 units). Text is retained.");
    }
    Ok(())
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Created {
    pub(crate) id: String,
    pub(crate) number: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Pending,
    NotSent(&'static str),
    Unknown(&'static str),
    Created(Created),
}
pub(crate) fn acknowledge(s: &Submission, v: &Value) -> Result<Created, &'static str> {
    let id = v["id"]
        .as_str()
        .filter(|v| valid_id(v))
        .ok_or("Invalid task ID.")?;
    let number = v["number"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
        .ok_or("Invalid task number.")?;
    // MissionTask has no missionId field. Membership is the qualified, captured
    // canonical POST route, not a fabricated response field or a title lookup.
    if v["title"].as_str() != Some(trim_text(&s.title))
        || v["body"].as_str().unwrap_or("") != trim_text(&s.body)
        || !(v["body"].is_null() || v["body"].is_string())
        || v["status"] != "todo"
        || v["order"].as_f64().is_none_or(|n| !n.is_finite())
        || ["createdAt", "updatedAt"]
            .iter()
            .any(|k| v[k].as_f64().is_none_or(|n| !n.is_finite() || n < 0.))
        || [
            "sessionId",
            "phaseId",
            "milestone",
            "preferredModel",
            "preferredThinking",
            "delegatedTo",
            "completedAt",
        ]
        .iter()
        .any(|k| !v[k].is_null())
        || ["dependsOn", "decisionIds", "blockedByPhases"]
            .iter()
            .any(|k| !v[k].is_null() && v[k].as_array().is_none_or(|a| !a.is_empty()))
        || (!v["missionId"].is_null() && v["missionId"].as_str() != Some(s.key.id.as_str()))
    {
        return Err("Creation response does not acknowledge the captured task.");
    }
    Ok(Created {
        id: id.into(),
        number,
    })
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
        key: &Key,
        title: &str,
        body: &str,
    ) -> Result<Submission, &'static str> {
        if self.blocked() {
            return Err("This task was already submitted. No retry was sent.");
        }
        if !key.valid() {
            return Err("Invalid captured mission.");
        }
        validate(title, body)?;
        let s = Submission {
            id: uuid::Uuid::new_v4().to_string(),
            key: key.clone(),
            title: title.into(),
            body: body.into(),
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

#[cfg(test)]
#[path = "mission_task_create_tests.rs"]
mod tests;
