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
    /// The old mission this plan re-plans. The daemon links both missions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    replaces: Option<String>,
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
    if !super::valid_id(&r.project_id)
        || source
            .project
            .as_ref()
            .is_some_and(|p| r.project_id != p.project_id)
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
        || r.replaces.as_deref().is_some_and(|id| !super::valid_id(id))
    {
        return Err(Error::Storage);
    }
    profile(&json!({"version":1,"projectId":r.project_id,"profile":r.profile,"configurationDigest":r.configuration_digest}), &r.project_id)
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
    pub choice: Option<crate::new_chat::ChatChoice>,
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
        self::profile(&profile, &source.project()?.project_id)?;
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
            choice: None,
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
            || intent
                .replaces
                .as_deref()
                .is_some_and(|id| !super::valid_id(id))
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
                project_id: self.profile["projectId"]
                    .as_str()
                    .ok_or(Error::Invalid)?
                    .into(),
                owner_session_id: self.owner.clone(),
                title,
                goal: intent.goal.clone(),
                model: self.model.clone(),
                profile: self.profile["profile"].clone(),
                configuration_digest: self.profile["configurationDigest"]
                    .as_str()
                    .ok_or(Error::Invalid)?
                    .into(),
                replaces: intent.replaces.clone(),
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
    if journal.planning.values().any(|r| {
        planning::in_scope(&r.source, &t.source)
            && r.operation["kind"] == "planning-enroll"
            && r.pending()
    }) {
        return Err(Error::Unknown);
    }
    shared.current(epoch)?;
    let choice = shared
        .chat_choice
        .lock()
        .expect("native chat choice poisoned")
        .clone();
    let selected = if let Some(choice) = &choice {
        Some(choice_transport(t, choice).await?)
    } else {
        None
    };
    let transport = selected.as_ref().unwrap_or(t);
    let profile = transport.planning_profile().await?;
    shared.current(epoch)?;
    let model = transport
        .planning_model
        .as_deref()
        .ok_or(Error::Unavailable)?;
    let mut slot = shared
        .enrollment
        .lock()
        .expect("native enrollment poisoned");
    if let Some(s) = slot.as_mut().filter(|s| {
        !s.used
            && s.prepared.profile == profile
            && s.prepared.model == model
            && s.prepared.choice == choice
    }) {
        s.epoch = Some(epoch);
    } else {
        let mut prepared = Prepared::new(&transport.source, model, profile)?;
        prepared.setup.project = choice
            .as_ref()
            .map_or_else(|| "Selected project".into(), |c| c.project_path.clone());
        prepared.choice = choice;
        *slot = Some(Selection {
            epoch: Some(epoch),
            prepared,
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
    let selected = if let Some(choice) = &prepared.choice {
        if shared
            .chat_choice
            .lock()
            .expect("native chat choice poisoned")
            .as_ref()
            != Some(choice)
        {
            return Err(Error::Stale);
        }
        Some(choice_transport(t, choice).await?)
    } else {
        None
    };
    if selected.as_ref().unwrap_or(t).planning_profile().await? != prepared.profile {
        return Err(Error::Stale);
    }
    shared.current(epoch)
}

/// Reuse the project's configured task-model policy. A saved choice alone is not authority.
async fn choice_transport(
    t: &super::Transport,
    choice: &crate::new_chat::ChatChoice,
) -> Result<super::Transport, Error> {
    if !choice.validate()
        || t.source
            .project
            .as_ref()
            .is_some_and(|p| p.project_id != choice.project_id)
    {
        return Err(Error::Unavailable);
    }
    let catalog = super::new_chat::inventory(t).await?;
    let project = catalog["projects"]
        .as_array()
        .ok_or(Error::Invalid)?
        .iter()
        .find(|p| {
            p["projectId"] == choice.project_id
                && p["projectPath"] == choice.project_path
                && p["contextDigest"] == choice.context_digest
        })
        .ok_or(Error::Stale)?;
    let current = super::new_chat::profile(
        t,
        &super::new_chat::Select {
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
    if current != expected {
        return Err(Error::Stale);
    }
    let mut selected = t.for_project(project)?;
    selected.planning_model = Some(choice.model.clone());
    Ok(selected)
}

pub(super) async fn send(
    t: &super::Transport,
    journal: &mut super::Journal,
    shared: &super::Shared,
    epoch: u64,
    intent: NewIntent,
) -> Result<crate::model::IntentOutcome, Error> {
    if let Some(record) = journal.planning.values().find(|r| {
        planning::in_scope(&r.source, &t.source) && r.setup_digest.as_deref() == Some(&intent.setup)
    }) {
        let request: Value =
            serde_json::from_str(record.operation["payload"].as_str().ok_or(Error::Storage)?)
                .map_err(|_| Error::Storage)?;
        if request["goal"] != intent.goal
            || request["replaces"].as_str() != intent.replaces.as_deref()
            || record.not_sent
        {
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
    if journal.planning.values().any(|r| {
        planning::in_scope(&r.source, &t.source)
            && r.operation["kind"] == "planning-enroll"
            && r.pending()
    }) {
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
    if let Err(error) = qualify(t, shared, epoch, &prepared).await {
        if let Some(selection) = shared
            .enrollment
            .lock()
            .expect("native enrollment poisoned")
            .as_mut()
        {
            selection.epoch = None;
        }
        shared.change(|_| ());
        return Err(error);
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_replan_enrollment_names_the_old_mission_only_when_asked() {
        let source = Source {
            profile: std::env::temp_dir(),
            port: 1,
            home: crate::contract::Home {
                daemon_id: "daemon".into(),
                lineage_id: "lineage".into(),
            },
            project: Some(super::super::Project {
                project_id: "project".into(),
                project_path: "/project".into(),
            }),
        };
        let profile = json!({"version":1,"projectId":"project","configurationDigest":"b".repeat(64),
            "profile":{"version":1,"id":"native-mission-planning","source":"skills","commit":"a".repeat(40)}});
        let prepared = Prepared::new(&source, "faux/faux-1", profile).unwrap();
        let intent = |replaces: Option<&str>| NewIntent {
            goal: "Re-plan the docs".into(),
            setup: prepared.setup.digest.clone(),
            replaces: replaces.map(Into::into),
        };
        let payload = |r: &planning::PlanningRecord| -> Value {
            serde_json::from_str(r.operation["payload"].as_str().unwrap()).unwrap()
        };
        let plain = prepared.record(&source, &intent(None)).unwrap();
        assert!(payload(&plain).get("replaces").is_none());
        let replan = prepared
            .record(&source, &intent(Some("old-mission")))
            .unwrap();
        assert_eq!(payload(&replan)["replaces"], "old-mission");
        assert!(validate_record(&source, &replan.operation, Some(&prepared.setup.digest)).is_ok());
        assert_eq!(
            prepared.record(&source, &intent(Some("../old"))).err(),
            Some(Error::Invalid)
        );
    }
}
