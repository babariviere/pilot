//! One explicit user-authored update. Reads cannot settle a missing POST receipt.
use crate::{mission_browser::Key, mission_conversion::trim_text};
use serde_json::Value;

pub(crate) const TEXT_UNITS: usize = 8_000;
pub(crate) const WIRE_BYTES: usize = 64 * 1024;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Submission {
    pub(crate) id: String,
    pub(crate) key: Key,
    pub(crate) text: String,
}
pub(crate) fn validate(text: &str) -> Result<(), &'static str> {
    if trim_text(text).is_empty() || text.encode_utf16().count() > TEXT_UNITS {
        return Err("Enter an update of 1–8,000 characters (UTF-16 units). Text is retained.");
    }
    Ok(())
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Pending,
    NotSent(&'static str),
    Unknown(&'static str),
    Acknowledged(u64),
}
pub(crate) fn acknowledge(s: &Submission, v: &Value) -> Result<u64, &'static str> {
    let id = v["id"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991);
    if v["kind"] != "update"
        || v["text"].as_str() != Some(trim_text(&s.text))
        || ["sessionId", "taskId", "health"]
            .iter()
            .any(|k| !v[k].is_null())
        || v["at"].as_f64().is_none_or(|n| !n.is_finite() || n < 0.)
    {
        return Err("Response does not acknowledge the captured user update.");
    }
    id.ok_or("Invalid event ID.")
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
    pub(crate) fn begin(&mut self, key: &Key, text: &str) -> Result<Submission, &'static str> {
        if self.blocked() {
            return Err("This update was already submitted. No retry was sent.");
        }
        if !key.valid() {
            return Err("Invalid captured mission.");
        }
        validate(text)?;
        let s = Submission {
            id: uuid::Uuid::new_v4().to_string(),
            key: key.clone(),
            text: text.into(),
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
#[path = "mission_update_tests.rs"]
mod tests;
