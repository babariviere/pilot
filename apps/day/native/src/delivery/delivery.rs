//! Canonical delivery reads and explicit user assessments. No model subscription or replay.
use super::{Error, Journal, Shared, Source, Transport, planning, valid_id};
use crate::bridge::{Command, Gate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const MAX_REVISION: u64 = 9_007_199_254_740_990;

/// Native chooses the project. TSX can only page within that root's sources.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct List {
    pub after: Option<u64>,
}
impl List {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if self.after.is_some_and(|n| n > MAX_REVISION) {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum Subject {
    Task {
        #[serde(rename = "projectId")]
        project: String,
        #[serde(rename = "missionId")]
        mission: String,
        #[serde(rename = "taskId")]
        task: String,
    },
    Chat {
        #[serde(rename = "projectId")]
        project: String,
        #[serde(rename = "sessionId")]
        session: String,
    },
}
impl Subject {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        let ids = match self {
            Self::Task {
                project,
                mission,
                task,
            } => vec![project, mission, task],
            Self::Chat { project, session } => vec![project, session],
        };
        if ids.iter().all(|id| valid_id(id)) {
            Ok(())
        } else {
            Err(Error::Invalid)
        }
    }
    pub(super) fn project(&self) -> &str {
        match self {
            Self::Task { project, .. } | Self::Chat { project, .. } => project,
        }
    }
    pub(super) fn path(&self) -> String {
        match self {
            Self::Task {
                project,
                mission,
                task,
            } => format!("/api/projects/{project}/missions/{mission}/tasks/{task}/delivered-work"),
            Self::Chat { project, session } => {
                format!("/api/projects/{project}/chats/{session}/delivered-work")
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Write {
    pub(super) subject: Subject,
    target_id: String,
    delivery_id: String,
    expected_revision: u64,
    owner_session_id: Option<String>,
    note: String,
    revision_recipient_session_id: Option<String>,
    #[serde(skip)]
    pub action: String,
}
impl Write {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        self.subject.validate()?;
        if !valid_id(&self.target_id)
            || !digest(&self.delivery_id)
            || self.expected_revision > MAX_REVISION
            || self
                .owner_session_id
                .as_ref()
                .is_some_and(|id| !valid_id(id))
            || !valid_note(&self.action, &self.note)
            || self
                .revision_recipient_session_id
                .as_ref()
                .is_some_and(|id| self.action != "send_back" || !valid_id(id))
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}
pub(super) fn digest(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
fn valid_note(action: &str, note: &str) -> bool {
    match action {
        "send_back" => !note.trim().is_empty() && note.len() <= 8000,
        "done" | "reopen" => note.is_empty(),
        _ => false,
    }
}

/// Navigation is not a verification operation and is never journaled or replayed.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Open {
    pub(super) subject: Subject,
    target_id: String,
    delivery_id: String,
    owner_session_id: Option<String>,
    resource_id: String,
    url: String,
}
impl Open {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        self.subject.validate()?;
        if !valid_id(&self.target_id)
            || !digest(&self.delivery_id)
            || !valid_id(&self.resource_id)
            || self
                .owner_session_id
                .as_ref()
                .is_some_and(|id| !valid_id(id))
        {
            return Err(Error::Invalid);
        }
        super::navigation::web(&self.url)?;
        Ok(())
    }
    fn qualifies(&self, v: &Value) -> Result<(), Error> {
        if v["subject"] != serde_json::to_value(&self.subject).map_err(|_| Error::Invalid)?
            || v["targetId"] != self.target_id
            || v["deliveryId"] != self.delivery_id
            || v["ownerSessionId"] != json!(self.owner_session_id)
        {
            return Err(Error::Stale);
        }
        let rows = v["pullRequests"].as_array().ok_or(Error::Invalid)?;
        let mut matching = rows.iter().filter(|r| r["id"] == self.resource_id);
        let resource = matching.next().ok_or(Error::Stale)?;
        if matching.next().is_some() || resource["kind"] != "github.pr" {
            return Err(Error::Invalid);
        }
        // Match the exact displayed destination, not a label, guessed PR URL or
        // delivery hash (which pins resource IDs but does not hash their URLs).
        let target = resource["pullRequest"]["url"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| resource["url"].as_str())
            .ok_or(Error::Invalid)?;
        if target != self.url {
            return Err(Error::Stale);
        }
        super::navigation::web(target)?;
        Ok(())
    }
}

fn output_capabilities(shared: &Shared) -> Value {
    json!({"web":shared.url_opener.is_some(),"artifacts":false,"documents":false,"paths":false})
}

/// Native-only metadata, not a second verification or daemon payload field.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Pin {
    owner_session_id: Option<String>,
    #[serde(default)]
    recipient_session_id: Option<String>,
}

fn payload(op: &Value) -> Result<Value, Error> {
    serde_json::from_str(op["payload"].as_str().ok_or(Error::Storage)?).map_err(|_| Error::Storage)
}
pub(super) fn validate_record(r: &planning::PlanningRecord) -> Result<(), Error> {
    let p = payload(&r.operation)?;
    let pin = r.verification_pin.as_ref().ok_or(Error::Storage)?;
    let subject: Subject =
        serde_json::from_value(p["subject"].clone()).map_err(|_| Error::Storage)?;
    subject.validate().map_err(|_| Error::Storage)?;
    if p.as_object().is_none_or(|o| o.len() != 6 && o.len() != 7)
        || p.get("revisionRecipientSessionId").is_some_and(|s| {
            s.as_str().is_none_or(|id| !valid_id(id)) || p["action"] != "send_back"
        })
        || p["purpose"] != "user-verification"
        || subject.project() != r.source.project()?.project_id
        || p["deliveryId"] != r.operation["bindingId"]
        || r.operation["bindingGeneration"] != 1
        || p["deliveryId"].as_str().is_none_or(|s| !digest(s))
        || p["expectedRevision"]
            .as_u64()
            .is_none_or(|n| n > MAX_REVISION)
        || p["note"]
            .as_str()
            .is_none_or(|s| !valid_note(p["action"].as_str().unwrap_or(""), s))
        || pin
            .owner_session_id
            .as_ref()
            .is_some_and(|id| !valid_id(id))
        || pin
            .recipient_session_id
            .as_ref()
            .is_some_and(|id| !valid_id(id))
        || r.setup_digest.is_some()
    {
        return Err(Error::Storage);
    }
    if let Some(pair) = &r.receipt
        && exact(pair.clone(), &r.operation, pin)? != *pair
    {
        return Err(Error::Storage);
    }
    Ok(())
}

/// Only a matching accepted pair proves success. Pending/missing/malformed stays Check-only.
fn exact(mut pair: Value, op: &Value, pin: &Pin) -> Result<Value, Error> {
    let outer = &pair["receipt"];
    if outer["operationId"] != op["operationId"]
        || outer["payloadHash"] != op["payloadHash"]
        || outer["targetId"] != op["targetId"]
        || outer["destination"] != op["destination"]
    {
        return Err(Error::Unknown);
    }
    let domain = &pair["verificationReceipt"];
    if outer["state"] == "rejected" && domain.is_null() {
        pair["state"] = json!("rejected");
        return Ok(pair);
    }
    let p = payload(op)?;
    let v = &domain["verification"];
    let expected_state = match p["action"].as_str() {
        Some("done") => "done",
        Some("send_back") => "sent_back",
        Some("reopen") => "open",
        _ => return Err(Error::Unknown),
    };
    if outer["state"] != "accepted"
        || domain["state"] != "accepted"
        || domain["operation"] != *op
        || domain["operationId"] != op["operationId"]
        || domain["payloadHash"] != op["payloadHash"]
        || domain["intent"] != p
        || outer["result"] != *v
        || v["version"] != 1
        || v["subject"] != p["subject"]
        || v["deliveryId"] != p["deliveryId"]
        || v["operationId"] != op["operationId"]
        || v["revision"].as_u64()
            != p["expectedRevision"]
                .as_u64()
                .and_then(|n| n.checked_add(1))
        || v["state"] != expected_state
        || v["note"] != p["note"]
        || !v["createdAt"].is_u64()
    {
        return Err(Error::Unknown);
    }
    if p["action"] == "send_back" {
        let owner = pin
            .recipient_session_id
            .as_ref()
            .or(pin.owner_session_id.as_ref())
            .ok_or(Error::Unknown)?;
        if v["messageReceipt"]
            != json!({"sessionId":owner,"requestId":op["operationId"],"state":"admitted"})
        {
            return Err(Error::Unknown);
        }
    } else if !v["messageReceipt"].is_null() {
        return Err(Error::Unknown);
    }
    pair["state"] = json!("accepted");
    Ok(pair)
}
fn selected(r: &planning::PlanningRecord, source: &Source) -> bool {
    receipt_source(&r.source, source) && r.operation["kind"] == "user-verification"
}
pub(super) fn receipt_source(saved: &Source, source: &Source) -> bool {
    // Port/path are live transport/configuration, not receipt identity. A cold
    // daemon can move ports; historical lookup still pins profile, lineage and
    // exact project/subject. It can never send the old envelope again.
    saved.profile == source.profile
        && saved.home == source.home
        && saved
            .project
            .as_ref()
            .zip(source.project.as_ref())
            .is_some_and(|(a, b)| a.project_id == b.project_id)
}
fn summary(r: &planning::PlanningRecord) -> Value {
    let p = payload(&r.operation).unwrap_or(Value::Null);
    json!({"operationId":r.id(),"subject":p["subject"],"targetId":r.mission(),
        "deliveryId":p["deliveryId"],"expectedRevision":p["expectedRevision"],
        "ownerSessionId":r.verification_pin.as_ref().and_then(|p| p.owner_session_id.as_ref()),
        "action":p["action"],"note":p["note"],
        "state":if r.not_sent {json!("not-sent")} else {r.receipt.as_ref().map(|v|v["state"].clone()).unwrap_or(json!("unknown"))},
        "lookup":r.receipt})
}
fn operations(t: &Transport, journal: &Journal) -> Vec<Value> {
    journal
        .planning
        .values()
        .filter(|r| selected(r, &t.source))
        .map(summary)
        .collect()
}
/// A subject of another project than the one the window acts on now: the
/// window moved after the screen asked (a project switch). That request is
/// out of date, not a lost identity, so it is refused as Stale and never
/// fails the new project's reads. No request is sent for it.
pub(super) fn in_scope(t: &Transport, s: &Subject) -> Result<(), Error> {
    if s.project() != t.source.project()?.project_id {
        return Err(Error::Stale);
    }
    Ok(())
}

pub(super) async fn read(t: &Transport, s: &Subject) -> Result<Value, Error> {
    s.validate()?;
    in_scope(t, s)?;
    t.gate(false).await?;
    let v = t.get(&s.path()).await?;
    validate_snapshot(&v, s)?;
    Ok(v)
}

fn validate_snapshot(v: &Value, s: &Subject) -> Result<(), Error> {
    if v["version"] != 1
        || v["subject"] != serde_json::to_value(s).map_err(|_| Error::Invalid)?
        || v["targetId"].as_str().is_none_or(|s| !valid_id(s))
        || (!v["deliveryId"].is_null() && v["deliveryId"].as_str().is_none_or(|s| !digest(s)))
        || (!v["ownerSessionId"].is_null()
            && v["ownerSessionId"].as_str().is_none_or(|s| !valid_id(s)))
        || v["verificationRevision"]
            .as_u64()
            .is_none_or(|n| n > MAX_REVISION)
        || !v["verificationCurrent"].is_boolean()
        || !matches!(
            v["verificationReceiptState"].as_str(),
            Some("accepted" | "unknown")
        )
        || (v["verificationCurrent"] == true
            && (v["verificationReceiptState"] != "accepted" || v["verification"].is_null()))
        || (!v["pendingOperationId"].is_null()
            && v["pendingOperationId"]
                .as_str()
                .is_none_or(|s| !valid_id(s)))
        || v["production"] != "not_tracked"
        || !v["artifacts"].is_array()
        || !v["pullRequests"].is_array()
    {
        return Err(Error::Invalid);
    }
    // Preserve canonical completion, evidence, PR tracking and user assessment as separate fields.
    Ok(())
}

pub(super) async fn list(t: &Transport, request: &List) -> Result<Value, Error> {
    request.validate()?;
    t.gate(false).await?;
    let path = format!(
        "/api/projects/{}/delivered-work{}",
        t.source.project()?.project_id,
        request
            .after
            .map(|n| format!("?after={n}"))
            .unwrap_or_default()
    );
    let v = t.get(&path).await?;
    validate_list(&v, &t.source.project()?.project_id)?;
    if request.after.is_some_and(|after| {
        v["more"] == true && v["nextCursor"].as_u64().is_none_or(|next| next <= after)
    }) {
        return Err(Error::Invalid);
    }
    Ok(v)
}

fn validate_list(v: &Value, project: &str) -> Result<(), Error> {
    let baseline = v["baseline"]["sourceSequence"]
        .as_u64()
        .ok_or(Error::Invalid)?;
    let cursor = v["sourceCursor"].as_u64().ok_or(Error::Invalid)?;
    let more = v["more"].as_bool().ok_or(Error::Invalid)?;
    let current = v["currentness"].as_str().ok_or(Error::Invalid)?;
    let items = v["items"].as_array().ok_or(Error::Invalid)?;
    if v["version"] != 1
        || v["projectId"] != project
        || v["baseline"]["mode"] != "start_fresh"
        || baseline > cursor
        || cursor > MAX_REVISION
        || items.len() > 20
        || !matches!(current, "live" | "stale")
        || v["complete"] != (!more && current == "live")
        || (more
            && v["nextCursor"]
                .as_u64()
                .is_none_or(|n| n <= baseline || n > cursor))
        || (!more && !v["nextCursor"].is_null())
    {
        return Err(Error::Invalid);
    }
    let mut previous = baseline;
    if let Some(selected) = v.get("selected") {
        let rows = selected.as_array().ok_or(Error::Invalid)?;
        if rows.len() > 20 {
            return Err(Error::Invalid);
        }
        for item in rows {
            let s: Subject =
                serde_json::from_value(item["subject"].clone()).map_err(|_| Error::Invalid)?;
            s.validate()?;
            if s.project() != project
                || item["title"].as_str().is_none()
                || item["snapshot"]["reviewQueue"] != "selected"
                    && item["snapshot"]["reviewQueue"] != "later"
            {
                return Err(Error::Invalid);
            }
            validate_snapshot(&item["snapshot"], &s)?;
        }
    }
    for item in items {
        let s: Subject =
            serde_json::from_value(item["subject"].clone()).map_err(|_| Error::Invalid)?;
        s.validate()?;
        let seq = item["sourceSequence"].as_u64().ok_or(Error::Invalid)?;
        if !matches!(s, Subject::Task { .. })
            || s.project() != project
            || seq <= previous
            || seq > cursor
            || item["title"].as_str().is_none()
            || item["snapshot"]["deliveryId"].is_null()
        {
            return Err(Error::Invalid);
        }
        validate_snapshot(&item["snapshot"], &s)?;
        previous = seq;
    }
    if more && v["nextCursor"].as_u64().is_none_or(|n| n < previous) {
        return Err(Error::Invalid);
    }
    Ok(())
}
pub(super) async fn handle(
    t: &Transport,
    journal: &mut Journal,
    shared: &Shared,
    command: &Command,
    gate: &Arc<Mutex<Gate>>,
) -> Result<Value, Error> {
    // WS notices are not authority. Daemon CAS and its synchronous admission fence decide.
    let check = || {
        shared.open()?;
        command.admit(&gate.lock().expect("bridge gate poisoned"))
    };
    let mut outcome = Value::Null;
    let subject = match command {
        Command::DeliveryList(request) => {
            let epoch = shared.epoch.load(std::sync::atomic::Ordering::SeqCst);
            check()?;
            let snapshot = list(t, request).await?;
            shared.current(epoch)?;
            check()?;
            return Ok(json!({"snapshot":snapshot,"outcome":null}));
        }
        Command::DeliveryRead(s) => Some(s.clone()),
        Command::DeliverySaved => {
            // The journal's saved commands only: no HTTP, Check, or read of any
            // delivery. The project is the root's own choice, echoed, never chosen.
            check()?;
            return Ok(
                json!({"snapshot":{"projectId":t.source.project()?.project_id},
                "operations":operations(t,journal),"operationsProjectId":t.source.project()?.project_id,"outcome":null,
                "outputCapabilities":output_capabilities(shared)}),
            );
        }
        Command::DeliveryOpen(r) => {
            r.validate()?;
            let opener = shared.url_opener.as_ref().ok_or(Error::Unavailable)?;
            let before = read(t, &r.subject).await?;
            r.qualifies(&before)?;
            // Recheck project, permissions and the exact canonical source after
            // entered I/O. Neither a cached page nor a WS notice grants an open.
            let current = read(t, &r.subject).await?;
            r.qualifies(&current)?;
            t.local()?;
            let guard = gate.lock().expect("bridge gate poisoned");
            shared.open()?;
            command.admit(&guard)?;
            // No await/queue between admission and dispatch. No generic path,
            // callback supplied by TSX, provider, acceptance write or HTTP POST.
            opener(&r.url).map_err(|_| Error::Unknown)?;
            return Ok(json!({"opened":true,"url":r.url,"outcome":null}));
        }
        Command::DeliveryWrite(w) => {
            w.validate()?;
            in_scope(t, &w.subject)?;
            let subject = serde_json::to_value(&w.subject).map_err(|_| Error::Invalid)?;
            if journal.planning.values().any(|r| {
                selected(r, &t.source)
                    && r.pending()
                    && payload(&r.operation).is_ok_and(|p| p["subject"] == subject)
            }) {
                return Err(Error::Unknown);
            }
            let v = read(t, &w.subject).await?;
            if v["deliveryId"] != w.delivery_id
                || v["targetId"] != w.target_id
                || v["verificationRevision"] != w.expected_revision
                || v["ownerSessionId"] != json!(w.owner_session_id)
                || !v["pendingOperationId"].is_null()
            {
                return Err(Error::Stale);
            }
            if w.action == "send_back"
                && w.revision_recipient_session_id
                    .as_deref()
                    .or(w.owner_session_id.as_deref())
                    != v["revisionRecipientSessionId"]
                        .as_str()
                        .or(v["ownerSessionId"].as_str())
            {
                return Err(Error::Stale);
            }
            check()?;
            let mut intent = json!({"purpose":"user-verification","subject":subject,"deliveryId":w.delivery_id,
                "expectedRevision":w.expected_revision,"action":w.action,"note":w.note});
            if let Some(recipient) = &w.revision_recipient_session_id {
                intent["revisionRecipientSessionId"] = json!(recipient);
            }
            let mut r = planning::verification_record(
                &t.source,
                w.target_id.clone(),
                w.delivery_id.clone(),
                intent,
                Pin {
                    owner_session_id: w.owner_session_id.clone(),
                    recipient_session_id: v["revisionRecipientSessionId"]
                        .as_str()
                        .map(str::to_owned),
                },
            )?;
            journal.save_planning(r.clone())?;
            if let Err(e) = t.local().and_then(|_| check()) {
                r.not_sent = true;
                journal.save_planning(r)?;
                return Err(e);
            }
            let result = t.raw_operation(&r.operation, false).await;
            outcome = settle(journal, &mut r, result);
            Some(w.subject.clone())
        }
        Command::DeliveryCheck(id) => {
            let mut r = journal
                .planning
                .get(id)
                .filter(|r| selected(r, &t.source))
                .cloned()
                .ok_or(Error::Unknown)?;
            // Only the saved envelope. Never read/rebind the current delivery for this lookup.
            t.local()?;
            check()?;
            if r.pending() {
                let result = t.raw_operation(&r.operation, true).await;
                outcome = settle(journal, &mut r, result);
            } else {
                if !r.not_sent {
                    // A historical ACK is kept, but a new Check must still pass
                    // the daemon's current exact-subject access check.
                    let pair = exact(
                        t.raw_operation(&r.operation, true).await?,
                        &r.operation,
                        r.verification_pin.as_ref().ok_or(Error::Storage)?,
                    )?;
                    if r.receipt.as_ref() != Some(&pair) {
                        return Err(Error::Unknown);
                    }
                }
                outcome = summary(&r);
            }
            None
        }
        _ => return Err(Error::Invalid),
    };
    let snapshot = match subject {
        Some(s) => read(t, &s).await,
        None => Ok(Value::Null),
    };
    if matches!(command, Command::DeliveryRead(_)) {
        let v = snapshot?;
        check()?;
        Ok(
            json!({"snapshot":v,"operations":operations(t,journal),"operationsProjectId":t.source.project()?.project_id,"outcome":outcome,
            "outputCapabilities":output_capabilities(shared)}),
        )
    } else {
        Ok(
            json!({"snapshot":snapshot.ok().filter(|_|check().is_ok()),"operations":operations(t,journal),
            "operationsProjectId":t.source.project()?.project_id,"outcome":outcome}),
        )
    }
}
fn settle(
    journal: &mut Journal,
    r: &mut planning::PlanningRecord,
    result: Result<Value, Error>,
) -> Value {
    if let Ok(pair) = result.and_then(|p| {
        exact(
            p,
            &r.operation,
            r.verification_pin.as_ref().ok_or(Error::Storage)?,
        )
    }) {
        r.receipt = Some(pair);
        if journal.save_planning(r.clone()).is_err() {
            journal.poison();
            let mut v = summary(r);
            v["state"] = json!("unknown");
            v["receiptSaved"] = json!(false);
            return v;
        }
    }
    summary(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The window moved from project "one" to "two" while the screen still
    /// asked about a result of "one": that read is dropped as Stale (never
    /// Identity, which fails every read of the window) and sends nothing.
    #[tokio::test]
    async fn a_read_of_the_previous_project_after_a_switch_is_stale_and_sends_nothing() {
        let focused = |project: &str| {
            Transport::new(crate::host::Source {
                profile: "/synthetic-profile".into(),
                // No profile and nothing listens here: a read that goes on fails.
                port: 1,
                home: crate::contract::Home {
                    daemon_id: "daemon".into(),
                    lineage_id: "lineage".into(),
                },
                project: Some(crate::host::Project {
                    project_id: project.into(),
                    project_path: format!("/{project}"),
                }),
            })
            .unwrap()
        };
        let old: Subject = serde_json::from_value(
            json!({"kind":"task","projectId":"one","missionId":"m","taskId":"t"}),
        )
        .unwrap();
        assert_eq!(read(&focused("two"), &old).await, Err(Error::Stale));
        // The same read while the window still acts on "one" passes the scope check
        // and goes on (to fail here on the missing profile, never as Stale).
        assert_ne!(read(&focused("one"), &old).await, Err(Error::Stale));
        // Only Identity, Offline and Storage fail the window's reads (host/bridge.rs).
        assert!(!matches!(
            Error::Stale,
            Error::Identity | Error::Offline | Error::Storage
        ));
    }

    #[test]
    fn delivery_list_is_bounded_scoped_and_never_accepts_unknown_as_done() {
        let subject = json!({"kind":"task","projectId":"p","missionId":"m","taskId":"t"});
        let snapshot = json!({"version":1,"subject":subject,"targetId":"target","deliveryId":"d".repeat(64),
            "ownerSessionId":null,"verificationRevision":1,"verificationCurrent":false,
            "verificationReceiptState":"unknown","verification":null,"pendingOperationId":"uncertain",
            "production":"not_tracked","artifacts":[],"pullRequests":[]});
        let page = json!({"version":1,"projectId":"p","baseline":{"mode":"start_fresh","sourceSequence":10},
            "sourceCursor":12,"complete":true,"more":false,"nextCursor":null,"currentness":"live",
            "items":[{"subject":subject,"title":"Result","sourceSequence":11,"snapshot":snapshot}]});
        assert_eq!(validate_list(&page, "p"), Ok(()));
        for (path, value) in [
            ("/projectId", json!("other")),
            ("/baseline/sourceSequence", json!(12)),
            ("/complete", json!(false)),
            ("/items/0/sourceSequence", json!(10)),
            ("/items/0/subject/projectId", json!("other")),
            ("/items/0/snapshot/subject/taskId", json!("other")),
            ("/items/0/snapshot/verificationCurrent", json!(true)),
            ("/items/0/snapshot/deliveryId", Value::Null),
        ] {
            let mut changed = page.clone();
            *changed.pointer_mut(path).unwrap() = value;
            assert_eq!(validate_list(&changed, "p"), Err(Error::Invalid), "{path}");
        }
        let mut many = page.clone();
        many["items"] = json!(vec![page["items"][0].clone(); 21]);
        assert_eq!(validate_list(&many, "p"), Err(Error::Invalid));
        assert!(serde_json::from_value::<List>(json!({"projectId":"p"})).is_err());
        assert!(serde_json::from_value::<List>(json!({"after":-1})).is_err());
        assert_eq!(
            List {
                after: Some(MAX_REVISION + 1)
            }
            .validate(),
            Err(Error::Invalid)
        );
    }

    #[test]
    fn output_activation_pins_exact_subject_delivery_owner_resource_and_target() {
        let subject = json!({"kind":"task","projectId":"p","missionId":"m","taskId":"t"});
        let args = json!({"subject":subject,"targetId":"target","deliveryId":"d".repeat(64),
            "ownerSessionId":"owner","resourceId":"r","url":"https://github.com/a/b/pull/1"});
        let r: Open = serde_json::from_value(args.clone()).unwrap();
        r.validate().unwrap();
        let page = json!({"subject":subject,"targetId":"target","deliveryId":args["deliveryId"],
            "ownerSessionId":"owner","pullRequests":[{"id":"r","kind":"github.pr","url":args["url"]}]});
        assert_eq!(r.qualifies(&page), Ok(()));
        for pointer in [
            "/subject/projectId",
            "/subject/taskId",
            "/targetId",
            "/deliveryId",
            "/ownerSessionId",
            "/pullRequests/0/id",
            "/pullRequests/0/url",
        ] {
            let mut changed = page.clone();
            *changed.pointer_mut(pointer).unwrap() = json!("changed");
            assert_eq!(r.qualifies(&changed), Err(Error::Stale), "{pointer}");
        }
        for extra in [
            json!({"path":"../../a"}),
            json!({"artifactId":"a","revision":1}),
            json!({"callback":"run"}),
        ] {
            let mut forged = args.clone();
            forged
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert!(serde_json::from_value::<Open>(forged).is_err());
        }
        let mut changed = page;
        changed["pullRequests"][0]["pullRequest"] = json!({"url":"https://example.com/other"});
        assert_eq!(r.qualifies(&changed), Err(Error::Stale));
    }

    fn pair() -> (Value, Value, Pin) {
        let p = json!({"purpose":"user-verification","subject":{"kind":"chat","projectId":"project","sessionId":"owner"},
            "deliveryId":"d".repeat(64),"expectedRevision":0,"action":"send_back","note":"  exact 🐦\n  "});
        let op = json!({"operationId":"operation","payloadHash":"hash","targetId":"target",
            "destination":{"hostId":"daemon"},"payload":p.to_string()});
        let v = json!({"version":1,"subject":p["subject"],"deliveryId":p["deliveryId"],"revision":1,
            "operationId":"operation","state":"sent_back","note":p["note"],"createdAt":100,
            "messageReceipt":{"sessionId":"owner","requestId":"operation","state":"admitted"}});
        let outer = json!({"operationId":"operation","payloadHash":"hash","targetId":"target",
            "destination":op["destination"],"state":"accepted","result":v});
        let domain = json!({"operation":op,"operationId":"operation","payloadHash":"hash","intent":p,"verification":v,"state":"accepted"});
        (
            json!({"receipt":outer,"verificationReceipt":domain}),
            op,
            Pin {
                owner_session_id: Some("owner".into()),
                recipient_session_id: None,
            },
        )
    }
    #[test]
    fn coordinator_receipt_is_pinned_without_changing_legacy_owner_receipts() {
        let (mut pair, op, mut pin) = pair();
        pin.recipient_session_id = Some("coordinator".into());
        assert!(matches!(
            exact(pair.clone(), &op, &pin),
            Err(Error::Unknown)
        ));
        pair["verificationReceipt"]["verification"]["messageReceipt"]["sessionId"] =
            json!("coordinator");
        pair["receipt"]["result"]["messageReceipt"]["sessionId"] = json!("coordinator");
        assert_eq!(exact(pair, &op, &pin).unwrap()["state"], "accepted");
    }
    #[test]
    fn only_exact_terminal_receipt_pairs_and_admitted_message_settle() {
        let (pair, op, pin) = pair();
        assert_eq!(exact(pair.clone(), &op, &pin).unwrap()["state"], "accepted");
        for pointer in [
            "/receipt/operationId",
            "/receipt/payloadHash",
            "/receipt/targetId",
            "/receipt/destination",
            "/receipt/result/note",
            "/verificationReceipt/operation",
            "/verificationReceipt/operationId",
            "/verificationReceipt/payloadHash",
            "/verificationReceipt/intent/note",
            "/verificationReceipt/verification/revision",
            "/verificationReceipt/verification/subject",
            "/verificationReceipt/verification/note",
            "/verificationReceipt/verification/messageReceipt/sessionId",
            "/verificationReceipt/verification/messageReceipt/requestId",
            "/verificationReceipt/verification/messageReceipt/state",
        ] {
            let mut malformed = pair.clone();
            *malformed.pointer_mut(pointer).unwrap() = json!("wrong");
            assert!(
                matches!(exact(malformed, &op, &pin), Err(Error::Unknown)),
                "{pointer}"
            );
        }
        for (outer, domain) in [
            ("pending", "accepted"),
            ("accepted", "pending"),
            ("unknown", "accepted"),
            ("rejected", "accepted"),
        ] {
            let mut malformed = pair.clone();
            malformed["receipt"]["state"] = json!(outer);
            malformed["verificationReceipt"]["state"] = json!(domain);
            assert!(matches!(exact(malformed, &op, &pin), Err(Error::Unknown)));
        }
        let mut rejected = pair;
        rejected["receipt"]["state"] = json!("rejected");
        rejected["verificationReceipt"] = Value::Null;
        assert_eq!(exact(rejected, &op, &pin).unwrap()["state"], "rejected");
    }
}
