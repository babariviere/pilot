//! Fixed passive MCP GET. Never checks, connects, signs in or reads credentials.
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
            .name("local-mcp-status-reader".into())
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
