//! Exact-source title/body editing. Client capture IDs are not replay keys.
use crate::mission_browser::Key;
use serde_json::Value;
#[cfg(test)]
#[path = "task_edit_tests.rs"]
mod tests;
pub(crate) const TITLE_UNITS: usize = 200;
pub(crate) const BODY_UNITS: usize = 8000;
pub(crate) const WIRE_BYTES: usize = 2 * 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Content {
    pub(crate) title: String,
    pub(crate) body: String,
}
impl Content {
    pub(crate) fn capture(title: &str, body: &str) -> Result<Self, &'static str> {
        // Daemon checks raw JS length before returning trimmed text.
        if title.encode_utf16().count() > TITLE_UNITS || body.encode_utf16().count() > BODY_UNITS {
            return Err("Title is limited to 200 UTF-16 units; body to 8000. Nothing was saved.");
        }
        let title = crate::mission_conversion::trim_text(title);
        if title.is_empty() {
            return Err("A task title is required.");
        }
        Ok(Self {
            title: title.into(),
            body: crate::mission_conversion::trim_text(body).into(),
        })
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) key: Key,
    pub(crate) task: String,
    pub(crate) number: u64,
}
impl Target {
    pub(crate) fn valid(&self) -> bool {
        self.key.valid()
            && crate::local_model::valid_id(&self.task)
            && !self.task.bytes().all(|c| c.is_ascii_digit())
            && self.number > 0
            && self.number <= 1_000_000_000
    }
}
pub(crate) fn parse(source: &Target, v: &Value) -> Result<Content, &'static str> {
    if !source.valid()
        || v["id"].as_str() != Some(&source.task)
        || v["number"].as_u64() != Some(source.number)
    {
        return Err("Response belongs to another exact mission task.");
    }
    // Reads must not reuse capture's write limits or normalize stored text.
    Ok(Content {
        title: v["title"].as_str().ok_or("Invalid task title.")?.into(),
        body: if v["body"].is_null() {
            ""
        } else {
            v["body"].as_str().ok_or("Invalid task body.")?
        }
        .into(),
    })
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Save {
    pub(crate) id: String,
    pub(crate) source: Target,
    pub(crate) value: Content,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Pending,
    NotSent(&'static str),
    Unknown(&'static str),
    Saved(Content),
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
        source: &Target,
        title: &str,
        body: &str,
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
            value: Content::capture(title, body)?,
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
                Outcome::Unknown("Save response did not match the captured task text.")
            }
            o => o,
        };
        true
    }
}
