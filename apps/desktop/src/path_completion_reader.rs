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

fn daemon_label(hello: &Value) -> String {
    match hello["daemonVersion"].as_str().filter(|v| !v.is_empty()) {
        Some(version) => format!("daemon {}", display_reason(version, 64)),
        None => "daemon".into(),
    }
}

/// Daemon error text is diagnostic data, never markup or a fallback instruction.
fn display_reason(reason: &str, limit: usize) -> String {
    let mut chars = reason
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !c.is_control());
    let mut text: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        text.push('…');
    }
    text
}

fn refusal(status: u16, bytes: &[u8], hello: &Value) -> String {
    let body = serde_json::from_slice::<Value>(bytes).ok();
    let reason = body.as_ref().and_then(|v| v["error"].as_str());
    let reason = reason.map(|s| display_reason(s, 512)).unwrap_or_default();
    let reason = if reason.trim().is_empty() {
        "No reason returned."
    } else {
        &reason
    };
    let daemon = daemon_label(hello);
    if status == 404 && reason == "Not found" {
        return format!(
            "Path completion endpoint missing on {daemon} (HTTP 404). Check Settings → Updates."
        );
    }
    format!("Path completion refused by {daemon} (HTTP {status}). {reason}")
}

pub(crate) async fn fetch(
    client: &reqwest::Client,
    options: &LocalOptions,
    capture: &Capture,
) -> Result<Candidates, String> {
    let hello = crate::local_client::hello(client, options).await?;
    if hello["capabilities"]["sessionPathCandidates"] != 1 {
        return Err(format!(
            "Path completion is not supported by this {}. Check Settings → Updates.",
            daemon_label(&hello)
        ));
    }
    if !crate::local_model::valid_id(&capture.target.chat)
        || capture.target.cwd.is_empty()
        || !valid_prefix(&capture.token.prefix)
    {
        return Err("Path source unavailable.".into());
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
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    if response.content_length().is_some_and(|n| n > 16384) {
        return Err(format!("Path response exceeded its bound (HTTP {status})."));
    }
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| format!("Path response interrupted (HTTP {status})."))?
    {
        if bytes.len() + chunk.len() > 16384 {
            return Err(format!("Path response exceeded its bound (HTTP {status})."));
        }
        bytes.extend_from_slice(&chunk);
    }
    if status != 200 {
        return Err(refusal(status, &bytes, &hello));
    }
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid path response.")?;
    if v["sessionId"] != capture.target.chat
        || v["cwd"] != capture.target.cwd
        || v["prefix"] != capture.token.prefix
        || v["daemonId"] != host.daemon_id
        || v["lineageId"] != host.lineage_id
    {
        return Err("Path completion source changed.".into());
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
            return Err("Invalid candidate scope.".into());
        }
        // A candidate must be a direct child of the queried parent, never a deeper path.
        if path.rsplit_once('/').map(|(p, _)| p)
            != capture.token.prefix.rsplit_once('/').map(|(p, _)| p)
        {
            return Err("Invalid candidate parent.".into());
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
    pub(crate) result: Result<Candidates, String>,
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
