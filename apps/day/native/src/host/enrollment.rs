//! Creation-only planning selection. The VM names only a shown setup and goal.
use super::{Error, Source, planning};
use crate::plan::{NewIntent, Setup};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Mirrors daemon PlanningEnrollment; never exported or accepted from TSX.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct PlanningEnrollment {
    purpose: Purpose,
    project_id: String,
    owner_session_id: String,
    title: String,
    goal: String,
    model: String,
    profile: Value,
    configuration_digest: String,
}
#[derive(Debug, Serialize, Deserialize)]
enum Purpose {
    #[serde(rename = "planning-enroll")]
    Enroll,
}

pub(super) fn validate_record(
    source: &Source,
    operation: &Value,
    setup: Option<&str>,
) -> Result<(), Error> {
    let r: PlanningEnrollment =
        serde_json::from_str(operation["payload"].as_str().ok_or(Error::Storage)?)
            .map_err(|_| Error::Storage)?;
    if r.project_id != source.project_id
        || operation["bindingId"] != r.configuration_digest
        || operation["bindingGeneration"] != 1
        || setup.is_none_or(|s| !hex(s, 64))
        || uuid::Uuid::parse_str(&r.owner_session_id).is_err()
        || r.title.trim().is_empty()
        || r.title.len() > 200
        || r.goal.trim().is_empty()
        || r.goal.len() > 12000
        || r.model.trim().is_empty()
        || r.model.len() > 256
    {
        return Err(Error::Storage);
    }
    profile(&json!({"version":1,"projectId":r.project_id,"profile":r.profile,"configurationDigest":r.configuration_digest}), &source.project_id)
        .map_err(|_| Error::Storage)
}

pub(super) struct Selection {
    pub epoch: Option<u64>,
    pub prepared: Prepared,
    pub used: bool,
}

#[derive(Debug, Clone)]
pub(super) struct Prepared {
    pub setup: Setup,
    pub profile: Value,
    pub model: String,
    pub enrollment: String,
    pub owner: String,
}

pub(super) fn profile(value: &Value, project: &str) -> Result<(), Error> {
    if value["version"] != 1
        || value["projectId"] != project
        || value["profile"]["version"] != 1
        || value["profile"]["id"] != "native-mission-planning"
        || value["profile"]["source"]
            .as_str()
            .is_none_or(str::is_empty)
        || value["profile"]["commit"]
            .as_str()
            .is_none_or(|s| !hex(s, 40))
        || value["configurationDigest"]
            .as_str()
            .is_none_or(|s| !hex(s, 64))
        || serde_json::to_vec(value).map_or(true, |s| s.len() > 16384)
    {
        return Err(Error::Unavailable);
    }
    Ok(())
}

fn hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|c| c.is_ascii_hexdigit())
}

impl Prepared {
    pub fn new(source: &Source, model: &str, profile: Value) -> Result<Self, Error> {
        self::profile(&profile, &source.project_id)?;
        let enrollment = uuid::Uuid::new_v4().to_string();
        let owner = uuid::Uuid::new_v4().to_string();
        let bytes = serde_json::to_vec(&json!({"source":source,"model":model,"profile":profile,
            "enrollment":enrollment,"owner":owner,"purpose":"planning-enroll"}))
        .map_err(|_| Error::Invalid)?;
        Ok(Self {
            setup: Setup {
                project: "Selected project".into(),
                model: model.into(),
                access: "Planning only".into(),
                digest: format!("{:x}", Sha256::digest(bytes)),
            },
            profile,
            model: model.into(),
            enrollment,
            owner,
        })
    }

    pub fn record(
        &self,
        source: &Source,
        intent: &NewIntent,
    ) -> Result<planning::PlanningRecord, Error> {
        if intent.setup != self.setup.digest {
            return Err(Error::Stale);
        }
        if intent.goal.trim().is_empty()
            || intent.goal.len() > 12000
            || intent.goal.chars().count() > crate::plan_desk::MAX_TEXT
        {
            return Err(Error::Invalid);
        }
        // Keep the user's goal byte-for-byte. Only the display title is shortened.
        let title: String = intent
            .goal
            .trim()
            .chars()
            .scan(0, |bytes, c| {
                *bytes += c.len_utf8();
                (*bytes <= 200).then_some(c)
            })
            .take(80)
            .collect();
        planning::enrollment_record(
            source,
            &self.enrollment,
            &self.setup.digest,
            serde_json::to_value(PlanningEnrollment {
                purpose: Purpose::Enroll,
                project_id: source.project_id.clone(),
                owner_session_id: self.owner.clone(),
                title,
                goal: intent.goal.clone(),
                model: self.model.clone(),
                profile: self.profile["profile"].clone(),
                configuration_digest: self.profile["configurationDigest"]
                    .as_str()
                    .ok_or(Error::Invalid)?
                    .into(),
            })
            .map_err(|_| Error::Invalid)?,
        )
    }
}

pub(super) async fn prepare(
    t: &super::Transport,
    journal: &super::Journal,
    shared: &super::Shared,
    epoch: u64,
) -> Result<crate::model::IntentOutcome, Error> {
    if let Some(s) = shared
        .enrollment
        .lock()
        .expect("native enrollment poisoned")
        .as_mut()
    {
        s.epoch = None;
    }
    if journal
        .planning
        .values()
        .any(|r| r.source == t.source && r.operation["kind"] == "planning-enroll" && r.pending())
    {
        return Err(Error::Unknown);
    }
    shared.current(epoch)?;
    let profile = t.planning_profile().await?;
    shared.current(epoch)?;
    let model = t.planning_model.as_deref().ok_or(Error::Unavailable)?;
    let mut slot = shared
        .enrollment
        .lock()
        .expect("native enrollment poisoned");
    if let Some(s) = slot
        .as_mut()
        .filter(|s| !s.used && s.prepared.profile == profile && s.prepared.model == model)
    {
        s.epoch = Some(epoch);
    } else {
        *slot = Some(Selection {
            epoch: Some(epoch),
            prepared: Prepared::new(&t.source, model, profile)?,
            used: false,
        });
    }
    drop(slot);
    shared.change(|_| ());
    Ok(shared.outcome(
        crate::model::OutcomeStatus::Accepted,
        "Planning setup read. Nothing started.",
    ))
}

async fn qualify(
    t: &super::Transport,
    shared: &super::Shared,
    epoch: u64,
    prepared: &Prepared,
) -> Result<(), Error> {
    if t.planning_profile().await? != prepared.profile {
        return Err(Error::Stale);
    }
    shared.current(epoch)
}

pub(super) async fn send(
    t: &super::Transport,
    journal: &mut super::Journal,
    shared: &super::Shared,
    epoch: u64,
    intent: NewIntent,
) -> Result<crate::model::IntentOutcome, Error> {
    if let Some(record) = journal
        .planning
        .values()
        .find(|r| r.source == t.source && r.setup_digest.as_deref() == Some(&intent.setup))
    {
        let request: Value =
            serde_json::from_str(record.operation["payload"].as_str().ok_or(Error::Storage)?)
                .map_err(|_| Error::Storage)?;
        if request["goal"] != intent.goal || record.not_sent {
            return Err(Error::Stale);
        }
        // A duplicate intent returns only the retained outcome. It never enters POST again.
        return Ok(shared.outcome(
            super::planning_status(record),
            "Saved enrollment outcome. Nothing resent.",
        ));
    }
    // Only the exact historical branch above ignores invalidations. A new
    // enrollment always needs current selection authority before any probe.
    shared.current(epoch)?;
    if journal
        .planning
        .values()
        .any(|r| r.source == t.source && r.operation["kind"] == "planning-enroll" && r.pending())
    {
        return Err(Error::Unknown);
    }
    let prepared = {
        let slot = shared
            .enrollment
            .lock()
            .expect("native enrollment poisoned");
        let selected = slot
            .as_ref()
            .filter(|s| !s.used && s.epoch == Some(epoch))
            .ok_or(Error::Stale)?;
        selected.prepared.clone()
    };
    let mut record = prepared.record(&t.source, &intent)?;
    qualify(t, shared, epoch, &prepared).await?;
    journal.save_planning(record.clone())?;
    if let Some(s) = shared
        .enrollment
        .lock()
        .expect("native enrollment poisoned")
        .as_mut()
    {
        s.used = true;
    }
    super::publish_planning(shared, &record);
    if let Err(e) = qualify(t, shared, epoch, &prepared).await {
        record.not_sent = true;
        journal.save_planning(record.clone())?;
        super::publish_planning(shared, &record);
        return Err(e);
    }
    match t.planning_operation(&record.operation, false).await {
        Ok(receipt) => {
            record.receipt = Some(receipt);
            if journal.save_planning(record.clone()).is_err() {
                journal.poison();
                super::publish_planning(shared, &record);
                return Ok(shared.outcome(
                    crate::model::OutcomeStatus::Unknown,
                    "Receipt saving failed. Check; do not resend.",
                ));
            }
            super::publish_planning(shared, &record);
            let next = shared
                .epoch
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                .wrapping_add(1);
            if let Some(mission) = record
                .receipt
                .as_ref()
                .and_then(|r| r["result"]["missionId"].as_str())
            {
                let _ = super::read_planning(t, shared, next, mission).await;
            }
            Ok(shared.outcome(
                super::planning_status(&record),
                "Planning enrollment acknowledged. No build started.",
            ))
        }
        Err(_) => Ok(shared.outcome(
            crate::model::OutcomeStatus::Unknown,
            "No exact acknowledgement. Check; do not resend.",
        )),
    }
}
