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
async fn profile(t: &Transport, request: &Select) -> Result<Value, Error> {
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
            Ok(json!({"snapshot":snapshot,"current":t.source.project_id,
                "operations":operations(t,journal),"outcome":null}))
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
            if shared
                .chat_choice
                .lock()
                .expect("native chat choice poisoned")
                .as_ref()
                != Some(choice)
            {
                return Err(Error::Stale);
            }
            inventory(t).await?;
            let v = profile(
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
                .filter(|r| same_home(&r.source, &t.source) && is_chat(r))
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
            Ok(
                json!({"snapshot":null,"operations":operations(t,journal),"outcome":summary(&record)}),
            )
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
    json!({"operationId":r.id(),"draftId":r.mission(),"state":if r.not_sent {"not-sent"} else {
        r.receipt.as_ref().and_then(|r| r["state"].as_str()).unwrap_or("unknown")},"receipt":r.receipt})
}
