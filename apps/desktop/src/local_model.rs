//! Bounded, content-private projection of the current Local wire contract.
//! Background-owned wire JSON reduction and conservative ordinary-chat eligibility.
use crate::model::Message;
use crate::tool_presentation::Tools;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

pub(crate) const ENTRY_CAP: usize = 256;
pub(crate) const ROW_CAP: usize = 512;
pub(crate) const SESSION_CAP: usize = 1000;
pub(crate) const PROJECT_CAP: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Project {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) path: String,
}
pub(crate) fn projects(value: &Value) -> Result<Vec<Project>, &'static str> {
    let values = value.as_array().ok_or("Project list is unavailable.")?;
    if values.len() > PROJECT_CAP {
        return Err("Project catalog exceeds the 256-project display limit.");
    }
    let mut ids = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(values.len());
    for value in values {
        let id = value["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or("Invalid project identity; previous catalog retained.")?;
        let path = value["path"]
            .as_str()
            .filter(|p| p.starts_with('/') && p.len() <= 4096 && !p.contains('\0'))
            .ok_or("Invalid project path; previous catalog retained.")?;
        if !ids.insert(id) {
            return Err("Duplicate project identity; previous catalog retained.");
        }
        out.push(Project {
            id: id.into(),
            name: bounded(
                value["name"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Untitled project"),
                240,
            ),
            path: path.into(),
        });
    }
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.id.cmp(&b.id))
    });
    Ok(out)
}

#[cfg(test)]
mod project_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn bounded_atomic_project_catalog_retains_only_navigation_metadata() {
        let p=projects(&json!([{"id":"B","name":"Same","path":"/synthetic/B","environment":{"secret":"never retain"}}, {"id":"A","name":"same","path":"/synthetic/A"}])).unwrap();
        assert_eq!(
            p.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["A", "B"]
        );
        assert!(!format!("{p:?}").contains("never retain"));
        assert!(projects(&json!([{"id":"a","path":"/a"},{"id":"a","path":"/b"}])).is_err());
        assert!(projects(&json!([{"id":"a","path":"relative"}])).is_err());
        assert!(projects(&json!([{"id":"../a","path":"/a"}])).is_err());
        assert!(projects(&json!([{"id":"a","path":"/a"}, {"id":null,"path":"/b"}])).is_err());
        assert!(projects(&json!(null)).is_err());
        assert!(
            projects(&json!(
                (0..=PROJECT_CAP)
                    .map(|ix| json!({"id":ix.to_string(),"path":"/synthetic"}))
                    .collect::<Vec<_>>()
            ))
            .is_err()
        );
        assert_eq!(projects(&json!([])).unwrap(), Vec::new());
        let bounded = projects(&json!([{"id":"a","path":"/a","name":"é".repeat(400)}])).unwrap();
        assert!(bounded[0].name.len() <= 240);
    }
    #[test]
    fn projects_are_explicit_not_inferred_from_checkout_paths() {
        let mut raw = json!({"id":"a","cwd":"/synthetic/project/clone","projectId":"PROJECT"});
        assert_eq!(chat(&raw).unwrap().project_id.as_deref(), Some("PROJECT"));
        raw["projectId"] = json!("bad/id");
        assert!(chat(&raw).unwrap().project_id.is_none());
        raw["projectId"] = Value::Null;
        assert!(chat(&raw).unwrap().project_id.is_none());
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Chat {
    pub(crate) pull_requests: Vec<crate::jump::PullRequest>,
    pub(crate) failure: Option<crate::session_failure::Failure>,
    pub(crate) context_usage: crate::context_usage::Usage,
    pub(crate) model_configuration: Option<crate::chat_models::SessionModel>,
    pub(crate) attention: Option<crate::attention::Attention>,
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) state: String,
    pub(crate) archived: bool,
    pub(crate) local_draft: bool,
    pub(crate) writable: bool,
    pub(crate) busy: bool,
    pub(crate) signal: Option<crate::dither::Signal>,
    pub(crate) background_work: bool,
    pub(crate) cwd: String,
    pub(crate) project_id: Option<String>,
    /// List order and grouping inputs (`chat_order`).
    pub(crate) order: crate::chat_order::Order,
}
impl Chat {
    /// Row reason: attention, else live signal, else a non-routine raw state.
    /// A plain idle chat has nothing to say.
    pub(crate) fn row_reason(&self) -> Option<&str> {
        self.attention
            .as_ref()
            .map(|a| a.label.as_str())
            .filter(|label| !label.is_empty())
            .or_else(|| self.signal.map(|_| self.signal_label()))
            .or_else(|| {
                (!self.state.is_empty() && self.state != "idle").then_some(self.state.as_str())
            })
    }
    pub(crate) fn signal_label(&self) -> &str {
        use crate::dither::Signal;
        match self.signal {
            Some(Signal::Working) if self.background_work => "Working in background",
            Some(Signal::Working) => "Working",
            Some(Signal::NeedsYou) => "Needs you",
            Some(Signal::Failed) => "Failed",
            Some(Signal::Ready) => "Ready to merge",
            None => &self.state,
        }
    }
}
pub(crate) fn interactive_local(value: &Value) -> bool {
    value["control"] != true
        && value["role"].is_null()
        && value["diagnosticHost"].is_null()
        && value["archivedAt"].is_null()
        && value["continuedTo"].is_null()
        && (value["mode"].is_null() || matches!(value["mode"].as_str(), Some("ask" | "build")))
}

pub(crate) fn chat(value: &Value) -> Option<Chat> {
    let id = value["id"].as_str()?;
    if !valid_id(id) {
        return None;
    }
    let (signal, background_work) = decoration(value);
    Some(Chat {
        pull_requests: crate::jump::pull_requests(value),
        failure: crate::session_failure::read(value),
        context_usage: crate::context_usage::Usage::read(&value["usage"]),
        model_configuration: Some(crate::chat_models::SessionModel::read(value)),
        attention: crate::attention::project(value, signal),
        id: id.into(),
        title: bounded(value["title"].as_str().unwrap_or("Untitled chat"), 240),
        state: bounded(value["state"].as_str().unwrap_or("unknown"), 40),
        archived: value["archivedAt"].is_number(),
        local_draft: false,
        writable: interactive_local(value),
        busy: value["working"] == true
            || matches!(value["state"].as_str(), Some("working" | "starting")),
        signal,
        background_work,
        cwd: bounded(value["cwd"].as_str().unwrap_or(""), 4096),
        project_id: value["projectId"]
            .as_str()
            .filter(|id| valid_id(id))
            .map(str::to_owned),
        order: crate::chat_order::read(value, working(value)),
    })
}

/// Swift `SessionSummary.isWorking`: live work, including background jobs,
/// unless paused.
fn working(value: &Value) -> bool {
    let state = value["state"].as_str().unwrap_or("");
    let jobs = value["runningJobs"]
        .as_array()
        .is_some_and(|jobs| !jobs.is_empty());
    let paused = value["sleepPaused"] == true || value["offlinePaused"] == true;
    !paused
        && value["working"]
            .as_bool()
            .unwrap_or(matches!(state, "working" | "starting") || jobs)
}

// Read-only summary projection, mirroring SessionSignal/WorkingLine. It does not
// import Swift's private review marks or alter action eligibility/working state.
fn decoration(value: &Value) -> (Option<crate::dither::Signal>, bool) {
    use crate::dither::Signal;
    let state = value["state"].as_str().unwrap_or("");
    let jobs = value["runningJobs"]
        .as_array()
        .is_some_and(|jobs| !jobs.is_empty());
    let paused = value["sleepPaused"] == true || value["offlinePaused"] == true;
    let working = working(value);
    let background = working && !matches!(state, "working" | "starting") && jobs;
    let reason = value["attentionReason"]["kind"].as_str().unwrap_or("");
    let coordinator =
        value["missionCoordinator"] == true || value["activeMissionCoordinator"] == true;
    let ready = value["offlinePaused"] != true
        && !coordinator
        && reason != "pr_stuck"
        && value["pullRequest"]["state"] == "open"
        && value["pullRequest"]["readiness"]["state"] == "ready";
    let terminal = value["unpublishedWork"] != true
        && !coordinator
        && matches!(
            value["pullRequest"]["state"].as_str(),
            Some("merged" | "closed")
        )
        && ["pullRequests", "boundPullRequests"].iter().all(|field| {
            let pr = &value[*field];
            pr.as_array().is_none_or(|prs| {
                prs.iter()
                    .all(|pr| matches!(pr["state"].as_str(), Some("merged" | "closed")))
            })
        });
    let missing_pr = value["unpublishedWork"] == true
        && value["mode"] != "ask"
        && !coordinator
        && value["continuedTo"].is_null()
        && value["archivedAt"].is_null()
        && value["control"] != true
        && value["pullRequest"].is_null()
        && ["pullRequests", "boundPullRequests"]
            .iter()
            .all(|field| value[*field].as_array().is_none_or(Vec::is_empty));
    let signal = if matches!(reason, "long_job" | "mcp" | "tool_stall") {
        Some(Signal::NeedsYou)
    } else if working {
        Some(Signal::Working)
    } else if value["scheduledMessage"] == true {
        ready.then_some(Signal::Ready)
    } else if !paused && !terminal && (value["outcome"] == "failed" || state == "failed") {
        Some(Signal::Failed)
    } else if (!paused && value["outcome"] == "question") || reason == "pr_stuck" || missing_pr {
        Some(Signal::NeedsYou)
    } else {
        ready.then_some(Signal::Ready)
    };
    (signal, background)
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

fn bounded(text: &str, cap: usize) -> String {
    if text.len() <= cap {
        return text.into();
    }
    let mut end = cap.saturating_sub(3);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

#[derive(Default)]
pub(crate) struct LiveTranscript {
    pub(crate) failure_run_serial: u64,
    pub(crate) image_owner: Option<(crate::delivery_store::Host, String)>,
    question_pending: crate::question::Pending,
    question_run_active: bool,
    entries: BTreeMap<u64, Vec<Message>>,
    aliases: HashMap<(u64, usize), u64>,
    live: Option<Value>,
    // Presentation-only activity. Never retain reasoning
    // bodies in the UI projection; canonical daemon history is untouched.
    pub(crate) thinking: bool,
    thinking_suppressed: bool,
    pub(crate) presentation_dirty: bool,
    #[cfg(test)]
    assistant_message_builds: usize,
    live_key: u64,
    next_key: u64,
    tools: Tools,
    block_aliases: HashMap<(u64, usize, usize), u64>,
    live_block_keys: HashMap<usize, u64>,
    pub(crate) cursor: Option<u64>,
    pub(crate) prefix_pending: bool,
    pub(crate) loaded: bool,
    pub(crate) queued: usize,
    pub(crate) user_queue: std::sync::Arc<crate::queued_message::Snapshot>,
    /// Rows that just left the queue. The queue and history arrive on separate
    /// streams, so a consumed row is kept until its history entry (or a run
    /// boundary or the client's settle deadline) arrives.
    pub(crate) departed: Vec<crate::queued_message::Row>,
    /// Contents of user entries that arrived while their queue row is still
    /// listed. Cleared by the next queue update.
    arrived: Vec<Value>,
    /// After a snapshot, the next queue update is a new baseline, not a departure.
    queue_baseline: bool,
    active_head: Option<u64>,
    saved_history: Option<SavedHistory>,
    pub(crate) limited: bool,
    /// Newer entries were omitted while the reader held an older position.
    /// Only reopening the newest bounded window shows them.
    pub(crate) behind: bool,
    /// The reader holds an older position: a full window keeps its oldest
    /// entries instead of dropping them to admit newer ones.
    pub(crate) holding: bool,
    pub(crate) unsupported: usize,
}

struct SavedHistory {
    question_pending: crate::question::Pending,
    head: Option<u64>,
    cursor: Option<u64>,
    entries: BTreeMap<u64, Vec<Message>>,
}

impl LiveTranscript {
    pub(crate) fn question(&self) -> crate::question::Projection {
        use crate::question::Projection;
        if !self.loaded || self.prefix_pending || self.question_run_active || self.queued != 0 {
            return Projection::Unavailable;
        }
        match self.question_pending.current() {
            Ok(Some(question)) => Projection::Pending(question),
            Ok(None) => Projection::None,
            Err(error) => Projection::Invalid(error),
        }
    }
    fn key(&mut self) -> u64 {
        self.next_key += 1;
        (1 << 63) + self.next_key
    }

    pub(crate) fn rows(&mut self) -> Vec<Message> {
        self.presentation_dirty = false;
        let mut rows: Vec<_> = self.entries.values().flatten().cloned().collect();
        if let Some(live) = self.live.take() {
            rows.extend(self.assistant_rows(self.live_key, &live, None));
            self.live = Some(live);
        }
        let referenced: std::collections::BTreeSet<_> = rows
            .iter()
            .flat_map(|row| row.tool_ids().into_iter().flatten().cloned())
            .collect();
        rows.extend(self.tools.active_refs().into_iter().filter(|row| {
            row.tool_ids()
                .is_some_and(|ids| ids.iter().all(|id| !referenced.contains(id)))
        }));
        let mut rows = self.tools.project(rows);
        rows.extend(self.queued_rows());
        rows
    }

    /// The user's admitted input that has not joined a run yet, after history.
    fn queued_rows(&self) -> Vec<Message> {
        let mut arrived: Vec<&Value> = self.arrived.iter().collect();
        self.departed
            .iter()
            .chain(self.user_queue.rows.iter().filter(|row| {
                // Its history entry already arrived; the queue update follows.
                match arrived.iter().position(|c| **c == row.content) {
                    Some(ix) => {
                        arrived.swap_remove(ix);
                        false
                    }
                    None => true,
                }
            }))
            .map(queued_row)
            .collect()
    }

    /// Drops rows that left the queue without a matching history entry in time.
    pub(crate) fn settle_departed(&mut self) {
        if !self.departed.is_empty() {
            self.departed.clear();
            self.presentation_dirty = true;
        }
    }

    /// Pairs a newly committed user entry with the queue row it came from, by
    /// exact content. Presentation only: a match never settles a delivery.
    fn user_arrived(&mut self, entry: &Value) {
        let Some(id) = entry["id"].as_u64() else {
            return;
        };
        if entry["kind"] != "pi.user"
            || entry["origin"].is_string()
            || self.entries.contains_key(&id)
        {
            return;
        }
        let Some(content) = entry["model"]
            .as_array()
            .and_then(|models| models.iter().find(|m| m["role"] == "user"))
            .map(|m| &m["content"])
        else {
            return;
        };
        if let Some(ix) = self.departed.iter().position(|r| r.content == *content) {
            self.departed.remove(ix);
        } else if self.user_queue.rows.iter().any(|r| r.content == *content) {
            self.arrived.push(content.clone());
        }
    }

    pub(crate) fn has_capacity(&self) -> bool {
        self.entries.len() < ENTRY_CAP && !self.limited
    }
    fn register_calls(&mut self, value: &Value) {
        if let Some(blocks) = value["content"].as_array() {
            for block in blocks.iter().filter(|b| b["type"] == "toolCall") {
                if let Some(id) = block["id"]
                    .as_str()
                    .filter(|id| !id.is_empty() && id.len() <= 256)
                {
                    let key = self.tools.key(id).unwrap_or_else(|| self.key());
                    if !self.tools.call(
                        id,
                        key,
                        block["name"].as_str().unwrap_or("tool"),
                        &block["arguments"],
                    ) {
                        self.limited = true;
                    }
                }
            }
        }
    }
    fn assistant_rows(
        &mut self,
        key: u64,
        value: &Value,
        entry: Option<(u64, usize)>,
    ) -> Vec<Message> {
        // Do this before slimming, row identity allocation and Message/Markdown
        // construction. Reasoning and empty shells have no transcript height.
        if value["content"].as_array().is_none_or(|blocks| {
            blocks.iter().all(|block| {
                block["type"] == "thinking"
                    || (block["type"] == "text"
                        && block["text"].as_str().unwrap_or("").trim().is_empty())
            })
        }) && value["content"]
            .as_str()
            .is_none_or(|text| text.trim().is_empty())
        {
            return Vec::new();
        }
        let value = slim_message(value);
        self.register_calls(&value);
        let Some(blocks) = value["content"].as_array() else {
            return vec![message(key, &value, "assistant")];
        };
        let mut rows = Vec::new();
        for (block_ix, block) in blocks.iter().enumerate() {
            if matches!(block["type"].as_str(), Some("thinking" | "image"))
                || (block["type"] == "text"
                    && block["text"].as_str().unwrap_or("").trim().is_empty())
            {
                continue;
            }
            if block["type"] == "toolCall" {
                if let Some(id) = block["id"].as_str()
                    && let Some(key) = self.tools.key(id)
                {
                    rows.push(canonical_row(
                        Message::tool_ref(key, id),
                        entry,
                        Some(block_ix),
                    ));
                } else {
                    let row_key = self.block_key(key, block_ix, entry);
                    rows.push(canonical_row(
                        Message::live(
                            row_key,
                            "assistant".into(),
                            "[Tool metadata unavailable or exceeds capacity]".into(),
                        ),
                        entry,
                        Some(block_ix),
                    ));
                }
                continue;
            }
            let row_key = self.block_key(key, block_ix, entry);
            #[cfg(test)]
            {
                self.assistant_message_builds += 1;
            }
            let row = message(
                row_key,
                &serde_json::json!({"content":[block]}),
                if entry.is_some() {
                    "assistant"
                } else {
                    "Assistant · streaming"
                },
            )
            .with_sent(crate::message_time::read(&value));
            if row.source() != "[No text content]" {
                rows.push(canonical_row(row, entry, Some(block_ix)));
            }
        }
        rows
    }

    fn block_key(&mut self, key: u64, block_ix: usize, entry: Option<(u64, usize)>) -> u64 {
        if block_ix == 0 {
            return key;
        }
        if let Some((id, model)) = entry {
            if let Some(key) = self.block_aliases.get(&(id, model, block_ix)) {
                return *key;
            }
            let key = self.key();
            self.block_aliases.insert((id, model, block_ix), key);
            key
        } else {
            if let Some(key) = self.live_block_keys.get(&block_ix) {
                return *key;
            }
            let key = self.key();
            self.live_block_keys.insert(block_ix, key);
            key
        }
    }
    fn entry(&mut self, entry: &Value, promote: Option<u64>) {
        // Metadata is bounded independently from row admission. Even a user
        // entry beyond the visual row cap must close an old question.
        self.question_pending.observe(entry);
        let Some(id) = entry["id"].as_u64().filter(|id| *id < (1 << 53)) else {
            return;
        };
        if self.entries.contains_key(&id) {
            return;
        }
        if !self.admit(id, 0) {
            return;
        }
        let kind = bounded(entry["kind"].as_str().unwrap_or("unknown"), 80);
        let mut rows = Vec::new();
        if kind == "pilot.artifact" {
            if let Some(reference) =
                crate::artifact_model::Reference::pinned(&entry["data"]["artifact"])
            {
                rows.push(Message::artifact(id * 64, reference).with_artifact_size(
                    crate::artifact_model::RasterSize::hint(&entry["data"]["image"]),
                ));
            } else {
                self.unsupported += 1;
                rows.push(Message::live(
                    id * 64,
                    "Artifact unavailable".into(),
                    "[Invalid artifact publication metadata; no lookup performed.]".into(),
                ));
            }
        } else if let Some(models) = entry["model"].as_array().filter(|m| !m.is_empty()) {
            for (ix, value) in models.iter().take(32).enumerate() {
                let first_row = rows.len();
                if ix == 0
                    && let Some(key) = promote
                {
                    self.aliases.insert((id, ix), key);
                }
                let key = self
                    .aliases
                    .get(&(id, ix))
                    .copied()
                    .unwrap_or(id * 64 + ix as u64);
                let role = match value["role"].as_str() {
                    Some("user") => "user",
                    Some("assistant") => "assistant",
                    Some("toolResult") => "toolResult",
                    _ => "unknown",
                };
                if value["role"].is_null() {
                    continue;
                }
                // Authorship is structured provenance, never inferred from body text.
                let label = if role == "user" {
                    if entry["origin"].is_string() {
                        "Automatic input"
                    } else {
                        "You"
                    }
                } else {
                    role
                };
                if role == "assistant" {
                    rows.extend(self.assistant_rows(key, value, Some((id, ix))));
                } else if role == "toolResult" {
                    if let Some(call) = value["toolCallId"]
                        .as_str()
                        .filter(|id| !id.is_empty() && id.len() <= 256)
                    {
                        let known = self.tools.contains(call);
                        let key = self.tools.key(call).unwrap_or_else(|| self.key());
                        self.tools.result(
                            call,
                            key,
                            value["toolName"].as_str().unwrap_or("tool"),
                            value,
                        );
                        if !self.tools.contains(call) {
                            self.limited = true;
                            rows.push(Message::live(key,"toolResult".into(),"[Tool detail capacity reached. This result was not retained by the viewer.]".into()));
                            continue;
                        }
                        if !known {
                            rows.push(Message::tool_ref(key, call));
                        }
                    } else {
                        rows.push(message(key, value, &format!("toolResult · entry {id}")));
                    }
                } else {
                    let row = message(key, value, &format!("{label} · entry {id}"));
                    let only_images = row.source() == "[No text content]"
                        && value["content"].as_array().is_some_and(|blocks| {
                            blocks.iter().any(|block| block["type"] == "image")
                        });
                    if !only_images && (role != "unknown" || row.source() != "[No text content]") {
                        rows.push(row);
                    }
                }
                if role != "assistant" {
                    for row in &mut rows[first_row..] {
                        *row = row
                            .clone()
                            .anchored(crate::model::ReaderKey::model(id, ix, None));
                    }
                }
                if matches!(role, "user" | "assistant" | "toolResult")
                    && let Some(blocks) = value["content"].as_array().filter(|blocks| {
                        blocks
                            .iter()
                            .take(256)
                            .any(|block| block["type"] == "image")
                    })
                {
                    for (block_ix, block) in blocks
                        .iter()
                        .take(256)
                        .enumerate()
                        .filter(|(_, b)| b["type"] == "image")
                    {
                        let mut image = crate::conversation_images::Source::read(block_ix, block);
                        image.owner = self.image_owner.clone();
                        // A separate presentation allocation, never a guessed canonical ID.
                        let row_key = self.block_key(key, block_ix + 256, Some((id, ix)));
                        rows.push(
                            Message::image(row_key, format!("Stored image · {label}"), image)
                                .anchored(crate::model::ReaderKey::model(id, ix, Some(block_ix))),
                        );
                    }
                    if role == "assistant" {
                        rows[first_row..].sort_by_key(|row| match row.reader_key() {
                            Some(crate::model::ReaderKey::Entry { block, .. }) => {
                                block.unwrap_or(0)
                            }
                            _ => 0,
                        });
                    }
                }
            }
            if models.len() > 32 {
                self.unsupported += 1;
            }
        } else {
            self.unsupported += 1;
            rows.push(Message::live(id * 64, format!("{kind} · entry {id}"),
                "[Structured entry. This viewer does not render its actions, attachments or metadata.]".into()));
        }
        if !self.admit(id, rows.len()) {
            return;
        }
        for row in &mut rows {
            if row.reader_key().is_none() {
                *row = row.clone().anchored(crate::model::ReaderKey::Entry {
                    entry: id,
                    model: None,
                    block: None,
                });
            }
        }
        self.entries.insert(id, rows);
    }

    /// Make room for entry `id` with `rows` rows. A full window follows the
    /// tail by dropping its oldest entries for a newer one. While the reader
    /// holds an older position, the newer entry is omitted and recorded.
    fn admit(&mut self, id: u64, rows: usize) -> bool {
        let newer = rows <= ROW_CAP - 33
            && self
                .entries
                .last_key_value()
                .is_some_and(|(last, _)| id > *last);
        loop {
            let retained: usize = self.entries.values().map(Vec::len).sum();
            if self.entries.len() < ENTRY_CAP && retained + rows <= ROW_CAP - 33 {
                return true;
            }
            self.limited = true;
            if !newer || self.holding {
                self.behind |= newer;
                return false;
            }
            self.entries.pop_first();
        }
    }

    /// Returned changes are applied in sequence on one background owner.
    pub(crate) fn apply(&mut self, event: &Value) {
        if event["type"] == "run_start" {
            self.failure_run_serial = self.failure_run_serial.saturating_add(1);
        }
        match event["type"].as_str() {
            Some("run_start") => self.question_run_active = true,
            Some("run_end" | "run_error" | "error") => self.question_run_active = false,
            _ => {}
        }
        if matches!(event["type"].as_str(), Some("run_start" | "run_end")) {
            self.thinking_suppressed = false;
        }
        if reasoning_deltas_only(event) {
            for change in event["changes"].as_array().unwrap() {
                self.change_live(change);
            }
            self.thinking &= !self.thinking_suppressed;
            return;
        }
        self.presentation_dirty = true;
        if matches!(
            event["type"].as_str(),
            Some("snapshot" | "run_error" | "error")
        ) {
            self.departed.clear();
            self.arrived.clear();
            self.queue_baseline |= event["type"] == "snapshot";
        }
        match event["type"].as_str().unwrap_or("") {
            "run_error" | "error" => self.stop_thinking(),
            "snapshot"
            | "run_start"
            | "message_end"
            | "run_end"
            | "tool_execution_start"
            | "tool_execution_update"
            | "tool_execution_end" => self.thinking = false,
            _ => {}
        }
        match event["type"].as_str().unwrap_or("") {
            "snapshot" => {
                let active = event["entries"].as_array().cloned().unwrap_or_default();
                let head = active.iter().filter_map(|e| e["head"].as_u64()).min();
                let kept = self.saved_history.take().unwrap_or_else(|| SavedHistory {
                    question_pending: std::mem::take(&mut self.question_pending),
                    head: self.active_head,
                    cursor: self.cursor,
                    entries: std::mem::take(&mut self.entries),
                });
                self.entries.clear();
                self.question_pending = crate::question::Pending::default();
                self.question_run_active =
                    event["run"].is_object() || event["generation"].is_object();
                self.saved_history = Some(kept);
                self.active_head = head;
                self.limited = false;
                self.behind = false;
                self.unsupported = 0;
                let start = active.len().saturating_sub(ENTRY_CAP);
                for entry in active[start..].iter().rev() {
                    self.entry(entry, None);
                }
                self.prefix_pending = event["prefixPending"] == true;
                self.cursor = head.filter(|h| *h > 1);
                if start > 0 {
                    self.limited = true;
                    self.cursor = active[start]["id"].as_u64();
                }
                self.set_live(event["generation"]["message"].clone());
                self.tools.interrupt();
                if let Some(tools) = event["tools"].as_array() {
                    for tool in tools.iter().filter(|t| t["status"] == "running").take(32) {
                        if let Some(id) = tool["callId"].as_str().filter(|id| id.len() <= 256) {
                            let key = self.tools.key(id).unwrap_or_else(|| self.key());
                            self.tools
                                .start(id, key, tool["name"].as_str().unwrap_or("tool"));
                            self.tools.update(
                                id,
                                key,
                                &serde_json::json!({"set":tool["output"].as_str().unwrap_or("")}),
                            );
                        }
                    }
                }
                if !self.prefix_pending {
                    self.finish_snapshot();
                }
            }
            "snapshot_prefix" => {
                if !self.prefix_pending {
                    return;
                }
                self.prefix_pending = false;
                if let Some(entries) = event["entries"].as_array() {
                    if let Some(head) = entries.iter().filter_map(|e| e["head"].as_u64()).min() {
                        self.active_head = Some(self.active_head.map_or(head, |old| old.min(head)));
                    }
                    for entry in entries.iter().rev().take(ENTRY_CAP) {
                        self.entry(entry, None);
                    }
                }
                self.finish_snapshot();
            }
            "entry_appended" => {
                self.user_arrived(&event["entry"]);
                self.entry(&event["entry"], None)
            }
            "queue_update" => {
                let next = crate::queued_message::Snapshot::read(&event["items"]);
                if !next.unavailable && !std::mem::take(&mut self.queue_baseline) {
                    let mut arrived = std::mem::take(&mut self.arrived);
                    for row in self.user_queue.rows.iter() {
                        if next.rows.iter().any(|r| r.id == row.id) {
                            continue;
                        }
                        if let Some(ix) = arrived.iter().position(|c| *c == row.content) {
                            arrived.swap_remove(ix);
                        } else {
                            self.departed.push(row.clone());
                        }
                    }
                }
                self.arrived.clear();
                self.user_queue = std::sync::Arc::new(next);
                self.queued = event["items"].as_array().map_or(0, Vec::len)
                    + event["automatic"].as_array().map_or(0, Vec::len);
            }
            "message_start" => {
                self.set_live(event["message"].clone());
                self.thinking = self.live.as_ref().is_some_and(active_thinking);
            }
            "message_update" => {
                if let Some(changes) = event["changes"].as_array() {
                    for change in changes {
                        self.change_live(change);
                    }
                }
                if let Some(live) = self.live.clone() {
                    self.register_calls(&live);
                }
            }
            "message_end" => {
                let key = self.live.as_ref().map(|_| self.live_key);
                if let Some(id) = event["entry"]["id"].as_u64() {
                    for (block, key) in &self.live_block_keys {
                        self.block_aliases.insert((id, 0, *block), *key);
                    }
                }
                self.user_arrived(&event["entry"]);
                self.entry(&event["entry"], key);
                self.live = None;
                self.live_block_keys.clear();
            }
            "tool_execution_start" => {
                if let Some(id) = event["toolCallId"].as_str().filter(|s| s.len() <= 256) {
                    let key = self.tools.key(id).unwrap_or_else(|| self.key());
                    if !self
                        .tools
                        .start(id, key, event["toolName"].as_str().unwrap_or("tool"))
                    {
                        self.limited = true;
                    }
                }
            }
            "tool_execution_update" => {
                if let Some(id) = event["toolCallId"].as_str().filter(|id| id.len() <= 256) {
                    let key = self.tools.key(id).unwrap_or_else(|| self.key());
                    if !self.tools.update(id, key, &event["output"]) {
                        self.limited = true;
                    }
                }
            }
            "tool_execution_end" => {
                if let Some(id) = event["toolCallId"].as_str().filter(|id| id.len() <= 256) {
                    let key = self.tools.key(id).unwrap_or_else(|| self.key());
                    self.tools.end_unknown(id, key, event["isError"] == true);
                    if event["entry"]["id"].as_u64().is_none() {
                        self.tools.orphan(id);
                    }
                }
                self.entry(&event["entry"], None);
            }
            "run_end" => {
                self.live = None;
                self.tools.interrupt();
                self.departed.clear();
            }
            // These are explicitly not actions. No permissions, queues or read tracking are changed.
            _ => {}
        }
        // Aliases exist only for retained entries, never one per lifetime event.
        if !self.prefix_pending {
            self.aliases
                .retain(|(id, _), _| self.entries.contains_key(id));
            self.block_aliases
                .retain(|(id, _, _), _| self.entries.contains_key(id));
            let mut ids = std::collections::BTreeSet::new();
            for row in self.entries.values().flatten() {
                ids.extend(row.tool_ids().into_iter().flatten().cloned());
            }
            if let Some(live) = &self.live
                && let Some(blocks) = live["content"].as_array()
            {
                ids.extend(
                    blocks
                        .iter()
                        .filter_map(|block| block["id"].as_str())
                        .map(String::from),
                );
            }
            self.tools.retain(&ids);
            if matches!(event["type"].as_str(), Some("snapshot" | "snapshot_prefix")) {
                self.tools.end_snapshot(&ids);
            }
        }
        self.thinking &= !self.thinking_suppressed;
    }

    pub(crate) fn stop_thinking(&mut self) {
        self.thinking = false;
        self.thinking_suppressed = true;
    }

    fn finish_snapshot(&mut self) {
        self.loaded = true;
        let kept = self.saved_history.take();
        self.cursor = self.active_head.filter(|h| *h > 1);
        if let Some(kept) = kept
            && self.active_head.is_some()
            && kept.head == self.active_head
        {
            self.question_pending.merge(kept.question_pending);
            self.cursor = kept.cursor;
            for (id, rows) in kept.entries {
                if Some(id) >= self.active_head {
                    continue;
                }
                let count: usize = self.entries.values().map(Vec::len).sum();
                if self.entries.len() < ENTRY_CAP && count + rows.len() < ROW_CAP - 33 {
                    self.entries.entry(id).or_insert(rows);
                } else {
                    self.limited = true;
                }
            }
        }
    }

    fn set_live(&mut self, value: Value) {
        if value.is_null() {
            self.live = None;
            return;
        }
        if self.live.as_ref().map(|v| &v["timestamp"]) != Some(&value["timestamp"]) {
            self.live_key = self.key();
            self.live_block_keys.clear();
        }
        let slim = slim_message(&value);
        self.register_calls(&slim);
        self.live = Some(slim);
    }

    fn change_live(&mut self, change: &Value) {
        let kind = change["type"].as_str().unwrap_or("");
        if kind == "thinking_end" {
            self.thinking = false;
            return;
        }
        if kind == "message" {
            self.set_live(change["message"].clone());
            self.thinking = self.live.as_ref().is_some_and(active_thinking);
            return;
        }
        let Some(live) = &mut self.live else {
            return;
        };
        let Some(ix) = change["contentIndex"]
            .as_u64()
            .filter(|ix| *ix < 256)
            .map(|ix| ix as usize)
        else {
            return;
        };
        match kind {
            "thinking_delta" => {
                if live["content"]
                    .as_array()
                    .and_then(|blocks| blocks.get(ix))
                    .is_none_or(|block| block["type"] != "thinking")
                {
                    return;
                }
                self.thinking = true;
                // No invisible body buffer, Markdown, row or layout work.
                return;
            }
            "thinking_end" | "text_end" | "toolcall_end" => self.thinking = false,
            "thinking_start" | "block"
                if kind == "thinking_start" || change["block"]["type"] == "thinking" =>
            {
                self.thinking = true;
                change_message(
                    live,
                    &serde_json::json!({"type":"block","contentIndex":ix,"block":{"type":"thinking"}}),
                );
            }
            _ => {
                if matches!(
                    kind,
                    "text_start" | "text_delta" | "toolcall_start" | "toolcall_delta" | "block"
                ) {
                    self.thinking = false;
                }
                change_message(live, change);
            }
        }
        *live = slim_message(live);
    }

    pub(crate) fn page(&mut self, before: u64, value: &Value) {
        self.presentation_dirty = true;
        if self.prefix_pending || self.cursor != Some(before) {
            return;
        }
        let mut oldest = before;
        if let Some(entries) = value["entries"].as_array() {
            for entry in entries.iter().take(24) {
                if let Some(id) = entry["id"].as_u64().filter(|id| *id < before) {
                    self.entry(entry, None);
                    oldest = oldest.min(id);
                }
            }
        }
        self.cursor = (value["more"] == true && oldest < before && oldest > 1).then_some(oldest);
    }
}

pub(crate) fn reasoning_deltas_only(event: &Value) -> bool {
    event["type"] == "message_update"
        && event["changes"].as_array().is_some_and(|changes| {
            !changes.is_empty()
                && changes
                    .iter()
                    .all(|change| change["type"] == "thinking_delta")
        })
}

fn active_thinking(value: &Value) -> bool {
    value["content"]
        .as_array()
        .and_then(|blocks| blocks.last())
        .is_some_and(|block| block["type"] == "thinking")
}

fn canonical_row(row: Message, entry: Option<(u64, usize)>, block: Option<usize>) -> Message {
    if let Some((entry, model)) = entry {
        row.anchored(crate::model::ReaderKey::model(entry, model, block))
    } else {
        row
    }
}
fn slim_message(value: &Value) -> Value {
    let mut content = Vec::new();
    if let Some(text) = value["content"].as_str() {
        content.push(serde_json::json!({"type":"text","text":text}));
    } else if let Some(blocks) = value["content"].as_array() {
        for block in blocks.iter().take(256) {
            let kind = match block["type"].as_str() {
                Some("text") => "text",
                Some("thinking") => "thinking",
                Some("toolCall") => "toolCall",
                Some("image") => "image",
                _ => "unknown",
            };
            let field = if kind == "thinking" {
                "thinking"
            } else {
                "text"
            };
            let text = block[field].as_str().unwrap_or("");
            if kind == "thinking" {
                content.push(serde_json::json!({"type":"thinking"}));
                continue;
            }
            if kind == "toolCall" {
                let encoded = serde_json::to_string(&block["arguments"]).unwrap_or_default();
                let args = if encoded.len() <= crate::tool_presentation::ARG_CAP {
                    block["arguments"].clone()
                } else {
                    serde_json::json!({"viewerOmitted":"Arguments exceed the 12 KiB viewer limit"})
                };
                content.push(serde_json::json!({"type":"toolCall","id":block["id"].as_str().filter(|id|!id.is_empty()&&id.len()<=256),"name":block["name"].as_str().map(|name|bounded(name,160)),"arguments":args}));
                continue;
            }
            content.push(serde_json::json!({"type":kind,field:text}));
        }
    }
    serde_json::json!({"role":"assistant","timestamp":value["timestamp"].as_u64(),"content":content})
}

/// Presentation keys for queued input, one per durable submission ID. Disjoint
/// from entry keys (below 2^59), sending keys (2^61) and live keys (2^63 and up).
const QUEUED_KEY: u64 = 1 << 62;
pub(crate) fn queued_submission(row: &Message) -> Option<u64> {
    (row.id() & !(QUEUED_KEY - 1) == QUEUED_KEY && row.reader_key().is_none())
        .then(|| row.id() - QUEUED_KEY)
}
pub(crate) fn queued_row(row: &crate::queued_message::Row) -> Message {
    let images = row.content.as_array().map_or(0, |blocks| {
        blocks.iter().filter(|b| b["type"] == "image").count()
    });
    let mut text = content_text(&row.content);
    if images > 0 {
        let note = if images == 1 {
            "[1 image attached]".to_owned()
        } else {
            format!("[{images} images attached]")
        };
        text = if text == "[No text content]" {
            note
        } else {
            format!("{text}\n\n{note}")
        };
    }
    Message::live(QUEUED_KEY | row.id, "You".into(), text).with_pending(if row.mode == "steer" {
        "Queued to steer"
    } else {
        "Queued"
    })
}

fn message(id: u64, value: &Value, label: &str) -> Message {
    Message::live(id, label.into(), content_text(&value["content"]))
        .with_sent(crate::message_time::read(value))
}
fn content_text(content: &Value) -> String {
    let mut source = String::new();
    if let Some(text) = content.as_str() {
        source.push_str(text);
    } else if let Some(blocks) = content.as_array() {
        for block in blocks {
            match block["type"].as_str().unwrap_or("") {
                "text" => source.push_str(block["text"].as_str().unwrap_or("")),
                "thinking" => {}
                "toolCall" => {
                    source.push_str("\n\n[Tool call. Actions/arguments are not rendered.]\n\n")
                }
                "image" => {}
                _ => source.push_str("\n\n[Unsupported content block]\n\n"),
            }
        }
    }
    if source.is_empty() {
        source = "[No text content]".into();
    }
    source
}

fn change_message(message: &mut Value, change: &Value) {
    if change["type"] == "message" {
        *message = change["message"].clone();
        return;
    }
    let Some(ix) = change["contentIndex"]
        .as_u64()
        .filter(|ix| *ix < 256)
        .map(|ix| ix as usize)
    else {
        return;
    };
    let Some(blocks) = message["content"].as_array_mut() else {
        return;
    };
    while blocks.len() <= ix {
        blocks.push(Value::Null);
    }
    match change["type"].as_str().unwrap_or("") {
        "text_start" | "thinking_start" | "toolcall_start" | "block" => {
            blocks[ix] = change["block"].clone()
        }
        "text_delta" | "thinking_delta" => {
            let field = if change["type"] == "text_delta" {
                "text"
            } else {
                "thinking"
            };
            if let Some(text) = blocks[ix][field].as_str() {
                let delta = change["delta"].as_str().unwrap_or("");
                blocks[ix][field] = Value::String(format!("{text}{delta}"));
            }
        }
        "toolcall_delta" => {
            let Some(path) = change["path"].as_array().filter(|p| p.len() <= 16) else {
                return;
            };
            let mut target = &mut blocks[ix]["arguments"];
            for part in path {
                if let Some(key) = part.as_str() {
                    let Some(object) = target.as_object_mut() else {
                        return;
                    };
                    let Some(next) = object.get_mut(key) else {
                        return;
                    };
                    target = next;
                } else if let Some(index) = part.as_u64().filter(|i| *i < 256) {
                    let Some(array) = target.as_array_mut() else {
                        return;
                    };
                    let Some(next) = array.get_mut(index as usize) else {
                        return;
                    };
                    target = next;
                } else {
                    return;
                }
            }
            if let Some(old) = target.as_str() {
                let delta = change["delta"].as_str().unwrap_or("");
                if old.len() + delta.len() <= crate::tool_presentation::ARG_CAP {
                    *target = Value::String(format!("{old}{delta}"));
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
#[path = "queued_rows_tests.rs"]
mod queued_rows_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn question_entry(id: u64, head: u64) -> Value {
        json!({"id":id,"head":head,"kind":"pilot.question","data":{"question":"Which checks?","options":[{"label":"Tests"}]},"model":[]})
    }
    fn pending_question_id(model: &LiveTranscript) -> Option<u64> {
        match model.question() {
            crate::question::Projection::Pending(q) => Some(q.identity.entry),
            _ => None,
        }
    }
    #[test]
    fn question_projection_waits_snapshot_prefix_and_run_not_background_jobs() {
        let mut model = LiveTranscript::default();
        assert_eq!(pending_question_id(&model), None);
        model.apply(
            &json!({"type":"snapshot","entries":[question_entry(4,1)],"run":{"startedAt":1}}),
        );
        assert_eq!(pending_question_id(&model), None);
        model.apply(&json!({"type":"run_end"}));
        assert_eq!(pending_question_id(&model), Some(4));
        model.apply(&json!({"type":"jobs_update","jobs":[{"status":"running"}]}));
        assert_eq!(pending_question_id(&model), Some(4));
        model.apply(&json!({"type":"run_start"}));
        assert_eq!(pending_question_id(&model), None);
        model.apply(&json!({"type":"run_error"}));
        assert_eq!(pending_question_id(&model), Some(4));
        model.apply(&json!({"type":"queue_update","items":[{"id":1}],"automatic":[]}));
        assert_eq!(pending_question_id(&model), None);
        model.apply(&json!({"type":"queue_update","items":[],"automatic":[]}));
        assert_eq!(pending_question_id(&model), Some(4));
        model.apply(&json!({"type":"snapshot","entries":[question_entry(4,1)],"generation":{"message":{"role":"assistant","content":[]}}}));
        assert_eq!(pending_question_id(&model), None);
    }
    #[test]
    fn question_projection_prefix_actual_user_compaction_and_invalid_latest() {
        let mut model = LiveTranscript::default();
        model.apply(
            &json!({"type":"snapshot","entries":[question_entry(10,1)],"prefixPending":true}),
        );
        assert_eq!(pending_question_id(&model), None);
        model.apply(&json!({"type":"snapshot_prefix","entries":[{"id":11,"head":1,"kind":"pi.user","model":[{"role":"user","content":"Already answered"}]}]}));
        assert_eq!(pending_question_id(&model), None);
        let mut bad = question_entry(12, 1);
        bad["data"]["question"] = " ".into();
        model.apply(&json!({"type":"entry_appended","entry":bad}));
        assert!(matches!(
            model.question(),
            crate::question::Projection::Invalid(_)
        ));
        model.apply(&json!({"type":"snapshot","entries":[question_entry(21,20)]}));
        assert_eq!(pending_question_id(&model), Some(21));
        model.apply(&json!({"type":"entry_appended","entry":{"id":22,"kind":"pi.compaction","model":[{"role":"user","content":"Summary"}]}}));
        assert_eq!(pending_question_id(&model), Some(21));
        model.apply(&json!({"type":"entry_appended","entry":{"id":23,"kind":"pilot.activity","model":[{"role":"user","content":"Continue"}]}}));
        assert_eq!(pending_question_id(&model), None);
    }
    #[test]
    fn question_projection_same_head_history_restore_different_head_reset() {
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"snapshot","entries":[question_entry(4,1)]}));
        assert_eq!(pending_question_id(&model), Some(4));
        model.apply(&json!({"type":"snapshot","entries":[{"id":8,"head":1,"kind":"pi.assistant","model":[]}],"prefixPending":true}));
        assert_eq!(pending_question_id(&model), None);
        model.apply(&json!({"type":"snapshot_prefix","entries":[]}));
        assert_eq!(
            pending_question_id(&model),
            Some(4),
            "Same canonical head may retain loaded older question metadata"
        );
        model.apply(&json!({"type":"snapshot","entries":[{"id":20,"head":5,"kind":"pi.assistant","model":[]}]}));
        assert_eq!(
            pending_question_id(&model),
            None,
            "Never transfer question metadata across a changed head"
        );
    }
    #[test]
    fn question_projection_user_beyond_row_cap_or_invalid_identity_fails_closed() {
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"snapshot","entries":[question_entry(4,1)]}));
        // A reader holding older rows: the window cannot admit newer ones.
        model.holding = true;
        for id in 10..10 + ENTRY_CAP as u64 {
            model.entries.insert(id, Vec::new());
        }
        let mut messages = vec![json!({"role":"assistant","content":"bounded ignored rows"}); 33];
        messages.push(json!({"role":"user","content":"New actual input"}));
        model.apply(&json!({"type":"entry_appended","entry":{"id":99999,"kind":"pi.user","model":messages}}));
        assert_eq!(pending_question_id(&model), None);
        assert!(!model.entries.contains_key(&99999));
        model.apply(&json!({"type":"snapshot","entries":[question_entry(8,1)]}));
        model.apply(&json!({"type":"entry_appended","entry":{"id":"invalid","kind":"pi.user","model":[{"role":"user","content":"Unknown boundary"}]}}));
        assert!(matches!(
            model.question(),
            crate::question::Projection::Invalid(_)
        ));
    }
    use serde_json::json;
    #[test]
    fn corner_summary_projection_preserves_action_eligibility_and_background_work() {
        use crate::dither::Signal;
        for (value, signal, bg) in [
            (
                json!({"id":"a","state":"working","working":true}),
                Some(Signal::Working),
                false,
            ),
            (
                json!({"id":"a","state":"idle","runningJobs":[{"name":"synthetic"}]}),
                Some(Signal::Working),
                true,
            ),
            (
                json!({"id":"a","state":"working","attentionReason":{"kind":"tool_stall"}}),
                Some(Signal::NeedsYou),
                false,
            ),
            (
                json!({"id":"a","state":"idle","outcome":"question"}),
                Some(Signal::NeedsYou),
                false,
            ),
            (
                json!({"id":"a","state":"failed"}),
                Some(Signal::Failed),
                false,
            ),
            (
                json!({"id":"a","state":"idle","pullRequest":{"state":"open","readiness":{"state":"ready"}}}),
                Some(Signal::Ready),
                false,
            ),
            (
                json!({"id":"a","state":"idle","unpublishedWork":true}),
                Some(Signal::NeedsYou),
                false,
            ),
            (
                json!({"id":"a","state":"idle","unpublishedWork":true,"control":true}),
                None,
                false,
            ),
            (
                json!({"id":"a","state":"idle","outcome":"failed","pullRequest":{"state":"merged"},"pullRequests":[{"state":"open"}]}),
                Some(Signal::Failed),
                false,
            ),
            (
                json!({"id":"a","state":"idle","outcome":"failed","pullRequest":{"state":"merged"},"pullRequests":[{"state":"closed"}]}),
                None,
                false,
            ),
        ] {
            let projected = chat(&value).unwrap();
            assert_eq!((projected.signal, projected.background_work), (signal, bg));
            assert_eq!(projected.writable, interactive_local(&value));
            assert_eq!(
                projected.busy,
                value["working"] == true
                    || matches!(value["state"].as_str(), Some("working" | "starting"))
            );
        }
    }

    #[test]
    fn reasoning_is_early_filtered_and_deltas_do_not_build_or_dirty_rows() {
        let mut model = LiveTranscript::default();
        for (id, content) in [json!([]), json!([{"type":"text","text":" \n\t"}]), json!([{"type":"thinking","thinking":""}]), json!([{"type":"thinking","thinking":"private synthetic reasoning"},{"type":"text","text":"  "}])].into_iter().enumerate() {
            model.apply(&json!({"type":"entry_appended","entry":{"id":id+1,"kind":"pi.assistant","model":[{"role":"assistant","content":content}]}}));
        }
        assert!(!model.thinking, "history never manufactures activity");
        assert!(model.rows().is_empty());
        assert_eq!(model.assistant_message_builds, 0);
        assert!(model.block_aliases.is_empty());
        model.apply(&json!({"type":"message_start","message":{"timestamp":12,"content":[{"type":"thinking","thinking":"synthetic"}]}}));
        assert!(model.thinking);
        assert!(model.rows().is_empty());
        for _ in 0..1024 {
            model.apply(&json!({"type":"message_update","changes":[{"type":"thinking_delta","contentIndex":0,"delta":"🦀".repeat(1024)}]}));
            assert!(model.thinking);
            assert!(!model.presentation_dirty);
        }
        assert_eq!(
            model.live.as_ref().unwrap()["content"],
            json!([{"type":"thinking"}])
        );
        assert!(model.rows().is_empty());
        assert_eq!(model.assistant_message_builds, 0);
        assert!(model.live_block_keys.is_empty());
        model.apply(&json!({"type":"message_update","changes":[{"type":"text_start","contentIndex":1,"block":{"type":"text","text":"answer"}}]}));
        assert!(!model.thinking);
        assert!(model.presentation_dirty);
        assert_eq!(model.rows()[0].source(), "answer");
    }

    #[test]
    fn thinking_lifecycle_resets_without_suppressing_ordinary_notes_or_answers() {
        let start = json!({"type":"message_start","message":{"timestamp":12,"content":[{"type":"thinking","thinking":"synthetic private body"}]}});
        let delta = json!({"type":"message_update","changes":[{"type":"thinking_delta","contentIndex":0,"delta":"more"}]});
        for terminal in [
            json!({"type":"tool_execution_start","toolCallId":"a","toolName":"read"}),
            json!({"type":"run_end"}),
            json!({"type":"message_end"}),
            json!({"type":"error"}),
            json!({"type":"run_error"}),
            json!({"type":"snapshot","entries":[],"generation":{"message":{"content":[{"type":"thinking","thinking":"old"}]}}}),
        ] {
            let mut model = LiveTranscript::default();
            model.apply(&start);
            assert!(model.thinking);
            model.apply(&terminal);
            assert!(!model.thinking);
            if matches!(terminal["type"].as_str(), Some("run_error" | "error")) {
                model.apply(&delta);
                assert!(
                    !model.thinking,
                    "late reasoning cannot revive an errored activity"
                );
            }
            assert!(
                model
                    .rows()
                    .iter()
                    .all(|row| !row.source().contains("synthetic private body"))
            );
        }
        let mut model = LiveTranscript::default();
        model.apply(&start);
        model.apply(&json!({"type":"message_update","changes":[{"type":"thinking_end"}]}));
        assert!(!model.thinking);
        model.apply(&delta);
        assert!(model.thinking);
        model.stop_thinking();
        model.apply(&delta);
        assert!(
            !model.thinking,
            "late deltas cannot revive a stopped indicator"
        );
        model.apply(&json!({"type":"run_start"}));
        assert!(
            !model.thinking,
            "a new run starts as working, not historical thinking"
        );
        model.apply(&json!({"type":"run_end"}));
        model.apply(&start);
        assert!(model.thinking, "a later run can think again");
        model.apply(&json!({"type":"message_update","changes":[{"type":"text_start","contentIndex":1,"block":{"type":"text","text":"Thinking: an ordinary substantive note 日本語"}}]}));
        assert!(!model.thinking);
        assert_eq!(
            model.rows()[0].source(),
            "Thinking: an ordinary substantive note 日本語"
        );
        model.apply(&json!({"type":"message_end","entry":{"id":22,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"thinking","thinking":"historical private body"},{"type":"text","text":"Final answer"}]}]}}));
        assert!(!model.thinking);
        assert_eq!(model.rows()[0].source(), "Final answer");
        assert_eq!(model.assistant_message_builds, 2);
    }
    #[test]
    fn canonical_publication_keeps_pinned_card_identity_and_never_parses_body_links() {
        let mut model = LiveTranscript::default();
        let reference =
            json!({"id":"synthetic-art","sessionId":"owner","revision":3,"title":"Synthetic"});
        let publication =
            json!({"id":3,"kind":"pilot.artifact","data":{"artifact":reference},"model":[]});
        let user = json!({"id":2,"kind":"pi.user","model":[{"role":"user","content":[{"type":"text","text":"{\"artifact\":{\"id\":\"body-only\",\"revision\":1}}"}]}]});
        model.apply(&json!({"type":"snapshot","entries":[user,publication.clone()]}));
        let rows = model.rows();
        assert_eq!(
            rows.iter().filter(|r| r.artifact_data().is_some()).count(),
            1
        );
        let row = rows.iter().find(|r| r.artifact_data().is_some()).unwrap();
        let key = row.id();
        assert_eq!(row.artifact_data().unwrap().revision, 3);
        assert_eq!(row.artifact_data().unwrap().session, "owner");
        assert_eq!(
            row.artifact_size(),
            None,
            "legacy publications carry no size"
        );
        let sized = json!({"id":4,"kind":"pilot.artifact","data":{"artifact":{"id":"sized","sessionId":"owner","revision":1,"title":"Sized"},"image":{"mimeType":"image/png","width":1024,"height":640}},"model":[]});
        let mut sized_model = LiveTranscript::default();
        sized_model.apply(&json!({"type":"snapshot","entries":[sized]}));
        assert_eq!(
            sized_model.rows()[0].artifact_size(),
            Some(crate::artifact_model::RasterSize {
                width: 1024,
                height: 640,
                first_frame: false
            })
        );
        model.apply(&json!({"type":"entry_appended","entry":publication}));
        let rows = model.rows();
        assert_eq!(
            rows.iter().filter(|r| r.artifact_data().is_some()).count(),
            1
        );
        assert_eq!(
            rows.iter()
                .find(|r| r.artifact_data().is_some())
                .unwrap()
                .id(),
            key
        );
    }
    #[test]
    fn malformed_publication_does_not_become_an_open_action() {
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"snapshot","entries":[{"id":1,"kind":"pilot.artifact","data":{"artifact":{"id":"../escape","sessionId":"owner","revision":0,"title":"Bad"}},"model":[]}]}));
        assert!(model.rows().iter().all(|r| r.artifact_data().is_none()));
        assert_eq!(model.unsupported, 1);
    }
    fn entry(id: u64, text: &str) -> Value {
        json!({"id":id,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":text}]}]})
    }
    #[test]
    fn split_snapshot_paging_and_stale_cursor() {
        let mut model = LiveTranscript::default();
        let mut tail = entry(50, "tail");
        tail["head"] = json!(40);
        model.apply(&json!({"type":"snapshot","entries":[tail],"prefixPending":true}));
        model.page(40, &json!({"entries":[entry(10,"stale")],"more":false}));
        assert_eq!(model.rows().len(), 1);
        model.apply(&json!({"type":"snapshot_prefix","entries":[entry(40,"prefix")]}));
        model.page(39, &json!({"entries":[entry(10,"stale")]}));
        assert_eq!(model.rows().len(), 2);
        model.page(
            40,
            &json!({"entries":[entry(20,"old"),entry(40,"duplicate")],"more":true}),
        );
        assert_eq!(
            model.rows().iter().map(|m| m.id()).collect::<Vec<_>>(),
            vec![1280, 2560, 3200]
        );
        assert_eq!(model.cursor, Some(20));
    }
    #[test]
    fn history_paging_stops_on_empty_nonprogress_and_overlapping_pages() {
        let mut tail = entry(50, "tail");
        tail["head"] = json!(50);
        for entries in [
            json!([]),
            json!([entry(50, "duplicate")]),
            json!([entry(60, "newer, not previous")]),
        ] {
            let mut model = LiveTranscript::default();
            model.apply(&json!({"type":"snapshot","entries":[tail]}));
            assert_eq!(model.cursor, Some(50));
            model.page(50, &json!({"entries":entries,"more":true}));
            assert_eq!(
                model.cursor, None,
                "server more=true must not repeat a nonprogressing cursor"
            );
            assert_eq!(model.rows().len(), 1);
            model.page(
                50,
                &json!({"entries":[entry(40,"stale retry")],"more":true}),
            );
            assert_eq!(model.rows().len(), 1);
        }
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"snapshot","entries":[tail]}));
        model.page(
            50,
            &json!({"entries":[entry(40,"older"),entry(50,"overlap")],"more":true}),
        );
        assert_eq!(model.cursor, Some(40));
        assert_eq!(model.rows().len(), 2);
        model.page(
            40,
            &json!({"entries":[entry(40,"overlap"),entry(50,"overlap")],"more":true}),
        );
        assert_eq!(model.cursor, None);
        assert_eq!(model.rows().len(), 2);
    }
    #[test]
    fn sent_time_is_each_messages_own_timestamp_through_stream_and_commit() {
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"snapshot","entries":[
            {"id":1,"kind":"pi.user","model":[{"role":"user","timestamp":1_000,"content":"Hi 👋"}]},
            {"id":2,"kind":"pi.assistant","model":[{"role":"assistant","timestamp":2_000,"content":[
                {"type":"text","text":"First"},{"type":"thinking","thinking":"hidden"},{"type":"text","text":"Second"}]}]},
            {"id":3,"kind":"pi.user","model":[{"role":"user","content":"No time"}]},
            {"id":4,"kind":"pi.user","model":[{"role":"user","timestamp":"2000","content":"Text time"}]},
        ]}));
        let sent: Vec<_> = model
            .rows()
            .iter()
            .map(|row| (row.source().to_owned(), row.sent()))
            .collect();
        assert_eq!(
            sent,
            [
                ("Hi 👋".into(), Some(1_000)),
                ("First".into(), Some(2_000)),
                ("Second".into(), Some(2_000)),
                ("No time".into(), None),
                ("Text time".into(), None),
            ]
        );
        model.apply(&json!({"type":"message_start","message":{"role":"assistant","timestamp":3_000,"content":[{"type":"text","text":"日"}]}}));
        let live = model.rows().last().unwrap().clone();
        assert_eq!(live.sent(), Some(3_000));
        model.apply(&json!({"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":"本"}]}));
        let streamed = model.rows().last().unwrap().clone();
        assert_eq!((streamed.id(), streamed.sent()), (live.id(), Some(3_000)));
        model.apply(
            &json!({"type":"message_end","entry":{"id":5,"kind":"pi.assistant","model":[
            {"role":"assistant","timestamp":3_000,"content":[{"type":"text","text":"日本"}]}]}}),
        );
        let committed = model.rows().last().unwrap().clone();
        assert_eq!(
            (committed.id(), committed.source(), committed.sent()),
            (live.id(), "日本", Some(3_000))
        );
    }
    #[test]
    fn streaming_promotes_identity_and_deduplicates_commit() {
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"message_start","message":{"role":"assistant","timestamp":12,"content":[{"type":"text","text":"日"}]}}));
        let key = model.rows()[0].id();
        model.apply(&json!({"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":"本語 👋"}]}));
        assert_eq!(model.rows()[0].source(), "日本語 👋");
        model.apply(&json!({"type":"message_end","entry":entry(2,"日本語 👋")}));
        model.apply(&json!({"type":"entry_appended","entry":entry(2,"duplicate")}));
        assert_eq!(model.rows().len(), 1);
        assert_eq!(model.rows()[0].id(), key);
    }
    #[test]
    fn replacement_split_snapshot_keeps_loaded_history_only_for_same_head() {
        let mut model = LiveTranscript::default();
        let mut marker = entry(10, "marker");
        marker["head"] = json!(10);
        model.apply(&json!({"type":"snapshot","entries":[marker.clone(),entry(11,"tail")]}));
        model.page(10, &json!({"entries":[entry(8,"history")],"more":true}));
        model.apply(&json!({"type":"snapshot","entries":[entry(11,"tail")],"prefixPending":true}));
        assert!(model.prefix_pending);
        model.apply(&json!({"type":"snapshot_prefix","entries":[marker]}));
        assert_eq!(model.cursor, Some(8));
        assert_eq!(model.rows().len(), 3);
        let mut reset = entry(12, "new head");
        reset["head"] = json!(12);
        model.apply(&json!({"type":"snapshot","entries":[reset]}));
        assert_eq!(model.cursor, Some(12));
        assert_eq!(model.rows().len(), 1);
    }

    #[test]
    fn live_state_bounds_tool_arguments_but_retains_all_text_blocks() {
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"message_start","message":{"content":[{"type":"toolCall","arguments":{"secret":"x".repeat(2*1024*1024)}}]}}));
        assert!(
            serde_json::to_vec(model.live.as_ref().unwrap())
                .unwrap()
                .len()
                < 1024
        );
        model.apply(&json!({"type":"message_update","changes":[{"type":"block","contentIndex":1,"block":{"type":"text","text":"x".repeat(1024*1024)}},{"type":"block","contentIndex":2,"block":{"type":"text","text":"y".repeat(1024*1024)}}]}));
        let rows = model.rows();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[1].source(), "x".repeat(1024 * 1024));
        assert_eq!(rows[2].source(), "y".repeat(1024 * 1024));
    }

    #[test]
    fn bounded_history_and_large_message_workload() {
        let started = std::time::Instant::now();
        let mut model = LiveTranscript::default();
        for id in 1..=6000 {
            model.apply(
                &json!({"type":"entry_appended","entry":entry(id,"synthetic bounded history")}),
            );
        }
        assert_eq!(model.entries.len(), ENTRY_CAP);
        assert!(model.limited);
        assert!(model.rows().len() <= ROW_CAP);
        let giant = crate::giant_fixture();
        let row = message(1, &json!({"content":&giant}), "assistant");
        assert_eq!(row.source().len(), giant.len());
        let row = message(1, &json!({"content":"x".repeat(1024*1024+1)}), "assistant");
        assert_eq!(row.source(), "x".repeat(1024 * 1024 + 1));
        println!(
            "Synthetic 6,000-entry projection bounded to {ENTRY_CAP} entries: {:?}; not a render benchmark",
            started.elapsed()
        );
    }

    #[test]
    fn full_window_follows_newest_entries_unless_the_reader_holds_older_ones() {
        let snapshot = |model: &mut LiveTranscript| {
            let entries: Vec<_> = (1..=300).map(|id| entry(id, "history")).collect();
            model.apply(&json!({"type":"snapshot","entries":entries}));
        };
        let mut model = LiveTranscript::default();
        snapshot(&mut model);
        // Trimming older entries keeps the newest window: nothing is missing below.
        assert!(model.limited && !model.behind);
        assert_eq!(model.entries.keys().next_back(), Some(&300));
        model.apply(&json!({"type":"entry_appended","entry":entry(301,"newest")}));
        assert!(!model.behind, "a following reader slides the window");
        assert_eq!(model.entries.len(), ENTRY_CAP);
        assert_eq!(model.entries.keys().next_back(), Some(&301));
        assert_eq!(
            model.entries.keys().next(),
            Some(&(301 - ENTRY_CAP as u64 + 1))
        );

        model.holding = true;
        let first = model.entries.keys().next().copied();
        model.apply(&json!({"type":"entry_appended","entry":entry(302,"while reading")}));
        assert!(
            model.behind,
            "a held window records the omitted newer entry"
        );
        assert_eq!(
            model.entries.keys().next().copied(),
            first,
            "older rows stay put"
        );
        assert!(!model.entries.contains_key(&302));
        // Older history never marks the window behind.
        model.behind = false;
        model.apply(&json!({"type":"entry_appended","entry":entry(5,"older")}));
        assert!(!model.behind);

        model.behind = true;
        snapshot(&mut model);
        assert!(!model.behind, "a fresh snapshot is the newest window");

        // An entry that can never fit does not empty the window.
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"snapshot","entries":[entry(1,"kept")]}));
        let blocks: Vec<_> = (0..ROW_CAP)
            .map(|i| json!({"type":"text","text":format!("b{i}")}))
            .collect();
        model.apply(&json!({"type":"entry_appended","entry":{"id":2,"kind":"message","model":[{"role":"assistant","content":blocks}]}}));
        assert!(model.entries.contains_key(&1) && !model.behind);
    }

    #[test]
    fn initial_admission_retains_all_rows_above_the_old_aggregate_byte_limit() {
        let mut model = LiveTranscript::default();
        let entries: Vec<_> = (1..=100)
            .map(|id| entry(id, &"x".repeat(100_000)))
            .collect();
        model.apply(&json!({"type":"snapshot","entries":entries}));
        assert!(!model.limited);
        assert_eq!(model.entries.len(), 100);
        assert!(model.entries.contains_key(&100));
        assert!(model.entries.contains_key(&1));
    }

    #[test]
    fn empty_unknown_metadata_does_not_become_a_fake_chat_message() {
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"entry_appended","entry":{"id":1,"kind":"pi.metadata","model":[{"role":"context","content":[]}]}}));
        assert!(model.rows().is_empty());
    }
}
