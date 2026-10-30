//! Explicit project-scoped tree GETs. Replacement/drop cancels obsolete I/O.
use crate::{
    LocalOptions,
    project_memory::{Range, Tree},
};
use std::time::Duration;
// Existing 1024-node tree limit and 2048-byte records, plus wire metadata.
const WIRE_CAP: usize = 1024 * 4096;
pub(crate) fn path(project: &str, range: Option<Range>) -> Result<String, &'static str> {
    if !crate::local_model::valid_id(project) || range.is_some_and(|r| !r.valid()) {
        return Err("Invalid Local project memory scope.");
    }
    Ok(match range {
        None => format!("/api/projects/{project}/memory/tree?depth=1"),
        Some(r) => format!(
            "/api/projects/{project}/memory/tree?depth=1&lo={}&hi={}",
            r.lo, r.hi
        ),
    })
}
pub(crate) async fn fetch(
    client: &reqwest::Client,
    options: &LocalOptions,
    project: &str,
    range: Option<Range>,
) -> Result<Tree, &'static str> {
    let path = path(project, range)?;
    crate::local_client::hello(client, options).await?;
    let mut response = client
        .get(format!("{}{path}", options.loopback()))
        .send()
        .await
        .map_err(|_| "Local memory is offline or could not be read. Refresh to retry.")?;
    match response.status().as_u16() {
        200 => {}
        404 => return Err("This project or its memory browser is unavailable on Local."),
        503 => return Err("Local memory is unavailable. Refresh to retry."),
        _ => return Err("Local refused the memory read. No fallback was attempted."),
    }
    if response
        .content_length()
        .is_some_and(|n| n > WIRE_CAP as u64)
    {
        return Err("Local memory exceeded its bounded tree response.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local memory response was interrupted.")?
    {
        if chunk.len() > WIRE_CAP.saturating_sub(bytes.len()) {
            return Err("Local memory exceeded its bounded tree response.");
        }
        bytes.extend_from_slice(&chunk);
    }
    crate::local_client::hello(client, options).await?;
    Tree::parse(
        serde_json::from_slice(&bytes).map_err(|_| "Malformed Local memory JSON.")?,
        range,
    )
}
#[derive(Clone)]
pub(crate) struct Request {
    pub(crate) generation: u64,
    pub(crate) target: Option<Range>,
}
pub(crate) struct Response {
    pub(crate) generation: u64,
    pub(crate) range: Option<Range>,
    pub(crate) result: Result<Tree, &'static str>,
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
        std::thread::Builder::new().name("local-project-memory-reader".into()).spawn(move|| {
            let _close=CloseRequests(events.clone());
            if let Ok(rt)=tokio::runtime::Builder::new_current_thread().enable_all().build() {rt.block_on(async move {
                let Ok(client)=reqwest::Client::builder().no_proxy().retry(reqwest::retry::never()).redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(5)).build() else {return;};
                let mut next=None;
                loop {
                    let r=match next.take() {Some(r)=>r,None=>match events.recv().await {Ok(r)=>r,Err(_)=>return}};
                    let result=tokio::select! {biased;
                        r=events.recv()=>{match r {Ok(r)=>next=Some(r),Err(_)=>return};continue;},
                        value=fetch(&client,&options,&project,r.target)=>value,
                    };
                    let response=Response {generation:r.generation,range:r.target,result};
                    if let Err(async_channel::TrySendError::Full(r))=updates.try_send(response) {let _=stale.try_recv();let _=updates.try_send(r);}
                }
            });}
        }).map_err(|_|"Cannot start the Local memory reader.")?;
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
