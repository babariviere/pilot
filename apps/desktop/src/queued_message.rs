//! Exact USER queue captures. Never converts a missing/changed row into a send.
use crate::delivery_store::Host;
use serde_json::Value;
pub(crate) const TEXT_BYTES: usize = 64 * 1024;
pub(crate) const SNAPSHOT_BYTES: usize = 512 * 1024;
pub(crate) const ROW_LIMIT: usize = 128;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Row {
    pub(crate) id: u64,
    pub(crate) mode: String,
    pub(crate) content: Value,
    pub(crate) token: Option<String>,
}
impl Row {
    fn guarded(&self) -> bool {
        self.id > 0
            && self.id <= 9_007_199_254_740_991
            && matches!(self.mode.as_str(), "steer" | "followUp")
            && self.token.as_ref().is_some_and(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            })
    }
    pub(crate) fn text(&self) -> Option<&str> {
        self.content.as_str().filter(|s| s.len() <= TEXT_BYTES)
    }
    pub(crate) fn preview(&self) -> String {
        if let Some(text) = self.content.as_str() {
            return text.chars().take(160).collect();
        }
        let mut preview = String::new();
        if let Some(parts) = self.content.as_array() {
            for text in parts.iter().filter_map(|p| p["text"].as_str()).take(4) {
                let remaining = 160usize.saturating_sub(preview.chars().count());
                if remaining == 0 {
                    break;
                }
                preview.extend(text.chars().take(remaining));
            }
        }
        if preview.is_empty() {
            "Structured message (attachments or unsupported content)".into()
        } else {
            format!("{preview} · structured message")
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub(crate) rows: Vec<Row>,
    pub(crate) unavailable: bool,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            rows: vec![],
            unavailable: true,
        }
    }
}
impl Snapshot {
    pub(crate) fn read(v: &Value) -> Self {
        let parse = || -> Option<Vec<Row>> {
            let rows = v.as_array().filter(|r| r.len() <= ROW_LIMIT)?;
            if serde_json::to_vec(v).ok()?.len() > SNAPSHOT_BYTES {
                return None;
            }
            let mut ids = std::collections::HashSet::new();
            rows.iter()
                .map(|r| {
                    let id = r["id"]
                        .as_u64()
                        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)?;
                    if !ids.insert(id) {
                        return None;
                    }
                    let mode = r["mode"]
                        .as_str()
                        .filter(|s| matches!(*s, "steer" | "followUp"))?
                        .to_owned();
                    let content = r.get("content")?.clone();
                    let token = r["guardToken"]
                        .as_str()
                        .filter(|s| {
                            s.len() == 64
                                && s.bytes()
                                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                        })
                        .map(str::to_owned);
                    Some(Row {
                        id,
                        mode,
                        content,
                        token,
                    })
                })
                .collect()
        };
        match parse() {
            Some(rows) => Self {
                rows,
                unavailable: false,
            },
            None => Self {
                rows: vec![],
                unavailable: true,
            },
        }
    }
}
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Source {
    pub(crate) home: Host,
    pub(crate) chat: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Change {
    Edit { text: String, mode: Option<String> },
    Remove,
}
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Operation {
    pub(crate) id: String,
    pub(crate) source: Source,
    pub(crate) row: Row,
    pub(crate) change: Change,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Pending,
    NotSent(&'static str),
    Unknown(&'static str),
    Acknowledged,
}
#[derive(Default)]
pub(crate) struct State {
    pub(crate) attempt: Option<(Operation, Outcome)>,
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
        row: &Row,
        change: Change,
    ) -> Result<Operation, &'static str> {
        if self.blocked() {
            return Err("This operation cannot be replayed. Its receipt is retained.");
        }
        if !crate::local_model::valid_id(&source.chat) || !row.guarded() {
            return Err("Safe queue admission is unavailable. Nothing sent.");
        }
        if let Change::Edit { text, mode } = &change {
            if row.text().is_none() {
                return Err(
                    "Structured or oversized messages cannot be edited as text. Original content is retained.",
                );
            }
            if text.len() > TEXT_BYTES || crate::mission_conversion::trim_text(text).is_empty() {
                return Err(
                    "Enter a message of at most 64 KiB. Empty text does not remove a message.",
                );
            }
            if mode
                .as_deref()
                .is_some_and(|m| !matches!(m, "steer" | "followUp"))
            {
                return Err("Invalid delivery mode.");
            }
        }
        let op = Operation {
            id: uuid::Uuid::new_v4().to_string(),
            source: source.clone(),
            row: row.clone(),
            change,
        };
        self.attempt = Some((op.clone(), Outcome::Pending));
        Ok(op)
    }
    pub(crate) fn finish(&mut self, op: &Operation, outcome: Outcome) -> bool {
        let Some((_, current)) = self
            .attempt
            .as_mut()
            .filter(|(o, r)| o == op && matches!(r, Outcome::Pending))
        else {
            return false;
        };
        *current = outcome;
        true
    }
}
#[cfg(test)]
#[path = "queued_message_tests.rs"]
mod tests;
