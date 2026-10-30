//! One explicit read at a time. Switching/closing cancels the previous future.
#[cfg(test)]
#[path = "mission_tasks_reader_tests.rs"]
mod tests;
use crate::{
    LocalOptions,
    mission_browser::{Home, Key},
    mission_tasks::{self as model, Snapshot},
};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Route(pub(crate) Key);
#[derive(Clone, Debug)]
pub(crate) struct Request {
    pub(crate) generation: u64,
    pub(crate) route: Option<Route>,
    /// One-use projection from the owning Browser's current detail read.
    pub(crate) loaded: Option<Data>,
}
pub(crate) type Data = Arc<Snapshot>;
pub(crate) struct Response {
    pub(crate) generation: u64,
    pub(crate) route: Route,
    pub(crate) result: Result<Data, &'static str>,
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
            .name("local-mission-tasks-reader".into())
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
    #[cfg(test)]
    pub(crate) fn disconnect_fixture(&self) {
        self.commands.close();
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
        let Some(route) = request.route else {
            continue;
        };
        let result = tokio::select! {biased;
            r=events.recv()=>{match r {Ok(r)=>next=Some(r),Err(_)=>return};continue;},
            value=fetch_loaded(&client,&options,&route,request.loaded)=>value,
        };
        let response = Response {
            generation: request.generation,
            route,
            result,
        };
        if let Err(async_channel::TrySendError::Full(r)) = updates.try_send(response) {
            let _ = stale.try_recv();
            let _ = updates.try_send(r);
        }
    }
}
#[cfg(test)]
pub(crate) async fn fetch(
    client: &reqwest::Client,
    options: &LocalOptions,
    route: &Route,
) -> Result<Data, &'static str> {
    fetch_loaded(client, options, route, None).await
}
async fn fetch_loaded(
    client: &reqwest::Client,
    options: &LocalOptions,
    route: &Route,
    loaded: Option<Data>,
) -> Result<Data, &'static str> {
    let local = Home::local(&options.host());
    let key = &route.0;
    if !key.valid() || key.home != local {
        return Err(
            "Task home is unavailable in this Local-only viewer. No fallback was attempted.",
        );
    }
    crate::local_client::gate(client, options).await?;
    if let Some(snapshot) = loaded {
        return if &snapshot.key == key {
            Ok(snapshot)
        } else {
            Err("Task snapshot belongs to a different mission.")
        };
    }
    let value = get(client, options, &format!("/api/missions/{}", key.id)).await?;
    model::parse(key, &value).map(Arc::new)
}

async fn get(
    client: &reqwest::Client,
    options: &LocalOptions,
    path: &str,
) -> Result<Value, &'static str> {
    let r = client
        .get(format!("{}{path}", options.loopback()))
        .send()
        .await
        .map_err(|_| "Couldn't load this mission. Refresh to try again.")?;
    match r.status().as_u16() {
        200 => {}
        404 | 405 => {
            return Err("This mission read is unavailable or unsupported by the Local daemon.");
        }
        503 => return Err("Missions aren't available right now. Refresh to try again."),
        _ => {
            return Err(
                "Mission read refused. No authentication, redirect or host fallback was attempted.",
            );
        }
    }
    detail_body(r).await
}
/// A whole mission-detail body. It carries every task, so it has no byte ceiling.
pub(crate) async fn detail_body(r: reqwest::Response) -> Result<Value, &'static str> {
    let body = r
        .bytes()
        .await
        .map_err(|_| "Mission response was interrupted.")?;
    serde_json::from_slice(&body)
        .map_err(|_| "Malformed mission JSON; previous snapshot is not current.")
}
