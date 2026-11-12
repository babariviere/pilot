//! Canonical delivery reads and explicit user assessments. No model subscription or replay.
use super::{Error, Journal, Shared, Source, Transport, planning, valid_id};
use crate::bridge::{Command, Gate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const MAX_REVISION: u64 = 9_007_199_254_740_990;

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
    fn project(&self) -> &str {
        match self {
            Self::Task { project, .. } | Self::Chat { project, .. } => project,
        }
    }
    fn path(&self) -> String {
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
    subject: Subject,
    target_id: String,
    delivery_id: String,
    expected_revision: u64,
    owner_session_id: Option<String>,
    note: String,
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
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}
fn digest(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
fn valid_note(action: &str, note: &str) -> bool {
    match action {
        "send_back" => !note.trim().is_empty() && note.len() <= 8000,
        "done" | "reopen" => note.is_empty(),
        _ => false,
    }
}

/// Native-only metadata, not a second verification or daemon payload field.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Pin {
    owner_session_id: Option<String>,
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
    if p.as_object().is_none_or(|o| o.len() != 6)
        || p["purpose"] != "user-verification"
        || subject.project() != r.source.project_id
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
        let owner = pin.owner_session_id.as_ref().ok_or(Error::Unknown)?;
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
    // Port/path are live transport/configuration, not receipt identity. A cold
    // daemon can move ports; historical lookup still pins profile, lineage and
    // exact project/subject. It can never send the old envelope again.
    r.source.profile == source.profile
        && r.source.home == source.home
        && r.source.project_id == source.project_id
        && r.operation["kind"] == "user-verification"
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
async fn read(t: &Transport, s: &Subject) -> Result<Value, Error> {
    s.validate()?;
    if s.project() != t.source.project_id {
        return Err(Error::Identity);
    }
    t.gate(false).await?;
    let v = t.get(&s.path()).await?;
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
    Ok(v)
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
        Command::DeliveryRead(s) => Some(s.clone()),
        Command::DeliverySaved => {
            // The journal's saved commands only: no HTTP, Check, or read of any
            // delivery. The project is the root's own choice, echoed, never chosen.
            check()?;
            return Ok(json!({"snapshot":{"projectId":t.source.project_id},
                "operations":operations(t,journal),"outcome":null}));
        }
        Command::DeliveryWrite(w) => {
            w.validate()?;
            if w.subject.project() != t.source.project_id {
                return Err(Error::Identity);
            }
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
            check()?;
            let mut r = planning::verification_record(
                &t.source,
                w.target_id.clone(),
                w.delivery_id.clone(),
                json!({
                "purpose":"user-verification","subject":subject,"deliveryId":w.delivery_id,
                "expectedRevision":w.expected_revision,"action":w.action,"note":w.note}),
                Pin {
                    owner_session_id: w.owner_session_id.clone(),
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
        Ok(json!({"snapshot":v,"operations":operations(t,journal),"outcome":outcome}))
    } else {
        Ok(
            json!({"snapshot":snapshot.ok().filter(|_|check().is_ok()),"operations":operations(t,journal),"outcome":outcome}),
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
            },
        )
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
