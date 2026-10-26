//! Future-chat preferences only. Capture identity is not a replay key or CAS.
use crate::{
    chat_models::{Catalog, Choice},
    task_edit::Target,
};
use serde_json::Value;
pub(crate) const WIRE_BYTES: usize = 2 * 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub(crate) struct Preference {
    pub(crate) model: Option<String>,
    pub(crate) thinking: Option<String>,
}
impl Preference {
    pub(crate) fn valid(&self) -> bool {
        self.model
            .as_deref()
            .is_none_or(|m| crate::chat_models::model_id(m) && m.encode_utf16().count() <= 256)
            && self.thinking.as_deref().is_none_or(|t| {
                !t.is_empty() && t.encode_utf16().count() <= 32 && !t.chars().any(char::is_control)
            })
            && (self.model.is_some() || self.thinking.is_none())
    }
    pub(crate) fn admitted(&self, catalog: &Catalog) -> bool {
        self.valid()
            && self.model.as_ref().is_none_or(|m| {
                catalog.admits(&Choice {
                    model: m.clone(),
                    thinking: self.thinking.clone(),
                })
            })
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Source {
    pub(crate) target: Target,
    pub(crate) project: String,
}
impl Source {
    pub(crate) fn valid(&self) -> bool {
        self.target.valid() && crate::local_model::valid_id(&self.project)
    }
}
pub(crate) struct Loaded {
    pub(crate) source: Source,
    pub(crate) title: String,
    pub(crate) value: Preference,
    pub(crate) catalog: Catalog,
}
pub(crate) fn parse(target: &Target, v: &Value) -> Result<Preference, &'static str> {
    if !target.valid() || v["id"] != target.task || v["number"].as_u64() != Some(target.number) {
        return Err("Wrong exact task identity.");
    }
    let field = |name: &str| -> Result<Option<String>, &'static str> {
        if v[name].is_null() {
            Ok(None)
        } else {
            v[name]
                .as_str()
                .map(|s| Some(s.into()))
                .ok_or("Malformed task preference.")
        }
    };
    let p = Preference {
        model: field("preferredModel")?,
        thinking: field("preferredThinking")?,
    };
    if !p.valid() {
        return Err("Malformed task preference.");
    }
    Ok(p)
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Save {
    pub(crate) id: String,
    pub(crate) source: Source,
    pub(crate) value: Preference,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Pending,
    NotSent(&'static str),
    Unknown(&'static str),
    Saved,
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
        value: &Preference,
        catalog: &Catalog,
    ) -> Result<Save, &'static str> {
        if self.blocked() || !source.valid() || !value.admitted(catalog) {
            return Err("This preference cannot be saved or replayed. Review the retained choice.");
        }
        let s = Save {
            id: uuid::Uuid::new_v4().to_string(),
            source: source.clone(),
            value: value.clone(),
        };
        self.attempt = Some((s.clone(), Outcome::Pending));
        Ok(s)
    }
    pub(crate) fn finish(&mut self, s: &Save, o: Outcome) -> bool {
        let Some((_, current)) = self
            .attempt
            .as_mut()
            .filter(|(a, o)| a == s && matches!(o, Outcome::Pending))
        else {
            return false;
        };
        *current = o;
        true
    }
}
pub(crate) fn ack(s: &Save, v: &Value) -> bool {
    v["operationId"] == s.id
        && v["missionId"] == s.source.target.key.id
        && v["projectId"] == s.source.project
        && v["home"]["daemonId"] == s.source.target.key.home.daemon
        && v["home"]["lineageId"] == s.source.target.key.home.lineage
        && parse(&s.source.target, &v["task"]).as_ref() == Ok(&s.value)
        && (s.value.model.is_none() || v["task"]["preferredModelSetBy"] == "user")
}
#[cfg(test)]
#[path = "task_model_tests.rs"]
mod tests;
