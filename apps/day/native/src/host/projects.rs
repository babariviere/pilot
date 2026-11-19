//! Profile-wide local project setup. One journaled send; recovery only looks up receipts.
use super::{Error, Journal, Shared, Transport, planning};
use crate::bridge::{Command, Gate};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) const KIND: &str = "native-project-action";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Intent {
    action: String,
    path: Option<String>,
    digest: Option<String>,
    url: Option<String>,
    destination: Option<String>,
    import_id: Option<String>,
    account: Option<String>,
    fingerprint: Option<String>,
    /// Link and unlink: the project whose agents read, and the project they read.
    project: Option<String>,
    linked: Option<String>,
    /// Allow-profile and stop-profile: the work profile the user allows or stops in `project`.
    profile: Option<String>,
}
impl Intent {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        let choice = matches!(self.action.as_str(), "allow-profile" | "stop-profile");
        if (matches!(self.action.as_str(), "link" | "unlink")
            && (self.project.is_none() || self.linked.is_none()))
            || (choice && (self.project.is_none() || self.profile.is_none()))
            || (!choice && self.profile.is_some())
            || (self.action == "cyber-not-now" && self.project.is_none())
        {
            return Err(Error::Invalid);
        }
        if !matches!(
            self.action.as_str(),
            "add"
                | "import"
                | "resume"
                | "confirm_existing"
                | "cancel_import"
                | "verify_existing"
                | "verify"
                | "authorize"
                | "prepare_key"
                | "approve_key"
                | "cancel"
                | "link"
                | "unlink"
                | "allow-profile"
                | "stop-profile"
                | "cyber-not-now"
        ) || [
            &self.path,
            &self.digest,
            &self.url,
            &self.destination,
            &self.import_id,
            &self.account,
            &self.fingerprint,
            &self.project,
            &self.linked,
            &self.profile,
        ]
        .iter()
        .any(|s| {
            s.as_ref()
                .is_some_and(|s| s.is_empty() || s.len() > 4096 || s.contains('\0'))
        }) {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    fn payload(&self) -> Value {
        let mut p = json!({"purpose":KIND,"action":self.action});
        for (name, value) in [
            ("path", &self.path),
            ("digest", &self.digest),
            ("url", &self.url),
            ("destination", &self.destination),
            ("importId", &self.import_id),
            ("account", &self.account),
            ("fingerprint", &self.fingerprint),
            ("project", &self.project),
            ("linked", &self.linked),
            ("profile", &self.profile),
        ] {
            if let Some(value) = value {
                p[name] = json!(value);
            }
        }
        p
    }
}

pub(super) fn validate_record(op: &Value) -> Result<(), Error> {
    let mut p: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Storage)?)
        .map_err(|_| Error::Storage)?;
    if p.as_object_mut().ok_or(Error::Storage)?.remove("purpose") != Some(json!(KIND))
        || op["targetId"] != "projects"
        || op["bindingGeneration"] != 1
    {
        return Err(Error::Storage);
    }
    let i: Intent = serde_json::from_value(p).map_err(|_| Error::Storage)?;
    i.validate().map_err(|_| Error::Storage)
}

fn same_home(a: &super::Source, b: &super::Source) -> bool {
    a.profile == b.profile && a.home == b.home
}
fn operations(t: &Transport, journal: &Journal) -> Vec<Value> {
    journal
        .planning
        .values()
        .filter(|r| same_home(&r.source, &t.source) && r.operation["kind"] == KIND)
        .map(|r| r.summary())
        .collect()
}
async fn read(t: &Transport) -> Result<Value, Error> {
    t.profile_gate().await?;
    let v = t.get("/api/native-projects/setup").await?;
    if v["version"] != 1
        || !v["projects"].is_array()
        || !v["imports"].is_array()
        || !v["github"].is_object()
    {
        return Err(Error::Invalid);
    }
    t.profile_gate().await?;
    Ok(v)
}
pub(super) async fn handle(
    t: &Transport,
    journal: &mut Journal,
    shared: &Shared,
    command: &Command,
    gate: &Arc<Mutex<Gate>>,
) -> Result<Value, Error> {
    let check = || {
        shared.open()?;
        command.admit(&gate.lock().expect("bridge gate poisoned"))
    };
    check()?;
    t.profile_gate().await?;
    let mut outcome = Value::Null;
    match command {
        Command::ProjectSetupRead => {}
        Command::ProjectPreview {
            path,
            url,
            destination,
        } => {
            let (endpoint, body) = if let Some(path) = path {
                ("/api/native-projects/preview", json!({"path":path}))
            } else {
                (
                    "/api/github-import/preview",
                    json!({"url":url,"destination":destination}),
                )
            };
            let v = t.project_preview(endpoint, body).await?;
            check()?;
            return Ok(json!({"snapshot":v,"outcome":null}));
        }
        Command::ProjectAction(intent) => {
            intent.validate()?;
            // One uncertain action for this profile blocks new effects, including across project focus changes.
            if !matches!(intent.action.as_str(), "cancel" | "cancel_import")
                && journal.planning.values().any(|r| {
                    same_home(&r.source, &t.source) && r.operation["kind"] == KIND && r.pending()
                })
            {
                return Err(Error::Unknown);
            }
            let request = intent.payload();
            let mut record = planning::record(
                &t.source,
                "projects".into(),
                planning::hash(&request.to_string()),
                request,
            )?;
            check()?;
            journal.save_planning(record.clone())?;
            if let Err(e) = t.local().and_then(|_| check()) {
                record.not_sent = true;
                journal.save_planning(record)?;
                return Err(e);
            }
            if let Ok(receipt) = t.planning_operation(&record.operation, false).await {
                record.receipt = Some(receipt);
                journal.save_planning(record.clone())?;
            }
            outcome = record.summary();
        }
        Command::ProjectCheck(id) => {
            let mut r = journal
                .planning
                .get(id)
                .filter(|r| same_home(&r.source, &t.source) && r.operation["kind"] == KIND)
                .cloned()
                .ok_or(Error::Unknown)?;
            if r.pending()
                && let Ok(receipt) = t.planning_operation(&r.operation, true).await
            {
                r.receipt = Some(receipt);
                journal.save_planning(r.clone())?;
            }
            outcome = r.summary();
        }
        _ => return Err(Error::Invalid),
    }
    let snapshot = read(t).await;
    if matches!(command, Command::ProjectSetupRead) {
        check()?;
        return Ok(
            json!({"snapshot":snapshot?,"operations":operations(t,journal),"outcome":outcome}),
        );
    }
    Ok(
        json!({"snapshot":snapshot.ok().filter(|_| check().is_ok()),"operations":operations(t,journal),"outcome":outcome}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_accepts_only_exact_actions_without_transport_or_credential_fields() {
        let valid = json!({"action":"add","path":"/source","digest":"a".repeat(64)});
        let intent: Intent = serde_json::from_value(valid.clone()).unwrap();
        assert_eq!(intent.validate(), Ok(()));
        for key in [
            "projectId",
            "operationId",
            "token",
            "host",
            "port",
            "command",
        ] {
            let mut forged = valid.clone();
            forged[key] = json!("forged");
            assert!(serde_json::from_value::<Intent>(forged).is_err(), "{key}");
        }
        let invalid: Intent = serde_json::from_value(json!({"action":"revoke_key"})).unwrap();
        assert_eq!(invalid.validate(), Err(Error::Invalid));
        let link: Intent =
            serde_json::from_value(json!({"action":"link","project":"app","linked":"lib"}))
                .unwrap();
        assert_eq!(link.validate(), Ok(()));
        assert_eq!(link.payload()["linked"], "lib");
        let partial: Intent =
            serde_json::from_value(json!({"action":"unlink","project":"app"})).unwrap();
        assert_eq!(partial.validate(), Err(Error::Invalid));
        let intent = |v: Value| serde_json::from_value::<Intent>(v).unwrap();
        let allow = intent(json!({"action":"allow-profile","project":"app","profile":"cyber"}));
        assert_eq!(allow.validate(), Ok(()));
        assert_eq!(allow.payload()["profile"], "cyber");
        let stop = intent(json!({"action":"stop-profile","project":"app","profile":"ui"}));
        assert_eq!(stop.validate(), Ok(()));
        let unnamed = intent(json!({"action":"allow-profile","project":"app"}));
        assert_eq!(unnamed.validate(), Err(Error::Invalid));
        let not_now = intent(json!({"action":"cyber-not-now","project":"app"}));
        assert_eq!(not_now.validate(), Ok(()));
        let nowhere = intent(json!({"action":"cyber-not-now"}));
        assert_eq!(nowhere.validate(), Err(Error::Invalid));
        let stray: Intent = serde_json::from_value(
            json!({"action":"link","project":"app","linked":"lib","profile":"cyber"}),
        )
        .unwrap();
        assert_eq!(stray.validate(), Err(Error::Invalid));
    }

    #[test]
    fn a_pending_setup_record_survives_reopen_and_stays_profile_wide() {
        let path = std::env::temp_dir().join(format!("project-ledger-{}", uuid::Uuid::new_v4()));
        let source = super::super::Source {
            profile: "/profile".into(),
            port: 1,
            home: crate::contract::Home {
                daemon_id: "d".into(),
                lineage_id: "l".into(),
            },
            project: None,
        };
        let request = json!({"purpose":KIND,"action":"verify_existing"});
        let record = planning::record(
            &source,
            "projects".into(),
            planning::hash(&request.to_string()),
            request,
        )
        .unwrap();
        let mut journal = Journal::open(path.clone()).unwrap();
        journal.save_planning(record.clone()).unwrap();
        drop(journal);
        let reopened = Journal::open(path.clone()).unwrap();
        let saved = reopened.planning.get(record.id()).unwrap();
        assert!(saved.pending());
        assert_eq!(saved.operation, record.operation);
        let mut focused = source.clone();
        focused.project = Some(super::super::Project {
            project_id: "other".into(),
            project_path: "/other".into(),
        });
        assert!(same_home(&saved.source, &focused));
        focused.home.lineage_id = "different".into();
        assert!(!same_home(&saved.source, &focused));
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }
}
