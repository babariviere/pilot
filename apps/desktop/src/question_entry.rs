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
