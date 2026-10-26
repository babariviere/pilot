//! One owned worker: replaceable/cancellable reads, non-replaceable explicit saves.
use crate::{
    LocalOptions,
    mission_brief::{self as model, Current, Outcome, Save, Source},
    mission_browser::Home,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
#[cfg(test)]
#[path = "mission_brief_reader_tests.rs"]
mod tests;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Current,
    History,
    Revision(u64),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Request {
    pub(crate) source: Source,
    pub(crate) generation: u64,
    pub(crate) kind: Kind,
}
#[derive(Debug)]
pub(crate) enum Data {
    Current(Current),
    History(Vec<model::Revision>),
    Revision(Arc<model::Brief>),
}
pub(crate) struct Response {
    pub(crate) request: Request,
    pub(crate) result: Result<Data, &'static str>,
}
pub(crate) struct Saved {
    pub(crate) save: Save,
    pub(crate) outcome: Outcome,
}
pub(crate) struct Updates {
    pub(crate) reads: async_channel::Receiver<Response>,
    pub(crate) saves: async_channel::Receiver<Saved>,
}
pub(crate) struct Reader {
    reads: async_channel::Sender<Option<Request>>,
    replace: async_channel::Receiver<Option<Request>>,
    saves: async_channel::Sender<Save>,
    saving: Arc<AtomicBool>,
}
struct Close {
    reads: async_channel::Receiver<Option<Request>>,
    saves: async_channel::Receiver<Save>,
}
impl Drop for Close {
    fn drop(&mut self) {
        self.reads.close();
        self.saves.close();
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.reads.close();
        self.saves.close();
    }
}
impl Reader {
    pub(crate) fn start(options: LocalOptions) -> Result<(Self, Updates), &'static str> {
        let (read, reads) = async_channel::bounded(1);
        let replace = reads.clone();
        let (save, saves) = async_channel::bounded(1);
        let saving = Arc::new(AtomicBool::new(false));
        let flag = saving.clone();
        let (read_tx, read_rx) = async_channel::bounded(1);
        let stale = read_rx.clone();
        let (save_tx, save_rx) = async_channel::bounded(1);
        std::thread::Builder::new()
            .name("local-brief-workspace".into())
            .spawn(move || {
                let _close = Close {
                    reads: reads.clone(),
                    saves: saves.clone(),
                };
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    rt.block_on(run(options, reads, saves, read_tx, stale, save_tx, flag));
                }
            })
            .map_err(|_| "Cannot start the Local brief worker.")?;
        Ok((
            Self {
                reads: read,
                replace,
                saves: save,
                saving,
            },
            Updates {
                reads: read_rx,
                saves: save_rx,
            },
        ))
    }
    pub(crate) fn read(&self, request: Option<Request>) -> bool {
        match self.reads.try_send(request) {
            Ok(()) => true,
            Err(async_channel::TrySendError::Full(r)) => {
                let _ = self.replace.try_recv();
                self.reads.try_send(r).is_ok()
            }
            Err(async_channel::TrySendError::Closed(_)) => false,
        }
    }
    pub(crate) fn save(&self, save: Save) -> bool {
        if self
            .saving
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        if self.saves.try_send(save).is_ok() {
            true
        } else {
            self.saving.store(false, Ordering::Release);
            false
        }
    }
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn disconnect_fixture(&self) {
        self.reads.close();
        self.saves.close();
    }
}
async fn run(
    options: LocalOptions,
    reads: async_channel::Receiver<Option<Request>>,
    saves: async_channel::Receiver<Save>,
    tx: async_channel::Sender<Response>,
    stale: async_channel::Receiver<Response>,
    saved: async_channel::Sender<Saved>,
    saving: Arc<AtomicBool>,
) {
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(1)
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
    else {
        return;
    };
    enum Next {
        Read(Option<Request>),
        Save(Save),
    }
    let mut next = None;
    loop {
        let command = match next.take() {
            Some(n) => n,
            None => tokio::select! {biased;
                s=saves.recv()=>match s {Ok(s)=>Next::Save(s),Err(_)=>return},
                r=reads.recv()=>match r {Ok(r)=>Next::Read(r),Err(_)=>return},
            },
        };
        match command {
            Next::Read(None) => {}
            Next::Read(Some(request)) => {
                let result = tokio::select! {biased;
                    s=saves.recv()=>{match s {Ok(s)=>next=Some(Next::Save(s)),Err(_)=>return};continue;},
                    r=reads.recv()=>{match r {Ok(r)=>next=Some(Next::Read(r)),Err(_)=>return};continue;},
                    result=fetch(&client,&options,&request)=>result,
                };
                let response = Response { request, result };
                if let Err(async_channel::TrySendError::Full(r)) = tx.try_send(response) {
                    let _ = stale.try_recv();
                    let _ = tx.try_send(r);
                }
            }
            Next::Save(save) => {
                // Navigation/read cancellation MUST NOT drop this future or its ACK.
                let outcome = write(&client, &options, &save).await;
                if saved.send(Saved { save, outcome }).await.is_err() {
                    return;
                }
                saving.store(false, Ordering::Release);
            }
        }
    }
}
async fn body(mut response: reqwest::Response, cap: usize) -> Result<Value, &'static str> {
    if response.content_length().is_some_and(|n| n > cap as u64) {
        return Err("Brief response exceeds the wire limit; partial JSON was not decoded.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Brief response was interrupted.")?
    {
        if bytes.len().saturating_add(chunk.len()) > cap {
            return Err("Brief response exceeds the wire limit; partial JSON was not decoded.");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Brief response JSON is invalid.")
}
async fn get(
    client: &reqwest::Client,
    options: &LocalOptions,
    path: &str,
    cap: usize,
) -> Result<Option<Value>, &'static str> {
    let response = client
        .get(format!("{}{path}", options.loopback()))
        .send()
        .await
        .map_err(|_| "Local brief read failed. Retry explicitly.")?;
    match response.status().as_u16() {
        200 => body(response, cap).await.map(Some),
        404 => Ok(None),
        _ => Err("Local brief read was refused or unavailable."),
    }
}
async fn qualify(
    client: &reqwest::Client,
    options: &LocalOptions,
    source: &Source,
) -> Result<u64, &'static str> {
    if !source.valid() || source.key.home != Home::local(&options.host()) {
        return Err(
            "Brief source is unavailable in this pinned Local profile. No host fallback was attempted.",
        );
    }
    let data =
        crate::mission_reader::fetch(client, options, &crate::mission_reader::Route::Catalog)
            .await?;
    let crate::mission_reader::Data::Catalog(catalog) = data else {
        return Err("Canonical brief catalog is unavailable.");
    };
    if !source.canonical(&catalog) {
        return Err(
            "Exact canonical mission/project evidence is absent from the received catalog. No lookup was guessed.",
        );
    }
    let header = get(
        client,
        options,
        &format!("/api/missions/{}", source.key.id),
        model::WIRE_BYTES,
    )
    .await?
    .ok_or("Canonical mission is no longer available.")?;
    model::header(source, &header)
}
pub(crate) async fn fetch(
    client: &reqwest::Client,
    options: &LocalOptions,
    request: &Request,
) -> Result<Data, &'static str> {
    let source = &request.source;
    let latest = qualify(client, options, source).await?;
    let path = format!("/api/missions/{}/brief", source.key.id);
    match request.kind {
        Kind::Current => match get(client, options, &path, model::WIRE_BYTES).await? {
            Some(value) => {
                let brief = Arc::new(model::parse(source, &value, None)?);
                if brief.revision.number < latest {
                    return Err(
                        "Brief response predates the received mission revision. Refresh explicitly.",
                    );
                }
                Ok(Data::Current(Current {
                    source: source.clone(),
                    brief: Some(brief),
                }))
            }
            None if latest == 0 => Ok(Data::Current(Current {
                source: source.clone(),
                brief: None,
            })),
            None => Err("Current brief is unavailable; a missing response is not an empty brief."),
        },
        Kind::History => {
            let value = get(
                client,
                options,
                &format!("{path}/revisions"),
                model::HISTORY_BYTES,
            )
            .await?
            .ok_or("Brief revision history is unavailable.")?;
            Ok(Data::History(model::history(&value)?))
        }
        Kind::Revision(n) => {
            if n == 0 || n > model::MAX_REVISION {
                return Err("Requested immutable revision is invalid.");
            }
            let value = get(
                client,
                options,
                &format!("{path}?revision={n}"),
                model::WIRE_BYTES,
            )
            .await?
            .ok_or("This immutable brief revision is unavailable.")?;
            Ok(Data::Revision(Arc::new(model::parse(
                source,
                &value,
                Some(n),
            )?)))
        }
    }
}
pub(crate) async fn write(
    client: &reqwest::Client,
    options: &LocalOptions,
    save: &Save,
) -> Outcome {
    if save.expected >= model::MAX_REVISION
        || save.markdown.len() > model::EDIT_BYTES
        || save.base.len() > model::EDIT_BYTES
        || (save.expected == 0 && !save.base.is_empty())
    {
        return Outcome::Rejected(
            "Captured brief save is outside its admitted limits. No save was sent.",
        );
    }
    let latest = match qualify(client, options, &save.source).await {
        Ok(n) => n,
        Err(e) => return Outcome::Rejected(e),
    };
    if latest != save.expected {
        return Outcome::Conflict;
    }
    let path = format!("/api/missions/{}/brief", save.source.key.id);
    if save.expected > 0 {
        match get(
            client,
            options,
            &format!("{path}?revision={}", save.expected),
            model::WIRE_BYTES,
        )
        .await
        {
            Ok(Some(v)) => match model::parse(&save.source, &v, Some(save.expected)) {
                Ok(b) if b.markdown == save.base => {}
                _ => {
                    return Outcome::Rejected(
                        "Captured base differs from the immutable received revision. No save was sent.",
                    );
                }
            },
            _ => {
                return Outcome::Rejected("Captured base could not be verified. No save was sent.");
            }
        }
    }
    let bytes = match serde_json::to_vec(
        &json!({"markdown":save.markdown.as_ref(),"expectedRevision":save.expected}),
    ) {
        Ok(b) if b.len() <= 1024 * 1024 => b,
        _ => {
            return Outcome::Rejected(
                "Encoded brief save exceeds the daemon request limit. No save was sent.",
            );
        }
    };
    let response = match client
        .put(format!("{}{path}", options.loopback()))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(bytes)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            return Outcome::Unknown(
                "Brief Save has no confirmed response. It may have committed; copy your draft and review latest before another Save.",
            );
        }
    };
    match response.status().as_u16() {
        200 => match body(response, model::WIRE_BYTES)
            .await
            .and_then(|v| model::parse(&save.source, &v, None))
        {
            Ok(b) if save.acknowledges(&b) => Outcome::Confirmed(Arc::new(b)),
            _ => Outcome::Unknown(
                "Save response could not be validated. The captured operation remains unconfirmed.",
            ),
        },
        409 => Outcome::Conflict,
        _ => Outcome::Unknown(
            "Save returned no confirmed success. A post-commit error is possible; your captured draft is retained.",
        ),
    }
}
