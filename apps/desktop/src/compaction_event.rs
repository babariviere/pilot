//! Context compaction and reset markers (`pi.compaction`, `pi.reset`),
//! shown like the Swift app's ChatEventRow: one quiet "Context compacted"
//! line, with before/after tokens only when the daemon reported both, that
//! expands to the summary. Display only. The kernel decorates compactions with
//! `tokensBefore`/`tokensAfter`/`tokensEstimated`; durable compaction
//! records `reason`. Nothing here infers savings, progress or fresh usage.
use serde_json::Value;

pub(crate) const COMPACTION: &str = "pi.compaction";
pub(crate) const RESET: &str = "pi.reset";
/// The durable harness wraps every summary it places in this exact text.
const SUMMARY_PREFIX: &str = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX: &str = "\n</summary>";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Compacted,
    Handoff,
    Reset,
}

/// The durable task's recorded trigger. Other values are not named.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reason {
    Manual,
    Threshold,
    Overflow,
}
impl Reason {
    fn read(value: &Value) -> Option<Self> {
        Some(match value.as_str()? {
            "manual" => Self::Manual,
            "threshold" => Self::Threshold,
            "overflow" => Self::Overflow,
            _ => return None,
        })
    }
    pub(crate) fn text(self) -> &'static str {
        match self {
            Self::Manual => "Requested manually.",
            Self::Threshold => "Started automatically near the context limit.",
            Self::Overflow => "Started automatically after the context overflowed.",
        }
    }
}

/// Reported context size before and after. Swift requires both.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Tokens {
    pub(crate) before: u64,
    pub(crate) after: u64,
    pub(crate) estimated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Event {
    pub(crate) kind: Kind,
    pub(crate) reason: Option<Reason>,
    pub(crate) tokens: Option<Tokens>,
    /// The exact stored text: `data.summary`, else the entry's message text
    /// (Swift's order). None when there is none, as for a plain reset.
    pub(crate) text: Option<String>,
}

/// Swift's compact count: whole thousands as "k".
fn count(value: u64) -> String {
    if value >= 1000 {
        format!("{}k", value / 1000)
    } else {
        value.to_string()
    }
}

fn message_text(message: &Value) -> String {
    match &message["content"] {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect(),
        _ => String::new(),
    }
}

impl Event {
    /// Some only for compaction and reset entries.
    pub(crate) fn read(entry: &Value) -> Option<Self> {
        let kind = match entry["kind"].as_str()? {
            COMPACTION if entry["data"]["mode"] == "handoff" => Kind::Handoff,
            COMPACTION => Kind::Compacted,
            RESET => Kind::Reset,
            _ => return None,
        };
        let data = &entry["data"];
        let tokens = match (data["tokensBefore"].as_u64(), data["tokensAfter"].as_u64()) {
            (Some(before), Some(after)) if kind == Kind::Compacted => Some(Tokens {
                before,
                after,
                estimated: data["tokensEstimated"] == true,
            }),
            _ => None,
        };
        let text = data["summary"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                let messages = entry["model"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                // Carried user messages already appear at their original history entries.
                let messages = if kind == Kind::Handoff {
                    &messages[..messages.len().min(1)]
                } else {
                    messages
                };
                messages
                    .iter()
                    .map(message_text)
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n")
            });
        Some(Self {
            kind,
            reason: (kind == Kind::Compacted)
                .then(|| Reason::read(&data["reason"]))
                .flatten(),
            tokens,
            text: (!text.trim().is_empty()).then_some(text),
        })
    }

    pub(crate) fn heading(&self) -> &'static str {
        match self.kind {
            Kind::Compacted => "Context compacted",
            Kind::Handoff => "Context handoff",
            Kind::Reset => "Context reset",
        }
    }

    /// "120k to 30k tokens", with "about" when the counts are estimates.
    pub(crate) fn metrics(&self) -> Option<String> {
        self.tokens.map(|t| {
            format!(
                "{}{} to {} tokens",
                if t.estimated { "about " } else { "" },
                count(t.before),
                count(t.after)
            )
        })
    }

    /// The collapsed line.
    pub(crate) fn sentence(&self) -> String {
        match self.metrics() {
            Some(metrics) => format!("{} · {metrics}", self.heading()),
            None => self.heading().into(),
        }
    }

    /// Summary Markdown to show: the harness wrapper removed when it is
    /// exactly present, else the stored text as is. Copy keeps `text`.
    pub(crate) fn detail(&self) -> Option<&str> {
        let text = self.text.as_deref()?;
        Some(
            text.strip_prefix(SUMMARY_PREFIX)
                .and_then(|inner| inner.strip_suffix(SUMMARY_SUFFIX))
                .filter(|inner| !inner.trim().is_empty())
                .unwrap_or(text),
        )
    }

    /// Tooltip and accessible text: everything the line leaves out.
    pub(crate) fn help(&self) -> String {
        [
            Some(self.sentence()),
            self.reason.map(|r| r.text().to_owned()),
            self.tokens
                .filter(|t| t.estimated)
                .map(|_| "Token counts are estimates.".to_owned()),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ")
    }
}

#[cfg(test)]
#[path = "compaction_event_tests.rs"]
mod tests;
