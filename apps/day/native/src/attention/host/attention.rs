//! Attention shares the native worker, admission fence and private command ledger.
use super::{Error, NativeHost, Shared, Source, Transport, valid_id};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[path = "scoped_attention.rs"]
pub(crate) mod scoped_attention;

/// Native navigation authority. The root supplies it; screen code cannot choose an opener.
pub type UrlOpener = std::sync::Arc<dyn Fn(&str) -> Result<(), Error> + Send + Sync>;

/// Exact draft location. Old revisions stay readable, never become current consent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftKey {
    pub kind: String,
    pub id: String,
    pub revision: u64,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Draft {
    pub draft_version: u32,
    pub source: Source,
    pub key: DraftKey,
    pub value: Value,
}
impl Draft {
    pub fn id(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(&self.source, &self.key))
                    .expect("serializable draft identity")
            )
        )
    }
    pub fn validate(&self) -> Result<(), Error> {
        if self.draft_version != 1
            || !matches!(self.key.kind.as_str(), "question" | "action")
            || self.key.id.is_empty()
            || self.key.id.len() > 256
            || self.key.revision == 0
            || !digest(&self.key.digest)
            || serde_json::to_vec(&self.value)
                .map_err(|_| Error::Invalid)?
                .len()
                > if self.key.kind == "question"
                    && crate::attention_interview::is_draft(&self.value)
                {
                    crate::attention_interview::DRAFT_STORAGE_LIMIT
                } else {
                    crate::attention_host::DRAFT_LIMIT
                }
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Record {
    pub attention_version: u32,
    pub source: Source,
    pub id: String,
    pub request: Value,
    pub receipt: Option<Value>,
    pub not_sent: bool,
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl Record {
    pub fn pending(&self) -> bool {
        !self.not_sent
            && self.receipt.as_ref().is_none_or(|v| {
                v["ok"] != true && v["error"]["code"] == "unknown"
                    || self.request["kind"] == "answer" && v["value"]["state"] == "pending"
            })
    }
    pub fn validate(&self) -> Result<(), Error> {
        let r = &self.request;
        if self.attention_version != 1
            || !valid_id(&self.id)
            || r["version"] != 1
            || r["projectId"] != self.source.project()?.project_id
            || r["home"] != home(&self.source)
            || serde_json::to_vec(r).map_err(|_| Error::Invalid)?.len()
                > if r["interview"].is_object() {
                    256 * 1024
                } else {
                    65536
                }
        {
            return Err(Error::Invalid);
        }
        match r["kind"].as_str() {
            Some("action")
                if r["command"]["operationId"] == self.id
                    && matches!(
                        r["command"]["kind"].as_str(),
                        Some("progress" | "defer" | "resume" | "complete")
                    ) => {}
            Some("help") if r["request"]["requestId"] == self.id => (),
            Some("resource") => (),
            Some("answer")
                if r["operation"]["operationId"] == self.id
                    && r["operation"]["kind"] == "attention-answer" => {}
            _ => return Err(Error::Invalid),
        }
        if self.request.get("scopedTarget").is_some() {
            scoped_attention::validate_record(self)?;
        }
        if let Some(receipt) = &self.receipt {
            exact(r, receipt)?;
        }
        Ok(())
    }
    pub fn summary(&self) -> Value {
        json!({"id":self.id,"request":self.request,"receipt":self.receipt,"state":if self.not_sent {"not-sent"} else if self.pending() {"unknown"} else {"acknowledged"}, "navigation":if self.request["kind"] == "resource" {json!("unknown")} else {Value::Null}})
    }
}

fn home(source: &Source) -> Value {
    json!({"hostId":"local","daemonId":source.home.daemon_id,"lineageId":source.home.lineage_id})
}
fn exact(request: &Value, reply: &Value) -> Result<(), Error> {
    if reply["ok"] == false {
        if request.get("scopedTarget").is_some() {
            return Err(Error::Unknown);
        }
        return if matches!(
            reply["error"]["code"].as_str(),
            Some(
                "invalid"
                    | "not_found"
                    | "stale"
                    | "forbidden"
                    | "conflict"
                    | "unavailable"
                    | "unknown"
            )
        ) {
            Ok(())
        } else {
            Err(Error::Unknown)
        };
    }
    if reply["ok"] != true {
        return Err(Error::Unknown);
    }
    let value = &reply["value"];
    match request["kind"].as_str() {
        Some("action") => {
            let cmd = &request["command"];
            let record = if value["record"].is_object() {
                &value["record"]
            } else {
                value
            };
            let identity = if cmd["kind"] == "create" {
                &cmd["id"]
            } else {
                &cmd["expected"]["id"]
            };
            let revision = if cmd["kind"] == "create" {
                Some(1)
            } else {
                cmd["expected"]["revision"]
                    .as_u64()
                    .and_then(|v| v.checked_add(1))
            };
            if record["id"] != *identity
                || record["revision"].as_u64() != revision
                || record["content"]["projectId"] != request["projectId"]
                || record["digest"].as_str().is_none_or(|s| !digest(s))
                || record["digest"]
                    != format!(
                        "{:x}",
                        Sha256::digest(canonical(&record["content"]).as_bytes())
                    )
                || record["digest"] != cmd["expected"]["digest"]
                || (cmd["kind"] == "complete"
                    && (record["completion"]["operationId"] != cmd["operationId"]
                        || record["completion"]["source"] != "user_report"
                        || record["completion"]["report"] != cmd["report"]
                        || record["state"] != "completed"))
                || (cmd["kind"] != "complete"
                    && (!record["completion"].is_null() || record["progress"] != cmd["progress"]))
                || (cmd["kind"] == "defer" && record["state"] != "deferred")
                || (cmd["kind"] == "resume" && record["state"] != "pending")
            {
                return Err(Error::Unknown);
            }
        }
        Some("help") if value["request"] == request["request"] => (),
        Some("answer") => {
            super::planning::exact(value.clone(), &request["operation"])?;
            if request.get("scopedTarget").is_some()
                && value["state"] == "accepted"
                && value["result"]["sessionId"] != request["operation"]["targetId"]
            {
                return Err(Error::Unknown);
            }
            if request["clarification"] == true && value["state"] == "accepted" {
                let saved = &value["result"]["clarification"];
                if value["result"]["sessionId"] != request["operation"]["targetId"]
                    || saved["operationId"] != request["operation"]["operationId"]
                    || saved["questionId"] != request["scope"]["subject"]["entryId"]
                    || saved["question"] != request["message"]
                    || !saved["answer"]
                        .as_str()
                        .is_some_and(|s| !s.trim().is_empty() && s.len() <= 16000)
                {
                    return Err(Error::Unknown);
                }
            }
        }
        Some("resource")
            if value["expected"] == request["expected"]
                && value["url"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("https://")) => {}
        _ => return Err(Error::Unknown),
    }
    Ok(())
}

pub(super) fn publish(shared: &Shared, record: &Record) {
    shared
        .attention_operations
        .lock()
        .expect("attention operations poisoned")
        .insert(record.id.clone(), record.summary());
    shared.change(|_| ());
}

/// Marks a published operation as on its way (`"inFlight": true` on its summary) while this send waits
/// for its receipt. Dropping it clears the mark, whatever the send returned. Only memory changes: the
/// saved record is the same, so a crash still leaves it Unknown.
struct InFlight<'a> {
    shared: &'a Shared,
    id: String,
}

impl<'a> InFlight<'a> {
    fn start(shared: &'a Shared, id: &str) -> Self {
        Self::mark(shared, id, true);
        Self {
            shared,
            id: id.to_owned(),
        }
    }

    fn mark(shared: &Shared, id: &str, on: bool) {
        if let Some(Value::Object(op)) = shared
            .attention_operations
            .lock()
            .expect("attention operations poisoned")
            .get_mut(id)
        {
            if on {
                op.insert("inFlight".into(), json!(true));
            } else {
                op.remove("inFlight");
            }
        }
        shared.change(|_| ());
    }
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        Self::mark(self.shared, &self.id, false);
    }
}

impl NativeHost {
    /// Read-only native attention snapshot. Staleness is explicit, not a permission grant.
    pub fn attention_snapshot(&self) -> Option<Value> {
        let mut read = self
            .0
            .shared
            .attention
            .lock()
            .expect("attention read poisoned")
            .clone()?;
        read["current"] = json!(
            read["epoch"].as_u64()
                == Some(
                    self.0
                        .shared
                        .epoch
                        .load(std::sync::atomic::Ordering::SeqCst)
                )
                && read["readError"].is_null()
                && self
                    .0
                    .shared
                    .connected
                    .load(std::sync::atomic::Ordering::SeqCst)
                && self.0.shared.open().is_ok()
        );
        Some(read)
    }
    pub fn attention_operations(&self) -> Vec<Value> {
        self.0
            .shared
            .attention_operations
            .lock()
            .expect("attention operations poisoned")
            .values()
            .cloned()
            .collect()
    }
    pub fn attention_draft(&self, key: &DraftKey) -> Option<Value> {
        self.0
            .shared
            .attention_drafts
            .lock()
            .expect("attention drafts poisoned")
            .get(&serde_json::to_string(key).ok()?)
            .cloned()
    }
    /// Every saved draft of this source, current and earlier revisions.
    /// Earlier revisions are history; they never pick or report anything.
    pub fn attention_drafts(&self) -> Vec<(DraftKey, Value)> {
        self.0
            .shared
            .attention_drafts
            .lock()
            .expect("attention drafts poisoned")
            .iter()
            .filter_map(|(k, v)| Some((serde_json::from_str(k).ok()?, v.clone())))
            .collect()
    }
}

impl Transport {
    async fn attention_call(&self, request: &Value, lookup: bool) -> Result<Value, Error> {
        if request["kind"] == "answer" {
            return self
                .planning_operation(&request["operation"], lookup)
                .await
                .map(|receipt| json!({"ok":true,"value":receipt}));
        }
        let header = self.local()?;
        let response = self
            .client
            .post(self.url(if lookup {
                "/api/native-attention/receipt"
            } else {
                "/api/native-attention"
            }))
            .header("x-pilot-github-capability", header)
            .header("content-type", "application/json")
            .body(serde_json::to_vec(request).map_err(|_| Error::Invalid)?)
            .send()
            .await
            .map_err(|_| Error::Unknown)?;
        let value = super::transport::body(response).await?;
        self.local()?;
        Ok(value)
    }
}

pub(super) async fn read(t: &Transport, shared: &Shared, epoch: u64) -> Result<Value, Error> {
    let result = read_current(t, shared, epoch).await;
    if let Err(error) = result {
        let mut read = shared.attention.lock().expect("attention read poisoned");
        if matches!(
            error,
            Error::Identity | Error::Invalid | Error::Capacity | Error::Closed
        ) {
            *read = None;
        } else if let Some(value) = read.as_mut() {
            // A read that raced a newer change is not a failure: the moved
            // epoch already marks this read as not current, and the next
            // read follows.
            if error != Error::Stale {
                value["readError"] = json!("Pilot could not read what needs you.");
            }
        }
        drop(read);
        shared.change(|_| ());
    }
    result
}

async fn read_current(t: &Transport, shared: &Shared, epoch: u64) -> Result<Value, Error> {
    let mut value = snapshot(t).await?;
    shared.current(epoch)?;
    value["canOpenUrl"] = json!(shared.url_opener.is_some());
    value["epoch"] = json!(epoch);
    *shared.attention.lock().expect("attention read poisoned") = Some(value.clone());
    shared.change(|_| ());
    Ok(value)
}

/// The questions and actions as they are now, for a write. Unlike `read`, a notice during the read
/// does not refuse it: a write checks only its own question or action, never the rest of the mission.
async fn latest(t: &Transport, shared: &Shared) -> Result<Value, Error> {
    let mut value = snapshot(t).await?;
    shared.open()?;
    // It is the newest read now; a notice during it starts another read as usual.
    value["canOpenUrl"] = json!(shared.url_opener.is_some());
    value["epoch"] = json!(shared.epoch.load(std::sync::atomic::Ordering::SeqCst));
    *shared.attention.lock().expect("attention read poisoned") = Some(value.clone());
    shared.change(|_| ());
    Ok(value)
}

/// Passive canonical read, without selecting a page or changing the root's cache.
pub(super) async fn snapshot(t: &Transport) -> Result<Value, Error> {
    t.gate(false).await?;
    let hello = match t.gated.get() {
        Some(hello) => hello.clone(),
        None => t.get("/api/hello").await?,
    };
    if hello["capabilities"]["nativeAttention"] != 1 {
        return Err(Error::Unavailable);
    }
    let reply = t.attention_call(&json!({"version":1,"home":home(&t.source),"projectId":t.source.project()?.project_id,"kind":"read"}),false).await?;
    if reply["ok"] != true
        || reply["value"]["version"] != 1
        || reply["value"]["projectId"] != t.source.project()?.project_id
        || !reply["value"]["questions"].is_array()
        || !reply["value"]["actions"].is_array()
    {
        return Err(Error::Unavailable);
    }
    Ok(reply["value"].clone())
}

fn qualifies(request: &Value, read: &Value) -> Result<(), Error> {
    match request["kind"].as_str() {
        Some("action" | "resource") => {
            let expected = if request["kind"] == "resource" {
                &request["expected"]
            } else {
                &request["command"]["expected"]
            };
            let action = read["actions"]
                .as_array()
                .and_then(|a| a.iter().find(|a| a["record"]["id"] == expected["id"]))
                .ok_or(Error::Stale)?;
            if action["record"]["revision"] != expected["revision"]
                || action["record"]["digest"] != expected["digest"]
                || action["authorityDigest"] != request["authorityDigest"]
            {
                return Err(Error::Stale);
            }
            if request["kind"] == "action"
                && !matches!(
                    request["command"]["kind"].as_str(),
                    Some("progress" | "defer" | "resume" | "complete")
                )
            {
                return Err(Error::Invalid);
            }
        }
        Some("help" | "answer") => {
            let scope = if request["kind"] == "answer" {
                &request["scope"]
            } else {
                &request["request"]["scope"]
            };
            if !read["questions"]
                .as_array()
                .is_some_and(|q| q.iter().any(|q| q["scope"] == *scope))
            {
                return Err(Error::Stale);
            }
        }
        _ => return Err(Error::Invalid),
    }
    Ok(())
}

pub(super) async fn handle(
    t: &Transport,
    journal: &mut super::Journal,
    shared: &Shared,
    epoch: u64,
    work: super::Work,
) -> Result<crate::model::IntentOutcome, Error> {
    use crate::model::OutcomeStatus;
    match work {
        super::Work::AttentionRead => {
            read(t, shared, epoch).await?;
        }
        super::Work::AttentionDraft(key, value) => {
            let draft = Draft {
                draft_version: 1,
                source: t.source.clone(),
                key,
                value,
            };
            journal.save_attention_draft(draft.clone())?;
            shared
                .attention_drafts
                .lock()
                .expect("attention drafts poisoned")
                .insert(
                    serde_json::to_string(&draft.key).map_err(|_| Error::Invalid)?,
                    draft.value,
                );
        }
        super::Work::AttentionSend(request) => {
            let kind = request["kind"].as_str().unwrap_or("").to_owned();
            let (result, tries) = send(t, journal, shared, epoch, request).await;
            // Only the kind, error and tries: never the question, answer or words.
            let error = match &result {
                Ok(outcome) if outcome.status == OutcomeStatus::Accepted => None,
                Ok(outcome) => Some(format!("{:?}", outcome.status)),
                Err(error) => Some(format!("{error:?}")),
            };
            if let Some(error) = error {
                crate::day_log::event(
                    "attention.send_refused",
                    json!({"command": kind, "error": error, "tries": tries}),
                );
            }
            return result;
        }
        super::Work::AttentionCheck(id) => {
            let mut record = journal
                .attention
                .get(&id)
                .filter(|r| r.source == t.source)
                .cloned()
                .ok_or(Error::Unknown)?;
            // Navigation has no durable OS-open receipt. Never repeat it, including on lookup.
            if record.request["kind"] != "resource" && record.pending() {
                t.gate(false).await?;
                shared.open()?;
                let reply = t.attention_call(&record.request, true).await?;
                exact(&record.request, &reply)?;
                record.receipt = Some(reply);
                journal.save_attention(record.clone())?;
                publish(shared, &record);
            }
            if record.pending() {
                return Err(Error::Unknown);
            }
            return Ok(shared.outcome(
                record_status(&record),
                "Exact receipt lookup only. No send, navigation or continuation.",
            ));
        }
        _ => return Err(Error::Invalid),
    }
    Ok(shared.outcome(
        OutcomeStatus::Accepted,
        "Attention read or draft saved. No completion or continuation.",
    ))
}

/// How many times one user action is sent when only the surrounding read moved: the first send
/// and two more. Each try costs two service reads; three tries cover a mission whose members are
/// busy for about a second, and the user waits at most about 3 s before Pilot says so.
const ATTEMPTS: u32 = 3;

/// The pause before try "attempt" + 1, or None once every try is used.
fn retry_after(attempt: u32) -> Option<std::time::Duration> {
    (attempt < ATTEMPTS).then(|| std::time::Duration::from_millis(250 * u64::from(attempt)))
}

const ANSWER_GONE: &str =
    "This question is no longer waiting. Nothing was sent; your answer stays.";
const ANSWER_CHANGED: &str = "This question changed before Pilot could send your answer. Nothing was sent; your answer stays. Read it again.";
const ACTION_CHANGED: &str = "This request changed before Pilot could send. Nothing was sent; your words stay. Read it again.";

/// What Pilot says when every try met a read that had moved on again.
fn exhausted(request: &Value) -> &'static str {
    if matches!(request["kind"].as_str(), Some("answer" | "help")) {
        "Pilot tried 3 times, but the mission kept changing around this question. Nothing was sent; your answer stays. Try again in a moment."
    } else {
        "Pilot tried 3 times, but the mission kept changing around this request. Nothing was sent; your words stay. Try again in a moment."
    }
}

/// Sends "request" and returns the result with the number of tries used. A refusal only because
/// the read moved on (a mission notice raised the read fence, or the authority digest around the
/// target moved) sends the same answer again, rebound to the newest read, as a new operation. A
/// read that itself races another notice uses that try and reads again on the next one. A changed
/// or gone target stops at once. Unknown never comes back here: it is never resent.
async fn send(
    t: &Transport,
    journal: &mut super::Journal,
    shared: &Shared,
    mut epoch: u64,
    mut request: Value,
) -> (Result<crate::model::IntentOutcome, Error>, u32) {
    use crate::model::OutcomeStatus;
    let mut attempt = 1;
    let mut result = send_once(t, journal, shared, epoch, request.clone()).await;
    loop {
        if !matches!(result, Err(Error::Stale)) {
            return (result, attempt);
        }
        // The window moved to another project: this answer is not sent there.
        if shared
            .focus
            .lock()
            .expect("native focus poisoned")
            .as_ref()
            .is_some_and(|p| t.source.project.as_ref() != Some(p))
        {
            return (Err(Error::Stale), attempt);
        }
        let Some(wait) = retry_after(attempt) else {
            return (
                Ok(shared.outcome(OutcomeStatus::Stale, exhausted(&request))),
                attempt,
            );
        };
        tokio::time::sleep(wait).await;
        attempt += 1;
        // The newest read; the target is checked again against it.
        epoch = shared.epoch.load(std::sync::atomic::Ordering::SeqCst);
        result = match latest(t, shared).await {
            Ok(current) => match rebind(&request, &current) {
                Ok(next) => {
                    request = next;
                    send_once(t, journal, shared, epoch, request.clone()).await
                }
                Err(changed) => {
                    return (Ok(shared.outcome(OutcomeStatus::Stale, changed)), attempt);
                }
            },
            Err(error) => return (Err(error), attempt),
        };
    }
}

/// "request" bound to "read" when the exact target is unchanged: the same question (chat, entry,
/// event and content) or the same action (id, revision and digest). Only the authority digest,
/// which follows the mission and chat around it, may differ. Anything else says what changed.
fn rebind(request: &Value, read: &Value) -> Result<Value, &'static str> {
    let mut next = request.clone();
    match request["kind"].as_str() {
        Some(kind @ ("answer" | "help")) => {
            let scope = if kind == "answer" {
                &request["scope"]
            } else {
                &request["request"]["scope"]
            };
            let current = read["questions"]
                .as_array()
                .and_then(|q| q.iter().find(|q| q["scope"]["subject"] == scope["subject"]))
                .map(|q| &q["scope"])
                .ok_or(ANSWER_GONE)?;
            if ["projectId", "eventId", "contentDigest"]
                .iter()
                .any(|k| current[*k] != scope[*k])
            {
                return Err(ANSWER_CHANGED);
            }
            if kind == "answer" {
                next["scope"] = current.clone();
            } else {
                next["request"]["scope"] = current.clone();
            }
        }
        Some(kind @ ("action" | "resource")) => {
            let expected = if kind == "resource" {
                &request["expected"]
            } else {
                &request["command"]["expected"]
            };
            let current = read["actions"]
                .as_array()
                .and_then(|a| a.iter().find(|a| a["record"]["id"] == expected["id"]))
                .ok_or(ACTION_CHANGED)?;
            if current["record"]["revision"] != expected["revision"]
                || current["record"]["digest"] != expected["digest"]
            {
                return Err(ACTION_CHANGED);
            }
            next["authorityDigest"] = current["authorityDigest"].clone();
        }
        _ => return Err(ACTION_CHANGED),
    }
    Ok(next)
}

/// One try: qualify, journal with a new operation ID, re-read after fsync, then send once.
async fn send_once(
    t: &Transport,
    journal: &mut super::Journal,
    shared: &Shared,
    epoch: u64,
    mut request: Value,
) -> Result<crate::model::IntentOutcome, Error> {
    {
        {
            let shown = shared
                .attention
                .lock()
                .expect("attention read poisoned")
                .clone()
                .ok_or(Error::Stale)?;
            qualifies(&request, &shown)?;
            // An unresolved operation for the same subject blocks a second send, even after reopen.
            // Navigation changes no record and has no receipt to look up, so an
            // uncertain open never blocks the user's own report.
            let target = subject(&request);
            if journal.attention.values().any(|r| {
                r.source == t.source
                    && r.pending()
                    && r.request["kind"] != "resource"
                    && request["kind"] != "resource"
                    && subject(&r.request) == target
            }) {
                return Err(Error::Unknown);
            }
            let id = uuid::Uuid::new_v4().to_string();
            request["version"] = json!(1);
            request["home"] = home(&t.source);
            request["projectId"] = json!(t.source.project()?.project_id);
            match request["kind"].as_str() {
                Some("action") => request["command"]["operationId"] = json!(id),
                Some("help") => request["request"]["requestId"] = json!(id),
                Some("resource") => {
                    if shared.url_opener.is_none() {
                        return Err(Error::Unavailable);
                    }
                }
                Some("answer") => {
                    bind_answer(&t.source, &id, &mut request)?;
                }
                _ => return Err(Error::Invalid),
            }
            let mut record = Record {
                attention_version: 1,
                source: t.source.clone(),
                id,
                request,
                receipt: None,
                not_sent: false,
            };
            record.validate()?;
            let fresh = latest(t, shared).await?;
            qualifies(&record.request, &fresh)?;
            journal.save_attention(record.clone())?;
            // On its way until this send returns: the card says sending or asking, not "no answer came
            // back". A crash before the receipt leaves the saved record Unknown, as before.
            publish(shared, &record);
            let _in_flight = InFlight::start(shared, &record.id);
            // No second read after the fsync: the read just before it names the exact target, and the
            // daemon checks that target (question content, action revision and digest, authority
            // digest) again before it takes the request. The extra read cost a whole attention read
            // (often 1-2 s while agents work) on every answer.
            if let Ok(reply) = t.attention_call(&record.request, false).await
                && exact(&record.request, &reply).is_ok()
            {
                if record.request["kind"] == "resource" && reply["ok"] == true {
                    let expected = &record.request["expected"];
                    let pinned = fresh["actions"]
                        .as_array()
                        .and_then(|a| a.iter().find(|a| a["record"]["id"] == expected["id"]))
                        .ok_or(Error::Unknown)?;
                    if reply["value"]["url"] != pinned["record"]["content"]["destination"]["uri"] {
                        return Err(Error::Unknown);
                    }
                }
                record.receipt = Some(reply);
                if journal.save_attention(record.clone()).is_err() {
                    journal.poison();
                    publish(shared, &record);
                    return Err(Error::Unknown);
                }
                publish(shared, &record);
                if record.request["kind"] == "resource"
                    && record.receipt.as_ref().is_some_and(|r| r["ok"] == true)
                {
                    shared.current(epoch)?;
                    let opener = shared.url_opener.as_ref().ok_or(Error::Unavailable)?;
                    opener(
                        record
                            .receipt
                            .as_ref()
                            .and_then(|r| r["value"]["url"].as_str())
                            .ok_or(Error::Invalid)?,
                    )?;
                }
            }
            publish(shared, &record);
            if record.pending() {
                return Err(Error::Unknown);
            }
            let status = record_status(&record);
            return Ok(shared.outcome(status,"Exact attention result saved. Completion reports do not verify publication or start work."));
        }
    }
}

// Ordinary and direct answers use exactly the same daemon operation envelope.
fn bind_answer(source: &Source, id: &str, request: &mut Value) -> Result<(), Error> {
    let mut payload = json!({"projectId":source.project()?.project_id,"scope":request["scope"]});
    if let Some(interview) = request.get("interview") {
        payload["interview"] = interview.clone();
        if let Some(revision) = request.get("draftRevision") {
            payload["draftRevision"] = revision.clone();
        }
    } else {
        payload["message"] = request["message"].clone();
        if request["clarification"] == true {
            payload["clarification"] = json!(true);
        }
    }
    let payload = serde_json::to_string(&payload).map_err(|_| Error::Invalid)?;
    // bindingId uses canonical sorted JSON, not feature-dependent serde map order.
    let scope = canonical(&request["scope"]);
    request["operation"] = json!({"schemaVersion":1,"operationId":id,"producerId":uuid::Uuid::new_v4().to_string(),"sequence":1,
        "origin":home(source),"destination":{"hostId":"daemon","daemonId":source.home.daemon_id,"lineageId":source.home.lineage_id},
        "kind":"attention-answer","targetId":request["scope"]["subject"]["sessionId"],"payloadHash":format!("{:x}",Sha256::digest(payload.as_bytes())),
        "payload":payload,"bindingId":format!("{:x}",Sha256::digest(scope.as_bytes())),"bindingGeneration":1});
    Ok(())
}

fn record_status(record: &Record) -> crate::model::OutcomeStatus {
    use crate::model::OutcomeStatus;
    if record.not_sent {
        return OutcomeStatus::Rejected;
    }
    if record.pending() {
        return OutcomeStatus::Unknown;
    }
    if record.receipt.as_ref().is_some_and(|r| {
        r["ok"] == true
            && !(record.request["kind"] == "answer" && r["value"]["state"] == "rejected")
    }) {
        OutcomeStatus::Accepted
    } else {
        OutcomeStatus::Rejected
    }
}

fn subject(request: &Value) -> Value {
    match request["kind"].as_str() {
        Some("help") => request["request"]["scope"]["subject"].clone(),
        Some("answer") => request["scope"]["subject"].clone(),
        Some("resource") => request["expected"]["id"].clone(),
        _ => request["command"]["expected"]["id"].clone(),
    }
}
fn canonical(value: &Value) -> String {
    fn sorted(v: &Value) -> Value {
        match v {
            Value::Object(o) => {
                let mut keys: Vec<_> = o.keys().collect();
                keys.sort();
                Value::Object(
                    keys.into_iter()
                        .map(|k| (k.clone(), sorted(&o[k])))
                        .collect(),
                )
            }
            Value::Array(a) => Value::Array(a.iter().map(sorted).collect()),
            v => v.clone(),
        }
    }
    serde_json::to_string(&sorted(value)).expect("serializable scope")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_journals_allow_escaped_drafts_and_kept_questions_without_widening_ordinary_limits() {
        let source = Source {
            profile: std::env::temp_dir(),
            port: 1,
            home: crate::contract::Home {
                daemon_id: "daemon".into(),
                lineage_id: "lineage".into(),
            },
            project: Some(crate::host::Project {
                project_id: "project".into(),
                project_path: "/project".into(),
            }),
        };
        let answers: Vec<Value> = (0..12).map(|n| json!({"questionId":format!("q{n}"),"selectedOptionId":null,"text":"\n".repeat(1900)})).collect();
        let text = json!({"roundId":"r","answers":answers}).to_string();
        assert!(text.len() < 48 * 1024);
        let value = json!({"text":text,"pick":null,"question":""});
        assert!(serde_json::to_vec(&value).unwrap().len() > 48 * 1024);
        let mut draft = Draft {
            draft_version: 1,
            source: source.clone(),
            key: DraftKey {
                kind: "question".into(),
                id: "question-s-1".into(),
                revision: 1,
                digest: "a".repeat(64),
            },
            value,
        };
        assert!(draft.validate().is_ok());
        draft.key.kind = "action".into();
        assert_eq!(draft.validate(), Err(Error::Invalid));
        draft.key.kind = "question".into();
        draft.value["text"] = json!("x".repeat(17000));
        assert_eq!(draft.validate(), Err(Error::Invalid));
        let mut record = Record {
            attention_version: 1,
            source: source.clone(),
            id: "op-id".into(),
            receipt: None,
            not_sent: false,
            request: json!({"kind":"answer","version":1,"projectId":"project","home":home(&source),
                "interview":{"roundId":"r","answers":answers},"interviewQuestions":"x".repeat(40000),
                "operation":{"operationId":"op-id","kind":"attention-answer","payload":"x".repeat(48000)}}),
        };
        assert!(serde_json::to_vec(&record.request).unwrap().len() > 65536);
        assert!(record.validate().is_ok());
        record.request.as_object_mut().unwrap().remove("interview");
        assert_eq!(record.validate(), Err(Error::Invalid));
    }

    #[test]
    fn attention_draft_capacity_never_evicts_and_existing_draft_can_still_save() {
        let path =
            std::env::temp_dir().join(format!("attention-capacity-{}.jsonl", uuid::Uuid::new_v4()));
        let source = Source {
            profile: std::env::temp_dir(),
            port: 1,
            home: crate::contract::Home {
                daemon_id: "daemon".into(),
                lineage_id: "lineage".into(),
            },
            project: Some(crate::host::Project {
                project_id: "project".into(),
                project_path: "/project".into(),
            }),
        };
        let mut journal = super::super::Journal::open(path.clone()).unwrap();
        let mut first = None;
        for n in 0..4096 {
            let d = Draft {
                draft_version: 1,
                source: source.clone(),
                key: DraftKey {
                    kind: "action".into(),
                    id: format!("action-{n}"),
                    revision: 1,
                    digest: "a".repeat(64),
                },
                value: json!({"report":"original"}),
            };
            if n == 0 {
                first = Some(d.clone());
            }
            journal.attention_drafts.insert(d.id(), d);
        }
        let mut next = first.clone().unwrap();
        next.key.id = "overflow".into();
        assert_eq!(journal.save_attention_draft(next), Err(Error::Capacity));
        assert_eq!(journal.attention_drafts.len(), 4096);
        let mut first = first.unwrap();
        first.value = json!({"report":"kept"});
        journal.save_attention_draft(first.clone()).unwrap();
        assert_eq!(
            journal.attention_drafts.get(&first.id()).unwrap().value,
            first.value
        );
        drop(journal);
        std::fs::remove_file(path).unwrap();
    }

    fn question(entry: u64, content: &str, authority: &str) -> Value {
        json!({"scope":{"subject":{"kind":"question","sessionId":"s","entryId":entry},"projectId":"p",
            "eventId":entry,"contentDigest":content,"authorityDigest":authority}})
    }

    #[test]
    fn an_unchanged_question_is_rebound_to_the_newest_authority() {
        let shown = json!({"questions":[question(12, "c", "a1")]});
        let answer =
            json!({"kind":"answer","scope":shown["questions"][0]["scope"],"message":"Yes"});
        // Members worked: only the authority around the same question moved.
        let moved = json!({"questions":[question(12, "c", "a2")]});
        assert_eq!(qualifies(&answer, &moved), Err(Error::Stale));
        let next = rebind(&answer, &moved).unwrap();
        assert_eq!(next["scope"]["authorityDigest"], "a2");
        assert_eq!(next["message"], "Yes");
        assert_eq!(qualifies(&next, &moved), Ok(()));
        // A help question about it is rebound the same way.
        let help = json!({"kind":"help","request":{"kind":"simpler","scope":shown["questions"][0]["scope"]}});
        assert_eq!(
            rebind(&help, &moved).unwrap()["request"]["scope"]["authorityDigest"],
            "a2"
        );
    }

    #[test]
    fn a_changed_or_gone_target_is_refused_and_says_what_changed() {
        let answer =
            json!({"kind":"answer","scope":question(12, "c", "a1")["scope"],"message":"Yes"});
        let reworded = json!({"questions":[question(12, "other", "a1")]});
        assert_eq!(rebind(&answer, &reworded), Err(ANSWER_CHANGED));
        let answered = json!({"questions":[question(13, "c", "a1")]});
        assert_eq!(rebind(&answer, &answered), Err(ANSWER_GONE));
        let action = json!({"kind":"action","authorityDigest":"a1",
            "command":{"kind":"progress","expected":{"id":"upload","revision":2,"digest":"d"}}});
        let same = json!({"actions":[{"record":{"id":"upload","revision":2,"digest":"d"},"authorityDigest":"a2"}]});
        assert_eq!(rebind(&action, &same).unwrap()["authorityDigest"], "a2");
        let replaced = json!({"actions":[{"record":{"id":"upload","revision":3,"digest":"e"},"authorityDigest":"a2"}]});
        assert_eq!(rebind(&action, &replaced), Err(ACTION_CHANGED));
    }

    #[test]
    fn retries_stop_after_three_tries_with_a_clear_message() {
        assert_eq!(retry_after(1), Some(std::time::Duration::from_millis(250)));
        assert_eq!(retry_after(2), Some(std::time::Duration::from_millis(500)));
        assert_eq!(retry_after(ATTEMPTS), None);
        assert!(exhausted(&json!({"kind":"answer"})).starts_with("Pilot tried 3 times"));
    }
}
