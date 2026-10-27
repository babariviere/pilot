//! One explicit read at a time. Switching/closing cancels the previous future.
#[cfg(test)]
#[path = "mission_reader_tests.rs"]
mod tests;
use crate::{
    LocalOptions,
    mission_browser::{self as model, Catalog, Detail, Home, Key, Members},
};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Route {
    Catalog,
    Detail(Key),
}
#[derive(Clone, Debug)]
pub(crate) struct Request {
    pub(crate) generation: u64,
    pub(crate) route: Option<Route>,
}
pub(crate) enum Data {
    Catalog(Arc<Catalog>),
    Detail(Arc<Detail>, Result<Arc<Members>, &'static str>),
}
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
            .name("local-mission-reader".into())
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
    #[cfg(any(test, feature = "native-probes"))]
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
            value=fetch(&client,&options,&route)=>value,
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
pub(crate) async fn fetch(
    client: &reqwest::Client,
    options: &LocalOptions,
    route: &Route,
) -> Result<Data, &'static str> {
    let local = Home::local(&options.host());
    if matches!(route,Route::Detail(k) if !k.valid()||k.home!=local) {
        return Err(
            "Mission home is unavailable in this Local-only viewer. No host fallback was attempted.",
        );
    }
    crate::local_client::gate(client, options).await?;
    match route {
        Route::Catalog => Ok(Data::Catalog(Arc::new(model::catalog(
            &get(
                client,
                options,
                "/api/mission-catalog",
                model::CATALOG_BYTES,
            )
            .await?,
        )?))),
        Route::Detail(key) => {
            let d = Arc::new(model::detail(
                key,
                &get(
                    client,
                    options,
                    &format!("/api/missions/{}", key.id),
                    model::DETAIL_BYTES,
                )
                .await?,
            )?);
            let members = match get(
                client,
                options,
                &format!("/api/sessions?archived=all&missionId={}", key.id),
                model::MEMBER_BYTES,
            )
            .await
            {
                Ok(v) => model::members(&d, &v).map(Arc::new),
                Err(e) => Err(e),
            };
            Ok(Data::Detail(d, members))
        }
    }
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
