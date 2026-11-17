//! Explicit schedules on the existing native journal. Read/Check never dispatch.
use super::{Error, Journal, Shared, Transport, planning};
use crate::bridge::{Command, Gate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) const KIND: &str = "schedule-controls";
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Read {
    pub page: u32,
    pub edit_id: Option<String>,
    pub target_id: Option<String>,
    pub project_id: Option<String>,
}
impl Read {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if [&self.edit_id, &self.target_id, &self.project_id]
            .iter()
            .any(|id| id.as_ref().is_some_and(|s| !super::valid_id(s)))
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    fn for_value(page: u32, value: &Value) -> Self {
        Self {
            page,
            edit_id: value["id"].as_str().map(str::to_owned),
            target_id: value["target"]["sessionId"].as_str().map(str::to_owned),
            project_id: None,
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Intent {
    pub draft_id: String,
    pub binding: String,
    pub page: u32,
    pub action: String,
    pub value: Value,
}
impl Intent {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if uuid::Uuid::parse_str(&self.draft_id).is_err()
            || self.binding.len() != 64
            || !self
                .binding
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || !matches!(self.action.as_str(), "create" | "update" | "cancel")
            || !self.value.is_object()
            || self.value.to_string().len() > 20000
        {
            return Err(Error::Invalid);
        }
        let v = self.value.as_object().ok_or(Error::Invalid)?;
        if !v.keys().all(|k| {
            [
                "id",
                "expectedRevision",
                "title",
                "trigger",
                "at",
                "expiresAt",
                "atLocal",
                "expiresLocal",
                "timeZone",
                "recurrence",
                "target",
                "paused",
            ]
            .contains(&k.as_str())
        }) {
            return Err(Error::Invalid);
        }
        if self.action != "create"
            && (!self.value["id"].as_str().is_some_and(super::valid_id)
                || !self.value["expectedRevision"]
                    .as_u64()
                    .is_some_and(|n| n > 0))
        {
            return Err(Error::Invalid);
        }
        if self.action == "cancel" && v.len() != 2 {
            return Err(Error::Invalid);
        }
        if let Some(target) = v.get("target") {
            if target.as_object().is_none_or(|t| t.len() != 3)
                || target["kind"] != "message"
                || !target["sessionId"].as_str().is_some_and(super::valid_id)
                || !target["message"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty() && s.len() <= 16000)
            {
                return Err(Error::Invalid);
            }
        }
        Ok(())
    }
}
pub(super) fn validate_record(op: &Value) -> Result<(), Error> {
    let mut payload: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Storage)?)
        .map_err(|_| Error::Storage)?;
    if payload
        .as_object_mut()
        .ok_or(Error::Storage)?
        .remove("purpose")
        != Some(json!(KIND))
        || op["targetId"] != "global-schedules"
    {
        return Err(Error::Storage);
    }
    let i: Intent = serde_json::from_value(payload).map_err(|_| Error::Storage)?;
    i.validate()?;
    if op["bindingId"] != i.binding {
        return Err(Error::Storage);
    }
    Ok(())
}
pub(super) fn exact_result(op: &Value, receipt: &Value) -> Result<(), Error> {
    let p: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Unknown)?)
        .map_err(|_| Error::Unknown)?;
    let r = &receipt["result"];
    if r["action"] != p["action"]
        || !r["scheduleId"].as_str().is_some_and(super::valid_id)
        || (p["action"] != "create" && r["scheduleId"] != p["value"]["id"])
    {
        return Err(Error::Unknown);
    }
    Ok(())
}
async fn read(t: &Transport, selection: &Read) -> Result<Value, Error> {
    selection.validate()?;
    t.profile_gate().await?;
    let mut path = format!("/api/schedule-controls?page={}", selection.page);
    for (name, id) in [
        ("editId", &selection.edit_id),
        ("targetId", &selection.target_id),
        ("projectId", &selection.project_id),
    ] {
        if let Some(id) = id {
            path.push_str(&format!("&{name}={id}"));
        }
    }
    let mut v = t.get(&path).await?;
    if v["version"] != 1
        || v["host"]["daemonId"] != t.source.home.daemon_id
        || v["host"]["lineageId"] != t.source.home.lineage_id
        || v["host"]["hostId"] != "daemon"
        || v["page"] != selection.page
        || !v["schedules"].is_array()
        || !v["targets"].is_array()
    {
        return Err(Error::Invalid);
    }
    t.profile_gate().await?;
    v["draftId"] = json!(uuid::Uuid::new_v4().to_string());
    Ok(v)
}
fn operations(t: &Transport, j: &Journal) -> Vec<Value> {
    j.planning.values().filter(|r| r.source.profile == t.source.profile && r.source.home == t.source.home && r.operation["kind"] == KIND)
        .map(|r| { let p:Value=serde_json::from_str(r.operation["payload"].as_str().unwrap_or("")).unwrap_or(Value::Null); json!({"operationId":r.id(),"draftId":p["draftId"],"supersedesDraftId":r.schedule_predecessor,"pending":r.pending(),"state":if r.not_sent {json!("not-sent")} else {r.receipt.as_ref().map(|r| r["state"].clone()).unwrap_or(json!("unknown"))},"receipt":r.receipt}) }).collect()
}
fn existing_draft<'a>(
    source: &super::Source,
    journal: &'a Journal,
    intent: &Intent,
) -> Result<Option<&'a planning::PlanningRecord>, Error> {
    for r in journal.planning.values().filter(|r| {
        r.source.profile == source.profile
            && r.source.home == source.home
            && r.operation["kind"] == KIND
    }) {
        if r.schedule_predecessor.as_ref() == Some(&intent.draft_id) {
            return Err(Error::Stale);
        }
        let payload: Value =
            serde_json::from_str(r.operation["payload"].as_str().ok_or(Error::Storage)?)
                .map_err(|_| Error::Storage)?;
        if payload["draftId"] != intent.draft_id {
            continue;
        }
        if payload["action"] != intent.action || payload["value"] != intent.value {
            return Err(Error::Stale);
        }
        return Ok(Some(r));
    }
    Ok(None)
}
/// Fence a restored editor whose newer replacement has not reached the window
/// capture yet. The journaled intent captures this link before any POST.
fn saved_predecessor(source: &super::Source, journal: &Journal, current: &str) -> Option<String> {
    let saved = journal
        .windows
        .get(&super::window::SavedWindow::key(source).ok()?)?;
    let draft: Value = serde_json::from_str(saved.view["scheduleSettings"].as_str()?).ok()?;
    let id = draft["draft"]["draftId"].as_str()?;
    if id == current || uuid::Uuid::parse_str(id).is_err() {
        return None;
    }
    let known = journal.planning.values().any(|r| {
        r.source.profile == source.profile
            && r.source.home == source.home
            && r.operation["kind"] == KIND
            && (r.schedule_predecessor.as_deref() == Some(id)
                || serde_json::from_str::<Value>(r.operation["payload"].as_str().unwrap_or(""))
                    .is_ok_and(|p| p["draftId"] == id))
    });
    (!known).then(|| id.to_owned())
}
pub(super) async fn handle(
    t: &Transport,
    j: &mut Journal,
    shared: &Shared,
    command: &Command,
    gate: &Arc<Mutex<Gate>>,
) -> Result<Value, Error> {
    let check = || {
        shared.open()?;
        command.admit(&gate.lock().expect("bridge gate poisoned"))
    };
    let mut outcome = Value::Null;
    let selection;
    match command {
        Command::SchedulesRead(p) => {
            selection = p.clone();
        }
        Command::SchedulesWrite(i) => {
            i.validate()?;
            selection = Read::for_value(i.page, &i.value);
            // Recover the exact kept draft before checking a refreshed page binding.
            // Terminal receipts also fence duplicate Creates after restart.
            if let Some(r) = existing_draft(&t.source, j, i)? {
                outcome = json!({"operationId":r.id(),"state":r.receipt.as_ref().map(|r|r["state"].clone()).unwrap_or(json!("unknown")),"receipt":r.receipt});
            } else {
                if shared
                    .schedule_choice
                    .lock()
                    .expect("schedule choice poisoned")
                    .as_ref()
                    != Some(&i.draft_id)
                {
                    return Err(Error::Stale);
                }
                if operations(t, j).iter().any(|r| r["pending"] == true) {
                    return Err(Error::Unknown);
                }
                let current = read(t, &selection).await?;
                check()?;
                if current["binding"] != i.binding {
                    return Err(Error::Stale);
                }
                let mut payload = serde_json::to_value(i).map_err(|_| Error::Invalid)?;
                payload["purpose"] = json!(KIND);
                let mut r = planning::record(
                    &t.source,
                    "global-schedules".into(),
                    i.binding.clone(),
                    payload,
                )?;
                r.schedule_predecessor = saved_predecessor(&t.source, j, &i.draft_id);
                j.save_planning(r.clone())?;
                if let Err(e) = t.local().and_then(|_| check()) {
                    r.not_sent = true;
                    j.save_planning(r)?;
                    return Err(e);
                }
                if let Ok(receipt) = t.planning_operation(&r.operation, false).await {
                    r.receipt = Some(receipt);
                    if j.save_planning(r.clone()).is_err() {
                        j.poison();
                        return Err(Error::Unknown);
                    }
                }
                outcome = json!({"operationId":r.id(),"state":r.receipt.as_ref().map(|r| r["state"].clone()).unwrap_or(json!("unknown")),"receipt":r.receipt});
            }
        }
        Command::SchedulesCheck(id) => {
            let mut r = j
                .planning
                .get(id)
                .filter(|r| {
                    r.source.profile == t.source.profile
                        && r.source.home == t.source.home
                        && r.operation["kind"] == KIND
                })
                .cloned()
                .ok_or(Error::Unknown)?;
            let p: Value =
                serde_json::from_str(r.operation["payload"].as_str().ok_or(Error::Storage)?)
                    .map_err(|_| Error::Storage)?;
            selection = Read::for_value(
                p["page"].as_u64().ok_or(Error::Storage)? as u32,
                &p["value"],
            );
            t.profile_gate().await?;
            check()?;
            if r.pending()
                && let Ok(receipt) = t.planning_operation(&r.operation, true).await
            {
                r.receipt = Some(receipt);
                j.save_planning(r.clone())?;
            }
            outcome = json!({"operationId":r.id(),"state":r.receipt.as_ref().map(|r| r["state"].clone()).unwrap_or(json!("unknown")),"receipt":r.receipt});
        }
        _ => return Err(Error::Invalid),
    }
    let snapshot = read(t, &selection).await;
    if check().is_ok()
        && let Ok(v) = &snapshot
    {
        *shared
            .schedule_choice
            .lock()
            .expect("schedule choice poisoned") = v["draftId"].as_str().map(str::to_owned);
    }
    if matches!(command, Command::SchedulesRead(_)) {
        check()?;
        return Ok(json!({"snapshot":snapshot?,"operations":operations(t,j)}));
    }
    Ok(
        json!({"snapshot":snapshot.ok().filter(|_| check().is_ok()),"operations":operations(t,j),"outcome":outcome}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn schedule_choice_pages_keep_only_canonical_resource_ids() {
        let mut page: Read = serde_json::from_value(
            json!({"page":2,"editId":"rule","targetId":"agent","projectId":"project"}),
        )
        .unwrap();
        assert_eq!(page.validate(), Ok(()));
        page.target_id = Some("agent?token=secret".into());
        assert_eq!(page.validate(), Err(Error::Invalid));
    }
    #[test]
    fn kept_draft_keeps_its_operation_after_restart_and_terminal_receipt() {
        let dir =
            std::env::temp_dir().join(format!("day-schedule-journal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("journal");
        let source = super::super::Source {
            profile: dir.join("profile"),
            port: 1,
            home: crate::contract::Home {
                daemon_id: "daemon".into(),
                lineage_id: "lineage".into(),
            },
            project: None,
        };
        let mut intent = Intent {
            draft_id: uuid::Uuid::new_v4().to_string(),
            binding: "a".repeat(64),
            page: 0,
            action: "create".into(),
            value: json!({"title":"Check work","trigger":"at","at":1001,"target":{"kind":"message","sessionId":"agent","message":"Check work"}}),
        };
        let mut payload = serde_json::to_value(&intent).unwrap();
        payload["purpose"] = json!(KIND);
        let mut record = planning::record(
            &source,
            "global-schedules".into(),
            intent.binding.clone(),
            payload,
        )
        .unwrap();
        let id = record.id().to_owned();
        let old = uuid::Uuid::new_v4().to_string();
        {
            let mut journal = Journal::open(path.clone()).unwrap();
            journal
                .save_window(super::super::window::SavedWindow {
                    kind: "window-capture".into(),
                    version: 1,
                    source: source.clone(),
                    window: uuid::Uuid::new_v4().to_string(),
                    generation: 1,
                    save_sequence: 1,
                    view: serde_json::to_value(crate::update::SavedView {
                        settings: true,
                        schedule_settings: json!({"open":true,"draft":{"draftId":old}}).to_string(),
                        ..Default::default()
                    })
                    .unwrap(),
                })
                .unwrap();
            record.schedule_predecessor = saved_predecessor(&source, &journal, &intent.draft_id);
            assert_eq!(record.schedule_predecessor.as_deref(), Some(old.as_str()));
            journal.save_planning(record.clone()).unwrap();
        }
        {
            let mut journal = Journal::open(path.clone()).unwrap();
            let prior = existing_draft(&source, &journal, &intent).unwrap().unwrap();
            assert_eq!(prior.id(), id);
            assert!(prior.pending());
            let op = &record.operation;
            record.receipt = Some(
                json!({"operationId":op["operationId"],"payloadHash":op["payloadHash"],"destination":op["destination"],"targetId":op["targetId"],"state":"accepted","result":{"action":"create","scheduleId":"row"}}),
            );
            journal.save_planning(record).unwrap();
        }
        {
            let journal = Journal::open(path).unwrap();
            intent.binding = "b".repeat(64);
            intent.page = 1;
            let prior = existing_draft(&source, &journal, &intent).unwrap().unwrap();
            assert_eq!(prior.id(), id);
            assert!(!prior.pending());
            let fresh_id = intent.draft_id.clone();
            intent.draft_id = old;
            assert!(
                matches!(
                    existing_draft(&source, &journal, &intent),
                    Err(Error::Stale)
                ),
                "an older restored editor cannot create a replacement request"
            );
            intent.draft_id = fresh_id;
            intent.value["title"] = json!("Edited after submission");
            assert!(matches!(
                existing_draft(&source, &journal, &intent),
                Err(Error::Stale)
            ));
            intent.draft_id = uuid::Uuid::new_v4().to_string();
            assert!(
                existing_draft(&source, &journal, &intent)
                    .unwrap()
                    .is_none()
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn schedule_intent_and_receipt_pin_the_exact_row_and_action() {
        let i = Intent {
            draft_id: "b39c2068-6b29-4557-a046-f8a6a17b0e44".into(),
            binding: "a".repeat(64),
            page: 0,
            action: "cancel".into(),
            value: json!({"id":"row","expectedRevision":3}),
        };
        assert_eq!(i.validate(), Ok(()));
        let op = json!({"payload":serde_json::to_string(&i).unwrap()});
        assert_eq!(
            exact_result(
                &op,
                &json!({"result":{"action":"cancel","scheduleId":"row"}})
            ),
            Ok(())
        );
        assert_eq!(
            exact_result(
                &op,
                &json!({"result":{"action":"cancel","scheduleId":"other"}})
            ),
            Err(Error::Unknown)
        );
    }
}
