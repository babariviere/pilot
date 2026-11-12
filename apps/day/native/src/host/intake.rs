//! Selected-project intake on the existing serialized host and fsynced ledger.
use super::{Error, Journal, Shared, Transport, planning, valid_id};
use crate::{
    bridge::{Command, Gate},
    contract::TrackedSource,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Intent {
    item_id: String,
    revision: u64,
    context_digest: String,
    state: Option<String>,
    mission_id: Option<String>,
}
impl Intent {
    pub(crate) fn validate(&self, start: bool) -> Result<(), Error> {
        if !valid_id(&self.item_id)
            || self.revision == 0
            || self.revision > 9_007_199_254_740_991
            || self.context_digest.len() != 64
            || !self.context_digest.bytes().all(|c| c.is_ascii_hexdigit())
            || self.mission_id.as_ref().is_some_and(|id| !valid_id(id))
            || if start {
                self.state.is_some()
            } else {
                self.mission_id.is_some()
                    || !matches!(self.state.as_deref(), Some("new" | "later" | "discarded"))
            }
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}
fn is_intake(r: &planning::PlanningRecord) -> bool {
    matches!(
        r.operation["kind"].as_str(),
        Some("intake-triage" | "intake-start")
    )
}
pub(super) fn validate_record(source: &super::Source, op: &Value) -> Result<(), Error> {
    let p: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Storage)?)
        .map_err(|_| Error::Storage)?;
    if p["projectId"] != source.project_id
        || p["itemId"] != op["targetId"]
        || p["purpose"] != op["kind"]
        || p["contextDigest"] != op["bindingId"]
        || op["bindingGeneration"] != 1
        || p["revision"]
            .as_u64()
            .is_none_or(|n| n == 0 || n > 9_007_199_254_740_991)
        || p["contextDigest"]
            .as_str()
            .is_none_or(|s| s.len() != 64 || !s.bytes().all(|c| c.is_ascii_hexdigit()))
        || if op["kind"] == "intake-start" {
            !p["state"].is_null()
                || p["sessionId"].as_str().is_none_or(|s| !valid_id(s))
                || (!p["missionId"].is_null()
                    && p["missionId"].as_str().is_none_or(|s| !valid_id(s)))
        } else {
            !p["sessionId"].is_null()
                || !p["missionId"].is_null()
                || !matches!(p["state"].as_str(), Some("new" | "later" | "discarded"))
        }
    {
        return Err(Error::Storage);
    }
    Ok(())
}
fn summaries(t: &Transport, journal: &Journal) -> Vec<Value> {
    journal
        .planning
        .values()
        .filter(|r| r.source == t.source && is_intake(r))
        .map(|r| {
            let p: Value = serde_json::from_str(r.operation["payload"].as_str().unwrap_or(""))
                .unwrap_or(Value::Null);
            // `asked` is a triage's requested state; `missionId` a Start's chosen mission.
            json!({"operationId":r.id(), "itemId":r.mission(), "revision":p["revision"],
            "asked":p["state"], "missionId":p["missionId"], "sessionId":p["sessionId"],
            "kind":r.operation["kind"], "state":if r.not_sent {"not-sent"} else {
                r.receipt.as_ref().and_then(|r| r["state"].as_str()).unwrap_or("unknown")},
            "receipt":r.receipt})
        })
        .collect()
}
async fn read(t: &Transport) -> Result<Value, Error> {
    t.gate(false).await?;
    let mut v = t
        .get(&format!("/api/projects/{}/intake", t.source.project_id))
        .await?;
    if v["version"] != 1
        || v["projectId"] != t.source.project_id
        || v["contextDigest"]
            .as_str()
            .is_none_or(|s| s.len() != 64 || !s.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(Error::Invalid);
    }
    let sources = v["sources"].as_array().ok_or(Error::Invalid)?;
    if sources.len() != 2 {
        return Err(Error::Invalid);
    }
    for (source, kind) in sources.iter().zip(["slack", "linear"]) {
        let items = source["items"].as_array().ok_or(Error::Invalid)?;
        let total = source["total"].as_u64().ok_or(Error::Invalid)?;
        if source["kind"] != kind
            || source["source"] != kind
            || source["limit"] != 100
            || items.len() > 100
            || total < items.len() as u64
            || source["complete"] != (total == items.len() as u64)
            || items.iter().any(|item| {
                item["projectId"] != t.source.project_id
                    || item["kind"] != kind
                    || item["id"].as_str().is_none_or(|s| !valid_id(s))
                    || item["revision"].as_u64().is_none_or(|n| n == 0)
                    || !matches!(
                        item["triageState"].as_str(),
                        Some("new" | "later" | "discarded")
                    )
            })
        {
            return Err(Error::Invalid);
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| Error::Invalid)?
        .as_millis();
    let now = u64::try_from(now).map_err(|_| Error::Invalid)?;
    // Reuse Today's presentation projection, not a second domain model. `intake`
    // holds the new, unclaimed rows; `later` and `discarded` the user's triage;
    // `claimed` the rows an entered Start owns. Only `intake` counts unshown rows.
    let project = |keep: &dyn Fn(&Value) -> bool| -> Result<Value, Error> {
        let mut projected = sources.clone();
        for source in &mut projected {
            let held = source["items"].as_array().ok_or(Error::Invalid)?.len();
            source["items"]
                .as_array_mut()
                .ok_or(Error::Invalid)?
                .retain(|i| keep(i));
            let shown = source["items"].as_array().ok_or(Error::Invalid)?.len();
            source["total"] =
                json!(source["total"].as_u64().ok_or(Error::Invalid)? - (held - shown) as u64);
        }
        let projected: Vec<TrackedSource> =
            serde_json::from_value(json!(projected)).map_err(|_| Error::Invalid)?;
        serde_json::to_value(crate::intake::intake(&projected, now)).map_err(|_| Error::Invalid)
    };
    let unclaimed = |i: &Value| i["startOperationId"].is_null();
    let projected = [
        (
            "intake",
            project(&|i| i["triageState"] == "new" && unclaimed(i))?,
        ),
        (
            "later",
            project(&|i| i["triageState"] == "later" && unclaimed(i))?,
        ),
        (
            "discarded",
            project(&|i| i["triageState"] == "discarded" && unclaimed(i))?,
        ),
        ("claimed", project(&|i| !unclaimed(i))?),
    ];
    for (key, value) in projected {
        v[key] = value;
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
    // Not `shared.current(epoch)`: every dashboard or session notice, including
    // the one an earlier intake write causes, bumps the epoch. The daemon's CAS
    // on the pinned revision and project configuration is the authority here;
    // the host only has to be open and the window's gate still admitting.
    let _ = epoch;
    let check = || {
        shared.open()?;
        command.admit(&gate.lock().expect("bridge gate poisoned"))
    };
    let mut outcome = Value::Null;
    match command {
        Command::IntakeRead => {}
        Command::IntakeWrite(intent) => {
            if journal.planning.values().any(|r| {
                r.source == t.source && is_intake(r) && r.mission() == intent.item_id && r.pending()
            }) {
                return Err(Error::Unknown);
            }
            let snapshot = read(t).await?;
            check()?;
            if snapshot["contextDigest"] != intent.context_digest {
                return Err(Error::Stale);
            }
            let item = snapshot["sources"]
                .as_array()
                .ok_or(Error::Invalid)?
                .iter()
                .flat_map(|s| s["items"].as_array().into_iter().flatten())
                .find(|i| i["id"] == intent.item_id)
                .ok_or(Error::Stale)?;
            if item["revision"] != intent.revision || !item["startOperationId"].is_null() {
                return Err(Error::Stale);
            }
            let start = intent.state.is_none();
            if start && item["triageState"] != "new" {
                return Err(Error::Stale);
            }
            let mut request = json!({"purpose":if start {"intake-start"} else {"intake-triage"},
                "projectId":t.source.project_id,"itemId":intent.item_id,"revision":intent.revision,"contextDigest":intent.context_digest});
            if start {
                request["sessionId"] = json!(uuid::Uuid::new_v4().to_string());
                if let Some(mission) = &intent.mission_id {
                    request["missionId"] = json!(mission);
                }
            } else {
                request["state"] = json!(intent.state);
            }
            let mut record = planning::record(
                &t.source,
                intent.item_id.clone(),
                intent.context_digest.clone(),
                request,
            )?;
            journal.save_planning(record.clone())?;
            check()?;
            // No async gap, retry or recreation between the durable record and this sole POST.
            let mut saved = true;
            if let Ok(receipt) = t.planning_operation(&record.operation, false).await {
                record.receipt = Some(receipt);
                if journal.save_planning(record.clone()).is_err() {
                    journal.poison();
                    saved = false;
                }
            }
            outcome = json!({"operationId":record.id(), "state":if saved {record.receipt.as_ref().map(|r| r["state"].clone()).unwrap_or(json!("unknown"))} else {json!("unknown")},
                "receipt":record.receipt});
        }
        Command::IntakeCheck(id) => {
            let mut record = journal
                .planning
                .get(id)
                .filter(|r| r.source == t.source && is_intake(r))
                .cloned()
                .ok_or(Error::Unknown)?;
            t.gate(false).await?;
            check()?;
            if record.pending()
                && let Ok(receipt) = t.planning_operation(&record.operation, true).await
            {
                record.receipt = Some(receipt);
                journal.save_planning(record.clone())?;
            }
            outcome = json!({"operationId":record.id(),"state":record.receipt.as_ref().map(|r| r["state"].clone()).unwrap_or(json!("unknown")),"receipt":record.receipt});
        }
        _ => return Err(Error::Invalid),
    }
    let snapshot = read(t).await;
    if matches!(command, Command::IntakeRead) {
        let snapshot = snapshot?;
        check()?;
        Ok(json!({"snapshot":snapshot,"operations":summaries(t,journal),"outcome":outcome}))
    } else {
        // A failed/raced refresh cannot erase the exact acknowledgement.
        Ok(
            json!({"snapshot":snapshot.ok().filter(|_| check().is_ok()),"operations":summaries(t,journal),"outcome":outcome}),
        )
    }
}
