//! Bounded structured ask_user metadata and Swift-compatible reply formatting.
//! This is presentation/private identity, never backend answer or grant authority.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::Arc};

type Failure = &'static str;
const OPTIONS: usize = 9;
const METADATA_BYTES: usize = 20 * 1024;
pub(crate) const REPLY_BYTES: usize = 32 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Identity {
    pub(crate) entry: u64,
    pub(crate) fingerprint: String,
}
#[derive(Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Choice {
    pub(crate) label: String,
    pub(crate) detail: Option<String>,
    pub(crate) suggested: bool,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) enum Kind {
    Message,
    AccessUnavailable,
}
#[derive(Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Content {
    pub(crate) question: String,
    pub(crate) context: Option<String>,
    pub(crate) options: Vec<Choice>,
    pub(crate) multi: bool,
    pub(crate) kind: Kind,
}
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Question {
    pub(crate) identity: Identity,
    pub(crate) content: Content,
}

/// Foundation's whitespaceAndNewline set includes U+200B, unlike Rust trim.
/// Confirmed using the installed SDK enum and actual CoreFoundation membership.
pub(crate) fn trim_reply(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{200b}')
}
fn text(value: &Value, limit: usize) -> Result<String, Failure> {
    let s = trim_reply(value.as_str().ok_or("Question text is invalid")?);
    if s.encode_utf16().count() > limit {
        return Err("Question metadata exceeds supported limits");
    }
    Ok(s.into())
}
fn optional(value: &Value, limit: usize) -> Result<Option<String>, Failure> {
    if !value.is_string() {
        return Ok(None);
    }
    let s = text(value, limit)?;
    Ok((!s.is_empty()).then_some(s))
}
impl Question {
    pub(crate) fn parse(entry: u64, data: &Value) -> Result<Self, Failure> {
        if entry == 0 || entry > 9_007_199_254_740_991 {
            return Err("Question identity is invalid");
        }
        let question = text(&data["question"], 300)?;
        if question.is_empty() {
            return Err("Question is empty");
        }
        let context = optional(&data["context"], 600)?;
        let mut options = Vec::new();
        if let Some(values) = data["options"].as_array() {
            if values.len() > 64 {
                return Err("Question option metadata exceeds supported limits");
            }
            for value in values {
                let Some(label) = value["label"].as_str() else {
                    continue;
                };
                let label = trim_reply(label);
                if label.is_empty() {
                    continue;
                }
                if label.encode_utf16().count() > 120 {
                    return Err("Question answer label exceeds supported limits");
                }
                options.push(Choice {
                    label: label.into(),
                    detail: optional(&value["detail"], 240)?,
                    suggested: value["suggested"] == true,
                });
                if options.len() == OPTIONS {
                    break;
                }
            }
        }
        // Any access marker, including malformed metadata, must never become
        // a generic message-based grant/deny surface.
        let kind = if data["databaseAccess"].is_null() {
            Kind::Message
        } else {
            Kind::AccessUnavailable
        };
        let multi = kind == Kind::Message && data["multiSelect"] == true && options.len() > 1;
        let content = Content {
            question,
            context,
            options,
            multi,
            kind,
        };
        let bytes =
            serde_json::to_vec(&content).map_err(|_| "Question metadata cannot be encoded")?;
        if bytes.len() > METADATA_BYTES {
            return Err("Question metadata exceeds supported limits");
        }
        let fingerprint = format!("{:x}", Sha256::digest(bytes));
        Ok(Self {
            identity: Identity { entry, fingerprint },
            content,
        })
    }
    pub(crate) fn reply(
        &self,
        selected: &BTreeSet<usize>,
        own: &str,
    ) -> Result<Option<String>, Failure> {
        if self.content.kind != Kind::Message {
            return Err("Database access decisions are not supported here");
        }
        if own.len() > REPLY_BYTES {
            return Err("Question reply exceeds 32 KiB; preserve the ordinary draft");
        }
        if selected.iter().any(|ix| *ix >= self.content.options.len())
            || (!self.content.multi && selected.len() > 1)
        {
            return Err("Question selection no longer matches its answers");
        }
        let mut parts = Vec::new();
        if !selected.is_empty() {
            let labels = selected
                .iter()
                .map(|ix| self.content.options[*ix].label.as_str());
            parts.push(if selected.len() > 1 {
                labels
                    .map(|s| format!("- {s}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                labels.collect::<Vec<_>>().join("")
            });
        }
        let own = trim_reply(own);
        if !own.is_empty() {
            parts.push(own.into());
        }
        if parts.is_empty() {
            return Ok(None);
        }
        let reply = parts.join("\n\n");
        if reply.len() > REPLY_BYTES {
            return Err("Combined question reply exceeds 32 KiB");
        }
        Ok(Some(reply))
    }
}

/// Two canonical markers, not another history buffer. Reset with the source
/// snapshot; unordered prefix/compaction entries cannot resurrect an answer.
#[derive(Clone, Default)]
pub(crate) struct Pending {
    latest: Option<(u64, Result<Arc<Question>, Failure>)>,
    user: u64,
    invalid: bool,
}
#[derive(Clone, Default)]
pub(crate) enum Projection {
    #[default]
    Unavailable,
    None,
    Pending(Arc<Question>),
    Invalid(Failure),
}
impl Pending {
    pub(crate) fn merge(&mut self, other: Self) {
        if let Some((id, result)) = other.latest
            && self
                .latest
                .as_ref()
                .is_none_or(|(current, _)| id > *current)
        {
            self.latest = Some((id, result));
        }
        self.user = self.user.max(other.user);
        self.invalid |= other.invalid;
    }
    pub(crate) fn observe(&mut self, entry: &Value) {
        let kind = entry["kind"].as_str().unwrap_or("");
        let actual_user = kind != "pi.compaction"
            && entry["model"]
                .as_array()
                .is_some_and(|messages| messages.iter().any(|m| m["role"] == "user"));
        let Some(id) = entry["id"].as_u64().filter(|id| *id > 0 && *id < 1 << 53) else {
            if kind == "pilot.question" || actual_user {
                self.invalid = true;
            }
            return;
        };
        if kind == "pilot.question" {
            if self.latest.as_ref().is_none_or(|(old, _)| id > *old) {
                self.latest = Some((id, Question::parse(id, &entry["data"]).map(Arc::new)));
            }
        } else if actual_user {
            self.user = self.user.max(id);
        }
    }
    pub(crate) fn current(&self) -> Result<Option<Arc<Question>>, Failure> {
        if self.invalid {
            return Err("Question identity metadata is invalid");
        }
        match &self.latest {
            Some((id, result)) if *id > self.user => result.clone().map(Some),
            _ => Ok(None),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplyIdentity {
    pub(crate) question: Identity,
    pub(crate) revision: u64,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnswerDraft {
    pub(crate) identity: ReplyIdentity,
    pub(crate) selected: BTreeSet<usize>,
    /// Bounded captured labels permit copying an unsent old reply after its
    /// canonical question is replaced, without retaining full question source.
    pub(crate) labels: Vec<String>,
    pub(crate) text: String,
}
impl Identity {
    pub(crate) fn validate(&self) -> Result<(), Failure> {
        if self.entry == 0
            || self.entry >= 1 << 53
            || self.fingerprint.len() != 64
            || !self
                .fingerprint
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err("Stored question identity is invalid");
        }
        Ok(())
    }
}
impl ReplyIdentity {
    pub(crate) fn validate(&self) -> Result<(), Failure> {
        self.question.validate()?;
        if self.revision >= 1 << 53 {
            return Err("Question reply revision is invalid");
        }
        Ok(())
    }
}
impl AnswerDraft {
    pub(crate) fn has_content(&self) -> bool {
        !self.text.is_empty() || !self.labels.is_empty()
    }
    pub(crate) fn capture(
        question: &Question,
        revision: u64,
        selected: BTreeSet<usize>,
        text: String,
    ) -> Result<Self, Failure> {
        if question.content.kind != Kind::Message {
            return Err("Access decisions cannot be answered with a message");
        }
        if selected
            .iter()
            .any(|ix| *ix >= question.content.options.len())
            || (!question.content.multi && selected.len() > 1)
        {
            return Err("Question selection no longer matches its answers");
        }
        let labels = selected
            .iter()
            .map(|ix| question.content.options[*ix].label.clone())
            .collect();
        let draft = Self {
            identity: ReplyIdentity {
                question: question.identity.clone(),
                revision,
            },
            selected,
            labels,
            text,
        };
        draft.validate()?;
        Ok(draft)
    }
    pub(crate) fn validate(&self) -> Result<(), Failure> {
        self.identity.question.validate()?;
        if self.identity.revision >= 1 << 53
            || self.text.len() > REPLY_BYTES
            || self.labels.len() != self.selected.len()
            || self.labels.len() > OPTIONS
            || self.selected.iter().any(|ix| *ix >= OPTIONS)
            || self.labels.iter().any(|label| {
                label.is_empty() || label.encode_utf16().count() > 120 || trim_reply(label) != label
            })
        {
            return Err("Question reply draft exceeds private limits");
        }
        Ok(())
    }
    pub(crate) fn reply(&self, question: &Question) -> Result<Option<String>, Failure> {
        self.validate()?;
        if question.identity != self.identity.question {
            return Err("Question changed; the original reply draft is retained");
        }
        let expected = self
            .selected
            .iter()
            .filter_map(|ix| question.content.options.get(*ix).map(|o| o.label.clone()))
            .collect::<Vec<_>>();
        if expected != self.labels {
            return Err("Question answers changed; the original reply is retained");
        }
        question.reply(&self.selected, &self.text)
    }
    pub(crate) fn recovery(&self) -> String {
        let picked = if self.labels.len() > 1 {
            self.labels
                .iter()
                .map(|s| format!("- {s}"))
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            self.labels.join("")
        };
        let own = self.text.as_str();
        [picked.as_str(), own]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

#[cfg(test)]
#[path = "question_tests.rs"]
mod tests;
