//! Attention shares the native worker, admission fence and private command ledger.
use super::{Error, NativeHost, Shared, Source, Transport, valid_id};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

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
                > 16384
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
            || r["projectId"] != self.source.project_id
            || r["home"] != home(&self.source)
            || serde_json::to_vec(r).map_err(|_| Error::Invalid)?.len() > 65536
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
    /// Runs on the existing worker. Completion means the exact draft crossed fsync.
    pub fn save_attention_draft(
        &self,
        key: DraftKey,
        value: Value,
    ) -> async_channel::Receiver<Result<crate::model::IntentOutcome, Error>> {
        self.request(super::Work::AttentionDraft(key, value))
    }
    pub fn read_attention(
        &self,
    ) -> async_channel::Receiver<Result<crate::model::IntentOutcome, Error>> {
        self.0
            .shared
            .attention_wanted
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.request(super::Work::AttentionRead)
    }
    /// Rust-only typed adapter input. Host adds identity and a fresh operation before fsync/send.
    pub fn send_attention(
        &self,
        request: Value,
    ) -> async_channel::Receiver<Result<crate::model::IntentOutcome, Error>> {
        self.request(super::Work::AttentionSend(request))
    }
    pub fn check_attention(
        &self,
        id: String,
    ) -> async_channel::Receiver<Result<crate::model::IntentOutcome, Error>> {
        self.request(super::Work::AttentionCheck(id))
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
    t.gate(false).await?;
    if t.get("/api/hello").await?["capabilities"]["nativeAttention"] != 1 {
        return Err(Error::Unavailable);
    }
    let reply = t.attention_call(&json!({"version":1,"home":home(&t.source),"projectId":t.source.project_id,"kind":"read"}),false).await?;
    shared.current(epoch)?;
    if reply["ok"] != true
        || reply["value"]["version"] != 1
        || reply["value"]["projectId"] != t.source.project_id
        || !reply["value"]["questions"].is_array()
        || !reply["value"]["actions"].is_array()
    {
        return Err(Error::Unavailable);
    }
    let mut value = reply["value"].clone();
    value["canOpenUrl"] = json!(shared.url_opener.is_some());
    value["epoch"] = json!(epoch);
    *shared.attention.lock().expect("attention read poisoned") = Some(value.clone());
    shared.change(|_| ());
    Ok(value)
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
        super::Work::AttentionSend(mut request) => {
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
            request["projectId"] = json!(t.source.project_id);
            match request["kind"].as_str() {
                Some("action") => request["command"]["operationId"] = json!(id),
                Some("help") => request["request"]["requestId"] = json!(id),
                Some("resource") => {
                    if shared.url_opener.is_none() {
                        return Err(Error::Unavailable);
                    }
                }
                Some("answer") => {
                    let payload = json!({"projectId":t.source.project_id,"scope":request["scope"],"message":request["message"]});
                    let payload = serde_json::to_string(&payload).map_err(|_| Error::Invalid)?;
                    // bindingId uses canonical sorted JSON, not feature-dependent serde map order.
                    let scope = canonical(&request["scope"]);
                    request["operation"] = json!({"schemaVersion":1,"operationId":id,"producerId":uuid::Uuid::new_v4().to_string(),"sequence":1,
                        "origin":home(&t.source),"destination":{"hostId":"daemon","daemonId":t.source.home.daemon_id,"lineageId":t.source.home.lineage_id},
                        "kind":"attention-answer","targetId":request["scope"]["subject"]["sessionId"],"payloadHash":format!("{:x}",Sha256::digest(payload.as_bytes())),
                        "payload":payload,"bindingId":format!("{:x}",Sha256::digest(scope.as_bytes())),"bindingGeneration":1});
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
            let fresh = read(t, shared, epoch).await?;
            qualifies(&record.request, &fresh)?;
            journal.save_attention(record.clone())?;
            publish(shared, &record);
            // Re-read after fsync; a queued event or permission change must stop a first send.
            let check = read(t, shared, epoch)
                .await
                .and_then(|r| qualifies(&record.request, &r));
            if let Err(e) = check {
                record.not_sent = true;
                journal.save_attention(record.clone())?;
                publish(shared, &record);
                return Err(e);
            }
            shared.current(epoch)?;
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
            if record.pending() {
                return Err(Error::Unknown);
            }
            let status = record_status(&record);
            return Ok(shared.outcome(status,"Exact attention result saved. Completion reports do not verify publication or start work."));
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
            project_id: "project".into(),
            project_path: "/project".into(),
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
}
