//! User-only Linear publishing. The daemon owns durable entry and lookup.
use super::{Error, Shared, Transport, bridge::Call, transport::body, valid_id};
use crate::bridge::{Command, Gate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Request {
    mission_id: String,
    intent: Intent,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Intent {
    Read,
    Check,
    Setting {
        enabled: bool,
        revision: u64,
    },
    Preview {
        parent_url: String,
        task_ids: Vec<String>,
    },
    Publish {
        parent_url: String,
        task_ids: Vec<String>,
        pin: String,
    },
    Reconcile {
        parent_url: String,
        task_ids: Vec<String>,
        pin: String,
    },
}

impl Request {
    pub(crate) fn validate(&self, method: &str) -> Result<(), Error> {
        if !valid_id(&self.mission_id) {
            return Err(Error::Invalid);
        }
        let (suffix, selection, pin) = match &self.intent {
            Intent::Read => ("read", None, None),
            Intent::Check => ("check", None, None),
            Intent::Setting { .. } => ("setting", None, None),
            Intent::Preview {
                parent_url,
                task_ids,
            } => ("preview", Some((parent_url, task_ids)), None),
            Intent::Publish {
                parent_url,
                task_ids,
                pin,
            } => ("publish", Some((parent_url, task_ids)), Some(pin)),
            Intent::Reconcile {
                parent_url,
                task_ids,
                pin,
            } => ("reconcile", Some((parent_url, task_ids)), Some(pin)),
        };
        if method.strip_prefix("day.linearPublisher.") != Some(suffix)
            || selection.is_some_and(|(url, ids)| {
                !url.starts_with("https://linear.app/")
                    || url.len() > 2000
                    || ids.is_empty()
                    || ids.len() > 8
                    || ids.iter().any(|id| !valid_id(id))
            })
            || pin.is_some_and(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }

    fn writes(&self) -> bool {
        matches!(
            self.intent,
            Intent::Setting { .. } | Intent::Publish { .. } | Intent::Reconcile { .. }
        )
    }
}

async fn send(
    root: &Transport,
    shared: &Shared,
    gate: &Mutex<Gate>,
    command: &Command,
    request: &Request,
) -> Result<Value, Error> {
    let scoped = root.mission_planning_transport(&request.mission_id).await?;
    let t = scoped.as_ref().unwrap_or(root);
    let project = &t.source.project()?.project_id;
    t.gate(false).await?;
    shared.open()?;
    command.admit(&gate.lock().expect("bridge gate poisoned"))?;
    let path = format!(
        "/api/projects/{project}/missions/{}/linear-publisher",
        request.mission_id
    );
    let response = t
        .client
        .post(t.url(&path))
        .header("x-pilot-github-capability", t.local()?)
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&request.intent).map_err(|_| Error::Invalid)?)
        .timeout(Duration::from_secs(100))
        .send()
        .await;
    let result = async {
        let value = body(response.map_err(|_| Error::Offline)?).await?;
        t.local()?;
        if value["projectId"] != *project || value["missionId"] != request.mission_id {
            return Err(Error::Identity);
        }
        Ok(json!({"snapshot":value,"outcome":null}))
    }
    .await;
    if request.writes() {
        result.map_err(|_| Error::Unknown)
    } else {
        result
    }
}

pub(super) async fn handle(root: Transport, shared: Arc<Shared>, call: Call) {
    let Call {
        command,
        gate,
        reply,
        ..
    } = call;
    let result = match &command {
        Command::LinearPublisher(request) => send(&root, &shared, &gate, &command, request).await,
        _ => Err(Error::Invalid),
    };
    reply(result);
}
