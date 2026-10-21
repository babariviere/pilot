//! Bounded, content-private projection of the current Local wire contract.
//! Background-owned wire JSON reduction and conservative ordinary-chat eligibility.
use crate::model::Message;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

pub(crate) const ENTRY_CAP: usize = 256;
pub(crate) const ROW_CAP: usize = 512;
pub(crate) const SOURCE_CAP: usize = 8 * 1024 * 1024;
pub(crate) const MESSAGE_CAP: usize = 1024 * 1024;
pub(crate) const SESSION_CAP: usize = 1000;

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Chat {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) state: String,
    pub(crate) archived: bool,
    pub(crate) local_draft: bool,
    pub(crate) writable: bool,
    pub(crate) busy: bool,
    pub(crate) cwd: String,
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
    Some(Chat {
        id: id.into(),
        title: bounded(value["title"].as_str().unwrap_or("Untitled chat"), 240),
        state: bounded(value["state"].as_str().unwrap_or("unknown"), 40),
        archived: value["archivedAt"].is_number(),
        local_draft: false,
        writable: interactive_local(value),
        busy: value["working"] == true
            || matches!(value["state"].as_str(), Some("working" | "starting")),
        cwd: bounded(value["cwd"].as_str().unwrap_or(""), 4096),
    })
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
    entries: BTreeMap<u64, Vec<Message>>,
    aliases: HashMap<(u64, usize), u64>,
    live: Option<Value>,
    live_key: u64,
    next_key: u64,
    tools: BTreeMap<String, (u64, String)>,
    pub(crate) cursor: Option<u64>,
    pub(crate) prefix_pending: bool,
    pub(crate) loaded: bool,
    pub(crate) queued: usize,
    active_head: Option<u64>,
    saved_history: Option<SavedHistory>,
    pub(crate) limited: bool,
    pub(crate) unsupported: usize,
}

struct SavedHistory {
    head: Option<u64>,
    cursor: Option<u64>,
    entries: BTreeMap<u64, Vec<Message>>,
}

impl LiveTranscript {
    fn key(&mut self) -> u64 {
        self.next_key += 1;
        (1 << 63) + self.next_key
    }

    pub(crate) fn rows(&self) -> Vec<Message> {
        let mut rows: Vec<_> = self.entries.values().flatten().cloned().collect();
        if let Some(live) = &self.live {
            rows.push(message(self.live_key, live, "Assistant · streaming"));
        }
        for (key, output) in self.tools.values() {
            rows.push(Message::live(*key, "Tool · running".into(), output.clone()));
        }
        rows
    }

    pub(crate) fn has_capacity(&self) -> bool {
        self.entries.len() < ENTRY_CAP && !self.limited
    }

    fn entry(&mut self, entry: &Value, promote: Option<u64>) {
        let Some(id) = entry["id"].as_u64().filter(|id| *id < (1 << 53)) else {
            return;
        };
        if self.entries.contains_key(&id) {
            return;
        }
        if self.entries.len() >= ENTRY_CAP {
            self.limited = true;
            return;
        }
        let kind = bounded(entry["kind"].as_str().unwrap_or("unknown"), 80);
        let mut rows = Vec::new();
        if let Some(models) = entry["model"].as_array().filter(|m| !m.is_empty()) {
            for (ix, value) in models.iter().take(32).enumerate() {
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
                rows.push(message(key, value, &format!("{label} · entry {id}")));
            }
            if models.len() > 32 {
                self.unsupported += 1;
            }
        } else {
            self.unsupported += 1;
            rows.push(Message::live(id * 64, format!("{kind} · entry {id}"),
                "[Structured entry. This viewer does not render its actions, attachments or metadata.]".into()));
        }
        let retained_rows: usize = self.entries.values().map(Vec::len).sum();
        let retained_bytes: usize = self
            .entries
            .values()
            .flatten()
            .map(|m| m.source().len())
            .sum();
        let added_bytes: usize = rows.iter().map(|m| m.source().len()).sum();
        if retained_rows + rows.len() > ROW_CAP - 33
            || retained_bytes + added_bytes > SOURCE_CAP - MESSAGE_CAP - 32 * 65536
        {
            self.limited = true;
            return;
        }
        self.entries.insert(id, rows);
    }

    /// Returned changes are applied in sequence on one background owner.
    pub(crate) fn apply(&mut self, event: &Value) {
        match event["type"].as_str().unwrap_or("") {
            "snapshot" => {
                let active = event["entries"].as_array().cloned().unwrap_or_default();
                let head = active.iter().filter_map(|e| e["head"].as_u64()).min();
                let kept = self.saved_history.take().unwrap_or_else(|| SavedHistory {
                    head: self.active_head,
                    cursor: self.cursor,
                    entries: std::mem::take(&mut self.entries),
                });
                self.entries.clear();
                self.saved_history = Some(kept);
                self.active_head = head;
                self.limited = false;
                self.unsupported = 0;
                let start = active.len().saturating_sub(ENTRY_CAP);
                for entry in &active[start..] {
                    self.entry(entry, None);
                }
                self.prefix_pending = event["prefixPending"] == true;
                self.cursor = head.filter(|h| *h > 1);
                if start > 0 {
                    self.limited = true;
                    self.cursor = active[start]["id"].as_u64();
                }
                self.set_live(event["generation"]["message"].clone());
                self.tools.clear();
                if let Some(tools) = event["tools"].as_array() {
                    for tool in tools.iter().filter(|t| t["status"] == "running").take(32) {
                        if let Some(id) = tool["callId"].as_str().filter(|id| id.len() <= 256) {
                            let key = self.key();
                            self.tools.insert(
                                id.into(),
                                (key, bounded(tool["output"].as_str().unwrap_or(""), 65536)),
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
            "entry_appended" => self.entry(&event["entry"], None),
            "queue_update" => {
                self.queued = event["items"].as_array().map_or(0, Vec::len)
                    + event["automatic"].as_array().map_or(0, Vec::len);
            }
            "message_start" => self.set_live(event["message"].clone()),
            "message_update" => {
                if let Some(live) = &mut self.live
                    && let Some(changes) = event["changes"].as_array()
                {
                    for change in changes {
                        change_message(live, change);
                    }
                    *live = slim_message(live);
                }
            }
            "message_end" => {
                let key = self.live.as_ref().map(|_| self.live_key);
                self.entry(&event["entry"], key);
                self.live = None;
            }
            "tool_execution_start" => {
                if self.tools.len() >= 32 {
                    self.limited = true;
                    return;
                }
                if let Some(id) = event["toolCallId"].as_str().filter(|s| s.len() <= 256) {
                    let key = self.key();
                    self.tools.insert(
                        id.into(),
                        (key, "[Tool running; arguments are not rendered.]".into()),
                    );
                }
            }
            "tool_execution_update" => {
                if let Some((_, output)) = event["toolCallId"]
                    .as_str()
                    .and_then(|id| self.tools.get_mut(id))
                {
                    let update = &event["output"];
                    if let Some(set) = update["set"].as_str() {
                        *output = bounded(set, 65536);
                    } else {
                        let trim = update["trimStart"].as_u64().unwrap_or(0) as usize;
                        let offset = output
                            .char_indices()
                            .nth(trim)
                            .map_or(output.len(), |(i, _)| i);
                        output.drain(..offset);
                        output.push_str(update["append"].as_str().unwrap_or(""));
                        *output = bounded(output, 65536);
                    }
                }
            }
            "tool_execution_end" => {
                let key = event["toolCallId"]
                    .as_str()
                    .and_then(|id| self.tools.remove(id))
                    .map(|(key, _)| key);
                self.entry(&event["entry"], key);
            }
            "run_end" => {
                self.live = None;
                self.tools.clear();
            }
            // These are explicitly not actions. No permissions, queues or read tracking are changed.
            _ => {}
        }
        // Aliases exist only for retained entries, never one per lifetime event.
        if !self.prefix_pending {
            self.aliases
                .retain(|(id, _), _| self.entries.contains_key(id));
        }
    }

    fn finish_snapshot(&mut self) {
        self.loaded = true;
        let kept = self.saved_history.take();
        self.cursor = self.active_head.filter(|h| *h > 1);
        if let Some(kept) = kept
            && self.active_head.is_some()
            && kept.head == self.active_head
        {
            self.cursor = kept.cursor;
            for (id, rows) in kept.entries {
                if Some(id) >= self.active_head {
                    continue;
                }
                let count: usize = self.entries.values().map(Vec::len).sum();
                let bytes: usize = self
                    .entries
                    .values()
                    .flatten()
                    .chain(rows.iter())
                    .map(|r| r.source().len())
                    .sum();
                if self.entries.len() < ENTRY_CAP
                    && count + rows.len() < ROW_CAP - 33
                    && bytes <= SOURCE_CAP - MESSAGE_CAP - 32 * 65536
                {
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
        }
        self.live = Some(slim_message(&value));
    }

    pub(crate) fn page(&mut self, before: u64, value: &Value) {
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

fn slim_message(value: &Value) -> Value {
    let mut content = Vec::new();
    let mut bytes = 0;
    if let Some(text) = value["content"].as_str() {
        content.push(serde_json::json!({"type":"text","text":if text.len()<=MESSAGE_CAP {text} else {"[Message exceeds 1 MiB viewer limit]"}}));
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
            bytes += text.len();
            if bytes > MESSAGE_CAP {
                content.clear();
                content.push(serde_json::json!({"type":"text","text":"[Message exceeds 1 MiB viewer limit]"}));
                break;
            }
            content.push(serde_json::json!({"type":kind,field:text}));
        }
    }
    serde_json::json!({"role":"assistant","timestamp":value["timestamp"].as_u64(),"content":content})
}

fn message(id: u64, value: &Value, label: &str) -> Message {
    let mut source = String::new();
    if let Some(text) = value["content"].as_str() {
        source.push_str(text);
    } else if let Some(blocks) = value["content"].as_array() {
        for block in blocks {
            match block["type"].as_str().unwrap_or("") {
                "text" => source.push_str(block["text"].as_str().unwrap_or("")),
                "thinking" => {
                    source.push_str("\n\nThinking:\n\n");
                    source.push_str(block["thinking"].as_str().unwrap_or(""));
                }
                "toolCall" => {
                    source.push_str("\n\n[Tool call. Actions/arguments are not rendered.]\n\n")
                }
                "image" => {
                    source.push_str("\n\n[Image omitted. No image loading in this viewer.]\n\n")
                }
                _ => source.push_str("\n\n[Unsupported content block]\n\n"),
            }
            if source.len() > MESSAGE_CAP {
                break;
            }
        }
    }
    if source.len() > MESSAGE_CAP {
        source = "[Message exceeds the viewer’s 1 MiB source limit. Open it in Swift.]".into();
    }
    if source.is_empty() {
        source = "[No text content]".into();
    }
    Message::live(id, label.into(), source)
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
                if text.len() + delta.len() <= MESSAGE_CAP {
                    blocks[ix][field] = Value::String(format!("{text}{delta}"));
                } else {
                    blocks[ix][field] =
                        Value::String("[Streaming block exceeds 1 MiB viewer limit]".into());
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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
    fn live_state_drops_arguments_and_bounds_aggregate_not_just_individual_blocks() {
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"message_start","message":{"content":[{"type":"toolCall","arguments":{"secret":"x".repeat(2*MESSAGE_CAP)}}]}}));
        assert!(
            serde_json::to_vec(model.live.as_ref().unwrap())
                .unwrap()
                .len()
                < 1024
        );
        model.apply(&json!({"type":"message_update","changes":[{"type":"block","contentIndex":1,"block":{"type":"text","text":"x".repeat(MESSAGE_CAP)}},{"type":"block","contentIndex":2,"block":{"type":"text","text":"y".repeat(MESSAGE_CAP)}}]}));
        assert!(
            serde_json::to_vec(model.live.as_ref().unwrap())
                .unwrap()
                .len()
                < MESSAGE_CAP
        );
        assert!(model.rows()[0].source().contains("exceeds"));
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
        let row = message(1, &json!({"content":giant}), "assistant");
        assert_eq!(row.source().len(), MESSAGE_CAP);
        let row = message(
            1,
            &json!({"content":"x".repeat(MESSAGE_CAP+1)}),
            "assistant",
        );
        assert!(row.source().contains("exceeds"));
        println!(
            "Synthetic 6,000-entry projection bounded to {ENTRY_CAP} entries: {:?}; not a render benchmark",
            started.elapsed()
        );
    }
}
