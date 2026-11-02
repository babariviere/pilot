//! Fixed passive schedule GET, plus the explicit Cancel/Dismiss DELETE. Never creates or dispatches.
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
struct CloseRequests(async_channel::Receiver<Request>);
impl Drop for CloseRequests {
    fn drop(&mut self) {
        self.0.close();
    }
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
                let _close = CloseRequests(events.clone());
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

/// Result of one Cancel or Dismiss. Never retried or replayed.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Done,
    /// Local answered before changing anything.
    Refused(&'static str),
    /// Sent, but no valid answer from the same daemon.
    Unconfirmed(&'static str),
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
pub(crate) async fn act(
    client: &reqwest::Client,
    options: &LocalOptions,
    id: &str,
    revision: u64,
    action: RowAction,
) -> Outcome {
    const CHANGED: &str = "This scheduled message changed. Nothing was changed.";
    if !crate::local_model::valid_id(id) {
        return Outcome::Refused(
            "Pilot can’t address this scheduled message. Nothing was changed.",
        );
    }
    if crate::local_client::hello(client, options).await.is_err() {
        return Outcome::Refused("Local is unavailable or changed identity. Nothing was changed.");
    }
    let current = match client.get(record_url(options, id)).send().await {
        Ok(mut r) if r.status().as_u16() == 200 => body(&mut r, RECORD_CAP)
            .await
            .and_then(|b| serde_json::from_slice::<Item>(&b).ok()),
        Ok(r) if r.status().as_u16() == 404 => {
            return Outcome::Refused("Local no longer has this scheduled message.");
        }
        _ => None,
    };
    let Some(current) = current else {
        return Outcome::Refused(
            "Local couldn’t read this scheduled message. Nothing was changed.",
        );
    };
    if current.id != id || current.revision != revision || current.state != action.state() {
        return Outcome::Refused(CHANGED);
    }
    // The daemon refuses with 409 if the record changed after the read above.
    let mut delete_url = record_url(options, id);
    delete_url.push_str(&format!("?expectedRevision={revision}"));
    let mut response = match client.delete(delete_url).send().await {
        Ok(response) => response,
        Err(error) if error.is_connect() => {
            return Outcome::Refused("Local is offline. Nothing was changed.");
        }
        Err(_) => return Outcome::Unconfirmed(UNCONFIRMED),
    };
    match response.status().as_u16() {
        200 => {}
        // Conflict and NotFound are raised before the store is touched.
        409 => return Outcome::Refused("This scheduled message changed. Nothing was changed."),
        404 => return Outcome::Refused("Local no longer has this scheduled message."),
        _ => return Outcome::Unconfirmed(UNCONFIRMED),
    }
    let ok = body(&mut response, 1024)
        .await
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some_and(|v| v == serde_json::json!({"ok": true}));
    if !ok || crate::local_client::hello(client, options).await.is_err() {
        return Outcome::Unconfirmed(UNCONFIRMED);
    }
    Outcome::Done
}
/// Runs one action on its own thread. Dropping the receiver ignores, never cancels, the request.
pub(crate) fn perform(
    options: LocalOptions,
    id: String,
    revision: u64,
    action: RowAction,
) -> async_channel::Receiver<Outcome> {
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
                .map(|(runtime, client)| {
                    runtime.block_on(act(&client, &options, &id, revision, action))
                });
            if let Some(outcome) = outcome {
                let _ = sender.send_blocking(outcome);
            }
        });
    receiver
}
