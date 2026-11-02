//! Project hooks on the Local daemon: the passive `GET /api/projects` and `GET /api/chat-settings`,
//! and the explicit `PUT /api/projects/:id/automations` with the revision it was read at.
//! Writes carry the native host-action capability. Nothing is retried; a lost answer stays unknown.
use crate::{
    LocalOptions,
    automation_hooks::{ProjectHooks, parse_projects},
};
use serde_json::{Value, json};

/// 256 projects with up to 32 hooks of 8 KiB commands each, plus other project settings.
const LIST_BYTES: usize = 16 * 1024 * 1024;
/// One project's hooks, or the daemon's error.
const SAVE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Snapshot {
    pub(crate) projects: Vec<ProjectHooks>,
    /// The host's Automations switch. None: this daemon doesn't report it.
    pub(crate) enabled: Option<bool>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Saved {
    /// 200 with exactly the sent list at the next revision.
    Ack(ProjectHooks),
    /// 409: someone else saved first. Carries Local's current list when readable.
    Conflict(Option<ProjectHooks>),
    /// 400: Local refused the list and changed nothing.
    Rejected(String),
    /// Refused before anything changed: switched off, not authorized, unknown project.
    Refused(&'static str),
    /// Sent, but no exact answer: the hooks may or may not have changed.
    Unknown,
}

#[derive(Clone, Debug)]
pub(crate) enum Job {
    Read,
    Save {
        project_id: String,
        expected_revision: u64,
        items: Vec<Value>,
    },
}
#[derive(Clone, Debug)]
pub(crate) enum Reply {
    Read(Result<Snapshot, &'static str>),
    Save(Saved),
}
impl Job {
    /// What a vanished worker means: a read learned nothing, a save is unknown.
    pub(crate) fn lost(&self) -> Reply {
        match self {
            Self::Read => Reply::Read(Err("Local hooks couldn't be read. Refresh to retry.")),
            Self::Save { .. } => Reply::Save(Saved::Unknown),
        }
    }
    fn refused(&self) -> Reply {
        match self {
            Self::Read => self.lost(),
            Self::Save { .. } => Reply::Save(Saved::Refused(
                "Pilot couldn't start the request. Nothing was changed.",
            )),
        }
    }
}

/// Runs one job on its own short-lived thread.
pub(crate) fn start(
    options: LocalOptions,
    job: Job,
) -> Result<async_channel::Receiver<Reply>, Reply> {
    let refused = job.refused();
    let (tx, rx) = async_channel::bounded(1);
    std::thread::Builder::new()
        .name("local-automation-hooks".into())
        .spawn(move || {
            let refused = job.refused();
            let reply = match (
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build(),
                crate::chat_settings::client(),
            ) {
                (Ok(runtime), Ok(client)) => runtime.block_on(run(&client, &options, job)),
                _ => refused,
            };
            let _ = tx.send_blocking(reply);
        })
        .map_err(|_| refused)?;
    Ok(rx)
}

pub(crate) async fn run(client: &reqwest::Client, options: &LocalOptions, job: Job) -> Reply {
    match job {
        Job::Read => Reply::Read(read(client, options).await),
        Job::Save {
            project_id,
            expected_revision,
            items,
        } => Reply::Save(save(client, options, &project_id, expected_revision, items).await),
    }
}

async fn body(response: &mut reqwest::Response, cap: usize) -> Option<Vec<u8>> {
    if response.content_length().is_some_and(|n| n > cap as u64) {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if chunk.len() > cap.saturating_sub(bytes.len()) {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    Some(bytes)
}

pub(crate) async fn read(
    client: &reqwest::Client,
    options: &LocalOptions,
) -> Result<Snapshot, &'static str> {
    crate::local_client::hello(client, options).await?;
    let mut response = client
        .get(format!("{}/api/projects", options.loopback()))
        .send()
        .await
        .map_err(|_| "Local is offline or its hooks couldn't be read. Refresh to retry.")?;
    if response.status().as_u16() != 200 {
        return Err("Local refused the project read. Refresh to retry.");
    }
    let bytes = body(&mut response, LIST_BYTES)
        .await
        .ok_or("Local's project list was interrupted or too large.")?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Local's project list is unreadable.")?;
    let projects = parse_projects(&value)?;
    // The switch decides whether hooks run and can be edited; unknown is not "off".
    let enabled = crate::chat_settings::read(client, options)
        .await
        .ok()
        .and_then(|s| s.automations);
    crate::local_client::hello(client, options).await?;
    Ok(Snapshot { projects, enabled })
}

fn url(options: &LocalOptions, project_id: &str) -> String {
    let mut url = reqwest::Url::parse(&options.loopback()).expect("loopback URL");
    url.path_segments_mut().expect("HTTP URL").extend([
        "api",
        "projects",
        project_id,
        "automations",
    ]);
    url.into()
}

pub(crate) async fn save(
    client: &reqwest::Client,
    options: &LocalOptions,
    project_id: &str,
    expected_revision: u64,
    items: Vec<Value>,
) -> Saved {
    const UNAUTHORIZED: &str =
        "Pilot couldn't authorize this change on Local. Nothing was changed.";
    if !crate::local_model::valid_id(project_id) {
        return Saved::Refused("Pilot can't address this project. Nothing was changed.");
    }
    if crate::local_client::hello(client, options).await.is_err() {
        return Saved::Refused("Local is unavailable or changed identity. Nothing was changed.");
    }
    let Ok(capability) = options.model_scope_capability() else {
        return Saved::Refused(UNAUTHORIZED);
    };
    let Ok(mut header) = reqwest::header::HeaderValue::from_str(&capability) else {
        return Saved::Refused(UNAUTHORIZED);
    };
    header.set_sensitive(true);
    let request = json!({"expectedRevision": expected_revision, "items": items});
    let mut response = match client
        .put(url(options, project_id))
        .header("Content-Type", "application/json")
        .header("x-pilot-github-capability", header)
        .body(request.to_string())
        .send()
        .await
    {
        Ok(response) => response,
        // A refused connection never delivered the body. Anything later might have.
        Err(error) if error.is_connect() => {
            return Saved::Refused("Local is offline. Nothing was changed.");
        }
        Err(_) => return Saved::Unknown,
    };
    let status = response.status().as_u16();
    let reply = body(&mut response, SAVE_BYTES)
        .await
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    match status {
        200 => match reply.and_then(|v| ProjectHooks::read(project_id, &v)) {
            Some(saved)
                if saved.revision == expected_revision + 1
                    && saved.error.is_none()
                    && saved.raw_items() == items =>
            {
                Saved::Ack(saved)
            }
            _ => Saved::Unknown,
        },
        409 => Saved::Conflict(reply.and_then(|v| ProjectHooks::read(project_id, &v["current"]))),
        400 => Saved::Rejected(
            reply
                .as_ref()
                .and_then(|v| v["error"].as_str())
                .map(|e| {
                    e.lines()
                        .next()
                        .unwrap_or("")
                        .chars()
                        .take(300)
                        .collect::<String>()
                })
                .filter(|e| !e.trim().is_empty())
                .unwrap_or_else(|| "Local refused these hooks. Nothing was changed.".into()),
        ),
        403 => Saved::Refused(UNAUTHORIZED),
        404 if reply
            .as_ref()
            .is_some_and(|v| v["error"] == "automations_unavailable") =>
        {
            Saved::Refused("Automations are off on this host. Nothing was changed.")
        }
        404 => Saved::Refused("Local no longer has this project. Nothing was changed."),
        503 => Saved::Refused("Local can't change hooks right now. Nothing was changed."),
        _ => Saved::Unknown,
    }
}
