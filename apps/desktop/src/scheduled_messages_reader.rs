//! Fixed passive schedule GET, plus explicit writes: Cancel/Dismiss/Delete (DELETE), revision-checked
//! rule edits (PATCH) and creation (POST), each fenced to the checked Local home. Never retried.
use crate::close_on_drop::CloseOnDrop;
use crate::{
    LocalOptions,
    scheduled_messages::{Item, RowAction, Snapshot},
};
use std::time::Duration;
// Existing store: 4 MiB target payloads, 1000 rows, plus metadata/JSON escaping.
// No text truncation or partial roster adoption on overflow.
const WIRE_CAP: usize = 8 * 1024 * 1024;
pub(crate) async fn fetch(
    client: &reqwest::Client,
    options: &LocalOptions,
) -> Result<Snapshot, &'static str> {
    crate::local_client::hello(client, options).await?;
    let mut response = client
        .get(format!("{}/api/schedules", options.loopback()))
        .send()
        .await
        .map_err(|_| "Local scheduled items is offline or could not be read. Refresh to retry.")?;
    match response.status().as_u16() {
        200 => {}
        404 => return Err("scheduled items is unavailable on this Local daemon."),
        503 => return Err("Local scheduled items is unavailable. Refresh to retry."),
        _ => return Err("Local refused the scheduled items read. No fallback was attempted."),
    }
    if response
        .content_length()
        .is_some_and(|n| n > WIRE_CAP as u64)
    {
        return Err("Local scheduled items exceeded its read response budget.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local scheduled items response was interrupted.")?
    {
        if chunk.len() > WIRE_CAP.saturating_sub(bytes.len()) {
            return Err("Local scheduled items exceeded its read response budget.");
        }
        bytes.extend_from_slice(&chunk);
    }
    crate::local_client::hello(client, options).await?;
    Snapshot::parse(&bytes)
}
#[derive(Clone)]
pub(crate) struct Request {
    pub(crate) generation: u64,
}
pub(crate) struct Response {
    pub(crate) generation: u64,
    pub(crate) result: Result<Snapshot, &'static str>,
}
pub(crate) struct Reader {
    commands: async_channel::Sender<Request>,
    replace: async_channel::Receiver<Request>,
}
impl Reader {
    pub(crate) fn start(
        options: LocalOptions,
    ) -> Result<(Self, async_channel::Receiver<Response>), &'static str> {
        let (commands, events) = async_channel::bounded::<Request>(1);
        let replace = events.clone();
        let (updates, output) = async_channel::bounded(1);
        let stale = output.clone();
        std::thread::Builder::new()
            .name("local-scheduled-items-reader".into())
            .spawn(move || {
                let _close = CloseOnDrop(events.clone());
                let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return; };
                runtime.block_on(async move {
                    let Ok(client) = reqwest::Client::builder()
                        .no_proxy().retry(reqwest::retry::never())
                        .redirect(reqwest::redirect::Policy::none())
                        .connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(5))
                        .build() else { return; };
                    let mut next = None;
                    loop {
                        let request = match next.take() {
                            Some(request) => request,
                            None => match events.recv().await { Ok(request) => request, Err(_) => return },
                        };
                        let result = tokio::select! {
                            biased;
                            request = events.recv() => {
                                match request { Ok(request) => next = Some(request), Err(_) => return }
                                continue;
                            },
                            result = fetch(&client, &options) => result,
                        };
                        let response = Response { generation: request.generation, result };
                        if let Err(async_channel::TrySendError::Full(response)) = updates.try_send(response) {
                            let _ = stale.try_recv();
                            let _ = updates.try_send(response);
                        }
                    }
                });
            }).map_err(|_| "Cannot start the Local scheduled items reader.")?;
        Ok((Self { commands, replace }, output))
    }
    pub(crate) fn request(&self, r: Request) -> bool {
        match self.commands.try_send(r) {
            Ok(()) => true,
            Err(async_channel::TrySendError::Closed(_)) => false,
            Err(async_channel::TrySendError::Full(r)) => {
                let _ = self.replace.try_recv();
                self.commands.try_send(r).is_ok()
            }
        }
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.commands.close();
    }
}

/// Result of one write. Never retried or replayed.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Done,
    /// Local answered before changing anything.
    Refused(String),
    /// Sent, but no valid answer from the same daemon.
    Unconfirmed(String),
}
fn refused(text: &str) -> Outcome {
    Outcome::Refused(text.into())
}
fn unconfirmed() -> Outcome {
    Outcome::Unconfirmed(UNCONFIRMED.into())
}
const UNCONFIRMED: &str = "Pilot couldn’t confirm this change. The list shows what Local reports now; nothing was retried.";
const RECORD_CAP: usize = 64 * 1024;
fn record_url(options: &LocalOptions, id: &str) -> String {
    let mut url = reqwest::Url::parse(&options.loopback()).expect("loopback URL");
    url.path_segments_mut()
        .expect("HTTP URL")
        .extend(["api", "schedules", id]);
    url.into()
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
/// Cancels a pending record or dismisses a failed one through the existing DELETE.
/// The record must still be at the shown revision and state on the same daemon first,
/// and the DELETE carries that revision so a record that changed since is refused.
/// Pause, Resume and Dismiss on a recurring rule go through the revision-checked PATCH.
pub(crate) async fn act(
    client: &reqwest::Client,
    options: &LocalOptions,
    id: &str,
    revision: u64,
    action: RowAction,
) -> Outcome {
    const CHANGED: &str = "This scheduled message changed. Nothing was changed.";
    if !crate::local_model::valid_id(id) {
        return refused("Pilot can’t address this scheduled message. Nothing was changed.");
    }
    if let Some(body) = action.patch() {
        return edit(client, options, id, revision, body).await;
    }
    if crate::local_client::hello(client, options).await.is_err() {
        return refused(OFFLINE);
    }
    let current = match client.get(record_url(options, id)).send().await {
        Ok(mut r) if r.status().as_u16() == 200 => body(&mut r, RECORD_CAP)
            .await
            .and_then(|b| serde_json::from_slice::<Item>(&b).ok()),
        Ok(r) if r.status().as_u16() == 404 => {
            return refused("Local no longer has this scheduled message.");
        }
        _ => None,
    };
    let Some(current) = current else {
        return refused("Local couldn’t read this scheduled message. Nothing was changed.");
    };
    if current.id != id
        || current.revision != revision
        || current.state != action.state()
        || current.recurring() != (action == RowAction::Delete)
    {
        return refused(CHANGED);
    }
    // The daemon refuses with 409 if the record changed after the read above.
    let mut delete_url = record_url(options, id);
    delete_url.push_str(&format!("?expectedRevision={revision}"));
    let mut response = match client.delete(delete_url).send().await {
        Ok(response) => response,
        Err(error) if error.is_connect() => {
            return refused("Local is offline. Nothing was changed.");
        }
        Err(_) => return unconfirmed(),
    };
    match response.status().as_u16() {
        200 => {}
        // Conflict and NotFound are raised before the store is touched.
        409 => return refused(CHANGED),
        404 => return refused("Local no longer has this scheduled message."),
        _ => return unconfirmed(),
    }
    let ok = body(&mut response, 1024)
        .await
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some_and(|v| v == serde_json::json!({"ok": true}));
    if !ok || crate::local_client::hello(client, options).await.is_err() {
        return unconfirmed();
    }
    Outcome::Done
}
const OFFLINE: &str = "Local is unavailable or changed identity. Nothing was changed.";
/// A rule edit or creation, as the editor or a row action captured it.
#[derive(Clone, Debug)]
pub(crate) enum Write {
    Row {
        id: String,
        revision: u64,
        action: RowAction,
    },
    /// POST /api/schedules. Recurring rules carry native authority.
    Create { body: serde_json::Value },
    /// PATCH of a recurring rule at the shown revision.
    Edit {
        id: String,
        revision: u64,
        body: serde_json::Value,
    },
}
/// The daemon's one-line `{"error"}` text, bounded.
async fn server_error(response: &mut reqwest::Response) -> Option<String> {
    let bytes = body(response, 4096).await?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let text = value["error"].as_str()?.lines().next()?.trim();
    (!text.is_empty()).then(|| text.chars().take(200).collect())
}
/// Every recurring write is fenced to the checked home and authorized by the native app.
fn home(options: &LocalOptions, body: &mut serde_json::Value) {
    let host = options.host();
    body["expectedHome"] =
        serde_json::json!({"daemonId": host.daemon_id, "lineageId": host.lineage_id});
}
fn authorized(
    options: &LocalOptions,
    request: reqwest::RequestBuilder,
    native: bool,
) -> Result<reqwest::RequestBuilder, Outcome> {
    if !native {
        return Ok(request);
    }
    let token = options.model_scope_capability().map_err(|_| {
        refused("Pilot couldn’t authorize this change on Local. Nothing was changed.")
    })?;
    let mut header = reqwest::header::HeaderValue::from_str(&token).map_err(|_| {
        refused("Pilot couldn’t authorize this change on Local. Nothing was changed.")
    })?;
    header.set_sensitive(true);
    Ok(request.header("x-pilot-github-capability", header))
}
/// Refusals Local raises before it writes. 400 on a create can follow a committed row,
/// so it is said as such, never as "nothing was saved".
async fn answer(
    mut response: reqwest::Response,
    created: bool,
    accept: impl Fn(&Item) -> bool,
    client: &reqwest::Client,
    options: &LocalOptions,
) -> Outcome {
    let status = response.status().as_u16();
    if matches!(status, 200 | 201) {
        let ok = body(&mut response, RECORD_CAP)
            .await
            .and_then(|b| serde_json::from_slice::<Item>(&b).ok())
            .is_some_and(|item| item.valid() && accept(&item));
        if !ok || crate::local_client::hello(client, options).await.is_err() {
            return unconfirmed();
        }
        return Outcome::Done;
    }
    let error = server_error(&mut response).await;
    let said = |fallback: &str| error.clone().unwrap_or_else(|| fallback.into());
    match status {
        503 if error.as_deref() == Some("Automations are disabled") => {
            refused("Automations are off. Turn them on in Settings → Chats. Nothing was changed.")
        }
        409 => Outcome::Refused(format!(
            "{} Nothing was changed.",
            match error.as_deref() {
                Some(e) if e.starts_with("Schedule home changed") => {
                    "Local changed identity.".to_owned()
                }
                Some(e) if e.starts_with("Only pending") => "It’s running right now.".to_owned(),
                _ => "This automation changed.".to_owned(),
            }
        )),
        403 => refused("Local refused native authorization. Nothing was changed."),
        404 => Outcome::Refused(format!("{}. Nothing was changed.", said("Not found"))),
        400 if created => Outcome::Unconfirmed(format!(
            "Local refused it: {}. Refresh to check it wasn’t saved anyway.",
            said("invalid request")
        )),
        400 => Outcome::Refused(format!("Local refused it: {}.", said("invalid request"))),
        _ => unconfirmed(),
    }
}
async fn edit(
    client: &reqwest::Client,
    options: &LocalOptions,
    id: &str,
    revision: u64,
    mut body: serde_json::Value,
) -> Outcome {
    if !crate::local_model::valid_id(id) || !body.is_object() {
        return refused("Pilot can’t address this automation. Nothing was changed.");
    }
    if crate::local_client::hello(client, options).await.is_err() {
        return refused(OFFLINE);
    }
    body["expectedRevision"] = serde_json::json!(revision);
    home(options, &mut body);
    let request = match authorized(
        options,
        client
            .patch(record_url(options, id))
            .header("Content-Type", "application/json")
            .body(body.to_string()),
        true,
    ) {
        Ok(request) => request,
        Err(outcome) => return outcome,
    };
    match request.send().await {
        Ok(response) => {
            let accept = |item: &Item| item.id == id && item.revision > revision;
            answer(response, false, accept, client, options).await
        }
        Err(error) if error.is_connect() => refused("Local is offline. Nothing was changed."),
        Err(_) => unconfirmed(),
    }
}
async fn create(
    client: &reqwest::Client,
    options: &LocalOptions,
    mut body: serde_json::Value,
) -> Outcome {
    if !body.is_object() {
        return refused("Pilot couldn’t prepare this automation. Nothing was saved.");
    }
    if crate::local_client::hello(client, options).await.is_err() {
        return refused("Local is unavailable or changed identity. Nothing was saved.");
    }
    let recurring = body["trigger"] == "recurring";
    home(options, &mut body);
    let request = match authorized(
        options,
        client
            .post(format!("{}/api/schedules", options.loopback()))
            .header("Content-Type", "application/json")
            .body(body.to_string()),
        recurring,
    ) {
        Ok(request) => request,
        Err(outcome) => return outcome,
    };
    match request.send().await {
        Ok(response) => {
            let accept = |item: &Item| item.revision == 1 && item.recurring() == recurring;
            answer(response, true, accept, client, options).await
        }
        Err(error) if error.is_connect() => refused("Local is offline. Nothing was saved."),
        Err(_) => unconfirmed(),
    }
}
pub(crate) async fn write(
    client: &reqwest::Client,
    options: &LocalOptions,
    write: Write,
) -> Outcome {
    match write {
        Write::Row {
            id,
            revision,
            action,
        } => act(client, options, &id, revision, action).await,
        Write::Create { body } => create(client, options, body).await,
        Write::Edit { id, revision, body } => edit(client, options, &id, revision, body).await,
    }
}
/// Runs one write on its own thread. Dropping the receiver ignores, never cancels, the request.
pub(crate) fn perform(options: LocalOptions, request: Write) -> async_channel::Receiver<Outcome> {
    let (sender, receiver) = async_channel::bounded(1);
    let _ = std::thread::Builder::new()
        .name("local-schedule-action".into())
        .spawn(move || {
            let outcome = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .ok()
                .zip(
                    reqwest::Client::builder()
                        .no_proxy()
                        .retry(reqwest::retry::never())
                        .redirect(reqwest::redirect::Policy::none())
                        .connect_timeout(Duration::from_secs(2))
                        .timeout(Duration::from_secs(10))
                        .build()
                        .ok(),
                )
                .map(|(runtime, client)| runtime.block_on(write(&client, &options, request)));
            if let Some(outcome) = outcome {
                let _ = sender.send_blocking(outcome);
            }
        });
    receiver
}
