//! Explicit project-scoped knowledge GETs. Replacement or drop cancels obsolete I/O.
use crate::{
    LocalOptions,
    knowledge::{Data, Page, Query, Route, WIRE_CAP, parse, path},
};
use std::time::Duration;

enum Failure {
    /// 404/405: this daemon or project has no such knowledge route.
    Missing(&'static str),
    Failed(&'static str),
}
impl Failure {
    fn message(self) -> &'static str {
        match self {
            Self::Missing(e) | Self::Failed(e) => e,
        }
    }
}

async fn read(
    client: &reqwest::Client,
    options: &LocalOptions,
    path: &str,
) -> Result<serde_json::Value, Failure> {
    let mut response = client
        .get(format!("{}{path}", options.loopback()))
        .send()
        .await
        .map_err(|_| {
            Failure::Failed("Project knowledge is offline or could not be read. Refresh to retry.")
        })?;
    match response.status().as_u16() {
        200 => {}
        404 => {
            return Err(Failure::Missing(
                "This knowledge is unavailable in this project on Local.",
            ));
        }
        405 => {
            return Err(Failure::Missing(
                "This Local daemon does not provide project knowledge yet.",
            ));
        }
        503 => {
            return Err(Failure::Failed(
                "Project knowledge is unavailable. Refresh to retry.",
            ));
        }
        _ => {
            return Err(Failure::Failed(
                "Local refused the knowledge read. No fallback was attempted.",
            ));
        }
    }
    let over = Failure::Failed("Project knowledge exceeded its bounded response.");
    if response
        .content_length()
        .is_some_and(|n| n > WIRE_CAP as u64)
    {
        return Err(over);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Failure::Failed("Project knowledge response was interrupted."))?
    {
        if chunk.len() > WIRE_CAP.saturating_sub(bytes.len()) {
            return Err(over);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Failure::Failed("Malformed project knowledge JSON."))
}

pub(crate) async fn fetch(
    client: &reqwest::Client,
    options: &LocalOptions,
    project: &str,
    route: &Route,
) -> Result<Data, &'static str> {
    let path = path(project, route)?;
    crate::local_client::hello(client, options).await?;
    let value = read(client, options, &path)
        .await
        .map_err(Failure::message)?;
    // The read may span a daemon replacement at the same address. Never publish it then.
    crate::local_client::hello(client, options).await?;
    parse(project, route, value)
}

/// A mission's linked subset, inside the mission reader's own hello fence. None when
/// this daemon has no knowledge catalog, so older daemons show no section.
pub(crate) async fn linked(
    client: &reqwest::Client,
    options: &LocalOptions,
    project: &str,
    mission: &str,
) -> Result<Option<Page>, &'static str> {
    let route = Route::List(Query {
        mission: Some(mission.to_owned()),
        ..Query::default()
    });
    let value = match read(client, options, &path(project, &route)?).await {
        Ok(v) => v,
        Err(Failure::Missing(_)) => return Ok(None),
        Err(Failure::Failed(e)) => return Err(e),
    };
    match parse(project, &route, value)? {
        Data::Page(page) => Ok(Some(page)),
        _ => Err("Local returned an unexpected knowledge response."),
    }
}

#[derive(Clone)]
pub(crate) struct Request {
    pub(crate) generation: u64,
    pub(crate) route: Route,
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
struct CloseRequests(async_channel::Receiver<Request>);
impl Drop for CloseRequests {
    fn drop(&mut self) {
        self.0.close();
    }
}
impl Reader {
    pub(crate) fn start(
        options: LocalOptions,
        project: String,
    ) -> Result<(Self, async_channel::Receiver<Response>), &'static str> {
        let (commands, events) = async_channel::bounded::<Request>(1);
        let replace = events.clone();
        let (updates, output) = async_channel::bounded(1);
        let stale = output.clone();
        std::thread::Builder::new()
            .name("local-project-knowledge-reader".into())
            .spawn(move || {
                let _close = CloseRequests(events.clone());
                let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                else {
                    return;
                };
                rt.block_on(async move {
                    let Ok(client) = reqwest::Client::builder()
                        .no_proxy()
                        .retry(reqwest::retry::never())
                        .redirect(reqwest::redirect::Policy::none())
                        .connect_timeout(Duration::from_secs(2))
                        .timeout(Duration::from_secs(5))
                        .build()
                    else {
                        return;
                    };
                    let mut next = None;
                    loop {
                        let r = match next.take() {
                            Some(r) => r,
                            None => match events.recv().await {
                                Ok(r) => r,
                                Err(_) => return,
                            },
                        };
                        let result = tokio::select! {biased;
                            n = events.recv() => { match n { Ok(n) => next = Some(n), Err(_) => return }; continue; },
                            value = fetch(&client, &options, &project, &r.route) => value,
                        };
                        let response = Response {
                            generation: r.generation,
                            route: r.route,
                            result,
                        };
                        if let Err(async_channel::TrySendError::Full(r)) = updates.try_send(response) {
                            let _ = stale.try_recv();
                            let _ = updates.try_send(r);
                        }
                    }
                });
            })
            .map_err(|_| "Cannot start the Local knowledge reader.")?;
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
