//! The user's own feedback about Pilot on the existing serialized host and
//! fsynced ledger. TSX sends the words, uploaded image references and, when the user kept it, the
//! exact mission or chat the feedback came from; the host names the record
//! and the service reads that origin's project and title. A Send is one
//! journaled operation sent once. A lost answer stays Unknown: Check looks up
//! that exact envelope and never sends a replacement. Saving feedback starts
//! no work and approves nothing.
//!
//! A step is one explicit act of the user's on saved feedback: start an agent
//! triage or a small fix in a project the user chose, link a mission, or mark
//! it resolved or open again. The host re-reads the project's chat setup right
//! before saving a triage or fix, and sends each step once, like a Send.
//! An answer is the user's reply to the triage's pending question, sent to
//! that chat once. It clarifies the feedback; it starts and approves nothing.
use super::{Error, Journal, Shared, Transport, planning, valid_id};
use crate::bridge::{Command, Gate};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

/// The operation kind and payload purpose.
pub(super) const KIND: &str = "user-feedback";
/// A step's operation kind and payload purpose.
pub(super) const WORK_KIND: &str = "feedback-work";
/// At most this many UTF-8 bytes of feedback text, as the service counts them.
pub(crate) const MAX_TEXT: usize = 8192;
/// At most this many saved items per page.
const PAGE: usize = 20;
const MAX_CURSOR: u64 = 9_007_199_254_740_991;
/// At most this many UTF-16 units in an answer, as the service counts them.
pub(crate) const MAX_ANSWER: usize = 8000;

fn valid_text(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= MAX_TEXT && !text.contains('\0')
}

fn valid_answer(text: &str) -> bool {
    !text.trim().is_empty() && text.encode_utf16().count() <= MAX_ANSWER && !text.contains('\0')
}

fn valid_question(n: u64) -> bool {
    n > 0 && n <= MAX_CURSOR
}

fn valid_digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Null, or exactly one mission or chat by its ID.
fn valid_origin(o: &Value) -> bool {
    o.is_null()
        || o.as_object().is_some_and(|m| {
            m.len() == 2
                && match m.get("kind").and_then(Value::as_str) {
                    Some("mission") => m
                        .get("missionId")
                        .and_then(Value::as_str)
                        .is_some_and(valid_id),
                    Some("chat") => m
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .is_some_and(valid_id),
                    _ => false,
                }
        })
}

/// One piece of feedback as the user wrote it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Intent {
    text: String,
    #[serde(default)]
    origin: Value,
    #[serde(default)]
    attachments: Option<Value>,
}
impl Intent {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if valid_text(&self.text)
            && valid_origin(&self.origin)
            && self.attachments.as_ref().is_none_or(valid_images)
        {
            Ok(())
        } else {
            Err(Error::Invalid)
        }
    }
}

/// The image limit also keeps the bridge and VM copies small.
pub(crate) const MAX_IMAGE: usize = 8 * 1024 * 1024;
pub(crate) const IMAGE_REQUEST: usize = MAX_IMAGE * 4 / 3 + 4096;

pub(crate) fn valid_images(v: &Value) -> bool {
    v.as_array().is_some_and(|images| {
        images.len() <= 4
            && images.iter().all(|r| {
                r.as_object().is_some_and(|o| o.len() == 3)
                    && r["uploadId"]
                        .as_str()
                        .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
                    && r["sha256"].as_str().is_some_and(valid_digest)
                    && r["bytes"]
                        .as_u64()
                        .is_some_and(|n| n >= 33 && n <= MAX_IMAGE as u64)
            })
            && images
                .iter()
                .enumerate()
                .all(|(i, a)| images[..i].iter().all(|b| a["uploadId"] != b["uploadId"]))
    })
}

/// Reserve an upload identity, or upload the exact PNG with that identity.
/// Upload retries reuse it. This is not a feedback Send or an operation ID.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ImageUpload {
    upload_id: Option<String>,
    data: Option<String>,
}
impl ImageUpload {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        match (&self.upload_id, &self.data) {
            (None, None) => Ok(()),
            (Some(id), None) if uuid::Uuid::parse_str(id).is_ok() => Ok(()),
            (Some(id), Some(data))
                if uuid::Uuid::parse_str(id).is_ok()
                    && data.len() <= IMAGE_REQUEST
                    && data.starts_with("data:image/png;base64,") =>
            {
                Ok(())
            }
            _ => Err(Error::Invalid),
        }
    }
}

async fn upload(t: &Transport, image: &ImageUpload) -> Result<Value, Error> {
    image.validate()?;
    if let (Some(id), None) = (&image.upload_id, &image.data) {
        let r = t
            .client
            .delete(t.url(&format!("/api/attachments/{id}")))
            .header("x-pilot-github-capability", t.local()?)
            .send()
            .await
            .map_err(|_| Error::Offline)?;
        return if r.status().is_success() {
            Ok(json!({"removed":true}))
        } else {
            Err(Error::Unavailable)
        };
    }
    let (Some(id), Some(data)) = (&image.upload_id, &image.data) else {
        return Ok(json!({"uploadId":uuid::Uuid::new_v4().to_string()}));
    };
    let bytes = STANDARD
        .decode(data.trim_start_matches("data:image/png;base64,"))
        .map_err(|_| Error::Invalid)?;
    if bytes.len() < 33 || bytes.len() > MAX_IMAGE || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(Error::Invalid);
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let reference = json!({"uploadId":id,"sha256":digest,"bytes":bytes.len()});
    let mut metadata = reference.clone();
    metadata["origin"] = json!({"hostId":"local","daemonId":t.source.home.daemon_id,"lineageId":t.source.home.lineage_id});
    let r = t
        .client
        .put(t.url(&format!("/api/attachments/{id}")))
        .header("x-pilot-github-capability", t.local()?)
        .header("x-pilot-attachment", STANDARD.encode(metadata.to_string()))
        .body(bytes)
        .send()
        .await
        .map_err(|_| Error::Offline)?;
    if !r.status().is_success() {
        return Err(Error::Unavailable);
    }
    if r.content_length().is_some_and(|n| n > 4096) {
        return Err(Error::Invalid);
    }
    let body = r.bytes().await.map_err(|_| Error::Offline)?;
    if body.len() > 4096
        || serde_json::from_slice::<Value>(&body).map_err(|_| Error::Invalid)? != reference
    {
        return Err(Error::Invalid);
    }
    t.profile_gate().await?;
    Ok(json!({"image":reference}))
}

/// One page of saved feedback: the newest, or older than `before`. Read only.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Read {
    before: Option<u64>,
    #[serde(default)]
    cached: bool,
}
impl Read {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if self.before.is_some_and(|n| n == 0 || n > MAX_CURSOR)
            || (self.cached && self.before.is_some())
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

/// One step on one saved feedback item. Only the fields its action needs.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Step {
    feedback_id: String,
    action: String,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    context_digest: Option<String>,
    #[serde(default)]
    triage_session_id: Option<String>,
    #[serde(default)]
    proposal_digest: Option<String>,
    #[serde(default)]
    mission_id: Option<String>,
    /// answer: the triage question's entry, as the read showed it.
    #[serde(default)]
    question_id: Option<u64>,
    /// answer: the user's words, exactly as sent to the triage.
    #[serde(default)]
    message: Option<String>,
}
impl Step {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        let id = |v: &Option<String>| v.as_deref().is_some_and(valid_id);
        let digest = |v: &Option<String>| v.as_deref().is_some_and(valid_digest);
        let chat =
            id(&self.project_id) && digest(&self.context_digest) && self.mission_id.is_none();
        let answer = self.question_id.is_some() || self.message.is_some();
        let ok = valid_id(&self.feedback_id)
            && (self.action == "answer") == answer
            && match self.action.as_str() {
                "triage" => {
                    chat && self.triage_session_id.is_none() && self.proposal_digest.is_none()
                }
                "fix" => chat && id(&self.triage_session_id) && digest(&self.proposal_digest),
                "link" => {
                    id(&self.mission_id)
                        && self.project_id.is_none()
                        && self.context_digest.is_none()
                        && self.triage_session_id.is_none()
                        && self.proposal_digest.is_none()
                }
                "resolve" | "reopen" => {
                    self.project_id.is_none()
                        && self.context_digest.is_none()
                        && self.triage_session_id.is_none()
                        && self.proposal_digest.is_none()
                        && self.mission_id.is_none()
                }
                // The answer names the triage chat; the service checks it is this item's current one.
                "answer" => {
                    id(&self.triage_session_id)
                        && self.question_id.is_some_and(valid_question)
                        && self.message.as_deref().is_some_and(valid_answer)
                        && self.project_id.is_none()
                        && self.context_digest.is_none()
                        && self.proposal_digest.is_none()
                        && self.mission_id.is_none()
                }
                _ => false,
            };
        if ok { Ok(()) } else { Err(Error::Invalid) }
    }
}

fn payload(op: &Value) -> Result<Value, Error> {
    serde_json::from_str(op["payload"].as_str().ok_or(Error::Storage)?).map_err(|_| Error::Storage)
}

/// A saved feedback operation holds only the words and an exact origin.
pub(super) fn validate_record(op: &Value) -> Result<(), Error> {
    let p = payload(op)?;
    if p.as_object()
        .is_none_or(|o| o.len() != 3 + usize::from(o.contains_key("attachments")))
        || p.get("attachments").is_some_and(|v| !valid_images(v))
        || p["purpose"] != KIND
        || op["kind"] != KIND
        || op["bindingGeneration"] != 1
        || p["text"].as_str().is_none_or(|t| !valid_text(t))
        || !valid_origin(&p["origin"])
    {
        return Err(Error::Storage);
    }
    Ok(())
}

/// The fields a saved step's payload holds for its action, after purpose, action and feedbackId.
fn step_fields(action: &str) -> Option<&'static [&'static str]> {
    const CHAT: &[&str] = &[
        "projectId",
        "projectPath",
        "contextDigest",
        "model",
        "thinking",
    ];
    const FIX: &[&str] = &[
        "projectId",
        "projectPath",
        "contextDigest",
        "model",
        "thinking",
        "triageSessionId",
        "proposalDigest",
    ];
    match action {
        "triage" => Some(CHAT),
        "fix" => Some(FIX),
        "link" => Some(&["missionId"]),
        "resolve" | "reopen" => Some(&[]),
        "answer" => Some(&["questionId", "message"]),
        _ => None,
    }
}

/// A saved step holds exactly its action's fields, aimed at its own target.
pub(super) fn validate_step_record(op: &Value) -> Result<(), Error> {
    let p = payload(op)?;
    let action = p["action"].as_str().unwrap_or("");
    let fields = step_fields(action).ok_or(Error::Storage)?;
    let o = p.as_object().ok_or(Error::Storage)?;
    let str_of = |k: &str| p[k].as_str().unwrap_or("");
    let chat = || {
        valid_id(str_of("projectId"))
            && valid_digest(str_of("contextDigest"))
            && op["bindingId"] == p["contextDigest"]
            && str_of("projectPath").starts_with('/')
            && str_of("projectPath").len() <= 4096
            && !str_of("model").is_empty()
            && str_of("model").len() <= 256
            && p["thinking"].as_str().is_some_and(|t| t.len() <= 128)
    };
    let target = op["targetId"].as_str().unwrap_or("");
    let ok = o.len() == 3 + fields.len()
        && fields.iter().all(|k| o.contains_key(*k))
        && p["purpose"] == WORK_KIND
        && op["kind"] == WORK_KIND
        && op["bindingGeneration"] == 1
        && valid_id(str_of("feedbackId"))
        && match action {
            "triage" => chat() && valid_id(target),
            "fix" => {
                chat()
                    && valid_id(target)
                    && valid_id(str_of("triageSessionId"))
                    && valid_digest(str_of("proposalDigest"))
            }
            "link" => valid_id(str_of("missionId")) && target == str_of("missionId"),
            "answer" => {
                valid_id(target)
                    && p["questionId"].as_u64().is_some_and(valid_question)
                    && valid_answer(str_of("message"))
            }
            _ => target == str_of("feedbackId"),
        };
    if ok { Ok(()) } else { Err(Error::Storage) }
}

/// Only an accepted receipt naming this operation and the step's own chat or mission proves a step.
pub(super) fn exact_step(op: &Value, r: &Value) -> Result<(), Error> {
    let p = payload(op).map_err(|_| Error::Unknown)?;
    let result = &r["result"];
    let kind = match p["action"].as_str() {
        Some("triage") => "triage",
        Some("fix") => "fix",
        Some("link") => "mission",
        Some("resolve") => "resolved",
        Some("reopen") => "reopened",
        Some("answer") => "answer",
        _ => return Err(Error::Unknown),
    };
    let same = match kind {
        "triage" | "fix" => {
            result["sessionId"] == op["targetId"] && result["projectId"] == p["projectId"]
        }
        "mission" => result["missionId"] == op["targetId"],
        "answer" => {
            result["sessionId"] == op["targetId"]
                && result["questionId"] == p["questionId"]
                && result["text"] == p["message"]
        }
        _ => true,
    };
    if !same
        || result["kind"] != kind
        || result["operationId"] != op["operationId"]
        || !result["recordedAt"].is_u64()
    {
        return Err(Error::Unknown);
    }
    Ok(())
}

/// Only an accepted receipt naming this record, operation and words proves a Send.
pub(super) fn exact_result(op: &Value, r: &Value) -> Result<(), Error> {
    let p = payload(op).map_err(|_| Error::Unknown)?;
    let result = &r["result"];
    if result["id"] != op["targetId"]
        || result["operationId"] != op["operationId"]
        || result["text"] != p["text"]
        || result["attachments"] != p["attachments"]
        || !result["recordedAt"].is_u64()
    {
        return Err(Error::Unknown);
    }
    Ok(())
}

fn is_feedback(r: &planning::PlanningRecord) -> bool {
    r.operation["kind"] == KIND
}

fn is_step(r: &planning::PlanningRecord) -> bool {
    r.operation["kind"] == WORK_KIND
}

/// Sends and steps whose result is not known yet. Settled ones show in the saved list.
fn unsettled(t: &Transport, journal: &Journal) -> Vec<Value> {
    journal
        .planning
        .values()
        .filter(|r| r.source == t.source && (is_feedback(r) || is_step(r)) && r.pending())
        .map(|r| {
            let p = payload(&r.operation).unwrap_or(Value::Null);
            if is_step(r) {
                json!({"operationId":r.id(),"state":"unknown","step":p["action"],"feedbackId":p["feedbackId"]})
            } else {
                json!({"operationId":r.id(),"state":"unknown","text":p["text"]})
            }
        })
        .collect()
}

fn valid_item(v: &Value) -> bool {
    let origin = &v["origin"];
    v["id"].as_str().is_some_and(valid_id)
        && v["operationId"].as_str().is_some_and(valid_id)
        && v["text"].as_str().is_some()
        && v["recordedAt"].is_u64()
        && (origin.is_null()
            || (match origin["kind"].as_str() {
                Some("mission") => origin["missionId"].as_str().is_some_and(valid_id),
                Some("chat") => origin["sessionId"].as_str().is_some_and(valid_id),
                _ => false,
            } && origin["projectId"].as_str().is_some_and(valid_id)
                && origin["title"].is_string()))
}

/// A page is newest first, strictly older than `before`, with an exact cursor.
fn valid_page(v: &Value, before: Option<u64>) -> bool {
    let (Some(list), Some(more)) = (v["items"].as_array(), v["more"].as_bool()) else {
        return false;
    };
    let mut previous = before.unwrap_or(u64::MAX);
    for item in list {
        let Some(n) = item["sequence"].as_u64() else {
            return false;
        };
        if n == 0 || n >= previous || !valid_item(item) {
            return false;
        }
        previous = n;
    }
    list.len() <= PAGE
        && if more {
            !list.is_empty() && v["before"].as_u64() == Some(previous)
        } else {
            v["before"].is_null()
        }
}

/// One page of the user's saved feedback. A failed read is never an empty list.
async fn read(t: &Transport, before: Option<u64>) -> Result<Value, Error> {
    t.profile_gate().await?;
    let after = before.map(|n| format!("&before={n}")).unwrap_or_default();
    let v = t.get(&format!("/api/feedback?limit={PAGE}{after}")).await?;
    if !valid_page(&v, before) {
        return Err(Error::Invalid);
    }
    t.profile_gate().await?;
    Ok(
        json!({"version":1,"items":v["items"],"more":v["more"],"before":v["before"],"older":before.is_some()}),
    )
}

/// Event-driven refresh. Bridge change notices only read this cached page.
pub(super) async fn refresh(t: &Transport, shared: &Shared) {
    let wanted = shared
        .feedback
        .lock()
        .expect("native feedback poisoned")
        .is_some();
    if wanted {
        let snapshot = read(t, None).await;
        *shared.feedback.lock().expect("native feedback poisoned") = Some(snapshot);
    }
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
    let mut outcome = Value::Null;
    let mut before = None;
    match command {
        Command::FeedbackImage(image) => {
            check()?;
            t.profile_gate().await?;
            check()?;
            return upload(t, image).await;
        }
        Command::FeedbackRead(request) => {
            request.validate()?;
            before = request.before;
        }
        Command::FeedbackSend(intent) => {
            intent.validate()?;
            // An earlier Send whose result is unknown is checked first, never sent again beside a copy.
            if journal
                .planning
                .values()
                .any(|r| r.source == t.source && is_feedback(r) && r.pending())
            {
                return Err(Error::Unknown);
            }
            // A service that cannot list feedback cannot be sent any.
            read(t, None).await?;
            check()?;
            let mut request = json!({"purpose":KIND,"text":intent.text,"origin":intent.origin});
            if let Some(images) = &intent.attachments {
                request["attachments"] = images.clone();
            }
            let digest = planning::hash(&request.to_string());
            let id = uuid::Uuid::new_v4().to_string();
            outcome = send_once(t, journal, &check, id, digest, request).await?;
        }
        Command::FeedbackStep(step) => {
            step.validate()?;
            // An earlier step whose result is unknown is checked first, never sent again beside a copy.
            if journal
                .planning
                .values()
                .any(|r| r.source == t.source && is_step(r) && r.pending())
            {
                return Err(Error::Unknown);
            }
            read(t, None).await?;
            check()?;
            let mut request =
                json!({"purpose":WORK_KIND,"action":step.action,"feedbackId":step.feedback_id});
            let (target, digest) = match step.action.as_str() {
                "triage" | "fix" => {
                    let mode = if step.action == "triage" {
                        "ask"
                    } else {
                        "build"
                    };
                    let select = super::new_chat::Select {
                        project_id: step.project_id.clone().unwrap_or_default(),
                        context_digest: step.context_digest.clone().unwrap_or_default(),
                        mode: mode.into(),
                    };
                    // The project's current setup, read right before saving. A changed one is Stale.
                    let profile = super::new_chat::profile(t, &select).await?;
                    check()?;
                    for k in [
                        "projectId",
                        "projectPath",
                        "contextDigest",
                        "model",
                        "thinking",
                    ] {
                        request[k] = profile[k].clone();
                    }
                    if step.action == "fix" {
                        request["triageSessionId"] = json!(step.triage_session_id);
                        request["proposalDigest"] = json!(step.proposal_digest);
                    }
                    (uuid::Uuid::new_v4().to_string(), select.context_digest)
                }
                "link" => {
                    request["missionId"] = json!(step.mission_id);
                    let digest = planning::hash(&request.to_string());
                    (step.mission_id.clone().unwrap_or_default(), digest)
                }
                "answer" => {
                    request["questionId"] = json!(step.question_id);
                    request["message"] = json!(step.message);
                    let digest = planning::hash(&request.to_string());
                    (step.triage_session_id.clone().unwrap_or_default(), digest)
                }
                _ => {
                    let digest = planning::hash(&request.to_string());
                    (step.feedback_id.clone(), digest)
                }
            };
            outcome = send_once(t, journal, &check, target, digest, request).await?;
        }
        Command::FeedbackCheck(id) => {
            let mut record = journal
                .planning
                .get(id)
                .filter(|r| r.source == t.source && (is_feedback(r) || is_step(r)))
                .cloned()
                .ok_or(Error::Unknown)?;
            // Only the saved envelope's receipt. Nothing is sent again.
            t.profile_gate().await?;
            check()?;
            if record.pending()
                && let Ok(receipt) = t.planning_operation(&record.operation, true).await
            {
                record.receipt = Some(receipt);
                journal.save_planning(record.clone())?;
            }
            outcome = outcome_of(&record, true);
        }
        _ => return Err(Error::Invalid),
    }
    let cached = if matches!(command, Command::FeedbackRead(request) if request.cached) {
        shared
            .feedback
            .lock()
            .expect("native feedback poisoned")
            .clone()
    } else {
        None
    };
    let snapshot = if let Some(snapshot) = cached {
        if !shared.connected.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Error::Offline);
        }
        snapshot
    } else {
        read(t, before).await
    };
    if before.is_none() {
        *shared.feedback.lock().expect("native feedback poisoned") = Some(snapshot.clone());
    }
    if matches!(command, Command::FeedbackRead(_)) {
        let snapshot = snapshot?;
        check()?;
        Ok(json!({"snapshot":snapshot,"operations":unsettled(t,journal),"outcome":outcome}))
    } else {
        // A failed/raced refresh cannot erase the exact acknowledgement.
        Ok(
            json!({"snapshot":snapshot.ok().filter(|_| check().is_ok()),"operations":unsettled(t,journal),"outcome":outcome}),
        )
    }
}

/// Saves the exact envelope, then sends it once. A lost answer stays Unknown.
async fn send_once(
    t: &Transport,
    journal: &mut Journal,
    check: &impl Fn() -> Result<(), Error>,
    target: String,
    digest: String,
    request: Value,
) -> Result<Value, Error> {
    let mut record = planning::record(&t.source, target, digest, request)?;
    record.validate().map_err(|_| Error::Invalid)?;
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
    Ok(outcome_of(&record, saved))
}

fn outcome_of(record: &planning::PlanningRecord, saved: bool) -> Value {
    let state = if record.not_sent {
        json!("not-sent")
    } else if saved {
        record
            .receipt
            .as_ref()
            .map(|r| r["state"].clone())
            .unwrap_or(json!("unknown"))
    } else {
        json!("unknown")
    };
    json!({"operationId":record.id(),"state":state,"receipt":if saved {record.receipt.clone()} else {None}})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feedback_images_are_exact_references_not_paths_and_the_receipt_must_match() {
        let image = json!({"uploadId":"00000000-0000-4000-8000-000000000001","sha256":"a".repeat(64),"bytes":70});
        assert!(valid_images(&json!([image])));
        assert!(!valid_images(&json!([image, image])));
        assert!(!valid_images(&json!([{"path":"/etc/passwd"}])));
        let p = json!({"purpose":KIND,"text":"popup","origin":null,"attachments":[image]});
        let op = json!({"operationId":"op","targetId":"feedback","kind":KIND,"bindingGeneration":1,"payload":p.to_string()});
        assert_eq!(validate_record(&op), Ok(()));
        let r = json!({"result":{"id":"feedback","operationId":"op","text":"popup","recordedAt":1,"attachments":[image]}});
        assert_eq!(exact_result(&op, &r), Ok(()));
        let mut changed = r.clone();
        changed["result"]["attachments"] = json!([]);
        assert_eq!(exact_result(&op, &changed), Err(Error::Unknown));
        let mut changed = image.clone();
        changed["bytes"] = json!(MAX_IMAGE + 1);
        assert!(!valid_images(&json!([changed])));
        for v in [
            json!({}),
            json!({"uploadId":image["uploadId"]}),
            json!({"uploadId":image["uploadId"],"data":"data:image/png;base64,AAAA"}),
        ] {
            assert!(
                serde_json::from_value::<ImageUpload>(v)
                    .unwrap()
                    .validate()
                    .is_ok()
            );
        }
        assert!(
            serde_json::from_value::<ImageUpload>(json!({"uploadId":"../escape"}))
                .unwrap()
                .validate()
                .is_err()
        );
    }

    fn intent(v: Value) -> Result<Intent, Error> {
        let i: Intent = serde_json::from_value(v).map_err(|_| Error::Invalid)?;
        i.validate()?;
        Ok(i)
    }

    #[test]
    fn a_send_holds_words_and_at_most_one_exact_origin() {
        assert!(intent(json!({"text":"The plan page is slow 🐢","origin":null})).is_ok());
        assert!(
            intent(json!({"text":"About this","origin":{"kind":"mission","missionId":"m-1"}}))
                .is_ok()
        );
        assert!(
            intent(json!({"text":"About this","origin":{"kind":"chat","sessionId":"s_1"}})).is_ok()
        );
        for bad in [
            json!({"text":"   ","origin":null}),
            json!({"text":"x".repeat(MAX_TEXT + 1),"origin":null}),
            json!({"text":"nul\0","origin":null}),
            json!({"text":"t","origin":{"kind":"mission","missionId":"../m"}}),
            json!({"text":"t","origin":{"kind":"chat","missionId":"m"}}),
            json!({"text":"t","origin":{"kind":"mission","missionId":"m","projectId":"p"}}),
            json!({"text":"t","origin":{"kind":"project","projectId":"p"}}),
            json!({"text":"t","origin":"m"}),
        ] {
            assert!(intent(bad.clone()).is_err(), "{bad}");
        }
        // The window cannot choose an ID, project, operation or status.
        for extra in ["id", "projectId", "operationId", "state"] {
            let mut forged = json!({"text":"t","origin":null});
            forged[extra] = json!("x");
            assert!(intent(forged).is_err(), "{extra}");
        }
    }

    #[test]
    fn only_the_same_record_operation_and_words_settle_a_send() {
        let p = json!({"purpose":KIND,"text":"Slow","origin":null});
        let op = json!({"operationId":"op","targetId":"f","kind":KIND,"bindingGeneration":1,"payload":p.to_string()});
        assert_eq!(validate_record(&op), Ok(()));
        let r = json!({"result":{"id":"f","operationId":"op","text":"Slow","recordedAt":1,"origin":null}});
        assert_eq!(exact_result(&op, &r), Ok(()));
        for (pointer, value) in [
            ("/result/id", json!("other")),
            ("/result/operationId", json!("other")),
            ("/result/text", json!("Fast")),
            ("/result/recordedAt", Value::Null),
        ] {
            let mut changed = r.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert_eq!(
                exact_result(&op, &changed),
                Err(Error::Unknown),
                "{pointer}"
            );
        }
        let mut forged = op.clone();
        forged["payload"] =
            json!(json!({"purpose":KIND,"text":"Slow","origin":null,"projectId":"p"}).to_string());
        assert_eq!(validate_record(&forged), Err(Error::Storage));
    }

    #[test]
    fn a_page_is_newest_first_with_an_exact_cursor() {
        let item = |n: u64| {
            json!({"sequence":n,"id":format!("f{n}"),"operationId":format!("o{n}"),"text":"t","recordedAt":1,
                "origin":{"kind":"mission","missionId":"m","projectId":"p","title":"Mission"}})
        };
        let page = json!({"items":[item(5),item(4)],"more":true,"before":4});
        assert!(valid_page(&page, None));
        assert!(valid_page(&page, Some(6)));
        assert!(!valid_page(&page, Some(5)));
        for (pointer, value) in [
            ("/before", json!(5)),
            ("/before", Value::Null),
            ("/items/1/sequence", json!(5)),
            ("/items/0/origin/projectId", Value::Null),
            ("/items/0/origin/kind", json!("project")),
            ("/items/0/id", json!("bad id")),
            ("/more", Value::Null),
        ] {
            let mut changed = page.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert!(!valid_page(&changed, None), "{pointer}");
        }
        assert!(valid_page(
            &json!({"items":[],"more":false,"before":null}),
            None
        ));
        let many = json!({"items":(1..=21).rev().map(item).collect::<Vec<_>>(),"more":false,"before":null});
        assert!(!valid_page(&many, None));
        assert_eq!(
            Read {
                before: Some(0),
                cached: false
            }
            .validate(),
            Err(Error::Invalid)
        );
    }

    fn step(v: Value) -> Result<Step, Error> {
        let s: Step = serde_json::from_value(v).map_err(|_| Error::Invalid)?;
        s.validate()?;
        Ok(s)
    }

    #[test]
    fn a_step_names_only_what_its_action_needs() {
        let d = "a".repeat(64);
        assert!(
            step(json!({"feedbackId":"f","action":"triage","projectId":"p","contextDigest":d}))
                .is_ok()
        );
        assert!(
            step(
                json!({"feedbackId":"f","action":"fix","projectId":"p","contextDigest":d,
            "triageSessionId":"s","proposalDigest":d})
            )
            .is_ok()
        );
        assert!(step(json!({"feedbackId":"f","action":"link","missionId":"m"})).is_ok());
        assert!(step(json!({"feedbackId":"f","action":"resolve"})).is_ok());
        assert!(step(json!({"feedbackId":"f","action":"reopen"})).is_ok());
        assert!(
            step(
                json!({"feedbackId":"f","action":"answer","triageSessionId":"s","questionId":42,
                "message":"The plan page 日本語"})
            )
            .is_ok()
        );
        for bad in [
            json!({"feedbackId":"f","action":"start"}),
            json!({"feedbackId":"f","action":"triage","projectId":"p"}),
            json!({"feedbackId":"f","action":"triage","projectId":"p","contextDigest":"A".repeat(64)}),
            json!({"feedbackId":"f","action":"triage","projectId":"p","contextDigest":d,"missionId":"m"}),
            json!({"feedbackId":"f","action":"fix","projectId":"p","contextDigest":d,"triageSessionId":"s"}),
            json!({"feedbackId":"f","action":"link"}),
            json!({"feedbackId":"f","action":"link","missionId":"m","projectId":"p"}),
            json!({"feedbackId":"f","action":"resolve","missionId":"m"}),
            json!({"feedbackId":"../f","action":"resolve"}),
            // The window cannot choose a model, mode, message or operation.
            json!({"feedbackId":"f","action":"triage","projectId":"p","contextDigest":d,"model":"x"}),
            json!({"feedbackId":"f","action":"triage","projectId":"p","contextDigest":d,"mode":"build"}),
            json!({"feedbackId":"f","action":"resolve","message":"x"}),
            // An answer names the chat, its question and words only, and only an answer has them.
            json!({"feedbackId":"f","action":"answer","triageSessionId":"s","message":"x"}),
            json!({"feedbackId":"f","action":"answer","triageSessionId":"s","questionId":0,"message":"x"}),
            json!({"feedbackId":"f","action":"answer","triageSessionId":"s","questionId":1,"message":"  "}),
            json!({"feedbackId":"f","action":"answer","triageSessionId":"s","questionId":1,"message":"x".repeat(MAX_ANSWER + 1)}),
            json!({"feedbackId":"f","action":"answer","questionId":1,"message":"x"}),
            json!({"feedbackId":"f","action":"answer","triageSessionId":"s","questionId":1,"message":"x","projectId":"p"}),
            json!({"feedbackId":"f","action":"resolve","questionId":1}),
            json!({"feedbackId":"f","action":"triage","projectId":"p","contextDigest":d,"questionId":1}),
        ] {
            assert!(step(bad.clone()).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_the_same_chat_question_and_words_settle_an_answer() {
        let p = json!({"purpose":WORK_KIND,"action":"answer","feedbackId":"f","questionId":42,"message":"The plan page"});
        let op = json!({"operationId":"op","targetId":"s1","kind":WORK_KIND,"bindingGeneration":1,
            "bindingId":"a".repeat(64),"payload":p.to_string()});
        assert_eq!(validate_step_record(&op), Ok(()));
        let r = json!({"result":{"operationId":"op","kind":"answer","sessionId":"s1","questionId":42,
            "text":"The plan page","recordedAt":1}});
        assert_eq!(exact_step(&op, &r), Ok(()));
        for (pointer, value) in [
            ("/result/sessionId", json!("s2")),
            ("/result/questionId", json!(43)),
            ("/result/text", json!("Another page")),
            ("/result/kind", json!("triage")),
            ("/result/operationId", json!("other")),
        ] {
            let mut changed = r.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert_eq!(exact_step(&op, &changed), Err(Error::Unknown), "{pointer}");
        }
        let mut forged = op.clone();
        forged["payload"] = json!(
            json!({"purpose":WORK_KIND,"action":"answer","feedbackId":"f","questionId":42,"message":"x","start":true})
                .to_string()
        );
        assert_eq!(validate_step_record(&forged), Err(Error::Storage));
    }

    #[test]
    fn only_the_steps_own_chat_or_mission_settles_it() {
        let d = "b".repeat(64);
        let op = |target: &str, p: Value| {
            json!({"operationId":"op","targetId":target,"kind":WORK_KIND,"bindingGeneration":1,
                "bindingId":d,"payload":p.to_string()})
        };
        let triage = op(
            "s1",
            json!({"purpose":WORK_KIND,"action":"triage","feedbackId":"f","projectId":"p",
                "projectPath":"/repo","contextDigest":d,"model":"fake/model","thinking":"high"}),
        );
        assert_eq!(validate_step_record(&triage), Ok(()));
        let r = json!({"result":{"operationId":"op","kind":"triage","sessionId":"s1","projectId":"p","recordedAt":1}});
        assert_eq!(exact_step(&triage, &r), Ok(()));
        for (pointer, value) in [
            ("/result/sessionId", json!("s2")),
            ("/result/projectId", json!("q")),
            ("/result/kind", json!("fix")),
            ("/result/operationId", json!("other")),
            ("/result/recordedAt", Value::Null),
        ] {
            let mut changed = r.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert_eq!(
                exact_step(&triage, &changed),
                Err(Error::Unknown),
                "{pointer}"
            );
        }
        let link = op(
            "m",
            json!({"purpose":WORK_KIND,"action":"link","feedbackId":"f","missionId":"m"}),
        );
        assert_eq!(validate_step_record(&link), Ok(()));
        let linked = json!({"result":{"operationId":"op","kind":"mission","missionId":"m","projectId":"p","recordedAt":1}});
        assert_eq!(exact_step(&link, &linked), Ok(()));
        let mark = op(
            "f",
            json!({"purpose":WORK_KIND,"action":"resolve","feedbackId":"f"}),
        );
        assert_eq!(validate_step_record(&mark), Ok(()));
        assert_eq!(
            exact_step(
                &mark,
                &json!({"result":{"operationId":"op","kind":"reopened","recordedAt":1}})
            ),
            Err(Error::Unknown)
        );
        // A step aimed elsewhere, or with an extra field, is not this step.
        for forged in [
            op(
                "m2",
                json!({"purpose":WORK_KIND,"action":"link","feedbackId":"f","missionId":"m"}),
            ),
            op(
                "g",
                json!({"purpose":WORK_KIND,"action":"resolve","feedbackId":"f"}),
            ),
            op(
                "f",
                json!({"purpose":WORK_KIND,"action":"resolve","feedbackId":"f","text":"x"}),
            ),
            op(
                "s1",
                json!({"purpose":WORK_KIND,"action":"triage","feedbackId":"f","projectId":"p",
                    "projectPath":"/repo","contextDigest":"c".repeat(64),"model":"fake/model","thinking":"high"}),
            ),
        ] {
            assert_eq!(
                validate_step_record(&forged),
                Err(Error::Storage),
                "{forged}"
            );
        }
    }
}
