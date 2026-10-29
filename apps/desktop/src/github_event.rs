//! Swift `GitHubAction`/`ChatEvent` parity: the kernel's sanitized execution
//! audit (`github_actions_update`) as quiet inline transcript events. The audit
//! is the authority: outcome comes only from its recorded exit status, never
//! from command text or output, and an unknown status never reads as success.
use crate::model::{Message, ReaderKey};
use serde_json::Value;
use std::collections::HashMap;

/// The kernel retains the newest 200 actions per chat; Swift shows the same.
pub(crate) const CAP: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Push,
    PrOpened,
    PrReady,
    PrDraft,
    PrEdited,
    PrReopened,
    Updated,
}
impl Kind {
    fn read(value: &Value) -> Option<Self> {
        Some(match value.as_str()? {
            "push" => Self::Push,
            "pr_opened" => Self::PrOpened,
            "pr_ready" => Self::PrReady,
            "pr_draft" => Self::PrDraft,
            "pr_edited" => Self::PrEdited,
            "pr_reopened" => Self::PrReopened,
            "github_updated" => Self::Updated,
            _ => return None,
        })
    }
}

/// The recorded command exit: 0, another status, or none exposed (null).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Succeeded,
    Failed(i64),
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Action {
    pub(crate) id: String,
    /// None for audits recorded by older kernels; `description` names them.
    pub(crate) kind: Option<Kind>,
    pub(crate) description: String,
    pub(crate) branch: Option<String>,
    pub(crate) pr: Option<u64>,
    pub(crate) title: Option<String>,
    /// Exact URL of a PR the action created (confirmed provenance only).
    pub(crate) url: Option<String>,
    pub(crate) tool_call: Option<String>,
    pub(crate) after_entry: Option<u64>,
    pub(crate) at: u64,
    pub(crate) outcome: Outcome,
}
fn text(value: &Value, cap: usize) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(|s| crate::local_model::bounded(s, cap))
}
impl Action {
    pub(crate) fn read(value: &Value) -> Option<Self> {
        let id = value["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 512)?;
        let kind = Kind::read(&value["kind"]);
        let pr = value["prNumber"].as_u64().filter(|n| *n > 0);
        let outcome = match value["exitCode"].as_i64() {
            Some(0) => Outcome::Succeeded,
            Some(code) => Outcome::Failed(code),
            None => Outcome::Unknown,
        };
        // Only a confirmed creation's own PR: never shown for another kind,
        // outcome or number than the one it names.
        let url = value["url"]
            .as_str()
            .filter(|url| {
                kind == Some(Kind::PrOpened)
                    && outcome == Outcome::Succeeded
                    && url.len() <= 2048
                    && url.starts_with("https://")
                    && !url.chars().any(char::is_whitespace)
                    && pr.is_some_and(|n| url.ends_with(&format!("/pull/{n}")))
            })
            .map(str::to_owned);
        Some(Self {
            id: id.into(),
            kind,
            description: text(&value["description"], 240)
                .unwrap_or_else(|| "GitHub activity".into()),
            branch: text(&value["branch"], 240),
            pr,
            title: text(&value["title"], 240),
            url,
            tool_call: value["toolCallId"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 256)
                .map(str::to_owned),
            after_entry: value["afterEntryId"].as_u64().filter(|id| *id < (1 << 53)),
            at: value["at"].as_u64().unwrap_or(0),
            outcome,
        })
    }
    /// The audit is a whole snapshot: the newest `CAP`, unreadable items and
    /// repeated IDs skipped, in the kernel's (execution) order.
    pub(crate) fn read_all(value: &Value) -> Vec<Self> {
        let items = value.as_array().map_or(&[][..], Vec::as_slice);
        let mut seen = std::collections::HashSet::new();
        let mut out: Vec<Self> = items
            .iter()
            .filter_map(Self::read)
            .filter(|a| seen.insert(a.id.clone()))
            .collect();
        out.drain(..out.len().saturating_sub(CAP));
        out
    }
}

/// One timeline line, possibly several collapsed actions (Swift `ChatEvent`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Event {
    pub(crate) kind: Option<Kind>,
    text: String,
    pub(crate) branch: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) url: Option<String>,
    pub(crate) at: u64,
    pub(crate) end: Option<u64>,
    pub(crate) outcome: Outcome,
    pub(crate) count: usize,
    /// The first action's audit ID: stable identity for disclosure state.
    pub(crate) id: String,
}
impl Event {
    pub(crate) fn new(action: &Action) -> Self {
        let pr = action
            .pr
            .map_or_else(|| "a PR".to_owned(), |n| format!("PR #{n}"));
        let [done, failed] = match action.kind {
            Some(Kind::Push) => ["Agent pushed".into(), "Agent could not push".into()],
            Some(Kind::PrOpened) => [
                format!("Agent created {pr}"),
                format!("Agent could not create {pr}"),
            ],
            Some(Kind::PrReady) => [
                format!("Agent marked {pr} ready"),
                format!("Agent could not mark {pr} ready"),
            ],
            Some(Kind::PrDraft) => [
                format!("Agent marked {pr} draft"),
                format!("Agent could not mark {pr} draft"),
            ],
            Some(Kind::PrEdited) => [
                format!("Agent edited {pr}"),
                format!("Agent could not edit {pr}"),
            ],
            Some(Kind::PrReopened) => [
                format!("Agent reopened {pr}"),
                format!("Agent could not reopen {pr}"),
            ],
            Some(Kind::Updated) => [
                "Agent updated GitHub".into(),
                "Agent's GitHub update failed".into(),
            ],
            None => [action.description.clone(), "GitHub action failed".into()],
        };
        Self {
            kind: action.kind,
            text: match action.outcome {
                Outcome::Succeeded => done,
                Outcome::Failed(_) => failed,
                Outcome::Unknown => match action.kind {
                    Some(Kind::Push) => "Agent attempted to push".into(),
                    Some(Kind::PrOpened) => format!("Agent attempted to create {pr}"),
                    Some(Kind::PrReady) => format!("Agent attempted to mark {pr} ready"),
                    Some(Kind::PrDraft) => format!("Agent attempted to mark {pr} draft"),
                    Some(Kind::PrEdited) => format!("Agent attempted to edit {pr}"),
                    Some(Kind::PrReopened) => format!("Agent attempted to reopen {pr}"),
                    Some(Kind::Updated) => "Agent attempted a GitHub update".into(),
                    None => "Agent attempted a GitHub action".into(),
                },
            },
            branch: action.branch.clone(),
            title: action.title.clone(),
            url: action.url.clone(),
            at: action.at,
            end: None,
            outcome: action.outcome,
            count: 1,
            id: action.id.clone(),
        }
    }
    pub(crate) fn failed(&self) -> bool {
        matches!(self.outcome, Outcome::Failed(_))
    }
    pub(crate) fn sentence(&self) -> String {
        if self.count == 1 {
            self.text.clone()
        } else if self.kind == Some(Kind::Push)
            && self.outcome == Outcome::Succeeded
            && self.branch.is_some()
        {
            format!("Agent pushed {} times to", self.count)
        } else {
            format!("{} · {} times", self.text, self.count)
        }
    }

    /// Shown on request beside the sentence, like Swift's Show.
    pub(crate) fn detail(&self) -> Option<String> {
        match self.outcome {
            Outcome::Failed(code) => Some(format!("Command exited with status {code}.")),
            _ => None,
        }
    }
    pub(crate) fn uncertainty(&self) -> Option<&'static str> {
        (self.outcome == Outcome::Unknown).then_some("The command's exit status is unknown.")
    }
    /// The sentence with its branch and title: the row's copy and find text.
    pub(crate) fn line(&self) -> String {
        [
            Some(self.sentence()),
            self.branch.clone(),
            self.title.clone(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ")
    }
    /// Swift's row help: everything the truncated line may hide.
    pub(crate) fn help(&self) -> String {
        [
            Some(self.line()),
            self.url.clone(),
            self.uncertainty().map(str::to_owned),
            self.detail(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ")
    }
    /// Swift `canCollapse`: repeated pushes to one branch, or identical
    /// events. An uncertain push never merges into a confirmed one.
    fn collapses(&self, other: &Self) -> bool {
        if self.kind == Some(Kind::Push)
            && other.kind == Some(Kind::Push)
            && self.branch.is_some()
            && self.branch == other.branch
            && self.outcome == other.outcome
            && !self.failed()
        {
            return true;
        }
        self.kind == other.kind
            && self.text == other.text
            && self.branch == other.branch
            && self.title == other.title
            && self.url == other.url
            && self.outcome == other.outcome
    }
}

fn entry_of(row: &Message) -> Option<u64> {
    match row.reader_key() {
        Some(ReaderKey::Entry { entry, .. }) => Some(entry),
        _ => None,
    }
}

/// Places each action after its recorded entry (or the entry holding its
/// top-level call), like Swift's `rebuildDisplayedEntries`. An action whose
/// anchor is not loaded waits for it. Older kernels recorded no position:
/// those follow the last entry sent at or before them. Adjacent events
/// collapse into one line. `keys` holds each action's stable row ID.
pub(crate) fn place(
    rows: Vec<Message>,
    actions: &[Action],
    keys: &HashMap<String, u64>,
    earlier: bool,
) -> Vec<Message> {
    if actions.is_empty() {
        return rows;
    }
    let mut last = HashMap::new();
    let mut calls = HashMap::new();
    let mut sent = Vec::new();
    for (ix, row) in rows.iter().enumerate() {
        let entry = entry_of(row);
        if let Some(entry) = entry {
            last.insert(entry, ix);
        }
        for id in row.tool_ids().into_iter().flatten() {
            calls.insert(id.clone(), entry);
        }
        if let (Some(entry), Some(at)) = (entry, row.sent()) {
            sent.push((at, entry));
        }
    }
    // Slot 0 is before every row; slot ix + 1 follows row ix.
    let mut after: HashMap<usize, Vec<&Action>> = HashMap::new();
    for action in actions {
        let slot = match (action.after_entry, &action.tool_call) {
            (None, None) => match sent.iter().rfind(|(at, _)| *at <= action.at) {
                Some((_, entry)) => last.get(entry).map(|ix| ix + 1),
                None => (!earlier).then_some(0),
            },
            (entry, call) => entry
                .and_then(|e| last.get(&e))
                .or_else(|| {
                    call.as_ref()
                        .and_then(|c| calls.get(c))
                        .and_then(|e| e.and_then(|e| last.get(&e)))
                })
                .map(|ix| ix + 1),
        };
        if let Some(slot) = slot {
            after.entry(slot).or_default().push(action);
        }
    }
    let mut out: Vec<Message> = Vec::with_capacity(rows.len() + actions.len());
    let mut pending: Option<(u64, Event)> = None;
    let flush = |out: &mut Vec<Message>, pending: &mut Option<(u64, Event)>| {
        if let Some((key, event)) = pending.take() {
            out.push(Message::github(key, event));
        }
    };
    for (slot, row) in std::iter::once(None)
        .chain(rows.into_iter().map(Some))
        .enumerate()
    {
        if let Some(row) = row {
            flush(&mut out, &mut pending);
            out.push(row);
        }
        for action in after.remove(&slot).into_iter().flatten() {
            let Some(key) = keys.get(&action.id).copied() else {
                continue;
            };
            let event = Event::new(action);
            match &mut pending {
                Some((_, previous)) if previous.collapses(&event) => {
                    previous.count += 1;
                    previous.end = Some(event.at);
                }
                _ => {
                    flush(&mut out, &mut pending);
                    pending = Some((key, event));
                }
            }
        }
    }
    flush(&mut out, &mut pending);
    out
}

#[cfg(test)]
#[path = "github_event_tests.rs"]
mod tests;
