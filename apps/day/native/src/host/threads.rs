//! Focused mission topics (docs/technical/mission-threads.md) on the existing
//! serialized host worker and fsynced ledger. Reads are the daemon's
//! authenticated topic view and the original coordinator history, projected
//! for display. The four topic writes are journaled operations sent once. A
//! lost answer stays Unknown: Check looks up that exact envelope and never
//! sends a replacement. TSX names the mission, the topic and the exact source
//! it showed; the host chooses operation and new topic IDs.
use super::{Error, Journal, Shared, Transport, planning, valid_id};
use crate::bridge::{Command, Gate};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// The four exact operation kinds; each is also its payload purpose.
pub(super) const KINDS: [&str; 4] = [
    "thread-create",
    "thread-disposition",
    "thread-reference",
    "thread-send",
];
/// At most this many characters in a topic title.
pub(crate) const MAX_TITLE: usize = 200;
/// At most this many UTF-8 bytes in one message.
pub(crate) const MAX_TEXT: usize = 32_000;
/// Entries per history page.
const PAGE: u64 = 32;
/// At most this many UTF-8 bytes of one entry are shown; the entry says so.
pub(crate) const ENTRY_TEXT: usize = 8_000;
const MAX_ENTRY_ID: u64 = 9_007_199_254_740_990;

pub(super) fn is_thread_kind(kind: &str) -> bool {
    KINDS.contains(&kind)
}

fn is_source(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_title(t: &str) -> bool {
    !t.trim().is_empty() && t == t.trim() && t.chars().count() <= MAX_TITLE && !t.contains('\0')
}

fn valid_text(t: &str) -> bool {
    !t.trim().is_empty() && t.len() <= MAX_TEXT && !t.contains('\0')
}

/// A canonical task/decision ID or an exact original coordinator entry.
pub(super) fn valid_reference(r: &Value) -> bool {
    let Some(o) = r.as_object() else {
        return false;
    };
    match r["kind"].as_str() {
        Some("task" | "decision") => o.len() == 2 && r["id"].as_str().is_some_and(valid_id),
        Some("history") => {
            o.len() == 3
                && r["sessionId"].as_str().is_some_and(valid_id)
                && r["entryId"]
                    .as_u64()
                    .is_some_and(|n| (1..MAX_ENTRY_ID).contains(&n))
        }
        _ => false,
    }
}

/// Read one mission's topics.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ReadRequest {
    pub mission_id: String,
}

/// Read one page of a topic's original coordinator history.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct HistoryRequest {
    mission_id: String,
    topic_id: String,
    /// Entries before this ID; none for the newest page.
    before: Option<u64>,
    /// Exact original session from a conversation cursor, not arbitrary navigation.
    session_id: Option<String>,
}
impl HistoryRequest {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if !valid_id(&self.mission_id)
            || !valid_id(&self.topic_id)
            || self.session_id.as_deref().is_some_and(|s| !valid_id(s))
            || self
                .before
                .is_some_and(|b| !(2..=MAX_ENTRY_ID).contains(&b))
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

/// One explicit user write, against the exact source the window showed.
/// The host picks the operation ID and, for a new topic, the topic ID.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Intent {
    mission_id: String,
    source: String,
    purpose: String,
    #[serde(default)]
    topic_id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    disposition: Option<String>,
    #[serde(default)]
    reference: Option<Value>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    interrupt: Option<bool>,
}
impl Intent {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        let topic = || self.topic_id.as_deref().is_some_and(valid_id);
        let only = |title: bool, disposition: bool, reference: bool, text: bool| {
            self.title.is_some() == title
                && self.disposition.is_some() == disposition
                && self.reference.is_some() == reference
                && self.text.is_some() == text
        };
        let ok = valid_id(&self.mission_id)
            && is_source(&self.source)
            && (self.interrupt.is_none()
                || (self.purpose == "thread-send" && self.interrupt == Some(true)))
            && match self.purpose.as_str() {
                "thread-create" => {
                    self.topic_id.is_none()
                        && only(true, false, false, false)
                        && self.title.as_deref().is_some_and(valid_title)
                }
                "thread-disposition" => {
                    topic()
                        && only(false, true, false, false)
                        && matches!(
                            self.disposition.as_deref(),
                            Some("open" | "later" | "discarded")
                        )
                }
                "thread-reference" => {
                    topic()
                        && only(false, false, true, false)
                        && self.reference.as_ref().is_some_and(valid_reference)
                }
                "thread-send" => {
                    topic()
                        && only(false, false, false, true)
                        && self.text.as_deref().is_some_and(valid_text)
                }
                _ => false,
            };
        if ok { Ok(()) } else { Err(Error::Invalid) }
    }

    /// The exact daemon payload: purpose, source, topic and one field.
    fn request(&self, topic: &str) -> Value {
        let mut r = json!({"purpose":self.purpose,"source":self.source,"topicId":topic});
        if let Some(v) = &self.title {
            r["title"] = json!(v);
        }
        if let Some(v) = &self.disposition {
            r["disposition"] = json!(v);
        }
        if let Some(v) = &self.reference {
            r["reference"] = v.clone();
        }
        if let Some(v) = &self.text {
            r["text"] = json!(v);
        }
        if self.interrupt == Some(true) {
            r["interrupt"] = json!(true);
        }
        r
    }
}

fn payload(op: &Value) -> Result<Value, Error> {
    serde_json::from_str(op["payload"].as_str().ok_or(Error::Storage)?).map_err(|_| Error::Storage)
}

fn field(kind: &str) -> &'static str {
    match kind {
        "thread-create" => "title",
        "thread-disposition" => "disposition",
        "thread-reference" => "reference",
        _ => "text",
    }
}

/// A saved topic operation names its mission, its source as the binding and exactly one field.
pub(super) fn validate_record(op: &Value) -> Result<(), Error> {
    let p = payload(op)?;
    let kind = op["kind"].as_str().unwrap_or("");
    let f = field(kind);
    let valid_field = match kind {
        "thread-create" => p[f].as_str().is_some_and(valid_title),
        "thread-disposition" => matches!(p[f].as_str(), Some("open" | "later" | "discarded")),
        "thread-reference" => valid_reference(&p[f]),
        "thread-send" => p[f].as_str().is_some_and(valid_text),
        _ => false,
    };
    if p.as_object().is_none_or(|o| {
        o.len()
            != if kind == "thread-send" && p["interrupt"] == true {
                5
            } else {
                4
            }
    }) || (p.get("interrupt").is_some() && !(kind == "thread-send" && p["interrupt"] == true))
        || p["purpose"] != op["kind"]
        || p["source"] != op["bindingId"]
        || !p["source"].as_str().is_some_and(is_source)
        || !p["topicId"].as_str().is_some_and(valid_id)
        || op["bindingGeneration"] != 1
        || !valid_field
    {
        return Err(Error::Storage);
    }
    Ok(())
}

/// Only an accepted receipt whose topic shows this exact effect settles a write.
/// A send also needs the planning admission of this same operation.
pub(super) fn exact_result(op: &Value, r: &Value) -> Result<(), Error> {
    let p = payload(op).map_err(|_| Error::Unknown)?;
    let topic = &r["result"]["topic"];
    let id = op["operationId"].as_str().unwrap_or("");
    let effect = match op["kind"].as_str() {
        Some("thread-create") => {
            topic["title"] == p["title"] && topic["createdBy"]["operationId"] == op["operationId"]
        }
        Some("thread-disposition") => topic["disposition"] == p["disposition"],
        Some("thread-reference") => topic["references"]
            .as_array()
            .is_some_and(|refs| refs.contains(&p["reference"])),
        Some("thread-send") => {
            // Sent now (its admission) or saved to wait for the planning agent (queued).
            topic["inputs"]
                .as_array()
                .is_some_and(|inputs| inputs.iter().any(|i| i["operationId"] == id))
                && (r["result"]["admission"]["admissionId"] == op["operationId"]
                    || r["result"]["queued"] == true)
        }
        _ => false,
    };
    if topic["id"] != p["topicId"] || topic["missionId"] != op["targetId"] || !effect {
        return Err(Error::Unknown);
    }
    Ok(())
}

fn is_thread(r: &planning::PlanningRecord) -> bool {
    r.operation["kind"].as_str().is_some_and(is_thread_kind)
}

fn state(r: &planning::PlanningRecord) -> Value {
    if r.not_sent {
        json!("not-sent")
    } else {
        r.receipt
            .as_ref()
            .and_then(|r| r["state"].as_str())
            .map_or(json!("unknown"), |s| json!(s))
    }
}

/// One saved write as the window shows it: never the envelope or credentials.
fn summary(r: &planning::PlanningRecord) -> Value {
    let p = payload(&r.operation).unwrap_or(Value::Null);
    let kind = r.operation["kind"].as_str().unwrap_or("");
    json!({"operationId":r.id(),"purpose":kind,"topicId":p["topicId"],
        "text":if kind == "thread-send" {p["text"].clone()} else {Value::Null},
        "state":state(r),
        "queued":r.receipt.as_ref().is_some_and(|r| r["result"]["queued"] == true),
        "reason":r.receipt.as_ref().map_or(Value::Null, |r| r["reason"].clone())})
}

fn summaries(t: &Transport, journal: &Journal, mission: &str) -> Vec<Value> {
    journal
        .planning
        .values()
        .filter(|r| r.source == t.source && is_thread(r) && r.mission() == mission)
        .map(summary)
        .collect()
}

/// A topics or history read. Conflict is a refused scope (owner, membership,
/// project or access), never an empty list or a transport outage.
async fn get(t: &Transport, path: &str) -> Result<Value, Error> {
    let header = t.local()?;
    let r = t
        .client
        .get(t.url(path))
        .header("x-pilot-github-capability", header)
        .send()
        .await
        .map_err(|_| Error::Offline)?;
    if matches!(r.status().as_u16(), 404 | 409) {
        return Err(Error::Stale);
    }
    let v = super::transport::body(r).await?;
    t.local()?;
    Ok(v)
}

async fn capability(t: &Transport) -> Result<(), Error> {
    t.gate(false).await?;
    let hello = t.get("/api/hello").await?;
    if hello["capabilities"]["nativeThreads"] != 1 {
        return Err(Error::Unavailable);
    }
    Ok(())
}

fn valid_topic(v: &Value, mission: &str, project: &str) -> bool {
    v["version"] == 1
        && v["id"].as_str().is_some_and(valid_id)
        && v["missionId"] == mission
        && v["projectId"] == project
        && v["ownerSessionId"].as_str().is_some_and(valid_id)
        && v["title"].as_str().is_some()
        && v["revision"].as_u64().is_some()
        && matches!(
            v["disposition"].as_str(),
            Some("open" | "later" | "discarded" | "resolved")
        )
        && v["createdBy"]["kind"] == "user"
        && v["references"]
            .as_array()
            .is_some_and(|r| r.iter().all(valid_reference))
        && v["inputs"].as_array().is_some_and(|i| {
            i.iter()
                .all(|i| i["operationId"].as_str().is_some_and(valid_id))
        })
}

fn valid_view(v: &Value, mission: &str, project: &str) -> bool {
    let mut ids = std::collections::HashSet::new();
    v["version"] == 1
        && v["missionId"] == mission
        && v["projectId"] == project
        && v["source"].as_str().is_some_and(is_source)
        && v["discussion"]["available"].is_boolean()
        && v["discussion"]["reason"].is_string()
        && (v["discussion"]["waits"].is_null() || v["discussion"]["waits"].is_boolean())
        && (v["waiting"].is_null()
            || v["waiting"].as_array().is_some_and(|w| {
                w.len() <= 100
                    && w.iter().all(|m| {
                        m["operationId"].as_str().is_some_and(valid_id)
                            && m["topicId"].as_str().is_some_and(valid_id)
                            && m["text"].is_string()
                    })
            }))
        && v["topics"].as_array().is_some_and(|topics| {
            topics.len() <= 100
                && topics.iter().all(|t| {
                    valid_topic(t, mission, project)
                        && ids.insert(t["id"].as_str().unwrap_or("").to_owned())
                })
        })
}

/// The topic as the window shows it.
fn topic(v: &Value) -> Value {
    json!({"id":v["id"],"title":v["title"],"revision":v["revision"],"disposition":v["disposition"],
        "ownerSessionId":v["ownerSessionId"],"references":v["references"],
        "inputs":v["inputs"].as_array().map(|i| i.iter().map(|i| i["operationId"].clone()).collect::<Vec<_>>()).unwrap_or_default(),
        "chatSessionId":v["chat"]["sessionId"],"handoff":v["handoff"],"resolvedBy":v["resolvedBy"]})
}

/// Task numbers and titles and decision texts, to name references. Not a second tracker.
fn catalog(detail: &Value, mission: &str) -> Value {
    if detail["mission"]["id"] != mission {
        return json!({"known":false,"tasks":[],"decisions":[]});
    }
    let tasks: Vec<Value> = detail["tasks"]
        .as_array()
        .map(|t| {
            t.iter()
                .filter(|t| t["id"].as_str().is_some_and(valid_id))
                .map(|t| json!({"id":t["id"],"number":t["number"],"title":t["title"],"status":t["status"]}))
                .collect()
        })
        .unwrap_or_default();
    let decisions: Vec<Value> = detail["decisions"]
        .as_array()
        .map(|d| {
            d.iter()
                .filter(|d| d["id"].as_str().is_some_and(valid_id))
                .map(|d| {
                    json!({"id":d["id"],"number":d["number"],"text":d["text"],
                    "withdrawn":d["withdrawn"].is_object() || d["replacement"].is_object()})
                })
                .collect()
        })
        .unwrap_or_default();
    json!({"known":true,"tasks":tasks,"decisions":decisions})
}

/// The mission's topics and whether discussion is open now. A preview, never an admission.
pub(super) async fn read(t: &Transport, mission: &str) -> Result<Value, Error> {
    capability(t).await?;
    let project = &t.source.project()?.project_id;
    let view = get(
        t,
        &format!("/api/projects/{project}/missions/{mission}/threads"),
    )
    .await?;
    if !valid_view(&view, mission, project) {
        return Err(Error::Invalid);
    }
    // Names for references only: without them the page says "task" or "decision".
    let names = t
        .get(&format!("/api/missions/{mission}"))
        .await
        .ok()
        .filter(|d| d["mission"]["projectId"] == *project)
        .map_or_else(
            || json!({"known":false,"tasks":[],"decisions":[]}),
            |d| catalog(&d, mission),
        );
    // A changed project/path or native identity during the read cannot publish it.
    t.gate(false).await?;
    Ok(
        json!({"version":1,"missionId":mission,"projectId":project,"source":view["source"],
        "discussion":{"available":view["discussion"]["available"],"reason":view["discussion"]["reason"],
            "waits":view["discussion"]["waits"] == true},
        "waiting":view["waiting"].as_array().map(|w| w.iter().map(|m| json!({"operationId":m["operationId"],"topicId":m["topicId"],"text":m["text"]})).collect::<Vec<_>>()).unwrap_or_default(),
        "topics":view["topics"].as_array().map(|t| t.iter().map(topic).collect::<Vec<_>>()).unwrap_or_default(),
        "catalog":names}),
    )
}

fn texts(content: &Value, kind: &str) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|p| p["type"] == kind)
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn message_text(e: &Value, role: &str) -> String {
    e["model"]
        .as_array()
        .map(|m| {
            m.iter()
                .filter(|m| m["role"] == role)
                .map(|m| texts(&m["content"], "text"))
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}

/// Semantic original activity only, not a dump of arbitrary entry metadata.
fn activity_text(e: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(messages) = e["model"].as_array() {
        for message in messages {
            if message["role"] == "toolResult" {
                let body = texts(&message["content"], "text");
                let name = message["toolName"].as_str().unwrap_or("tool");
                parts.push(format!("Tool result: {name}\n{body}"));
            } else if let Some(content) = message["content"].as_array() {
                for part in content.iter().filter(|p| p["type"] == "toolCall") {
                    let name = part["name"].as_str().unwrap_or("tool");
                    let arguments = if part["arguments"].is_null() {
                        String::new()
                    } else {
                        part["arguments"].to_string()
                    };
                    parts.push(format!("Tool call: {name}\n{arguments}"));
                }
            }
        }
    }
    for field in ["text", "message", "note"] {
        if let Some(text) = e["data"][field].as_str() {
            parts.push(text.to_owned());
        }
    }
    parts.join("\n\n")
}

/// At most ENTRY_TEXT bytes on a character boundary, and whether it was cut.
fn shorten(text: String) -> (String, bool) {
    if text.len() <= ENTRY_TEXT {
        return (text, false);
    }
    let mut end = ENTRY_TEXT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}

/// One original entry for display. Membership in the topic is only what the
/// topic itself names: its references and its saved inputs' exact operations.
fn entry(e: &Value, topic: &Value, owner: &str, chat: bool) -> Option<Value> {
    let id = e["id"].as_u64()?;
    let kind = e["kind"].as_str().unwrap_or("");
    let referenced = topic["references"].as_array().is_some_and(|refs| {
        refs.iter()
            .any(|r| r["kind"] == "history" && r["sessionId"] == owner && r["entryId"] == id)
    });
    let mut role = "activity";
    let mut text = String::new();
    let mut sent = Value::Null;
    match kind {
        "pilot.planning-input" => {
            role = "planning";
            let op: Value = e["data"]["operation"]
                .as_str()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(Value::Null);
            if op["kind"] != "thread-send" {
                text = message_text(e, "user");
            } else {
                let p: Value = op["payload"]
                    .as_str()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or(Value::Null);
                if let Some(t) = p["text"].as_str() {
                    role = "you";
                    text = t.to_owned();
                    sent = json!({"operationId":op["operationId"],"topicId":p["topicId"]});
                }
            }
        }
        "pi.user" => {
            role = if e["origin"].is_string() {
                "activity"
            } else {
                "you"
            };
            text = message_text(e, "user");
        }
        "pi.assistant" => {
            text = message_text(e, "assistant");
            if !text.is_empty() {
                role = if chat { "chat" } else { "coordinator" };
            }
        }
        _ => {}
    }
    let input = sent["operationId"].as_str().is_some_and(|op| {
        topic["inputs"]
            .as_array()
            .is_some_and(|i| i.iter().any(|i| i["operationId"] == op))
    });
    let activity = activity_text(e);
    if !activity.is_empty() {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(&activity);
    }
    let (text, shortened) = shorten(text);
    Some(
        json!({"id":id,"kind":kind,"role":role,"text":text,"shortened":shortened,
        "referenced":referenced,"input":input,"sentIn":sent["topicId"]}),
    )
}

/// Check the read-only conversation projection without cutting message text.
fn valid_conversation(v: &Value, session: &str) -> bool {
    let mut previous = 0;
    let mut identities = std::collections::HashSet::new();
    v["entries"].as_array().is_some_and(|entries| {
        entries.len() <= 2048 + PAGE as usize
            && entries.iter().all(|e| {
                let id = e["id"].as_u64().unwrap_or(0);
                let operation = e["operationId"].as_str();
                let ordered = id > 0
                    && id >= previous
                    && id < MAX_ENTRY_ID
                    && identities.insert((id, operation.map(str::to_owned)))
                    && (e["operationId"].is_null() || operation.is_some_and(valid_id));
                previous = id;
                ordered
                    && e["sessionId"] == session
                    && matches!(e["role"].as_str(), Some("you" | "chat" | "coordinator"))
                    && e["text"].is_string()
                    && (e["timestamp"].is_null() || e["timestamp"].as_u64().is_some())
                    && matches!(
                        e["replyState"].as_str(),
                        Some("unknown" | "pending" | "awaiting" | "answered" | "unanswered")
                    )
                    && e["original"] == json!({"kind":"history","sessionId":session,"entryId":id})
            })
    }) && (v["queuedMessages"].is_null()
        || v["queuedMessages"].as_array().is_some_and(|messages| {
            messages.len() <= 2048
                && messages.iter().all(|m| {
                    m["operationId"].as_str().is_some_and(valid_id)
                        && m["text"].is_string()
                        && matches!(m["replyState"].as_str(), Some("pending" | "unknown"))
                        && (m["timestamp"].is_null() || m["timestamp"].as_u64().is_some())
                })
        }))
        && v["more"].is_boolean()
        && (v["nextBefore"].is_null()
            || v["nextBefore"]
                .as_u64()
                .is_some_and(|n| (2..MAX_ENTRY_ID).contains(&n)))
        && (v["nextSessionId"].is_null() || v["nextSessionId"].as_str().is_some_and(valid_id))
        && (v["more"] != true || v["nextSessionId"].is_string())
        && matches!(v["earlierContext"].as_str(), Some("unknown" | "complete"))
}

/// One page of the topic's original coordinator history, oldest first.
/// It is the coordinator's whole conversation, never a topic-only transcript.
pub(super) async fn history(t: &Transport, r: &HistoryRequest) -> Result<Value, Error> {
    r.validate()?;
    capability(t).await?;
    let project = &t.source.project()?.project_id;
    let before = r.before.map(|b| format!("&before={b}")).unwrap_or_default();
    let session = r
        .session_id
        .as_ref()
        .map(|s| format!("&sessionId={s}"))
        .unwrap_or_default();
    let v = get(
        t,
        &format!(
            "/api/projects/{project}/missions/{}/threads/{}/history?limit={PAGE}{before}{session}",
            r.mission_id, r.topic_id
        ),
    )
    .await?;
    let topic = &v["topic"];
    // A thread with a thread chat reads that chat; an older one reads the coordinator's conversation.
    let chat = v["scope"] == "thread-chat";
    // The daemon authorizes old chat bindings from immutable receipts as well as today's chat.
    let owner = v["sessionId"].as_str().unwrap_or("");
    if !(chat || v["scope"] == "coordinator-history")
        || owner.is_empty()
        || !valid_id(owner)
        || r.session_id.as_deref().is_some_and(|s| s != owner)
        || (!chat && topic["ownerSessionId"] != owner)
        || topic["id"] != r.topic_id.as_str()
        || !valid_topic(topic, &r.mission_id, project)
        || v["sessionId"] != owner
        || !v["history"]["entries"].is_array()
        || !v["history"]["more"].is_boolean()
        || !valid_conversation(&v["conversation"], owner)
    {
        return Err(Error::Invalid);
    }
    let mut entries: Vec<Value> = v["history"]["entries"]
        .as_array()
        .map(|e| {
            e.iter()
                .filter_map(|e| entry(e, topic, owner, chat))
                .collect()
        })
        .unwrap_or_default();
    entries.sort_by_key(|e| e["id"].as_u64());
    let oldest = entries.first().and_then(|e| e["id"].as_u64());
    t.gate(false).await?;
    Ok(
        json!({"version":1,"missionId":r.mission_id,"topicId":r.topic_id,"sessionId":owner,
        "scope":v["scope"],"topic":self::topic(topic),"entries":entries,
        "conversation":v["conversation"],
        "more":v["history"]["more"] == true && oldest.is_some_and(|o| o > 1),
        "nextBefore":oldest}),
    )
}

/// Why a write was not sent, for the window. Nothing was saved or sent.
fn refused(reason: &str) -> Value {
    json!({"operationId":Value::Null,"purpose":Value::Null,"topicId":Value::Null,"state":"refused","reason":reason})
}

/// Checks the intent against the fresh read the host just made. None: send it.
fn qualify(intent: &Intent, current: &Value) -> Result<Option<&'static str>, Error> {
    if current["source"] != intent.source.as_str() {
        return Err(Error::Stale);
    }
    let Some(topic) = intent.topic_id.as_deref() else {
        return Ok((current["topics"].as_array().map_or(0, Vec::len) >= 100)
            .then_some("This mission already has 100 threads. Nothing was sent."));
    };
    let Some(shown) = current["topics"]
        .as_array()
        .and_then(|t| t.iter().find(|t| t["id"] == topic))
    else {
        return Err(Error::Stale);
    };
    Ok(match intent.purpose.as_str() {
        "thread-disposition"
            if shown["disposition"] == intent.disposition.as_deref().unwrap_or("") =>
        {
            Some("The thread is already like that. Nothing was sent.")
        }
        "thread-reference"
            if shown["references"]
                .as_array()
                .is_some_and(|r| r.len() >= 100) =>
        {
            Some("This thread already links 100 things. Nothing was sent.")
        }
        "thread-reference"
            if intent.reference.as_ref().is_some_and(|r| {
                r["kind"] == "history" && r["sessionId"] != shown["ownerSessionId"]
            }) =>
        {
            Some(
                "Only the coordinator conversation this thread started in can be linked. Nothing was sent.",
            )
        }
        "thread-send" if shown["disposition"] != "open" => {
            Some("Reopen this thread to write in it. Nothing was sent.")
        }
        "thread-send"
            if current["discussion"]["available"] != true
                && current["discussion"]["waits"] != true =>
        {
            Some(
                "The coordinator cannot take a message now: it needs an active planning coordinator. Nothing was sent.",
            )
        }
        _ => None,
    })
}

pub(super) async fn handle(
    t: &Transport,
    journal: &mut Journal,
    shared: &Shared,
    command: &Command,
    gate: &Arc<Mutex<Gate>>,
) -> Result<Value, Error> {
    let check = || {
        shared.open()?;
        command.admit(&gate.lock().expect("bridge gate poisoned"))
    };
    match command {
        Command::ThreadsRead(mission) => {
            if !valid_id(mission) {
                return Err(Error::Invalid);
            }
            let snapshot = read(t, mission).await?;
            check()?;
            Ok(
                json!({"snapshot":snapshot,"operations":summaries(t,journal,mission),"outcome":null}),
            )
        }
        Command::ThreadsHistory(request) => {
            let snapshot = history(t, request).await?;
            check()?;
            Ok(json!({"snapshot":snapshot,"outcome":null}))
        }
        Command::ThreadsWrite(intent) => {
            intent.validate()?;
            let mission = intent.mission_id.clone();
            // An earlier write or planning action for this mission whose result
            // is unknown blocks another until Check settles it.
            if journal
                .planning
                .values()
                .any(|r| r.source == t.source && r.mission() == mission && r.pending())
            {
                return Err(Error::Unknown);
            }
            let current = read(t, &mission).await?;
            check()?;
            if let Some(reason) = qualify(intent, &current)? {
                return Ok(
                    json!({"snapshot":current,"operations":summaries(t,journal,&mission),"outcome":refused(reason)}),
                );
            }
            let topic = intent
                .topic_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let mut record = planning::record(
                &t.source,
                mission.clone(),
                intent.source.clone(),
                intent.request(&topic),
            )?;
            journal.save_planning(record.clone())?;
            if let Err(e) = t.local().and_then(|_| check()) {
                record.not_sent = true;
                journal.save_planning(record)?;
                return Err(e);
            }
            // No async gap, retry or recreation between the durable record and this sole POST.
            let mut saved = true;
            if let Ok(receipt) = t.planning_operation(&record.operation, false).await {
                record.receipt = Some(receipt);
                if journal.save_planning(record.clone()).is_err() {
                    journal.poison();
                    saved = false;
                }
            }
            let mut outcome = summary(&record);
            if !saved {
                outcome["state"] = json!("unknown");
                outcome["reason"] = Value::Null;
            }
            // A failed or raced refresh cannot erase the exact acknowledgement.
            let snapshot = read(t, &mission).await.ok().filter(|_| check().is_ok());
            Ok(
                json!({"snapshot":snapshot,"operations":summaries(t,journal,&mission),"outcome":outcome}),
            )
        }
        Command::ThreadsCheck(id) => {
            let mut record = journal
                .planning
                .get(id)
                .filter(|r| r.source == t.source && is_thread(r))
                .cloned()
                .ok_or(Error::Unknown)?;
            // Only the saved envelope. Never re-read or rebind a current source for this lookup.
            t.gate(false).await?;
            check()?;
            if record.pending()
                && let Ok(receipt) = t.planning_operation(&record.operation, true).await
            {
                record.receipt = Some(receipt);
                journal.save_planning(record.clone())?;
            }
            let mission = record.mission().to_owned();
            let snapshot = read(t, &mission).await.ok().filter(|_| check().is_ok());
            Ok(
                json!({"snapshot":snapshot,"operations":summaries(t,journal,&mission),"outcome":summary(&record)}),
            )
        }
        _ => Err(Error::Invalid),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn original_activity_shows_tool_calls_results_and_notes_without_dumping_metadata() {
        let named = json!({"id":"t","inputs":[],"references":[]});
        let call = json!({"id":3,"kind":"pi.assistant","model":[{"role":"assistant","content":[
            {"type":"toolCall","name":"read","arguments":{"path":"file.ts"}}]}]});
        assert!(
            entry(&call, &named, "s", true).unwrap()["text"]
                .as_str()
                .unwrap()
                .contains("Tool call: read")
        );
        let result = json!({"id":4,"kind":"pi.tool-result","model":[{"role":"toolResult","toolName":"read","content":[{"type":"text","text":"Exact result"}]}]});
        assert!(
            entry(&result, &named, "s", true).unwrap()["text"]
                .as_str()
                .unwrap()
                .contains("Exact result")
        );
        let note = json!({"id":5,"kind":"note","data":{"text":"A note","privateMetadata":"not displayed"}});
        assert_eq!(entry(&note, &named, "s", true).unwrap()["text"], "A note");
    }

    #[test]
    fn conversation_keeps_full_text_and_exact_original_identity() {
        let full = "é".repeat(ENTRY_TEXT * 2);
        let page = json!({"entries":[{"id":7,"sessionId":"s","role":"you","text":full,
            "timestamp":1,"replyState":"unknown","original":{"kind":"history","sessionId":"s","entryId":7}}],
            "more":true,"nextBefore":null,"nextSessionId":"older","earlierContext":"unknown"});
        assert!(valid_conversation(&page, "s"));
        assert_eq!(
            page["entries"][0]["text"].as_str().unwrap().len(),
            ENTRY_TEXT * 4
        );
        for (pointer, value) in [
            ("/entries/0/original/sessionId", json!("other")),
            ("/entries/0/sessionId", json!("other")),
            ("/entries/0/replyState", json!("guessed")),
            ("/nextSessionId", Value::Null),
        ] {
            let mut bad = page.clone();
            *bad.pointer_mut(pointer).unwrap() = value;
            assert!(!valid_conversation(&bad, "s"), "{pointer}");
        }
        let mut duplicate = page.clone();
        duplicate["entries"]
            .as_array_mut()
            .unwrap()
            .push(page["entries"][0].clone());
        assert!(!valid_conversation(&duplicate, "s"));
    }

    fn intent(v: Value) -> Result<Intent, Error> {
        let i: Intent = serde_json::from_value(v).map_err(|_| Error::Invalid)?;
        i.validate()?;
        Ok(i)
    }

    #[test]
    fn each_write_names_one_purpose_and_only_its_own_field() {
        let base = json!({"missionId":"m","source":SOURCE});
        let with = |extra: Value| {
            let mut v = base.clone();
            for (k, x) in extra.as_object().unwrap() {
                v[k] = x.clone();
            }
            v
        };
        for ok in [
            json!({"purpose":"thread-create","title":"Importer limits"}),
            json!({"purpose":"thread-disposition","topicId":"t","disposition":"later"}),
            json!({"purpose":"thread-reference","topicId":"t","reference":{"kind":"task","id":"x"}}),
            json!({"purpose":"thread-reference","topicId":"t","reference":{"kind":"history","sessionId":"s","entryId":7}}),
            json!({"purpose":"thread-send","topicId":"t","text":"  Exact words 🙂\n"}),
            json!({"purpose":"thread-send","topicId":"t","text":"Now","interrupt":true}),
        ] {
            assert!(intent(with(ok.clone())).is_ok(), "{ok}");
        }
        for bad in [
            json!({"purpose":"thread-create","title":"  padded "}),
            json!({"purpose":"thread-create","title":"x".repeat(MAX_TITLE + 1)}),
            json!({"purpose":"thread-create","topicId":"t","title":"Chosen ID"}),
            json!({"purpose":"thread-disposition","topicId":"t","disposition":"archived"}),
            json!({"purpose":"thread-disposition","topicId":"t","disposition":"later","text":"x"}),
            json!({"purpose":"thread-reference","topicId":"t","reference":{"kind":"task","id":"x","title":"t"}}),
            json!({"purpose":"thread-reference","topicId":"t","reference":{"kind":"history","sessionId":"s","entryId":0}}),
            json!({"purpose":"thread-send","topicId":"t","text":"   "}),
            json!({"purpose":"thread-send","topicId":"t","text":"x".repeat(MAX_TEXT + 1)}),
            json!({"purpose":"thread-send","text":"no topic"}),
            json!({"purpose":"thread-send","topicId":"t","text":"Now","interrupt":false}),
            json!({"purpose":"thread-create","title":"Topic","interrupt":true}),
            json!({"purpose":"plan-start","topicId":"t"}),
        ] {
            assert!(intent(with(bad.clone())).is_err(), "{bad}");
        }
        // The window cannot choose the operation, the host or another source.
        for extra in ["operationId", "bindingId", "host"] {
            let mut forged = with(json!({"purpose":"thread-send","topicId":"t","text":"x"}));
            forged[extra] = json!("x");
            assert!(intent(forged).is_err(), "{extra}");
        }
        let mut short = with(json!({"purpose":"thread-send","topicId":"t","text":"x"}));
        short["source"] = json!("abc");
        assert!(intent(short).is_err());
    }

    #[test]
    fn the_payload_is_exact_and_keeps_message_bytes() {
        let i = intent(json!({"missionId":"m","source":SOURCE,"purpose":"thread-send","topicId":"t","text":"  a\n🙂 "})).unwrap();
        let r = i.request("t");
        assert_eq!(
            r,
            json!({"purpose":"thread-send","source":SOURCE,"topicId":"t","text":"  a\n🙂 "})
        );
        let op = json!({"kind":"thread-send","bindingId":SOURCE,"bindingGeneration":1,"payload":r.to_string()});
        assert_eq!(validate_record(&op), Ok(()));
        let mut other = op.clone();
        other["bindingId"] = json!("b".repeat(64));
        assert_eq!(validate_record(&other), Err(Error::Storage));
    }

    #[test]
    fn only_the_exact_effect_settles_a_write() {
        let p = json!({"purpose":"thread-send","source":SOURCE,"topicId":"t","text":"x"});
        let op =
            json!({"operationId":"op","kind":"thread-send","targetId":"m","payload":p.to_string()});
        let ok = json!({"result":{"topic":{"id":"t","missionId":"m","inputs":[{"operationId":"op","sessionId":"s"}]},
            "admission":{"admissionId":"op"}}});
        assert_eq!(exact_result(&op, &ok), Ok(()));
        for (pointer, value) in [
            ("/result/admission/admissionId", json!("other")),
            ("/result/topic/inputs", json!([])),
            ("/result/topic/id", json!("u")),
            ("/result/topic/missionId", json!("n")),
        ] {
            let mut changed = ok.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert_eq!(
                exact_result(&op, &changed),
                Err(Error::Unknown),
                "{pointer}"
            );
        }
        // A saved intent without admission is not delivery proof.
        let mut intent_only = ok.clone();
        intent_only["result"]["admission"] = Value::Null;
        assert_eq!(exact_result(&op, &intent_only), Err(Error::Unknown));
        // A message saved to wait is proven by its saved input and the queued mark.
        let mut queued = intent_only.clone();
        queued["result"]["queued"] = json!(true);
        assert_eq!(exact_result(&op, &queued), Ok(()));
        let d = json!({"purpose":"thread-disposition","source":SOURCE,"topicId":"t","disposition":"later"});
        let op = json!({"operationId":"d","kind":"thread-disposition","targetId":"m","payload":d.to_string()});
        let later = json!({"result":{"topic":{"id":"t","missionId":"m","disposition":"later"}}});
        assert_eq!(exact_result(&op, &later), Ok(()));
        let open = json!({"result":{"topic":{"id":"t","missionId":"m","disposition":"open"}}});
        assert_eq!(exact_result(&op, &open), Err(Error::Unknown));
    }

    fn view(available: bool, disposition: &str) -> Value {
        json!({"source":SOURCE,"discussion":{"available":available,"reason":"held"},
            "topics":[{"id":"t","disposition":disposition,"ownerSessionId":"s","references":[]}]})
    }

    #[test]
    fn sends_need_the_shown_source_an_open_topic_and_an_available_coordinator() {
        let send = intent(json!({"missionId":"m","source":SOURCE,"purpose":"thread-send","topicId":"t","text":"x"})).unwrap();
        assert_eq!(qualify(&send, &view(true, "open")), Ok(None));
        assert!(
            qualify(&send, &view(false, "open")).unwrap().is_some(),
            "held/busy/stopped refuse"
        );
        // Saved to wait for the planning agent when it cannot take it now.
        let mut waits = view(false, "open");
        waits["discussion"]["waits"] = json!(true);
        assert_eq!(qualify(&send, &waits), Ok(None));
        assert!(qualify(&send, &view(true, "later")).unwrap().is_some());
        let mut changed = view(true, "open");
        changed["source"] = json!("b".repeat(64));
        assert_eq!(qualify(&send, &changed), Err(Error::Stale));
        let mut gone = view(true, "open");
        gone["topics"] = json!([]);
        assert_eq!(qualify(&send, &gone), Err(Error::Stale));
        // Later and Discard stay available while discussion is not.
        let later = intent(json!({"missionId":"m","source":SOURCE,"purpose":"thread-disposition","topicId":"t","disposition":"later"})).unwrap();
        assert_eq!(qualify(&later, &view(false, "open")), Ok(None));
        let other = intent(
            json!({"missionId":"m","source":SOURCE,"purpose":"thread-reference","topicId":"t",
            "reference":{"kind":"history","sessionId":"other","entryId":3}}),
        )
        .unwrap();
        assert!(qualify(&other, &view(true, "open")).unwrap().is_some());
    }

    #[test]
    fn history_marks_only_what_the_topic_names() {
        let topic = json!({"id":"t","inputs":[{"operationId":"op1"}],
            "references":[{"kind":"history","sessionId":"s","entryId":4}]});
        let sent = json!({"operationId":"op1","kind":"thread-send",
            "payload":json!({"purpose":"thread-send","topicId":"t","text":"Exact 🙂"}).to_string()});
        let input = json!({"id":5,"kind":"pilot.planning-input","data":{"operation":sent.to_string()},
            "model":[{"role":"user","content":"Discuss this one mission topic … wrapper"}]});
        let e = entry(&input, &topic, "s", false).unwrap();
        assert_eq!(e["role"], "you");
        assert_eq!(e["text"], "Exact 🙂");
        assert_eq!(e["input"], true);
        let reply = json!({"id":6,"kind":"pi.assistant","model":[{"role":"assistant",
            "content":[{"type":"thinking","thinking":"hidden"},{"type":"text","text":"Answer"}]}]});
        let e = entry(&reply, &topic, "s", false).unwrap();
        assert_eq!(
            (e["role"].as_str(), e["text"].as_str()),
            (Some("coordinator"), Some("Answer"))
        );
        // Following output is not silently attributed to the topic.
        assert_eq!(
            (e["input"].as_bool(), e["referenced"].as_bool()),
            (Some(false), Some(false))
        );
        let old = json!({"id":4,"kind":"pi.user","model":[{"role":"user","content":"Earlier"}]});
        assert_eq!(entry(&old, &topic, "s", false).unwrap()["referenced"], true);
        let tool = json!({"id":7,"kind":"pi.tool-result"});
        assert_eq!(
            entry(&tool, &topic, "s", false).unwrap()["role"],
            "activity"
        );
        let long = json!({"id":8,"kind":"pi.user","model":[{"role":"user","content":"é".repeat(ENTRY_TEXT)}]});
        let e = entry(&long, &topic, "s", false).unwrap();
        assert_eq!(e["shortened"], true);
        assert!(e["text"].as_str().unwrap().len() <= ENTRY_TEXT);
        let automatic = json!({"id":9,"kind":"pi.user","origin":"mission",
            "model":[{"role":"user","content":"Mission notice"}]});
        assert_eq!(
            entry(&automatic, &topic, "s", false).unwrap()["role"],
            "activity"
        );
        let batch = json!({"id":10,"kind":"pilot.planning-input",
            "data":{"operation":json!({"kind":"plan-thread-messages"}).to_string()},
            "model":[{"role":"user","content":"Original delivered prompt with several exact messages"}]});
        let shown = entry(&batch, &topic, "s", false).unwrap();
        assert_eq!(shown["role"], "planning");
        assert_eq!(
            shown["text"],
            "Original delivered prompt with several exact messages"
        );
    }

    #[test]
    fn a_thread_chat_reply_is_the_chat_and_a_resolved_topic_is_valid() {
        let named = json!({"id":"t","inputs":[],"references":[]});
        let reply = json!({"id":2,"kind":"pi.assistant","model":[{"role":"assistant",
            "content":[{"type":"text","text":"Which layout?"}]}]});
        assert_eq!(entry(&reply, &named, "c", true).unwrap()["role"], "chat");
        let user =
            json!({"id":1,"kind":"pi.user","model":[{"role":"user","content":"Rework the page"}]});
        assert_eq!(entry(&user, &named, "c", true).unwrap()["role"], "you");
        let saved = json!({"version":1,"id":"t1","missionId":"m","projectId":"p","ownerSessionId":"o",
            "title":"T","revision":3,"disposition":"resolved","createdBy":{"kind":"user"},
            "references":[],"inputs":[],"chat":{"operationId":"op","sessionId":"c"},
            "resolvedBy":{"proposalId":"r","taskIds":["k"]}});
        assert!(valid_topic(&saved, "m", "p"));
        let shown = topic(&saved);
        assert_eq!(
            (
                shown["chatSessionId"].as_str(),
                shown["resolvedBy"]["taskIds"][0].as_str()
            ),
            (Some("c"), Some("k"))
        );
    }
}
