//! Historical `pilot.question` transcript records (ask_user), shown like the
//! Swift app's question event: one "Agent asked" line that expands to the
//! formatted question. Display only: the reply is the next user message, and
//! the live Ask popup keeps its own identity in `question.rs`.
use crate::question::trim_reply;
use serde_json::Value;

pub(crate) const KIND: &str = "pilot.question";
/// Ask_user shows at most nine answers, numbered from 1 (protocol AgentQuestion).
const OPTIONS: usize = 9;
const PREVIEW: usize = 160;

/// Kernel-only model edits, not messages or reply acknowledgments. Keep the
/// original user bubble; never apply these edits to the visible transcript.
/// Unrecognized shapes still use the viewer's unsupported-entry presentation.
pub(crate) fn is_reply_bookkeeping(entry: &Value) -> bool {
    if !matches!(
        entry["kind"].as_str(),
        Some("pilot.question-reply" | "pilot.question-reply-context")
    ) || !entry["model"].as_array().is_some_and(Vec::is_empty)
        || !entry["data"].is_null()
    {
        return false;
    }
    let Some(edits) = entry["edits"].as_array().filter(|edits| edits.len() == 1) else {
        return false;
    };
    let edit = &edits[0];
    if !edit["target"]
        .as_u64()
        .is_some_and(|id| id > 0 && id < 1 << 53)
    {
        return false;
    }
    match entry["kind"].as_str() {
        Some("pilot.question-reply") => edit["action"] == "omit" && edit["messages"].is_null(),
        Some("pilot.question-reply-context") => {
            edit["action"] == "replace"
                && edit["messages"]
                    .as_array()
                    .and_then(|messages| messages.last())
                    .is_some_and(|message| {
                        message["role"] == "user" && message["content"].is_string()
                    })
        }
        _ => false,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Choice {
    pub(crate) label: String,
    pub(crate) detail: Option<String>,
    pub(crate) suggested: bool,
}

/// The stored question as the protocol and Swift's AgentQuestion read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Record {
    pub(crate) question: String,
    pub(crate) context: Option<String>,
    pub(crate) options: Vec<Choice>,
    pub(crate) multi: bool,
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(trim_reply)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

impl Record {
    /// None when the record has no readable question text, the case Swift
    /// drops silently. Callers say so instead.
    pub(crate) fn read(data: &Value) -> Option<Self> {
        let question = text(&data["question"])?;
        let options: Vec<_> = data["options"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|option| {
                Some(Choice {
                    label: text(&option["label"])?,
                    detail: text(&option["detail"]),
                    suggested: option["suggested"] == true,
                })
            })
            .take(OPTIONS)
            .collect();
        // Access requests are single choice, as in Swift.
        let multi =
            data["databaseAccess"].is_null() && data["multiSelect"] == true && options.len() > 1;
        Some(Self {
            question,
            context: text(&data["context"]),
            options,
            multi,
        })
    }

    /// Markdown for the expanded row and Copy: the question, its context,
    /// then the numbered answers it offered.
    pub(crate) fn source(&self) -> String {
        let mut out = self.question.clone();
        if let Some(context) = &self.context {
            out.push_str("\n\n");
            out.push_str(context);
        }
        if !self.options.is_empty() {
            out.push('\n');
            for (ix, option) in self.options.iter().enumerate() {
                out.push_str(&format!("\n{}. {}", ix + 1, option.label));
                if let Some(detail) = &option.detail {
                    out.push_str(": ");
                    out.push_str(detail);
                }
                if option.suggested {
                    out.push_str(" (suggested)");
                }
            }
        }
        if self.multi {
            out.push_str("\n\nSeveral answers could be picked.");
        }
        out
    }

    /// First non-empty line, whitespace collapsed, for the collapsed row.
    pub(crate) fn preview(&self) -> String {
        let line = self
            .question
            .lines()
            .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
            .find(|line| !line.is_empty())
            .unwrap_or_default();
        if line.chars().count() > PREVIEW {
            line.chars().take(PREVIEW - 1).chain(['…']).collect()
        } else {
            line
        }
    }
}

#[cfg(test)]
#[path = "question_entry_tests.rs"]
mod tests;

#[cfg(any(test, feature = "native-probes"))]
pub(crate) mod fixture {
    use serde_json::{Value, json};

    /// The exact empty-model edit pair emitted by held-inputs.ts. The context
    /// target may be outside the loaded history window; it is never UI content.
    pub(crate) fn answered(answer: &str) -> Vec<Value> {
        vec![
            json!({"id":2,"head":1,"kind":"pilot.question","model":[],"data":{
                "question":"Should this apply only to new chats, or everywhere?",
                "context":"Choose the scope before I continue.","blocking":true,
                "options":[{"label":"New chats"},{"label":"Everywhere"}]
            }}),
            json!({"id":3,"head":1,"kind":"pi.user","model":[{"role":"user","content":answer,"timestamp":1}]}),
            json!({"id":4,"head":1,"kind":"pilot.question-reply","model":[],"edits":[{"target":3,"action":"omit"}]}),
            json!({"id":6,"head":1,"kind":"pilot.question-reply-context","model":[],"edits":[{
                "target":5,"action":"replace","messages":[
                    {"role":"toolResult","toolCallId":"ask-call","toolName":"codemode","content":[{"type":"text","text":"Everywhere"}]},
                    {"role":"user","content":answer,"timestamp":2}
                ]
            }]}),
        ]
    }
}
