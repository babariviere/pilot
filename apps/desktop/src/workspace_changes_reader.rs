//! One explicit read at a time. Replacement/drop cancels both bounded GETs.
#[cfg(test)]
#[path = "workspace_changes_reader_tests.rs"]
mod tests;
use crate::{
    LocalOptions,
    workspace_changes::{self as model, Snapshot},
};
use serde_json::Value;
use std::time::Duration;
pub(crate) fn url(options: &LocalOptions, chat: &str) -> Result<reqwest::Url, &'static str> {
    if !crate::local_model::valid_id(chat) {
        return Err("Invalid canonical chat identity.");
    }
    reqwest::Url::parse(&format!(
        "{}/api/sessions/{chat}/changes",
        options.loopback()
    ))
    .map_err(|_| "Invalid Local URL")
}
pub(crate) async fn fetch(
    client: &reqwest::Client,
    options: &LocalOptions,
    chat: &str,
) -> Result<Snapshot, &'static str> {
    let url = url(options, chat)?;
    crate::local_client::hello(client, options).await?;
    let snapshot = Snapshot::parse(get(client, url).await?)?;
    crate::local_client::hello(client, options).await?;
    Ok(snapshot)
}
async fn get(client: &reqwest::Client, url: reqwest::Url) -> Result<Value, &'static str> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Local workspace changes read failed. Refresh to retry.")?;
    match response.status().as_u16() {
        200 => {}
        409 => {
            return Err(
                "Local refused workspace access. Chat mode, lifecycle or source may have changed. No fallback attempted.",
            );
        }
        429 => return Err("Local workspace changes query capacity reached. Retry later."),
        404 | 405 | 503 => {
            return Err("Local workspace changes queries are unavailable or unsupported.");
        }
        _ => {
            return Err(
                "Local workspace changes read refused. No redirect or host fallback attempted.",
            );
        }
    }
    if response
        .content_length()
        .is_some_and(|n| n > model::WIRE_CAP as u64)
    {
        return Err("Local workspace changes response exceeded 8 MiB. No partial JSON decoded.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local workspace changes response interrupted.")?
    {
        if bytes.len().saturating_add(chunk.len()) > model::WIRE_CAP {
            return Err(
                "Local workspace changes response exceeded 8 MiB. No partial JSON decoded.",
            );
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Malformed Local workspace changes JSON.")
}
#[derive(Clone, Debug)]
pub(crate) struct Request {
    pub(crate) generation: u64,
    pub(crate) target: Option<String>,
}
pub(crate) struct Response {
    pub(crate) generation: u64,
    pub(crate) chat: String,
    pub(crate) result: Result<Snapshot, &'static str>,
}
pub(crate) struct Reader {
    commands: async_channel::Sender<Request>,
    replace: async_channel::Receiver<Request>,
}
// The producer retains a receiver for coalescing. A worker exit must explicitly
// close that lane, including runtime/client initialization failure or unwinding.
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
        let (commands, events) = async_channel::bounded(1);
        let replace = events.clone();
        let (updates, output) = async_channel::bounded(1);
        let stale = output.clone();
        std::thread::Builder::new()
            .name("local-workspace-changes-reader".into())
            .spawn(move || {
                let _close = CloseRequests(events.clone());
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    rt.block_on(run(options, events, updates, stale));
                }
            })
            .map_err(|_| "Cannot start the Local workspace changes reader.")?;
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
async fn run(
    options: LocalOptions,
    events: async_channel::Receiver<Request>,
    updates: async_channel::Sender<Response>,
    stale: async_channel::Receiver<Response>,
) {
    let client = match reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(1)
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(35))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut next = None;
    loop {
        let request = match next.take() {
            Some(r) => r,
            None => match events.recv().await {
                Ok(r) => r,
                Err(_) => return,
            },
        };
        let Some(chat) = request.target else {
            continue;
        };
        let result = tokio::select! {biased;
            r=events.recv()=>{match r {Ok(r)=>next=Some(r),Err(_)=>return};continue;},
            value=fetch(&client,&options,&chat)=>value,
        };
        let response = Response {
            generation: request.generation,
            chat,
            result,
        };
        if let Err(async_channel::TrySendError::Full(r)) = updates.try_send(response) {
            let _ = stale.try_recv();
            let _ = updates.try_send(r);
        }
    }
}
