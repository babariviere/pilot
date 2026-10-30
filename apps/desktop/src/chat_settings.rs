//! Host-global chat settings on the Local daemon. GET reads; only an explicit toggle PATCHes,
//! with the revision it was read at. Nothing is retried, polled or written on load.
use crate::LocalOptions;
use serde::Deserialize;
use std::time::Duration;

const PATH: &str = "/api/chat-settings";
/// The settings document is three short fields; anything larger is not this contract.
const RESPONSE_BYTES: usize = 4 * 1024;
/// Opaque daemon revision (a UUID today). Bounded so a hostile reply cannot grow state.
const REVISION_BYTES: usize = 256;

/// One acknowledged daemon value and the revision a write must name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub(crate) auto_handoff: bool,
    pub(crate) revision: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Wire {
    schema_version: u64,
    auto_handoff: bool,
    revision: String,
}

/// Strict schema 1 document: exactly three fields, a bounded non-empty revision.
pub(crate) fn parse(bytes: &[u8]) -> Option<Snapshot> {
    let wire: Wire = serde_json::from_slice(bytes).ok()?;
    (wire.schema_version == 1
        && !wire.revision.is_empty()
        && wire.revision.len() <= REVISION_BYTES
        && !wire.revision.chars().any(char::is_control))
    .then_some(Snapshot {
        auto_handoff: wire.auto_handoff,
        revision: wire.revision,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReadFailure {
    /// The daemon predates the endpoint. Never read as "off".
    Unsupported,
    /// Unreachable, identity changed, or the daemon reported the store unavailable.
    Unavailable,
    /// A reply that is not exactly the schema 1 document.
    Unreadable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Saved {
    /// 200 with exactly the requested value and a new revision.
    Ack(Snapshot),
    /// 409. Carries the one read-back taken right after it.
    Conflict(Result<Snapshot, ReadFailure>),
    /// 400. The daemon refused the body; nothing changed.
    Rejected,
    Unsupported,
    /// Refused before the PATCH left this process.
    NotSent,
    /// Sent, but no exact acknowledgment: the value may or may not have changed.
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Reply {
    Read(Result<Snapshot, ReadFailure>),
    Save(Saved),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Job {
    Read,
    Save {
        auto_handoff: bool,
        expected_revision: String,
    },
}
impl Job {
    /// What a vanished courier means for this job: a read learned nothing, a save is unknown.
    pub(crate) fn lost(&self) -> Reply {
        match self {
            Self::Read => Reply::Read(Err(ReadFailure::Unavailable)),
            Self::Save { .. } => Reply::Save(Saved::Unknown),
        }
    }
    fn refused(&self) -> Reply {
        match self {
            Self::Read => Reply::Read(Err(ReadFailure::Unavailable)),
            Self::Save { .. } => Reply::Save(Saved::NotSent),
        }
    }
}

/// Runs one job on its own short-lived thread. The owner admits one job at a time.
pub(crate) fn start(
    options: LocalOptions,
    job: Job,
) -> Result<async_channel::Receiver<Reply>, Reply> {
    let refused = job.refused();
    let (tx, rx) = async_channel::bounded(1);
    std::thread::Builder::new()
        .name("local-chat-settings".into())
        .spawn(move || {
            let refused = job.refused();
            let reply = match (
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build(),
                client(),
            ) {
                (Ok(runtime), Ok(client)) => runtime.block_on(run(&client, &options, job)),
                _ => refused,
            };
            let _ = tx.send_blocking(reply);
        })
        .map_err(|_| refused)?;
    Ok(rx)
}

pub(crate) fn client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(10))
        .build()
}

pub(crate) async fn run(client: &reqwest::Client, options: &LocalOptions, job: Job) -> Reply {
    match job {
        Job::Read => Reply::Read(read(client, options).await),
        Job::Save {
            auto_handoff,
            expected_revision,
        } => Reply::Save(save(client, options, auto_handoff, &expected_revision).await),
    }
}

async fn body(mut response: reqwest::Response) -> Option<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|n| n > RESPONSE_BYTES as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > RESPONSE_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    Some(bytes)
}

pub(crate) async fn read(
    client: &reqwest::Client,
    options: &LocalOptions,
) -> Result<Snapshot, ReadFailure> {
    crate::local_client::gate(client, options)
        .await
        .map_err(|_| ReadFailure::Unavailable)?;
    let response = client
        .get(format!("{}{PATH}", options.loopback()))
        .send()
        .await
        .map_err(|_| ReadFailure::Unavailable)?;
    match response.status().as_u16() {
        200 => body(response)
            .await
            .and_then(|bytes| parse(&bytes))
            .ok_or(ReadFailure::Unreadable),
        404 | 405 | 501 => Err(ReadFailure::Unsupported),
        _ => Err(ReadFailure::Unavailable),
    }
}

pub(crate) async fn save(
    client: &reqwest::Client,
    options: &LocalOptions,
    auto_handoff: bool,
    expected_revision: &str,
) -> Saved {
    if expected_revision.is_empty() || expected_revision.len() > REVISION_BYTES {
        return Saved::NotSent;
    }
    if crate::local_client::gate(client, options).await.is_err() {
        return Saved::NotSent;
    }
    let request = serde_json::json!({
        "autoHandoff": auto_handoff,
        "expectedRevision": expected_revision,
    });
    let response = client
        .patch(format!("{}{PATH}", options.loopback()))
        .header("Content-Type", "application/json")
        .body(request.to_string())
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        // A refused connection never delivered the body. Anything later might have.
        Err(error) if error.is_connect() => return Saved::NotSent,
        Err(_) => return Saved::Unknown,
    };
    match response.status().as_u16() {
        200 => match body(response).await.and_then(|bytes| parse(&bytes)) {
            Some(saved)
                if saved.auto_handoff == auto_handoff && saved.revision != expected_revision =>
            {
                Saved::Ack(saved)
            }
            _ => Saved::Unknown,
        },
        409 => Saved::Conflict(read(client, options).await),
        400 => Saved::Rejected,
        404 | 405 | 501 => Saved::Unsupported,
        // 503 after a PATCH means the daemon could not confirm its own write.
        _ => Saved::Unknown,
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Phase {
    #[default]
    Idle,
    Loading,
    /// The requested value. The shown value stays the acknowledged one until the reply.
    Saving(bool),
}

/// The last outcome worth saying. Each carries the requested value where it matters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Note {
    Saved(bool),
    Unsupported,
    LoadFailed,
    Conflict,
    Rejected,
    NotSent,
    Unknown(bool),
}

/// Pure owner state: the acknowledged value, at most one request in flight, one note.
#[derive(Debug, Default)]
pub(crate) struct Model {
    current: Option<Snapshot>,
    phase: Phase,
    note: Option<Note>,
    request: u64,
}
impl Model {
    /// Acknowledged value, or None when unknown, unavailable or not yet read.
    pub(crate) fn value(&self) -> Option<bool> {
        self.current.as_ref().map(|s| s.auto_handoff)
    }
    pub(crate) fn phase(&self) -> Phase {
        self.phase
    }
    pub(crate) fn note(&self) -> Option<Note> {
        self.note
    }
    pub(crate) fn begin_read(&mut self) -> Option<(u64, Job)> {
        if self.phase != Phase::Idle {
            return None;
        }
        self.request += 1;
        self.phase = Phase::Loading;
        self.note = None;
        Some((self.request, Job::Read))
    }
    /// Only from an acknowledged value that differs; never from Unknown.
    pub(crate) fn begin_save(&mut self, auto_handoff: bool) -> Option<(u64, Job)> {
        let current = self.current.as_ref()?;
        if self.phase != Phase::Idle || current.auto_handoff == auto_handoff {
            return None;
        }
        let job = Job::Save {
            auto_handoff,
            expected_revision: current.revision.clone(),
        };
        self.request += 1;
        self.phase = Phase::Saving(auto_handoff);
        self.note = None;
        Some((self.request, job))
    }
    /// Applies the reply for the request in flight. Stale or duplicate replies are ignored.
    pub(crate) fn finish(&mut self, request: u64, reply: Reply) -> bool {
        if request != self.request || self.phase == Phase::Idle {
            return false;
        }
        let requested = match std::mem::take(&mut self.phase) {
            Phase::Saving(value) => value,
            _ => false,
        };
        match reply {
            Reply::Read(Ok(snapshot)) => {
                self.current = Some(snapshot);
                self.note = None;
            }
            Reply::Read(Err(failure)) => {
                self.current = None;
                self.note = Some(match failure {
                    ReadFailure::Unsupported => Note::Unsupported,
                    _ => Note::LoadFailed,
                });
            }
            Reply::Save(Saved::Ack(snapshot)) => {
                self.note = Some(Note::Saved(snapshot.auto_handoff));
                self.current = Some(snapshot);
            }
            Reply::Save(Saved::Conflict(observed)) => {
                self.current = observed.ok();
                self.note = Some(Note::Conflict);
            }
            Reply::Save(Saved::Rejected) => self.note = Some(Note::Rejected),
            Reply::Save(Saved::NotSent) => self.note = Some(Note::NotSent),
            Reply::Save(Saved::Unsupported) => {
                self.current = None;
                self.note = Some(Note::Unsupported);
            }
            Reply::Save(Saved::Unknown) => {
                self.current = None;
                self.note = Some(Note::Unknown(requested));
            }
        }
        true
    }
    /// "Saved" describes the last action; it does not outlive leaving the page.
    pub(crate) fn clear_saved(&mut self) -> bool {
        let saved = matches!(self.note, Some(Note::Saved(_)));
        if saved {
            self.note = None;
        }
        saved
    }
}

#[cfg(test)]
#[path = "chat_settings_tests.rs"]
mod tests;
