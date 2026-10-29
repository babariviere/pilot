//! Actual named children from SessionSummary.subagents, never mission members
//! or tool-call labels. Names are canonical only within their owning session.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;
use std::{collections::HashSet, sync::Arc};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) parent: String,
    pub(crate) name: String,
    pub(crate) created_at: u64,
}
impl Target {
    pub(crate) fn new(parent: &str, child: &Child) -> Option<Self> {
        Some(Self {
            parent: parent.into(),
            name: child.name.clone(),
            created_at: child.created_at?,
        })
    }
    pub(crate) fn key(&self) -> String {
        format!(
            "subagent:{}:{:016x}:{}",
            self.parent,
            self.created_at,
            URL_SAFE_NO_PAD.encode(&self.name)
        )
    }
    pub(crate) fn from_key(key: &str) -> Option<Self> {
        let mut parts = key.strip_prefix("subagent:")?.splitn(3, ':');
        let parent = parts.next()?.to_owned();
        let created_at = u64::from_str_radix(parts.next()?, 16).ok()?;
        let name = String::from_utf8(URL_SAFE_NO_PAD.decode(parts.next()?).ok()?).ok()?;
        let target = Self {
            parent,
            name,
            created_at,
        };
        (crate::local_model::valid_id(&target.parent)
            && valid_name(&target.name)
            && target.key() == key)
            .then_some(target)
    }
    pub(crate) fn child<'a>(&self, chat: &'a crate::local_model::Chat) -> Option<&'a Child> {
        (chat.id == self.parent).then_some(())?;
        chat.subagents
            .children
            .iter()
            .find(|c| c.name == self.name && c.created_at == Some(self.created_at))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Child {
    pub(crate) name: String,
    pub(crate) task: String,
    pub(crate) model: Option<String>,
    pub(crate) last_answer: Option<String>,
    pub(crate) retired: bool,
    pub(crate) created_at: Option<u64>,
    pub(crate) state: State,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum State {
    Working,
    Idle,
    Done,
    Failed,
    Retired,
    Paused,
    Unknown,
}
impl State {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Working => "Working",
            Self::Idle => "Idle",
            Self::Done => "Done",
            Self::Failed => "Failed",
            Self::Retired => "Retired",
            Self::Paused => "Paused",
            Self::Unknown => "State unknown",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Report {
    pub(crate) children: Arc<[Child]>,
    pub(crate) unavailable: bool,
}
impl Report {
    pub(crate) fn visible(&self) -> bool {
        self.unavailable || !self.children.is_empty()
    }
    pub(crate) fn summary(&self, current: bool) -> String {
        if self.unavailable {
            return "Subagents unavailable".into();
        }
        let n = self.children.len();
        let label = format!("{n} subagent{}", if n == 1 { "" } else { "s" });
        if !current {
            return format!("{label} · Last reported");
        }
        let working = self
            .children
            .iter()
            .filter(|c| c.state == State::Working)
            .count();
        let failed = self
            .children
            .iter()
            .filter(|c| c.state == State::Failed)
            .count();
        let mut parts = vec![label];
        if working > 0 {
            parts.push(format!("{working} working"));
        }
        if failed > 0 {
            parts.push(format!("{failed} failed"));
        }
        parts.join(" · ")
    }
}

pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty() && !matches!(name, "." | "..") && !name.chars().any(char::is_control)
}

pub(crate) fn read(summary: &Value) -> Report {
    let raw = &summary["subagents"];
    if raw.is_null() {
        return Report::default();
    }
    let unknown = || Report {
        unavailable: true,
        ..Report::default()
    };
    let Some(values) = raw.as_array() else {
        return unknown();
    };
    let mut names = HashSet::new();
    let mut children = Vec::new();
    for value in values {
        let Some(name) = value["name"].as_str().filter(|n| valid_name(n)) else {
            return unknown();
        };
        // A duplicate cannot safely identify a read target. Do not guess which one.
        if !names.insert(name) {
            return unknown();
        }
        let error = value["error"].as_str().map(str::to_owned);
        let created_at = value["createdAt"]
            .as_f64()
            .filter(|n| n.is_finite())
            .map(f64::to_bits);
        let state = match value["state"].as_str() {
            _ if created_at.is_none() => State::Unknown,
            Some("working")
                if summary["offlinePaused"] == true
                    || summary["sleepPaused"] == true
                    || !summary["subscriptionPause"].is_null() =>
            {
                State::Paused
            }
            Some("working")
                if summary["state"] == "parked" || summary["archivedAt"].is_number() =>
            {
                State::Unknown
            }
            Some("working") => State::Working,
            Some("idle") if error.is_some() => State::Failed,
            Some("idle") if value["retired"] == true => State::Retired,
            Some("idle")
                if value["lastAnswerId"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty()) =>
            {
                State::Done
            }
            Some("idle") => State::Idle,
            _ => State::Unknown,
        };
        children.push(Child {
            name: name.into(),
            task: value["task"].as_str().unwrap_or_default().into(),
            model: value["model"].as_str().map(str::to_owned),
            last_answer: value["lastAnswerId"].as_str().map(str::to_owned),
            retired: value["retired"] == true,
            created_at,
            state,
            error,
        });
    }
    Report {
        children: children.into(),
        unavailable: false,
    }
}

pub(crate) fn transcript(
    value: &Value,
    name: &str,
) -> Result<Vec<crate::model::Message>, &'static str> {
    if value["name"] != name || value["full"] != true {
        return Err("Subagent transcript identity is unavailable.");
    }
    let events = value["events"]
        .as_array()
        .ok_or("Subagent transcript is unavailable.")?;
    let mut model = crate::local_model::LiveTranscript::default();
    for event in events {
        model.apply(event);
    }
    Ok(model.rows())
}

#[cfg(test)]
#[path = "session_subagents_tests.rs"]
mod tests;
