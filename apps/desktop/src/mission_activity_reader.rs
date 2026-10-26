//! One explicit read at a time. Switching/closing cancels the previous future.
#[cfg(test)]
#[path = "mission_activity_reader_tests.rs"]
mod tests;
use crate::{
    LocalOptions,
    mission_activity::{self as model, Entry},
    mission_browser::{Home, Key},
};
use serde_json::Value;
use std::time::Duration;
#[derive(Clone, Debug)]
pub(crate) struct Request {
    pub(crate) generation: u64,
    pub(crate) target: Option<(Key, Option<u64>)>,
}
pub(crate) struct Response {
    pub(crate) generation: u64,
    pub(crate) key: Key,
    pub(crate) before: Option<u64>,
    pub(crate) result: Result<Vec<Entry>, &'static str>,
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
            .name("local-mission-activity-reader".into())
            .spawn(move || {
                let _close = CloseRequests(events.clone());
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    rt.block_on(run(options, events, updates, stale));
                }
            })
            .map_err(|_| "Cannot start the Local mission reader.")?;
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
        .timeout(Duration::from_secs(5))
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
        let Some((key, before)) = request.target else {
            continue;
        };
        let result = tokio::select! {biased;
            r=events.recv()=>{match r {Ok(r)=>next=Some(r),Err(_)=>return};continue;},
            value=fetch(&client,&options,&key,before)=>value,
        };
        let response = Response {
            generation: request.generation,
            key,
            before,
            result,
        };
        if let Err(async_channel::TrySendError::Full(r)) = updates.try_send(response) {
            let _ = stale.try_recv();
            let _ = updates.try_send(r);
        }
    }
}
pub(crate) async fn fetch(
    client: &reqwest::Client,
    options: &LocalOptions,
    key: &Key,
    before: Option<u64>,
) -> Result<Vec<Entry>, &'static str> {
    if !key.valid() || key.home != Home::local(&options.host()) {
        return Err("Activity source is not the canonical Local home. No fallback was attempted.");
    }
    crate::local_client::gate(client, options).await?;
    let path = format!(
        "/api/missions/{}/events{}",
        key.id,
        before.map(|b| format!("?before={b}")).unwrap_or_default()
    );
    model::page(&get(client, options, &path, model::WIRE_CAP).await?, before)
}
async fn get(
    client: &reqwest::Client,
    options: &LocalOptions,
    path: &str,
    cap: usize,
) -> Result<Value, &'static str> {
    let mut r = client
        .get(format!("{}{path}", options.loopback()))
        .send()
        .await
        .map_err(|_| "Mission read failed. Check Local availability and retry.")?;
    match r.status().as_u16() {
        200 => {}
        404 | 405 => {
            return Err("This mission read is unavailable or unsupported by the Local daemon.");
        }
        503 => return Err("Local mission service is unavailable. Retry explicitly."),
        _ => {
            return Err(
                "Mission read refused. No authentication, redirect or host fallback was attempted.",
            );
        }
    }
    if r.content_length().is_some_and(|n| n > cap as u64) {
        return Err("Mission response exceeds the viewer byte limit; no partial JSON was decoded.");
    }
    let mut body = Vec::new();
    while let Some(chunk) = r
        .chunk()
        .await
        .map_err(|_| "Mission response was interrupted.")?
    {
        if body.len().saturating_add(chunk.len()) > cap {
            return Err(
                "Mission response exceeds the viewer byte limit; no partial JSON was decoded.",
            );
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|_| "Malformed mission JSON; previous snapshot is not current.")
}
