//! One explicit read at a time. Replacement/drop cancels both bounded GETs.
#[cfg(test)]
#[path = "session_file_view_reader_tests.rs"]
mod tests;
use crate::{
    LocalOptions,
    session_file_view::{self as model, Content},
};
use serde_json::Value;
use std::time::Duration;
pub(crate) fn same_source(a: Option<&LocalOptions>, b: Option<&LocalOptions>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.host() == b.host() && a.loopback() == b.loopback(),
        (None, None) => true,
        _ => false,
    }
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Target {
    pub(crate) chat: String,
    pub(crate) cwd: String,
    pub(crate) path: String,
}
pub(crate) fn url(options: &LocalOptions, target: &Target) -> Result<reqwest::Url, &'static str> {
    if !crate::local_model::valid_id(&target.chat)
        || !model::valid_path(&target.path)
        || target.cwd.is_empty()
        || target.cwd.len() > 16384
    {
        return Err("Canonical chat, workspace or file path unavailable.");
    }
    let mut url = reqwest::Url::parse(&format!(
        "{}/api/sessions/{}/files",
        options.loopback(),
        target.chat
    ))
    .map_err(|_| "Invalid Local URL")?;
    url.query_pairs_mut().append_pair("path", &target.path);
    Ok(url)
}
async fn workspace(
    client: &reqwest::Client,
    options: &LocalOptions,
    t: &Target,
) -> Result<(), &'static str> {
    let url = reqwest::Url::parse(&format!("{}/api/sessions/{}", options.loopback(), t.chat))
        .map_err(|_| "Invalid Local URL")?;
    let v = get(client, url).await?;
    if v["id"].as_str() != Some(t.chat.as_str()) || v["cwd"].as_str() != Some(t.cwd.as_str()) {
        return Err("Chat workspace no longer matches this Changes source. Reopen Changes.");
    }
    Ok(())
}
pub(crate) async fn fetch(
    client: &reqwest::Client,
    options: &LocalOptions,
    target: &Target,
) -> Result<Content, &'static str> {
    let url = url(options, target)?;
    crate::local_client::hello(client, options).await?;
    workspace(client, options, target).await?;
    let content = Content::parse(get(client, url).await?, &target.path)?;
    workspace(client, options, target).await?;
    crate::local_client::hello(client, options).await?;
    Ok(content)
}
async fn get(client: &reqwest::Client, url: reqwest::Url) -> Result<Value, &'static str> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Local file read failed. Refresh to retry.")?;
    match response.status().as_u16() {
        200 => {}
        409 => {
            return Err(
                "Local refused workspace access. The server did not grant this read. No fallback attempted.",
            );
        }
        404 => {
            return Err("File or chat unavailable (possibly deleted). No alternate path queried.");
        }
        429 => return Err("Local file query capacity reached. Retry later."),
        405 | 503 => {
            return Err("Local file queries are unavailable or unsupported.");
        }
        _ => {
            return Err("Local file read refused. No redirect or host fallback attempted.");
        }
    }
    if response
        .content_length()
        .is_some_and(|n| n > model::WIRE_CAP as u64)
    {
        return Err("Local file response exceeded 4 MiB. No partial JSON decoded.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local file response interrupted.")?
    {
        if bytes.len().saturating_add(chunk.len()) > model::WIRE_CAP {
            return Err("Local file response exceeded 4 MiB. No partial JSON decoded.");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Malformed Local file JSON.")
}
#[derive(Clone, Debug)]
pub(crate) struct Request {
    pub(crate) generation: u64,
    pub(crate) target: Option<Target>,
}
pub(crate) struct Response {
    pub(crate) generation: u64,
    pub(crate) target: Target,
    pub(crate) result: Result<Content, &'static str>,
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
            .name("local-session-file-reader".into())
            .spawn(move || {
                let _close = CloseRequests(events.clone());
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    rt.block_on(run(options, events, updates, stale));
                }
            })
            .map_err(|_| "Cannot start the Local file reader.")?;
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
        let Some(target) = request.target else {
            continue;
        };
        let result = tokio::select! {biased;
            r=events.recv()=>{match r {Ok(r)=>next=Some(r),Err(_)=>return};continue;},
            value=fetch(&client,&options,&target)=>value,
        };
        let response = Response {
            generation: request.generation,
            target,
            result,
        };
        if let Err(async_channel::TrySendError::Full(r)) = updates.try_send(response) {
            let _ = stale.try_recv();
            let _ = updates.try_send(r);
        }
    }
}
