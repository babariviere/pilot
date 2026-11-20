//! Exact legacy replacement preview and finish. Reads/restoration never execute.
use super::{Error, Journal, Shared, Transport, planning, valid_id};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Request {
    pub mission_id: String,
    pub successor_id: String,
    pub action: String,
    #[serde(default)]
    pub digest: String,
}
impl Request {
    pub fn validate(&self) -> Result<(), Error> {
        if !valid_id(&self.mission_id)
            || !valid_id(&self.successor_id)
            || !matches!(
                self.action.as_str(),
                "read" | "finish" | "check" | "history"
            )
            || (self.action == "finish" && self.digest.len() != 64)
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

fn validate(t: &Transport, request: &Request, p: &Value) -> Result<(), Error> {
    if p["version"] != 1
        || p["oldMissionId"] != request.mission_id
        || p["newMissionId"] != request.successor_id
        || !p["publication"].is_object()
        || p["transferLinear"] != false
        || !p["newBrief"]["markdown"].is_string()
        || !p["publication"]["digest"].is_string()
        || p["projectId"].as_str().is_none_or(|id| !valid_id(id))
        || t.source
            .project
            .as_ref()
            .is_some_and(|s| p["projectId"] != s.project_id)
        || p["oldSource"].as_str().is_none_or(|v| v.len() != 64)
        || p["newSource"].as_str().is_none_or(|v| v.len() != 64)
    {
        return Err(Error::Identity);
    }
    Ok(())
}

fn view(p: &Value, state: &str, digest: &str, message: &str) -> Value {
    let tasks = |key: &str| {
        p[key].as_array().into_iter().flatten().map(|t|
        json!({"id":t["id"],"number":t["number"],"title":t["title"],"status":t["status"]})).collect::<Vec<_>>()
    };
    json!({"digest":digest,"state":state,"message":message,
        "oldTitle":p["oldMission"]["title"],"newTitle":p["newMission"]["title"],
        "oldGoal":p["oldMission"]["goal"],"newGoal":p["newMission"]["goal"],
        "publicationId":p["publication"]["digest"],"briefRevision":p["newBrief"]["revision"],
        "agreement":p["publication"]["markdown"],"oldAgreement":p["oldBrief"]["markdown"],
        "oldTasks":tasks("oldTasks"),"newTasks":tasks("newTasks"),
        "keptChats":p["keptChats"].as_array().cloned().unwrap_or_default(),
        "members":p["members"].as_array().map_or(0, Vec::len),
        "linkedTickets":p["managedLinear"].as_array().map_or(0, Vec::len)})
}

pub(super) async fn handle(
    t: &Transport,
    journal: &mut Journal,
    shared: &Shared,
    epoch: u64,
    r: &Request,
    gate: &std::sync::Mutex<crate::bridge::Gate>,
) -> Result<Value, Error> {
    r.validate()?;
    shared.open()?;
    let admitted = || {
        let g = gate.lock().expect("bridge gate poisoned");
        if g.closed || g.sealed || g.flushing {
            Err(Error::Closed)
        } else {
            shared.open()
        }
    };
    admitted()?;
    if r.action == "history" {
        shared.current(epoch)?;
        t.gate(false).await?;
        let overview = t.overview().await?;
        if !overview.dashboard.missions.items.iter().any(|m| {
            m.id == r.successor_id
                && m.replaces
                    .as_ref()
                    .is_some_and(|l| l.mission_id == r.mission_id && l.state == "finished")
        }) {
            return Err(Error::Identity);
        }
        let old = t.get(&format!("/api/missions/{}", r.mission_id)).await?;
        if old["mission"]["id"] != r.mission_id
            || old["mission"]["status"] != "archived"
            || old["mission"]["projectId"] != t.source.project()?.project_id
        {
            return Err(Error::Identity);
        }
        t.gate(false).await?;
        shared.current(epoch)?;
        admitted()?;
        let records = |key: &str, fields: &[&str]| {
            old[key]
                .as_array()
                .into_iter()
                .flatten()
                .map(|record| {
                    let mut display = serde_json::Map::new();
                    for field in fields {
                        display.insert((*field).into(), record[*field].clone());
                    }
                    Value::Object(display)
                })
                .collect::<Vec<_>>()
        };
        return Ok(
            json!({"state":"history","digest":"","message":"Archived mission history. Reading starts and changes nothing.",
            "oldTitle":old["mission"]["title"],"newTitle":Value::Null,"oldGoal":old["mission"]["goal"],
            "oldAgreement":old["brief"]["markdown"],"oldTasks":records("tasks", &["id","number","title","status","body","sessionId"]),
            "decisions":records("decisions", &["id","number","text","replacement","withdrawn"]),
            "events":records("events", &["id","text"]),"resources":records("resources", &["id","title","url"]),"members":0,"linkedTickets":0}),
        );
    }
    let previous = journal
        .planning
        .values()
        .find(|record| {
            planning::in_scope(&record.source, &t.source)
                && record.mission() == r.mission_id
                && record.operation["kind"] == "mission-replan-finish"
                && !record.not_sent
                && (record.pending()
                    || record
                        .receipt
                        .as_ref()
                        .is_some_and(|p| p["state"] == "accepted"))
        })
        .cloned();
    if let Some(mut record) = previous {
        let payload: Value =
            serde_json::from_str(record.operation["payload"].as_str().ok_or(Error::Storage)?)
                .map_err(|_| Error::Storage)?;
        if payload["newMissionId"] != r.successor_id {
            return Err(Error::Unknown);
        }
        // Only Check enters receipt lookup. Finish and Read never resend or auto-lookup.
        if r.action == "check" && record.pending() {
            t.gate(false).await?;
            shared.open()?;
            if let Ok(receipt) = t.planning_operation(&record.operation, true).await {
                record.receipt = Some(receipt);
                journal.save_planning(record.clone())?;
                super::publish_planning(shared, &record);
            }
        }
        let status = super::planning_status(&record);
        let state = match status {
            crate::model::OutcomeStatus::Accepted => "finished",
            crate::model::OutcomeStatus::Rejected => "rejected",
            _ => "unknown",
        };
        return Ok(view(
            &Value::Null,
            state,
            "",
            if state == "finished" {
                "Migration finished. History and chats are kept. No work started."
            } else {
                "Migration is not confirmed. Check status; do not finish again."
            },
        ));
    }
    if r.action == "check" {
        return Err(Error::Unknown);
    }
    shared.current(epoch)?;
    t.gate(false).await?;
    let p = t
        .get(&format!("/api/missions/{}/successor/preview", r.mission_id))
        .await?;
    validate(t, r, &p)?;
    shared.current(epoch)?;
    let digest = planning::hash(&serde_json::to_string(&p).map_err(|_| Error::Invalid)?);
    if r.action == "read" {
        return Ok(view(
            &p,
            "preview",
            &digest,
            "Review the published replacement. Nothing changed.",
        ));
    }
    if r.digest != digest {
        return Err(Error::Stale);
    }
    admitted()?;
    // Preview is not proof that old agents have paused. The daemon checks exact
    // acknowledged safe Pause and both sources in the finish transaction.
    let payload = json!({"purpose":"mission-replan-finish","newMissionId":r.successor_id,
        "projectId":p["projectId"],"oldSource":p["oldSource"],"newSource":p["newSource"],"transferLinear":false});
    let mut record = planning::record(
        &t.source,
        r.mission_id.clone(),
        p["oldSource"].as_str().ok_or(Error::Invalid)?.into(),
        payload,
    )?;
    journal.save_planning(record.clone())?;
    super::publish_planning(shared, &record);
    // Recheck the shown sources after local journal I/O, before entering HTTP.
    let check = t
        .get(&format!("/api/missions/{}/successor/preview", r.mission_id))
        .await;
    if admitted().is_err()
        || shared.current(epoch).is_err()
        || !check.as_ref().is_ok_and(|v| v == &p)
    {
        record.not_sent = true;
        journal.save_planning(record.clone())?;
        super::publish_planning(shared, &record);
        return Err(Error::Stale);
    }
    let result = t.planning_operation(&record.operation, false).await;
    if let Ok(receipt) = result {
        record.receipt = Some(receipt);
        if journal.save_planning(record.clone()).is_err() {
            journal.poison();
            super::publish_planning(shared, &record);
            return Ok(view(
                &p,
                "unknown",
                &digest,
                "Receipt saving failed. Check status; do not finish again.",
            ));
        }
        super::publish_planning(shared, &record);
    }
    let status = super::planning_status(&record);
    let state = match status {
        crate::model::OutcomeStatus::Accepted => "finished",
        crate::model::OutcomeStatus::Rejected => "rejected",
        _ => "unknown",
    };
    Ok(view(
        &p,
        state,
        &digest,
        match state {
            "finished" => "Migration finished. History and chats are kept. No work started.",
            "rejected" => "Migration refused. Safely pause old work, then review a fresh preview.",
            _ => "Migration is not confirmed. Check status; do not finish again.",
        },
    ))
}
