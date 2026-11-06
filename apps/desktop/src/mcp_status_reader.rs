//! Fixed passive MCP GET, plus explicit user actions through the existing Local check and
//! sign-in routes. The daemon owns probes, browser and credentials; nothing here reads them.
use crate::close_on_drop::CloseOnDrop;
use crate::{LocalOptions, mcp_status::Snapshot};
use std::time::Duration;
// Same small-snapshot wire safety budget as the existing lifecycle transport.
// No text truncation or partial roster adoption on overflow.
const WIRE_CAP: usize = 2 * 1024 * 1024;
pub(crate) async fn fetch(
    client: &reqwest::Client,
    options: &LocalOptions,
) -> Result<Snapshot, &'static str> {
    crate::local_client::hello(client, options).await?;
    let mut response = client
        .get(format!("{}/api/mcp", options.loopback()))
        .send()
        .await
        .map_err(|_| "Local MCP status is offline or could not be read. Refresh to retry.")?;
    match response.status().as_u16() {
        200 => {}
        404 => return Err("MCP status is unavailable on this Local daemon."),
        503 => return Err("Local MCP status is unavailable. Refresh to retry."),
        _ => return Err("Local refused the MCP status read. No fallback was attempted."),
    }
    if response
        .content_length()
        .is_some_and(|n| n > WIRE_CAP as u64)
    {
        return Err("Local MCP status exceeded its read response budget.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local MCP status response was interrupted.")?
    {
        if chunk.len() > WIRE_CAP.saturating_sub(bytes.len()) {
            return Err("Local MCP status exceeded its read response budget.");
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
            .name("local-mcp-status-reader".into())
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
            }).map_err(|_| "Cannot start the Local MCP status reader.")?;
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
/// One deliberate user action through the existing Local MCP routes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Act {
    SignIn { server: String, again: bool },
    Cancel { server: String, started_at: u64 },
    Check { server: Option<String> },
}
impl Act {
    pub(crate) fn server(&self) -> Option<&str> {
        match self {
            Self::SignIn { server, .. } | Self::Cancel { server, .. } => Some(server),
            Self::Check { server } => server.as_deref(),
        }
    }
}
#[derive(Debug)]
pub(crate) enum Outcome {
    /// Sign-in or cancel ACK: the server's current sign-in, if any.
    SignIn(Option<crate::mcp_status::SignIn>),
    /// Check ACK: the status at once, with `checking` set.
    Status(Snapshot),
    /// Local answered with a refusal. Text says what is known.
    Refused(&'static str),
    /// Sent, but no valid answer from the same daemon. Never replayed.
    Unconfirmed(&'static str),
}
const UNCONFIRMED: &str = "Pilot couldn’t confirm this request. The status below is what Local reports now; nothing was retried.";
fn sign_in_url(options: &LocalOptions, server: &str) -> String {
    let mut url = reqwest::Url::parse(&options.loopback()).expect("loopback URL");
    url.path_segments_mut()
        .expect("HTTP URL")
        .extend(["api", "mcp", "servers", server, "sign-in"]);
    url.into()
}
/// No retries, redirects or fallback. Identity is pinned before and after the request.
pub(crate) async fn act(client: &reqwest::Client, options: &LocalOptions, act: &Act) -> Outcome {
    if crate::local_client::hello(client, options).await.is_err() {
        return Outcome::Refused("Local is unavailable or changed identity. Nothing was sent.");
    }
    let (request, body) = match act {
        Act::SignIn { server, again } => (
            client.post(sign_in_url(options, server)),
            serde_json::json!({ "again": again }),
        ),
        Act::Cancel { server, started_at } => (
            client.delete(sign_in_url(options, server)),
            serde_json::json!({ "expectedStartedAt": started_at }),
        ),
        Act::Check { server } => (
            client.post(format!("{}/api/mcp/check", options.loopback())),
            server.as_ref().map_or_else(
                || serde_json::json!({}),
                |s| serde_json::json!({ "server": s }),
            ),
        ),
    };
    let sent = request
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .await;
    let mut response = match sent {
        Ok(response) => response,
        Err(error) if error.is_connect() => {
            return Outcome::Refused("Local is offline. Nothing was sent.");
        }
        Err(_) => return Outcome::Unconfirmed(UNCONFIRMED),
    };
    match (response.status().as_u16(), act) {
        (200, _) => {}
        (409, Act::Cancel { .. }) => {
            return Outcome::Refused(
                "The sign-in changed before it could be cancelled. Nothing was cancelled.",
            );
        }
        (409, _) => {
            return Outcome::Refused(
                "Browser sign-in isn’t available for this server. Use pi mcp login in a terminal.",
            );
        }
        (404, _) => {
            return Outcome::Refused(
                "Local doesn’t report this server or action. Nothing was started.",
            );
        }
        (503, _) => return Outcome::Refused("MCP actions are unavailable on this Local daemon."),
        (400..=499, _) => {
            return Outcome::Refused("Local refused the request. Nothing was started.");
        }
        _ => return Outcome::Unconfirmed(UNCONFIRMED),
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if chunk.len() <= WIRE_CAP.saturating_sub(bytes.len()) => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return Outcome::Unconfirmed(UNCONFIRMED),
        }
    }
    if crate::local_client::hello(client, options).await.is_err() {
        return Outcome::Unconfirmed(UNCONFIRMED);
    }
    let parsed = match act {
        Act::Check { .. } => Snapshot::parse(&bytes).ok().map(Outcome::Status),
        _ => crate::mcp_status::parse_sign_in(&bytes).map(Outcome::SignIn),
    };
    parsed.unwrap_or(Outcome::Unconfirmed(UNCONFIRMED))
}
/// Runs one action on its own thread. Dropping the receiver ignores, never cancels, the request.
pub(crate) fn perform(options: LocalOptions, request: Act) -> async_channel::Receiver<Outcome> {
    let (sender, receiver) = async_channel::bounded(1);
    let _ = std::thread::Builder::new()
        .name("local-mcp-action".into())
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
                .map(|(runtime, client)| runtime.block_on(act(&client, &options, &request)));
            if let Some(outcome) = outcome {
                let _ = sender.send_blocking(outcome);
            }
        });
    receiver
}
