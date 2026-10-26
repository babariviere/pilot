//! Standalone empty-mission intent, retained independently of browser navigation.
use crate::{local_model::valid_id, mission_browser::Home, mission_conversion::trim_text};
use serde_json::Value;
pub(crate) const TITLE_UNITS: usize = 200;
pub(crate) const BODY_UNITS: usize = 4_000;
pub(crate) const WIRE_BYTES: usize = 256 * 1024;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Submission {
    pub(crate) id: String,
    pub(crate) home: Home,
    pub(crate) project: String,
    pub(crate) title: String,
    pub(crate) body: String,
}
pub(crate) fn validate(title: &str, goal: &str) -> Result<(), &'static str> {
    if trim_text(title).is_empty() || title.encode_utf16().count() > TITLE_UNITS {
        return Err("Enter a title of 1–200 UTF-16 units.");
    }
    if trim_text(goal).is_empty() || goal.encode_utf16().count() > BODY_UNITS {
        return Err("Enter a goal of 1–4,000 UTF-16 units.");
    }
    Ok(())
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Pending,
    NotSent(&'static str),
    Unknown(&'static str),
    Created(String),
}
pub(crate) fn acknowledge(s: &Submission, v: &Value) -> Result<String, &'static str> {
    let m = &v["mission"];
    let id = m["id"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or("Invalid mission ID.")?;
    if m["projectId"] != s.project
        || m["title"] != trim_text(&s.title)
        || m["goal"] != trim_text(&s.body)
        || m["status"] != "active"
        || !m["coordinatorSessionId"].is_null()
        || m["briefRevision"].as_u64() != Some(0)
        || ["createdAt", "updatedAt"]
            .iter()
            .any(|k| m[k].as_f64().is_none_or(|n| !n.is_finite() || n < 0.))
        || [
            "tasks",
            "phases",
            "decisions",
            "decisionProposals",
            "comments",
            "artifacts",
            "resources",
        ]
        .iter()
        .any(|k| v[k].as_array().is_none_or(|a| !a.is_empty()))
        || !v["brief"].is_null()
    {
        return Err("Response does not acknowledge the captured empty mission.");
    }
    Ok(id.into())
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
        home: &Home,
        project: &str,
        title: &str,
        body: &str,
    ) -> Result<Submission, &'static str> {
        if self.blocked() {
            return Err("Already submitted. No retry was sent.");
        }
        if !valid_id(project) {
            return Err("Select an existing Local project.");
        }
        validate(title, body)?;
        let s = Submission {
            id: uuid::Uuid::new_v4().to_string(),
            home: home.clone(),
            project: project.into(),
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
