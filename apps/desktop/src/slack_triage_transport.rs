//! Loopback reads and explicit writes for the Inbox Slack board, through existing pilotd routes:
//! GET /api/projects, /api/sources, /api/tracked-items and /api/tracked-items/:id/thread;
//! PATCH /api/tracked-items/:id with Slack overrides only; POST /api/sources/:id/poll without
//! force. Each runs on its own short-lived thread. Writes check the pinned daemon identity first
//! and are never retried: a lost or unconfirmed reply stays Unknown.
use crate::{
    LocalOptions,
    local_model::valid_id,
    slack_triage::{
        Board, Change, Item, PAGE, PROJECT_ITEMS, Project, ProjectBoard, Source, Thread,
    },
};
use serde_json::Value;
use std::{future::Future, time::Duration};

/// One page of 100 tracked items with their metadata stays far below this.
const RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// Runs one request on a dedicated current-thread runtime and delivers its single result.
pub(crate) fn spawn<T, F, Fut>(
    name: &str,
    timeout: Duration,
    work: F,
) -> Result<async_channel::Receiver<T>, &'static str>
where
    T: Send + 'static,
    F: FnOnce(reqwest::Client) -> Fut + Send + 'static,
    Fut: Future<Output = T>,
{
    let (tx, rx) = async_channel::bounded(1);
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return;
            };
            let Ok(client) = reqwest::Client::builder()
                .no_proxy()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(2))
                .timeout(timeout)
                .build()
            else {
                return;
            };
            let result = runtime.block_on(work(client));
            let _ = tx.send_blocking(result);
        })
        .map_err(|_| "Couldn't start the Slack request.")?;
    Ok(rx)
}

/// What pilotd answered: its status and JSON body, or nothing readable.
async fn body(response: reqwest::Response) -> (u16, Option<Value>) {
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|n| n > RESPONSE_BYTES as u64)
    {
        return (status, None);
    }
    let mut response = response;
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if chunk.len() > RESPONSE_BYTES.saturating_sub(bytes.len()) {
                    return (status, None);
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return (status, None),
        }
    }
    (status, serde_json::from_slice(&bytes).ok())
}

/// pilotd's own short reason for a refused request, when it gave one.
fn reason(value: &Option<Value>) -> Option<String> {
    value
        .as_ref()?
        .get("error")?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 300 && !s.chars().any(char::is_control))
        .map(|s| {
            if s.ends_with('.') {
                s.to_owned()
            } else {
                format!("{s}.")
            }
        })
}

const OFFLINE: &str = "Couldn't reach Pilot.";
const UNREADABLE: &str = "Pilot's Slack messages couldn't be read.";

async fn get(
    client: &reqwest::Client,
    options: &LocalOptions,
    path: &str,
) -> Result<Value, &'static str> {
    let response = client
        .get(format!("{}{path}", options.loopback()))
        .send()
        .await
        .map_err(|_| OFFLINE)?;
    match body(response).await {
        (200, Some(value)) => Ok(value),
        (404, _) if path.starts_with("/api/sources") || path.starts_with("/api/tracked-items") => {
            Err("This Pilot doesn't offer Slack triage.")
        }
        (503, _) => Err("Slack triage is unavailable in Pilot right now."),
        _ => Err(UNREADABLE),
    }
}

/// Every Slack message page of one project in one listing, bounded like Swift.
async fn pages(
    client: &reqwest::Client,
    options: &LocalOptions,
    project: &str,
    filter: &str,
) -> Result<(Vec<Item>, u64), &'static str> {
    let mut items = Vec::new();
    let mut total;
    loop {
        let value = get(
            client,
            options,
            &format!(
                "/api/tracked-items?projectId={project}&kind=slack{filter}&limit={PAGE}&offset={}",
                items.len()
            ),
        )
        .await?;
        total = value["total"].as_u64().ok_or(UNREADABLE)?;
        let page = value["items"].as_array().ok_or(UNREADABLE)?;
        for raw in page {
            let item = Item::parse(raw).ok_or(UNREADABLE)?;
            if item.project_id != project {
                return Err(UNREADABLE);
            }
            items.push(item);
        }
        if page.is_empty() || items.len() as u64 >= total.min(PROJECT_ITEMS as u64) {
            break;
        }
    }
    items.truncate(PROJECT_ITEMS);
    Ok((items, total))
}

/// The board for one project, or every Slack-tracking project when `scope` is None.
/// Dismissed messages are read only when shown, plus the ones a close label dismissed.
pub(crate) async fn read(
    client: &reqwest::Client,
    options: &LocalOptions,
    scope: Option<&str>,
    show_dismissed: bool,
) -> Result<Board, &'static str> {
    crate::local_client::gate(client, options).await?;
    let projects = get(client, options, "/api/projects").await?;
    let projects: Vec<Project> = projects
        .as_array()
        .ok_or(UNREADABLE)?
        .iter()
        .map(Project::parse)
        .collect::<Option<_>>()
        .ok_or(UNREADABLE)?;
    let scoped: Vec<Project> = match scope {
        Some(id) => vec![
            projects
                .into_iter()
                .find(|p| p.id == id)
                .ok_or("This project is no longer available.")?,
        ],
        None => projects.into_iter().filter(Project::tracks_slack).collect(),
    };
    let mut board = Board::default();
    for project in scoped {
        if !project.tracks_slack() {
            board.projects.push(ProjectBoard {
                project,
                ..Default::default()
            });
            continue;
        }
        let id = project.id.clone();
        let sources = get(client, options, &format!("/api/sources?projectId={id}")).await?;
        let source = sources
            .as_array()
            .ok_or(UNREADABLE)?
            .iter()
            .filter(|s| s["projectId"] == id.as_str())
            .find_map(Source::parse);
        let (mut items, active_total) = pages(client, options, &id, "").await?;
        let dismissed = if show_dismissed {
            "&dismissed=true"
        } else {
            "&dismissed=true&closedByLabel=true"
        };
        let (closed, _) = pages(client, options, &id, dismissed).await?;
        for item in closed {
            if !items.iter().any(|i| i.id == item.id) {
                items.push(item);
            }
        }
        board.projects.push(ProjectBoard {
            project,
            source,
            items,
            active_total,
        });
    }
    // A reply from another daemon must not be shown as this one's messages.
    crate::local_client::gate(client, options).await?;
    Ok(board)
}

/// The message's thread, parent first, read by pilotd from Slack on demand. Never stored.
pub(crate) async fn thread(
    client: &reqwest::Client,
    options: &LocalOptions,
    id: &str,
) -> Result<Thread, String> {
    const FAILED: &str = "Couldn't load this message.";
    if !valid_id(id) {
        return Err(FAILED.into());
    }
    crate::local_client::gate(client, options)
        .await
        .map_err(str::to_owned)?;
    let response = client
        .get(format!(
            "{}/api/tracked-items/{id}/thread",
            options.loopback()
        ))
        .send()
        .await
        .map_err(|_| OFFLINE.to_owned())?;
    match body(response).await {
        (200, Some(value)) => Thread::parse(&value, id).ok_or_else(|| FAILED.into()),
        // pilotd's plain reasons: sign-in, Slack unreachable, sync first, busy.
        (409 | 503, value) => Err(reason(&value)
            .filter(|r| !r.starts_with("Superseded"))
            .unwrap_or_else(|| FAILED.into())),
        _ => Err(FAILED.into()),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Saved(Box<Item>),
    NotSent(String),
    /// The request may have been applied. It is not resent.
    Unknown(String),
}

/// Saves one triage change. Only a 200 reply carrying the same message with the change counts
/// as saved; pilotd may change a message before failing, so any other reply stays Unknown.
pub(crate) async fn patch(
    client: &reqwest::Client,
    options: &LocalOptions,
    id: &str,
    project: &str,
    change: &Change,
) -> Outcome {
    if !valid_id(id) {
        return Outcome::NotSent("This message can't be changed.".into());
    }
    if let Err(failure) = crate::local_client::gate(client, options).await {
        return Outcome::NotSent(format!("{failure} Nothing was changed."));
    }
    let response = client
        .patch(format!("{}/api/tracked-items/{id}", options.loopback()))
        .header("Content-Type", "application/json")
        .body(change.body().to_string())
        .send()
        .await;
    let Ok(response) = response else {
        return Outcome::Unknown("No reply from Pilot. The change may have applied.".into());
    };
    match body(response).await {
        (200, Some(value)) => match Item::parse(&value) {
            Some(item)
                if item.id == id && item.project_id == project && change.applied(&item.triage) =>
            {
                Outcome::Saved(Box::new(item))
            }
            _ => Outcome::Unknown("Pilot's reply didn't confirm the change.".into()),
        },
        (_, value) => Outcome::Unknown(match reason(&value) {
            Some(reason) => format!("Pilot reported: {reason} The change may not have applied."),
            None => "Pilot didn't confirm the change. It may have applied.".into(),
        }),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PollOutcome {
    Done,
    /// pilotd refused before syncing: the hourly budget, a running sync, busy.
    Refused(String),
    Unknown(String),
}

/// One ordinary sync of a project's Slack source. Never forced past the hourly budget.
pub(crate) async fn poll(
    client: &reqwest::Client,
    options: &LocalOptions,
    project: &str,
) -> PollOutcome {
    if !valid_id(project) {
        return PollOutcome::Refused("This project can't be synced.".into());
    }
    if let Err(failure) = crate::local_client::gate(client, options).await {
        return PollOutcome::Refused(format!("{failure} Nothing was synced."));
    }
    let response = client
        .post(format!(
            "{}/api/sources/{project}:slack/poll",
            options.loopback()
        ))
        .send()
        .await;
    let Ok(response) = response else {
        return PollOutcome::Unknown("No reply from Pilot. The sync may still be running.".into());
    };
    match body(response).await {
        (200, _) => PollOutcome::Done,
        (409 | 503, value) => PollOutcome::Refused(
            reason(&value).unwrap_or_else(|| "Pilot couldn't sync Slack now.".into()),
        ),
        (_, value) => PollOutcome::Unknown(
            reason(&value).unwrap_or_else(|| "Pilot didn't confirm the sync.".into()),
        ),
    }
}

#[cfg(test)]
#[path = "slack_triage_transport_tests.rs"]
mod tests;
