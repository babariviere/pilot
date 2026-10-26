//! Cancellable, bounded loopback-only path reads. No writes, roots or fallback.
use crate::{
    LocalOptions,
    path_completion::{Capture, valid_prefix},
};
use serde_json::Value;
use std::time::Duration;
#[cfg(test)]
#[path = "path_completion_reader_tests.rs"]
mod tests;
#[derive(Clone, Debug)]
pub(crate) struct Candidate {
    pub(crate) path: String,
    pub(crate) directory: bool,
}
#[derive(Clone, Debug)]
pub(crate) struct Candidates {
    pub(crate) entries: Vec<Candidate>,
    pub(crate) truncated: bool,
}
pub(crate) async fn fetch(
    client: &reqwest::Client,
    options: &LocalOptions,
    capture: &Capture,
) -> Result<Candidates, &'static str> {
    let hello = crate::local_client::hello(client, options).await?;
    if hello["capabilities"]["sessionPathCandidates"] != 1 {
        return Err("Path completion unavailable on this daemon.");
    }
    if !crate::local_model::valid_id(&capture.target.chat)
        || capture.target.cwd.is_empty()
        || !valid_prefix(&capture.token.prefix)
    {
        return Err("Path source unavailable.");
    }
    let host = options.host();
    let mut url = reqwest::Url::parse(&format!(
        "{}/api/sessions/{}/path-candidates",
        options.loopback(),
        capture.target.chat
    ))
    .map_err(|_| "Invalid Local URL.")?;
    url.query_pairs_mut()
        .append_pair("cwd", &capture.target.cwd)
        .append_pair("prefix", &capture.token.prefix)
        .append_pair("daemonId", &host.daemon_id)
        .append_pair("lineageId", &host.lineage_id);
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Path completion unavailable.")?;
    if response.status() != 200 {
        return Err("Local refused path completion. No fallback attempted.");
    }
    let mut bytes = Vec::new();
    if response.content_length().is_some_and(|n| n > 16384) {
        return Err("Path response exceeded its bound.");
    }
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Path response interrupted.")?
    {
        if bytes.len() + chunk.len() > 16384 {
            return Err("Path response exceeded its bound.");
        }
        bytes.extend_from_slice(&chunk);
    }
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid path response.")?;
    if v["sessionId"] != capture.target.chat
        || v["cwd"] != capture.target.cwd
        || v["prefix"] != capture.token.prefix
        || v["daemonId"] != host.daemon_id
        || v["lineageId"] != host.lineage_id
    {
        return Err("Path completion source changed.");
    }
    let entries = v["entries"]
        .as_array()
        .filter(|a| a.len() <= 8)
        .ok_or("Invalid path candidates.")?;
    let mut result = Vec::new();
    for e in entries {
        let path = e["path"].as_str().ok_or("Invalid candidate path.")?;
        let directory = e["directory"].as_bool().ok_or("Invalid candidate kind.")?;
        if !valid_prefix(path)
            || path.len() > 1280
            || !path.starts_with(&capture.token.prefix)
            || path.ends_with('/')
        {
            return Err("Invalid candidate scope.");
        }
        // A candidate must be a direct child of the queried parent, never a deeper path.
        if path.rsplit_once('/').map(|(p, _)| p)
            != capture.token.prefix.rsplit_once('/').map(|(p, _)| p)
        {
            return Err("Invalid candidate parent.");
        }
        if !result.iter().any(|c: &Candidate| c.path == path) {
            result.push(Candidate {
                path: path.into(),
                directory,
            });
        }
    }
    let truncated = v["truncated"]
        .as_bool()
        .ok_or("Missing candidate coverage.")?;
    crate::local_client::hello(client, options).await?;
    Ok(Candidates {
        entries: result,
        truncated,
    })
}
pub(crate) struct Request {
    pub(crate) serial: u64,
    pub(crate) capture: Option<Capture>,
}
pub(crate) struct Response {
    pub(crate) serial: u64,
    pub(crate) capture: Capture,
    pub(crate) result: Result<Candidates, &'static str>,
}
pub(crate) struct Reader {
    commands: async_channel::Sender<Request>,
    replace: async_channel::Receiver<Request>,
}
impl Reader {
    pub(crate) fn start(
        options: LocalOptions,
    ) -> Result<(Self, async_channel::Receiver<Response>), &'static str> {
        let (commands, events) = async_channel::bounded(1);
        let replace = events.clone();
        let (updates, output) = async_channel::bounded(1);
        let stale = output.clone();
        std::thread::Builder::new().name("local-path-candidates".into()).spawn(move||{
            struct Close(async_channel::Receiver<Request>);impl Drop for Close{fn drop(&mut self){self.0.close();}}
            let _close=Close(events.clone());
            if let Ok(rt)=tokio::runtime::Builder::new_current_thread().enable_all().build(){rt.block_on(async move {
                let Ok(client)=reqwest::Client::builder().no_proxy().retry(reqwest::retry::never()).redirect(reqwest::redirect::Policy::none()).pool_max_idle_per_host(1).connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(3)).build() else{return;};
                let mut next=None;
                loop {
                    let r=match next.take(){Some(r)=>r,None=>match events.recv().await{Ok(r)=>r,Err(_)=>return}};
                    let Some(capture)=r.capture else{continue;};
                    let result=tokio::select!{biased;
                        r=events.recv()=>{next=r.ok();if next.is_none(){return;}continue;},
                        result=async{tokio::time::sleep(Duration::from_millis(120)).await;fetch(&client,&options,&capture).await}=>result,
                    };
                    if let Err(async_channel::TrySendError::Full(r))=updates.try_send(Response{serial:r.serial,capture,result}){let _=stale.try_recv();let _=updates.try_send(r);}
                }
            });}
        }).map_err(|_|"Path reader unavailable.")?;
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
