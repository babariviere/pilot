//! Project-pinned standalone admission on the existing worker, transport and ledger.
use super::{Error, Journal, Shared, Transport, planning};
use crate::{
    bridge::{Command, Gate},
    new_chat::ChatChoice,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Select {
    pub project_id: String,
    pub context_digest: String,
    pub mode: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Create {
    pub choice: ChatChoice,
    pub message: String,
}
impl Create {
    pub(crate) fn validate(&self) -> bool {
        self.choice.validate() && !self.message.trim().is_empty() && self.message.len() <= 12000
    }
}
fn is_chat(r: &planning::PlanningRecord) -> bool {
    r.operation["kind"] == "native-chat-create"
}
/// Continue: one fixed follow-up to one stopped chat. The daemon writes the words.
pub(super) const CONTINUE: &str = "chat-continue";
pub(super) const RECOVER: &str = "chat-recover";
/// Mirrors standalone creation's queued-input budget. The page shows byte counts before sending.
pub(crate) const RECOVERY_INPUT_BYTES: usize = 12_000;
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Recovery {
    pub session_id: String,
    pub message: String,
}
/// A Continue record carries no choice, so its binding is a fixed digest.
const CONTINUE_BINDING: &str = "0000000000000000000000000000000000000000000000000000000000000000";
fn is_continue(r: &planning::PlanningRecord) -> bool {
    r.operation["kind"] == CONTINUE || r.operation["kind"] == RECOVER
}
pub(super) fn pending_recovery(t: &Transport, journal: &Journal, session: &str) -> Option<Value> {
    journal
        .planning
        .values()
        .find(|r| {
            same_home(&r.source, &t.source)
                && is_continue(r)
                && r.pending()
                && r.mission() == session
        })
        .map(summary)
}
fn publish_recovery(t: &Transport, journal: &Journal, shared: &Shared, session: &str) {
    if let Some(chat) = shared
        .session_chat
        .lock()
        .expect("native session chat poisoned")
        .as_mut()
        .filter(|c| c.session == session)
    {
        chat.pending_recovery = pending_recovery(t, journal, session);
    }
}
/// A saved Continue names exactly one chat, as its target and its payload.
pub(super) fn validate_continue(op: &Value) -> Result<(), Error> {
    let p: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Storage)?)
        .map_err(|_| Error::Storage)?;
    let session = p["sessionId"].as_str().unwrap_or("");
    let recovery = op["kind"] == RECOVER;
    if (!recovery && op["kind"] != CONTINUE)
        || p.as_object()
            .is_none_or(|o| o.len() != if recovery { 5 } else { 2 })
        || p["purpose"] != op["kind"]
        || (recovery
            && p["message"]
                .as_str()
                .is_none_or(|s| s.len() > RECOVERY_INPUT_BYTES))
        || (recovery && p["updatedAt"].as_u64().is_none())
        || (recovery && p["inputGeneration"].as_u64().is_none())
        || !super::valid_id(session)
        || op["targetId"] != session
        || op["bindingId"] != CONTINUE_BINDING
        || op["bindingGeneration"] != 1
    {
        return Err(Error::Storage);
    }
    Ok(())
}
fn same_home(a: &super::Source, b: &super::Source) -> bool {
    a.profile == b.profile && a.home == b.home
}
pub(super) fn validate_record(op: &Value) -> Result<(), Error> {
    let mut p: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Storage)?)
        .map_err(|_| Error::Storage)?;
    let message = p
        .as_object_mut()
        .ok_or(Error::Storage)?
        .remove("message")
        .ok_or(Error::Storage)?;
    if p.as_object_mut().ok_or(Error::Storage)?.remove("purpose")
        != Some(json!("native-chat-create"))
    {
        return Err(Error::Storage);
    }
    let choice: ChatChoice = serde_json::from_value(p).map_err(|_| Error::Storage)?;
    if !choice.validate()
        || op["targetId"] != choice.draft_id
        || op["bindingId"] != choice.context_digest
        || op["bindingGeneration"] != 1
        || message
            .as_str()
            .is_none_or(|s| s.trim().is_empty() || s.len() > 12000)
    {
        return Err(Error::Storage);
    }
    Ok(())
}
fn operations(t: &Transport, journal: &Journal) -> Vec<Value> {
    journal.planning.values().filter(|r| same_home(&r.source, &t.source) && is_chat(r))
        .map(|r| {
            let p: Value = serde_json::from_str(r.operation["payload"].as_str().unwrap_or(""))
                .unwrap_or(Value::Null);
            json!({"operationId":r.id(),"draftId":r.mission(),"projectId":p["projectId"],
                "state":if r.not_sent {"not-sent"} else {r.receipt.as_ref().and_then(|r| r["state"].as_str()).unwrap_or("unknown")},
                "receipt":r.receipt})
        }).collect()
}
pub(super) async fn inventory(t: &Transport) -> Result<Value, Error> {
    // This profile identity is independent of the old selected project's existence.
    t.profile_gate().await?;
    let v = t.get("/api/native-projects").await?;
    let rows = v["projects"].as_array().ok_or(Error::Invalid)?;
    let mut ids = std::collections::HashSet::new();
    if v["version"] != 1
        || v["complete"] != true
        || rows.len() > 256
        || rows.iter().any(|r| {
            r["projectId"]
                .as_str()
                .is_none_or(|id| !super::valid_id(id) || !ids.insert(id))
                || r["projectPath"]
                    .as_str()
                    .is_none_or(|s| !s.starts_with('/') || s.len() > 4096)
                || r["contextDigest"]
                    .as_str()
                    .is_none_or(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
                || !r["name"].is_string()
        })
    {
        return Err(Error::Invalid);
    }
    Ok(v)
}
pub(super) async fn profile(t: &Transport, request: &Select) -> Result<Value, Error> {
    if !super::valid_id(&request.project_id) || !matches!(request.mode.as_str(), "ask" | "build") {
        return Err(Error::Invalid);
    }
    let v = t
        .get(&format!(
            "/api/projects/{}/chat-profile?mode={}",
            request.project_id, request.mode
        ))
        .await?;
    if v["projectId"] != request.project_id
        || v["mode"] != request.mode
        || v["contextDigest"] != request.context_digest
    {
        return Err(Error::Stale);
    }
    Ok(v)
}
pub(super) async fn handle(
    t: &Transport,
    journal: &mut Journal,
    shared: &Shared,
    epoch: u64,
    command: &Command,
    gate: &Arc<Mutex<Gate>>,
) -> Result<Value, Error> {
    // Not `shared.current(epoch)`: every dashboard or session notice bumps the
    // epoch, including the one an earlier creation causes. The re-read
    // inventory and chat profile (and the daemon's own recheck) fence the
    // project here; the host only has to be open and the window's gate admitting.
    let _ = epoch;
    let check = || {
        shared.open()?;
        command.admit(&gate.lock().expect("bridge gate poisoned"))
    };
    match command {
        Command::Projects => {
            let snapshot = inventory(t).await?;
            check()?;
            // `current` is this window's own project (Today's and new missions').
            // It is not a selection, and New never defaults to it.
            Ok(
                json!({"snapshot":snapshot,"current":t.source.project.as_ref().map(|p| &p.project_id),
                "operations":operations(t,journal),"outcome":null}),
            )
        }
        Command::ChatSelect(request) => {
            *shared
                .chat_choice
                .lock()
                .expect("native chat choice poisoned") = None;
            if journal
                .planning
                .values()
                .any(|r| same_home(&r.source, &t.source) && is_chat(r) && r.pending())
            {
                return Err(Error::Unknown);
            }
            inventory(t).await?;
            let mut v = profile(t, request).await?;
            check()?;
            v["draftId"] = json!(uuid::Uuid::new_v4().to_string());
            let choice: ChatChoice =
                serde_json::from_value(v.clone()).map_err(|_| Error::Invalid)?;
            if !choice.validate() {
                return Err(Error::Invalid);
            }
            *shared
                .chat_choice
                .lock()
                .expect("native chat choice poisoned") = Some(choice);
            Ok(json!({"snapshot":v,"outcome":null}))
        }
        Command::ChatCreate(request) => {
            if !request.validate() {
                return Err(Error::Invalid);
            }
            let choice = &request.choice;
            let mut payload = serde_json::to_value(choice).map_err(|_| Error::Invalid)?;
            payload["purpose"] = json!("native-chat-create");
            payload["message"] = json!(request.message);
            if let Some(prior) = journal.planning.values().find(|r| {
                same_home(&r.source, &t.source)
                    && is_chat(r)
                    && r.mission().eq_ignore_ascii_case(&choice.draft_id)
            }) {
                let prior_payload: Value = serde_json::from_str(
                    prior.operation["payload"].as_str().ok_or(Error::Storage)?,
                )
                .map_err(|_| Error::Storage)?;
                if prior_payload != payload {
                    return Err(Error::Stale);
                }
                return Ok(
                    json!({"snapshot":null,"operations":operations(t,journal),"outcome":summary(prior)}),
                );
            }
            if journal
                .planning
                .values()
                .any(|r| same_home(&r.source, &t.source) && is_chat(r) && r.pending())
            {
                return Err(Error::Unknown);
            }
            let mut compared_choice = choice.clone();
            let selected = shared
                .chat_choice
                .lock()
                .expect("native chat choice poisoned")
                .clone();
            compared_choice.allowance_micros = selected.as_ref().and_then(|c| c.allowance_micros);
            if selected.as_ref() != Some(&compared_choice) {
                return Err(Error::Stale);
            }
            inventory(t).await?;
            let mut v = profile(
                t,
                &Select {
                    project_id: choice.project_id.clone(),
                    context_digest: choice.context_digest.clone(),
                    mode: choice.mode.clone(),
                },
            )
            .await?;
            let mut expected = serde_json::to_value(choice).map_err(|_| Error::Invalid)?;
            expected
                .as_object_mut()
                .ok_or(Error::Invalid)?
                .remove("draftId");
            expected
                .as_object_mut()
                .ok_or(Error::Invalid)?
                .remove("allowanceMicros");
            v.as_object_mut()
                .ok_or(Error::Invalid)?
                .remove("allowanceMicros");
            if v != expected {
                return Err(Error::Stale);
            }
            check()?;
            let mut record = planning::record(
                &t.source,
                choice.draft_id.clone(),
                choice.context_digest.clone(),
                payload,
            )?;
            journal.save_planning(record.clone())?;
            if let Err(e) = t.local().and_then(|_| check()) {
                record.not_sent = true;
                journal.save_planning(record)?;
                return Err(e);
            }
            if let Ok(receipt) = t.planning_operation(&record.operation, false).await {
                record.receipt = Some(receipt);
                if journal.save_planning(record.clone()).is_err() {
                    return Ok(unsaved_receipt(journal, &record));
                }
            }
            Ok(
                json!({"snapshot":null,"operations":operations(t,journal),"outcome":summary(&record)}),
            )
        }
        Command::ChatCheck(id) => {
            let mut record = journal
                .planning
                .get(id)
                .filter(|r| same_home(&r.source, &t.source) && (is_chat(r) || is_continue(r)))
                .cloned()
                .ok_or(Error::Unknown)?;
            // Receipt lookup remains possible after deletion/configuration changes.
            t.local()?;
            command.admit(&gate.lock().expect("bridge gate poisoned"))?;
            if record.pending()
                && let Ok(receipt) = t.planning_operation(&record.operation, true).await
            {
                record.receipt = Some(receipt);
                if journal.save_planning(record.clone()).is_err() {
                    return Ok(unsaved_receipt(journal, &record));
                }
            }
            if is_continue(&record) {
                publish_recovery(t, journal, shared, record.mission());
            }
            Ok(
                json!({"snapshot":null,"operations":operations(t,journal),"outcome":summary(&record)}),
            )
        }
        Command::ChatContinue(_) | Command::ChatRecover(_) => {
            let (session, message) = match command {
                Command::ChatContinue(session) => (session, None),
                Command::ChatRecover(r) => (&r.session_id, Some(&r.message)),
                _ => unreachable!(),
            };
            if !super::valid_id(session) {
                return Err(Error::Invalid);
            }
            // An uncertain Continue holds its chat: it is shown for Check, never sent again.
            if let Some(prior) = journal.planning.values().find(|r| {
                same_home(&r.source, &t.source)
                    && is_continue(r)
                    && r.pending()
                    && r.mission() == session.as_str()
            }) {
                return Ok(json!({"snapshot":null,"outcome":summary(prior)}));
            }
            check()?;
            let payload = match message {
                Some(message) => {
                    let chat = shared
                        .session_chat
                        .lock()
                        .expect("native session chat poisoned");
                    let c = chat
                        .as_ref()
                        .filter(|c| {
                            c.session == *session
                                && c.reason.is_empty()
                                && !c.archived
                                && matches!(c.state, "failed" | "stopped")
                        })
                        .ok_or(Error::Stale)?;
                    json!({"purpose":RECOVER,"sessionId":session,"message":message,"updatedAt":c.updated_at,"inputGeneration":c.input_generation})
                }
                None => json!({"purpose":CONTINUE,"sessionId":session}),
            };
            let mut record =
                planning::record(&t.source, session.clone(), CONTINUE_BINDING.into(), payload)?;
            journal.save_planning(record.clone())?;
            publish_recovery(t, journal, shared, session);
            if let Err(e) = t.local().and_then(|_| check()) {
                record.not_sent = true;
                journal.save_planning(record)?;
                return Err(e);
            }
            if let Ok(receipt) = t.planning_operation(&record.operation, false).await {
                record.receipt = Some(receipt);
                if journal.save_planning(record.clone()).is_err() {
                    return Ok(unsaved_receipt(journal, &record));
                }
            }
            publish_recovery(t, journal, shared, session);
            Ok(json!({"snapshot":null,"outcome":summary(&record)}))
        }
        _ => Err(Error::Invalid),
    }
}
fn unsaved_receipt(journal: &mut Journal, record: &planning::PlanningRecord) -> Value {
    journal.poison();
    // Preserve the exact volatile ACK, but never report local durable success.
    let mut outcome = summary(record);
    outcome["state"] = json!("unknown");
    outcome["receiptSaved"] = json!(false);
    json!({"snapshot":null,"outcome":outcome})
}
fn summary(r: &planning::PlanningRecord) -> Value {
    let payload: Value =
        serde_json::from_str(r.operation["payload"].as_str().unwrap_or("")).unwrap_or(Value::Null);
    json!({"operationId":r.id(),"draftId":r.mission(),"state":if r.not_sent {"not-sent"} else {
        r.receipt.as_ref().and_then(|r| r["state"].as_str()).unwrap_or("unknown")},"receipt":r.receipt,
        "submittedText":if r.operation["kind"] == RECOVER {payload["message"].as_str()} else {None}})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(target: &str, payload: Value, binding: &str) -> Value {
        json!({"operationId":"op","targetId":target,"kind":CONTINUE,"bindingId":binding,
            "bindingGeneration":1,"payload":payload.to_string()})
    }

    #[test]
    fn a_saved_continue_names_one_chat_and_carries_no_words() {
        let ok = op(
            "s1",
            json!({"purpose":CONTINUE,"sessionId":"s1"}),
            CONTINUE_BINDING,
        );
        assert_eq!(validate_continue(&ok), Ok(()));
        for forged in [
            op(
                "s2",
                json!({"purpose":CONTINUE,"sessionId":"s1"}),
                CONTINUE_BINDING,
            ),
            op(
                "s1",
                json!({"purpose":CONTINUE,"sessionId":"s1","message":"x"}),
                CONTINUE_BINDING,
            ),
            op(
                "s1",
                json!({"purpose":CONTINUE,"sessionId":"s1"}),
                &"1".repeat(64),
            ),
            op(
                "../s",
                json!({"purpose":CONTINUE,"sessionId":"../s"}),
                CONTINUE_BINDING,
            ),
        ] {
            assert_eq!(validate_continue(&forged), Err(Error::Storage), "{forged}");
        }
    }

    #[test]
    fn only_a_receipt_naming_this_chat_and_operation_settles_a_continue() {
        let o = json!({"operationId":"op","targetId":"s1","kind":CONTINUE,"payloadHash":"h",
            "destination":{"hostId":"daemon"}});
        let receipt = |result: Value| {
            json!({"operationId":"op","payloadHash":"h","destination":{"hostId":"daemon"},
                "targetId":"s1","state":"accepted","result":result})
        };
        assert!(planning::exact(receipt(json!({"sessionId":"s1","operationId":"op"})), &o).is_ok());
        assert!(
            planning::exact(receipt(json!({"sessionId":"s2","operationId":"op"})), &o).is_err()
        );
        assert!(planning::exact(receipt(json!({"sessionId":"s1","operationId":"x"})), &o).is_err());
    }
}
