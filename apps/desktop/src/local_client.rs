//! Local-only, GET-only transport. No credentials, mutation routes or app WS messages.
//! A private runtime owns sockets/reducers. UI receives a coalesced bounded projection.
use crate::{
    local_model::{self, Chat, LiveTranscript},
    model::Message,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::task::JoinHandle;
use tokio_tungstenite::{
    client_async_with_config,
    tungstenite::{Message as Frame, protocol::WebSocketConfig},
};

type Failure = &'static str;
#[path = "model_scope_access.rs"]
mod model_scope_access;

#[derive(Clone)]
pub struct LocalOptions {
    externally_managed: bool,
    port: u16,
    daemon_id: String,
    lineage_id: String,
    native_home: Option<PathBuf>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    update_policy: std::collections::BTreeMap<String, String>,
}

impl LocalOptions {
    /// Context for an explicit request only. The native bridge must prove the
    /// actual owner and service; this getter never grants lifecycle authority.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn daemon_upgrade_location(
        &self,
    ) -> Option<pilot_desktop_updater::coordination::Location> {
        Some(pilot_desktop_updater::coordination::Location {
            home: self.native_home.clone()?,
            port: self.port,
            policy: self.update_policy.clone(),
        })
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn update_location(&self) -> Option<pilot_desktop_updater::coordination::Location> {
        if self.externally_managed {
            return None;
        }
        Some(pilot_desktop_updater::coordination::Location {
            home: self.native_home.clone()?,
            port: self.port,
            policy: self.update_policy.clone(),
        })
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn external_update_connection(
        &self,
    ) -> Option<pilot_desktop_updater::app_update::Connection> {
        if !self.externally_managed {
            return None;
        }
        Some(pilot_desktop_updater::app_update::Connection::new(
            pilot_desktop_updater::coordination::Location {
                home: self.native_home.clone()?,
                port: self.port,
                policy: self.update_policy.clone(),
            },
            self.daemon_id.clone(),
            self.lineage_id.clone(),
        ))
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn from_update_connection(
        connection: pilot_desktop_updater::app_update::Connection,
    ) -> Result<Self, Failure> {
        let options = Self::discover_at(connection.location().clone())?;
        if options.daemon_id != connection.daemon() || options.lineage_id != connection.lineage() {
            return Err("Update Local identity changed. No replacement daemon was started.");
        }
        options.verify_existing()
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn discover_at(
        location: pilot_desktop_updater::coordination::Location,
    ) -> Result<Self, &'static str> {
        let home = location.home;
        Ok(Self {
            externally_managed: false,
            port: location.port,
            daemon_id: identity_file(home.join("daemon-id"))?,
            lineage_id: identity_file(home.join("storage-lineage"))?,
            native_home: Some(home),
            update_policy: location.policy,
        })
    }
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn synthetic(port: u16) -> Self {
        Self {
            externally_managed: false,
            port,
            daemon_id: "test-daemon".into(),
            lineage_id: "test-lineage".into(),
            native_home: None,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            update_policy: Default::default(),
        }
    }
    pub(crate) fn host(&self) -> crate::delivery_store::Host {
        crate::delivery_store::Host {
            host_id: "local".into(),
            daemon_id: self.daemon_id.clone(),
            lineage_id: self.lineage_id.clone(),
        }
    }
    pub(crate) fn loopback(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    pub(crate) fn same_todo_source(&self, other: &Self) -> bool {
        self.host() == other.host()
            && self.port == other.port
            && self.native_home == other.native_home
    }
    /// Resolve the same Local port/data-home as pilotd, without starting it or writing state.
    pub fn discover() -> Result<Self, &'static str> {
        let port = std::env::var("PILOT_PORT")
            .unwrap_or_else(|_| "4319".into())
            .parse::<u16>()
            .ok()
            .filter(|p| *p > 0)
            .ok_or("Invalid PILOT_PORT")?;
        let home = if let Some(home) = std::env::var_os("PILOT_HOME") {
            PathBuf::from(home)
        } else {
            let data = std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or(
                    PathBuf::from(std::env::var_os("HOME").ok_or("HOME is unavailable")?)
                        .join(".local/share"),
                );
            data.join("pilot")
        };
        Ok(Self {
            externally_managed: false,
            port,
            daemon_id: identity_file(home.join("daemon-id"))?,
            lineage_id: identity_file(home.join("storage-lineage"))?,
            native_home: Some(home),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            update_policy: pilot_desktop_updater::coordination::captured_policy()
                .map_err(|_| "Configured runtime policy is invalid.")?,
        })
    }

    /// Explicit existing-daemon connection. No launcher, capsule publication or profile writes.
    pub fn connect_existing() -> Result<Self, Failure> {
        Self::discover()?.verify_existing()
    }
    pub(crate) fn verify_running(self) -> Result<Self, Failure> {
        let external = self.externally_managed;
        let mut options = self.verify_existing()?;
        options.externally_managed = external;
        Ok(options)
    }
    fn verify_existing(mut self) -> Result<Self, Failure> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "Cannot start Local connection check.")?;
        runtime.block_on(async {
            let client = reqwest::Client::builder()
                .no_proxy()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(5))
                .build()
                .map_err(|_| "Cannot check the existing daemon.")?;
            gate(&client, &self).await
        })?;
        self.externally_managed = true;
        Ok(self)
    }

    pub(crate) fn verify(&self, hello: &Value) -> Result<(), Failure> {
        if hello["daemonId"] != self.daemon_id || hello["lineageId"] != self.lineage_id {
            return Err(
                "Local identity changed. Stop and verify the Local data home before relaunching.",
            );
        }
        if hello["minimumClientProtocolVersion"]
            .as_u64()
            .is_none_or(|v| v > 1)
            || hello["protocolVersion"].as_u64().is_none_or(|v| v < 1)
            || hello["capabilities"]["independentExecution"] != true
        {
            return Err("Local daemon protocol/capabilities are incompatible.");
        }
        Ok(())
    }

    fn http_url(&self, route: &ReadRoute) -> String {
        format!("http://127.0.0.1:{}{}", self.port, route.path())
    }
    fn ws_path(&self, chat: Option<&str>, resume: Option<&Resume>) -> Result<String, Failure> {
        match chat {
            None => Ok("/api/ws".into()),
            Some(id) if local_model::valid_id(id) => {
                let mut path = format!("/api/sessions/{id}/ws?history=paged-v1");
                if let Some(resume) = resume
                    && local_model::valid_id(&resume.stream)
                {
                    path.push_str(&format!("&stream={}&after={}", resume.stream, resume.seq));
                }
                Ok(path)
            }
            _ => Err("Invalid chat identity"),
        }
    }
}

fn identity_file(path: PathBuf) -> Result<String, Failure> {
    use std::io::Read;
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| "Local identity files are unavailable; start Pilot normally first.")?;
    if !metadata.file_type().is_file() || metadata.len() > 128 {
        return Err("Invalid Local identity file");
    }
    let mut value = String::new();
    std::fs::File::open(path)
        .map_err(|_| "Cannot read Local identity")?
        .take(129)
        .read_to_string(&mut value)
        .map_err(|_| "Cannot read Local identity")?;
    let value = value.trim();
    if value.len() != 36
        || !value.bytes().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
    {
        return Err("Invalid Local identity");
    }
    Ok(value.into())
}

enum ReadRoute {
    Hello,
    Session {
        id: String,
    },
    History {
        id: String,
        before: u64,
        context: Option<Value>,
    },
    Artifact {
        owner: String,
        id: String,
        revision: u32,
    },
    Subagent {
        id: String,
        name: String,
    },
}
impl ReadRoute {
    fn budget(&self) -> Option<(usize, &'static str)> {
        match self {
            Self::Hello | Self::History { .. } | Self::Session { .. } | Self::Subagent { .. } => {
                None
            }
            // Pins may not carry a kind. Their revision can still be an image.
            Self::Artifact { .. } => Some((
                crate::artifact_image::HTTP_CAP,
                "Stored artifact response exceeds the 44 MiB read budget.",
            )),
        }
    }
    fn path(&self) -> String {
        match self {
            Self::Hello => "/api/hello".into(),
            Self::Subagent { id, name } => {
                let mut url = reqwest::Url::parse("http://localhost/").expect("static URL");
                url.path_segments_mut().expect("HTTP URL").extend([
                    "api",
                    "sessions",
                    id,
                    "subagents",
                    name,
                    "transcript",
                ]);
                url.path().into()
            }
            Self::Session { id } => format!("/api/sessions/{id}"),
            Self::Artifact {
                owner,
                id,
                revision,
            } => format!("/api/sessions/{owner}/artifacts/{id}?revision={revision}"),
            Self::History {
                id,
                before,
                context,
            } => {
                let path = format!("/api/sessions/{id}/history?before={before}&limit=24");
                if let Some(context) = context {
                    let mut url = reqwest::Url::parse(&format!("http://localhost{path}"))
                        .expect("history URL");
                    url.query_pairs_mut()
                        .append_pair("view", &context.to_string());
                    format!("{}?{}", url.path(), url.query().unwrap_or_default())
                } else {
                    path
                }
            }
        }
    }
}

#[derive(Clone, Default)]
struct Resume {
    stream: String,
    seq: u64,
}

pub(crate) enum Command {
    Clear { generation: u64 },
    Open { id: String, generation: u64 },
    Earlier { before: u64, generation: u64 },
    Reconnect,
    StopThinking { generation: u64 },
}

#[derive(Clone, Default)]
pub(crate) struct Presentation {
    pub(crate) control_connection_generation: u64,
    pub(crate) failure_run_serial: u64,
    pub(crate) todos: crate::session_todos::Feed,
    pub(crate) question: crate::question::Projection,
    /// The live run awaits `question`; see `LiveTranscript::question_awaited`.
    pub(crate) question_awaited: bool,
    pub(crate) mission_metadata: Arc<crate::mission_inspector::Metadata>,
    /// Mission titles from the session socket. `None` until the daemon sends
    /// its mission list (older daemons may not).
    pub(crate) mission_titles: Option<Arc<std::collections::HashMap<String, String>>>,
    pub(crate) projects: Arc<Vec<local_model::Project>>,
    pub(crate) projects_loaded: bool,
    pub(crate) projects_error: Option<&'static str>,
    pub(crate) artifacts: Arc<Vec<crate::artifact_model::Reference>>,
    pub(crate) artifact_metadata: crate::artifact_gallery::Metadata,
    pub(crate) chats: Arc<Vec<Chat>>,
    pub(crate) rows: Vec<Message>,
    pub(crate) generation: u64,
    pub(crate) cursor: Option<u64>,
    pub(crate) page_busy: bool,
    pub(crate) page_error: bool,
    pub(crate) status: String,
    pub(crate) chat_status: String,
    pub(crate) limited: bool,
    /// Newer entries were omitted from this window; reopening shows them.
    pub(crate) behind: bool,
    /// The chat stream reported a failure rather than a routine connection.
    pub(crate) chat_issue: bool,
    pub(crate) omitted: usize,
    pub(crate) loaded: bool,
    pub(crate) list_loaded: bool,
    pub(crate) page_revision: u64,
    pub(crate) batches: u64,
    pub(crate) queued: usize,
    pub(crate) user_queue: Arc<crate::queued_message::Snapshot>,
    pub(crate) thinking: bool,
    pub(crate) compacting: bool,
    #[cfg(test)]
    pub(crate) test_publications: u64,
}

impl Presentation {
    /// The same freshness gate serves reply admission and question attention.
    /// Display priority must never change the summary's working/run semantics.
    pub(crate) fn question_fresh(&self, selected: Option<&str>, generation: u64) -> bool {
        self.generation == generation
            && self.loaded
            && !self.chat_issue
            && selected.is_some_and(|id| {
                self.chats.iter().any(|chat| {
                    chat.id == id
                        && match chat.state.as_str() {
                            "idle" | "parked" | "failed" => true,
                            "working" => self.question_awaited,
                            _ => false,
                        }
                })
            })
    }

    /// Resolve once for every consumer (sidebar, Inbox, Home, mission, palette).
    /// Keep the reader's base summaries untouched so stale/answered projections
    /// immediately return to their ordinary state, without sticky overrides.
    pub(crate) fn for_display(&self, selected: Option<&str>) -> Self {
        let mut display = self.clone();
        if self.question_fresh(selected, self.generation)
            && let crate::question::Projection::Pending(question) = &self.question
            && let Some(ix) = self
                .chats
                .iter()
                .position(|c| Some(c.id.as_str()) == selected && !c.archived)
        {
            let chat = &mut Arc::make_mut(&mut display.chats)[ix];
            chat.signal = Some(crate::state_mark::Signal::NeedsYou);
            chat.attention = Some(crate::attention::question(&question.content.question));
            chat.order.question = true;
        }
        display
    }
}

/// The daemon behind the live Local control socket, from the hello that admitted
/// that socket. Never the bundled runtime, a staged capsule or a release listing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum ConnectedDaemon {
    /// Connecting, reconnecting, refused or stopped: no daemon is known to be live.
    #[default]
    NotConnected,
    /// `None` when the daemon reported no usable version (older or malformed hello).
    Connected(Option<Arc<str>>),
}

/// Display-safe `daemonVersion` from a verified hello, else `None`.
fn daemon_version(hello: &Value) -> Option<Arc<str>> {
    hello["daemonVersion"]
        .as_str()
        .filter(|v| {
            !v.is_empty()
                && v.len() <= 64
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-+_".contains(&b))
        })
        .map(Arc::from)
}

/// Drop closes the command source; the runtime aborts every task and socket.
/// No joins, HTTP reads or file I/O occur on the UI thread.
pub(crate) struct LocalClient {
    commands: async_channel::Sender<Command>,
    /// `generation << 1 | holding`: the reader holds older rows of that
    /// window. A shared value, so position reports never queue behind reads.
    holding: Arc<std::sync::atomic::AtomicU64>,
    /// Written by the read worker as the control socket connects and drops.
    daemon: Arc<std::sync::Mutex<ConnectedDaemon>>,
}
impl LocalClient {
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn synthetic_commands() -> (Self, async_channel::Receiver<Command>) {
        let (commands, receiver) = async_channel::bounded(4);
        (
            Self {
                commands,
                holding: Default::default(),
                daemon: Default::default(),
            },
            receiver,
        )
    }
    pub(crate) fn start(options: LocalOptions) -> (Self, async_channel::Receiver<Presentation>) {
        let (commands, receiver) = async_channel::bounded(4);
        let (updates, output) = async_channel::bounded(1);
        let replace = output.clone();
        let holding = Arc::<std::sync::atomic::AtomicU64>::default();
        let worker_holding = holding.clone();
        let daemon = Arc::<std::sync::Mutex<ConnectedDaemon>>::default();
        let worker_daemon = daemon.clone();
        std::thread::Builder::new()
            .name("local-read-viewer".into())
            .spawn(move || {
                if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    runtime.block_on(run(
                        options,
                        receiver,
                        updates,
                        replace,
                        worker_holding,
                        worker_daemon,
                    ));
                }
            })
            .expect("start isolated read worker");
        (
            Self {
                commands,
                holding,
                daemon,
            },
            output,
        )
    }
    pub(crate) fn command(&self, command: Command) -> bool {
        self.commands.try_send(command).is_ok()
    }
    /// The daemon this client is connected to right now.
    pub(crate) fn daemon(&self) -> ConnectedDaemon {
        self.daemon
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
    #[cfg(all(test, target_os = "macos"))]
    pub(crate) fn set_synthetic_daemon(&self, daemon: ConnectedDaemon) {
        *self
            .daemon
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = daemon;
    }
    /// Report whether the reader follows the newest rows of `generation`.
    pub(crate) fn follow(&self, generation: u64, following: bool) {
        self.holding.store(
            generation << 1 | u64::from(!following),
            std::sync::atomic::Ordering::Relaxed,
        );
    }
    #[cfg(test)]
    pub(crate) fn holding(&self) -> (u64, bool) {
        let value = self.holding.load(std::sync::atomic::Ordering::Relaxed);
        (value >> 1, value & 1 == 1)
    }
}

#[derive(Clone)]
struct Inbox {
    epoch: u64,
    sender: async_channel::Sender<(u64, Incoming)>,
}
impl Inbox {
    async fn send(&self, event: Incoming) -> Result<(), async_channel::SendError<(u64, Incoming)>> {
        self.sender.send((self.epoch, event)).await
    }
}

enum Incoming {
    Fatal(Failure),
    /// The control socket connected; the version comes from its admitting hello.
    Daemon(Option<Arc<str>>),
    Wire {
        generation: u64,
        chat: bool,
        value: Value,
    },
    Status {
        generation: u64,
        chat: bool,
        text: &'static str,
    },
    Page {
        generation: u64,
        before: u64,
        revision: u64,
        result: Result<Value, Failure>,
    },
}

async fn get(
    client: &reqwest::Client,
    options: &LocalOptions,
    route: ReadRoute,
) -> Result<Value, Failure> {
    let budget = route.budget();
    let body = get_bytes(client, options, route, budget).await?;
    serde_json::from_slice(&body).map_err(|_| "Invalid Local JSON response")
}

async fn get_bytes(
    client: &reqwest::Client,
    options: &LocalOptions,
    route: ReadRoute,
    budget: Option<(usize, &'static str)>,
) -> Result<Vec<u8>, Failure> {
    let mut response = client
        .get(options.http_url(&route))
        .send()
        .await
        .map_err(|_| "Local read failed. Check that Pilot is running.")?;
    if matches!(route, ReadRoute::Session { .. })
        && response.status() == reqwest::StatusCode::NOT_FOUND
    {
        return Err("Chat not found on Local. Check the link or restore the chat.");
    }
    if response.status() != reqwest::StatusCode::OK {
        return Err("Local read refused (HTTP status). No redirect or authentication fallback.");
    }
    if let Some((cap, message)) = budget
        && response.content_length().is_some_and(|n| n > cap as u64)
    {
        return Err(message);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local response interrupted")?
    {
        if let Some((cap, message)) = budget
            && chunk.len() > cap.saturating_sub(body.len())
        {
            return Err(message);
        }
        let needed = body.len() + chunk.len();
        if needed > body.capacity() {
            let target = body.capacity().saturating_mul(2).max(needed);
            let target = budget.map_or(target, |(cap, _)| target.min(cap));
            body.try_reserve_exact(target - body.len())
                .map_err(|_| "Cannot allocate the Local response")?;
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Existing GET-only session contract, pinned before and after the read.
pub(crate) async fn subagent_snapshot(
    options: &LocalOptions,
    id: &str,
    name: &str,
) -> Result<Vec<Message>, Failure> {
    if !local_model::valid_id(id) || !crate::session_subagents::valid_name(name) {
        return Err("Invalid subagent identity.");
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Local read unavailable.")?;
    hello(&client, options).await?;
    let value = get(
        &client,
        options,
        ReadRoute::Subagent {
            id: id.into(),
            name: name.into(),
        },
    )
    .await?;
    hello(&client, options).await?;
    crate::session_subagents::transcript(&value, name)
}

/// Existing GET-only session contract, pinned before and after the read.
pub(crate) async fn linked_chat(options: &LocalOptions, id: &str) -> Result<Chat, Failure> {
    if !local_model::valid_id(id) {
        return Err("Invalid canonical chat identity.");
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "Cannot read the linked chat.")?;
    gate(&client, options).await?;
    let value = get(&client, options, ReadRoute::Session { id: id.into() }).await?;
    gate(&client, options).await?;
    let chat = local_model::chat(&value).ok_or("Linked chat response is invalid.")?;
    if chat.id != id {
        return Err("Linked chat identity differs. No chat was opened.");
    }
    Ok(chat)
}
pub(crate) async fn gate(client: &reqwest::Client, options: &LocalOptions) -> Result<(), Failure> {
    hello(client, options).await.map(|_| ())
}

async fn history(
    client: &reqwest::Client,
    options: &LocalOptions,
    id: String,
    before: u64,
    context: Option<Value>,
) -> Result<Value, Failure> {
    gate(client, options).await?;
    let value = get(
        client,
        options,
        ReadRoute::History {
            id,
            before,
            context,
        },
    )
    .await?;
    gate(client, options).await?;
    Ok(value)
}
pub(crate) async fn hello(
    client: &reqwest::Client,
    options: &LocalOptions,
) -> Result<Value, Failure> {
    let hello = get(client, options, ReadRoute::Hello).await?;
    options.verify(&hello)?;
    Ok(hello)
}
pub(crate) async fn artifact(
    options: &LocalOptions,
    reference: &crate::artifact_model::Reference,
) -> Result<crate::artifact_model::Revision, Failure> {
    if !local_model::valid_id(&reference.session)
        || !local_model::valid_id(&reference.id)
        || reference.revision == 0
        || reference.revision > 1_000_000
    {
        return Err("Invalid artifact read scope");
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "Cannot start artifact reader")?;
    gate(&client, options).await?;
    let route = ReadRoute::Artifact {
        owner: reference.session.clone(),
        id: reference.id.clone(),
        revision: reference.revision,
    };
    if reference.kind == "image" {
        let bytes = get_bytes(
            &client,
            options,
            route,
            Some((
                crate::artifact_image::HTTP_CAP,
                "Stored image response exceeds the 44 MiB image-envelope limit.",
            )),
        )
        .await?;
        gate(&client, options).await?;
        return crate::artifact_model::Revision::image_bytes(&bytes, reference);
    }
    let value = get(&client, options, route).await?;
    gate(&client, options).await?;
    crate::artifact_model::Revision::parse(value, reference)
}

fn socket_task(
    options: LocalOptions,
    client: reqwest::Client,
    id: Option<String>,
    generation: u64,
    inbox: Inbox,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let is_chat = id.is_some();
        let mut resume: Option<Resume> = None;
        let mut failures = 0;
        loop {
            let status = |text| Incoming::Status {
                generation,
                chat: is_chat,
                text,
            };
            let admitted = hello(&client, &options).await;
            if let Err(error) = admitted {
                if error.contains("identity") || error.contains("incompatible") {
                    let _ = inbox.send(Incoming::Fatal(error)).await;
                    return;
                }
                let _ = inbox.send(status(error)).await;
                if error.contains("HTTP status")
                    || error.contains("limit")
                    || error.contains("JSON")
                {
                    return;
                }
                // Identity/protocol failures are final; network failures are bounded retries.
                if error.contains("identity") || error.contains("incompatible") || failures >= 7 {
                    return;
                }
            } else if let Ok(hello) = admitted {
                let Ok(path) = options.ws_path(id.as_deref(), resume.as_ref()) else {
                    return;
                };
                let connected = async {
                    let stream = tokio::net::TcpStream::connect((
                        std::net::Ipv4Addr::LOCALHOST,
                        options.port,
                    ))
                    .await?;
                    let config = WebSocketConfig::default()
                        .max_message_size(None)
                        .max_frame_size(None);
                    client_async_with_config(
                        format!("ws://127.0.0.1:{}{path}", options.port),
                        stream,
                        Some(config),
                    )
                    .await
                    .map(|(socket, _)| socket)
                    .map_err(std::io::Error::other)
                };
                if let Ok(Ok(mut socket)) =
                    tokio::time::timeout(Duration::from_secs(5), connected).await
                {
                    if !is_chat {
                        let _ = inbox.send(Incoming::Daemon(daemon_version(&hello))).await;
                    }
                    let _ = inbox.send(status("Connected · Local")).await;
                    let mut welcomed = !is_chat;
                    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
                    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    let mut last_frame = tokio::time::Instant::now();
                    loop {
                        let next = tokio::select! {
                            next=socket.next()=>next,
                            _=heartbeat.tick()=>{
                                if last_frame.elapsed()>=Duration::from_secs(90) {break;}
                                if !matches!(tokio::time::timeout(Duration::from_secs(2),socket.send(Frame::Ping(Vec::new().into()))).await,Ok(Ok(()))) {break;}
                                continue;
                            }
                        };
                        last_frame = tokio::time::Instant::now();
                        match next {
                            Some(Ok(Frame::Text(text))) => {
                                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                                    let _ = inbox
                                        .send(status(
                                            "Invalid Local stream JSON; subscription stopped.",
                                        ))
                                        .await;
                                    return;
                                };
                                failures = 0;
                                if is_chat {
                                    if value["sessionId"].as_str() != id.as_deref() {
                                        continue;
                                    }
                                    if value["type"] == "chat.stream" {
                                        let Some(stream) = value["streamId"]
                                            .as_str()
                                            .filter(|s| local_model::valid_id(s))
                                        else {
                                            return;
                                        };
                                        if value["resumed"] == true
                                            && resume.as_ref().is_none_or(|r| r.stream != stream)
                                        {
                                            let _ = inbox.send(status("Invalid Local resume identity; subscription stopped.")).await;
                                            return;
                                        }
                                        let seq = if value["resumed"] == true {
                                            resume.as_ref().map_or(0, |r| r.seq)
                                        } else {
                                            0
                                        };
                                        resume = Some(Resume {
                                            stream: stream.into(),
                                            seq,
                                        });
                                        welcomed = true;
                                    } else if value["type"] == "events" {
                                        let Some(seq) = value["seq"].as_u64() else {
                                            break;
                                        };
                                        if !welcomed {
                                            break;
                                        }
                                        let state =
                                            resume.as_mut().expect("welcome creates resume");
                                        if seq <= state.seq {
                                            continue;
                                        }
                                        if seq != state.seq + 1 {
                                            break;
                                        }
                                        state.seq = seq;
                                    }
                                }
                                if inbox
                                    .send(Incoming::Wire {
                                        generation,
                                        chat: is_chat,
                                        value,
                                    })
                                    .await
                                    .is_err()
                                {
                                    return;
                                }
                            }
                            Some(Ok(Frame::Close(close))) => {
                                if close.is_some_and(|c| (4400..4500).contains(&u16::from(c.code)))
                                {
                                    let _ = inbox
                                        .send(status(
                                            "Local subscription refused; use Reconnect to retry.",
                                        ))
                                        .await;
                                    return;
                                }
                                break;
                            }
                            Some(Err(tokio_tungstenite::tungstenite::Error::Capacity(_))) => {
                                let _ = inbox.send(status("Local WebSocket capacity error; subscription stopped. Use Reconnect to retry.")).await;
                                return;
                            }
                            Some(Ok(Frame::Ping(_) | Frame::Pong(_))) => {}
                            _ => break,
                        }
                    }
                }
            }
            failures += 1;
            if failures >= 8 {
                let _ = inbox
                    .send(status("Local disconnected; use Reconnect to retry."))
                    .await;
                return;
            }
            let _ = inbox
                .send(status(
                    "Local disconnected. Reconnecting with identity validation…",
                ))
                .await;
            tokio::time::sleep(Duration::from_millis(
                (500_u64 << failures.min(5)).min(10_000),
            ))
            .await;
        }
    })
}

const DEPARTED_SETTLE: Duration = Duration::from_millis(250);

fn publish(
    updates: &async_channel::Sender<Presentation>,
    replace: &async_channel::Receiver<Presentation>,
    value: Presentation,
) {
    if let Err(async_channel::TrySendError::Full(value)) = updates.try_send(value) {
        // Only complete projections are coalesced. No wire delta is discarded.
        let _ = replace.try_recv();
        let _ = updates.try_send(value);
    }
}

async fn run(
    options: LocalOptions,
    commands: async_channel::Receiver<Command>,
    updates: async_channel::Sender<Presentation>,
    replace: async_channel::Receiver<Presentation>,
    holding: Arc<std::sync::atomic::AtomicU64>,
    daemon: Arc<std::sync::Mutex<ConnectedDaemon>>,
) {
    let set_daemon = |value: ConnectedDaemon| {
        *daemon
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = value;
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .expect("Local HTTP client");
    let (sender, incoming) = async_channel::bounded(2);
    let mut inbox = Inbox { epoch: 0, sender };
    let mut fenced = false;
    let mut control = socket_task(options.clone(), client.clone(), None, 0, inbox.clone());
    let mut chat_socket: Option<JoinHandle<()>> = None;
    let mut page_task: Option<JoinHandle<()>> = None;
    let mut snapshot_revision = 0_u64;
    let mut awaiting_snapshot = false;
    let mut selected: Option<String> = None;
    let mut model = LiveTranscript::default();
    let mut view = Presentation {
        status: "Connecting to Local…".into(),
        ..Default::default()
    };
    publish(&updates, &replace, view.clone());
    // A consumed queue row waits this long for its history entry from the other stream.
    let mut settle: Option<tokio::time::Instant> = None;
    loop {
        tokio::select! {
            _ = async { tokio::time::sleep_until(settle.unwrap_or_else(tokio::time::Instant::now)).await }, if settle.is_some() => {
                settle = None;
                model.settle_departed();
            }
            command = commands.recv() => match command {
                Err(_) => break,
                Ok(Command::Clear {generation})=>{
                    if let Some(task)=chat_socket.take(){task.abort();}
                    if let Some(task)=page_task.take(){task.abort();}
                    view.todos=Default::default();selected=None;model=LiveTranscript::default();model.presentation_dirty=true;view.generation=generation;view.page_busy=false;view.page_error=false;view.chat_status.clear();view.chat_issue=false;view.batches=0;view.queued=0;view.user_queue=Arc::default();view.artifacts=Arc::new(Vec::new());view.artifact_metadata=Default::default();
                }
                Ok(Command::Open { id, generation }) => {
                    if fenced || !local_model::valid_id(&id) { continue; }
                    if let Some(task) = chat_socket.take() { task.abort(); }
                    if let Some(task) = page_task.take() { task.abort(); }
                    awaiting_snapshot = true;
                    view.todos = crate::session_todos::Feed::new(crate::session_todos::Source::new(options.clone(), id.clone(), generation));
                    selected = Some(id.clone());
                    view.artifacts=Arc::new(Vec::new());
                    view.artifact_metadata=Default::default();
                    model = LiveTranscript::default();
                    model.image_owner = Some((options.host(), id.clone()));
                    model.presentation_dirty = true;
                    view.generation = generation; view.page_busy = false; view.page_error=false; view.chat_status = "Loading chat…".into(); view.chat_issue=false; view.batches=0;view.queued=0;view.user_queue=Arc::default();
                    chat_socket = Some(socket_task(options.clone(),client.clone(),Some(id),generation,inbox.clone()));
                }
                Ok(Command::Earlier { before, generation }) => {
                    if fenced || generation != view.generation || view.page_busy || model.cursor != Some(before) || model.prefix_pending || !model.has_capacity() { continue; }
                    let Some(id) = selected.clone() else { continue; };
                    let (options, client, inbox) = (options.clone(),client.clone(),inbox.clone());
                    view.page_busy = true; view.page_error=false;
                    let revision = snapshot_revision;
                    let context = model.history_context.clone();
                    page_task = Some(tokio::spawn(async move {
                        let result = history(&client,&options,id,before,context).await;
                        let _ = inbox.send(Incoming::Page { generation,before,revision,result }).await;
                    }));
                }
                Ok(Command::Reconnect) => {
                    model.thinking=false; model.stale(); awaiting_snapshot=true;
                    set_daemon(ConnectedDaemon::NotConnected);
                    view.todos.stale();
                    inbox.epoch+=1; fenced=false;
                    if let Some(task)=page_task.take() {task.abort();} view.page_busy=false;
                    control.abort();
                    control = socket_task(options.clone(),client.clone(),None,0,inbox.clone());
                    if let Some(id) = selected.clone() {
                        if let Some(task) = chat_socket.take() { task.abort(); }
                        chat_socket = Some(socket_task(options.clone(),client.clone(),Some(id),view.generation,inbox.clone()));
                    }
                }
                Ok(Command::StopThinking { generation }) => {
                    if generation == view.generation { model.stop_thinking(); }
                }
            },
            event = incoming.recv() => match event {
                Err(_) => break,
                Ok((epoch,_)) if epoch != inbox.epoch => continue,
                Ok((_,Incoming::Fatal(text))) => {
                    model.stop_thinking(); model.stale();
                    set_daemon(ConnectedDaemon::NotConnected);
                    view.todos.stale();
                    fenced=true; control.abort();
                    if let Some(task)=chat_socket.take() {task.abort();}
                    if let Some(task)=page_task.take() {task.abort();}
                    view.page_busy=false; view.status=text.into(); view.chat_status=text.into();view.chat_issue=true;view.artifact_metadata.mark_stale();
                },
                Ok((_, Incoming::Status {generation, chat, text})) => {
                    if !chat || generation == view.generation { model.thinking=false; }
                    if chat { if generation != view.generation { continue; }
                        view.chat_issue = text!="Connected · Local";
                        if view.chat_issue{snapshot_revision+=1; if let Some(task)=page_task.take(){task.abort();} view.page_busy=false; view.page_revision+=1; view.artifact_metadata.mark_stale();view.todos.stale();model.stale();} view.chat_status = text.into(); }
                    else {
                        if text != "Connected · Local" { set_daemon(ConnectedDaemon::NotConnected); }
                        view.status = text.into();
                    }
                }
                Ok((_, Incoming::Daemon(version))) => {
                    view.control_connection_generation += 1;
                    set_daemon(ConnectedDaemon::Connected(version));
                },
                Ok((_, Incoming::Page { generation,before,revision,result })) => {
                    if generation != view.generation || revision != snapshot_revision { continue; }
                    view.page_busy = false;
                    view.page_revision+=1;
                    match result {
                        Ok(value) if model.page(before,&value) => { view.page_error=false; },
                        _ => { view.page_error=true; }
                    }
                }
                Ok((_, Incoming::Wire {generation,chat: is_chat,value})) => {
                    if is_chat {
                        if generation != view.generation || value["sessionId"].as_str()!=selected.as_deref() { continue; }
                        if value["type"] == "chat.stream" {awaiting_snapshot = value["resumed"] != true; snapshot_revision += 1; if let Some(task) = page_task.take() { task.abort(); } view.page_busy=false; view.page_error=false; view.page_revision+=1; view.todos.stream();model.compaction_stream(value["resumed"] == true);}
                        else if value["type"] == "artifacts" && value["sessionId"].as_str()==selected.as_deref(){if let Some(items)=view.artifact_metadata.accept(&value["artifacts"],selected.as_deref().unwrap_or("")){view.artifacts=items;}}
                        else if value["type"] == "events" && let Some(events) = value["events"].as_array() {
                            view.batches+=1;
                            let reader = holding.load(std::sync::atomic::Ordering::Relaxed);
                            model.holding = reader >> 1 == generation && reader & 1 == 1;
                            for event in events {
                                if event["type"] == "snapshot" { awaiting_snapshot=false; snapshot_revision += 1; if let Some(task) = page_task.take() { task.abort(); } view.page_busy=false; view.page_revision+=1; }
                                view.todos.apply(event);
                                if event["type"] == "history_error" { model.stale(); view.chat_issue=true; view.chat_status="Chat history could not be loaded. Reconnect to retry.".into(); }
                                if event["type"] != "todos_update" { model.apply(event); }
                            }
                            // Repeated reasoning deltas only update bounded
                            // counters. Do not publish/clone a transcript or
                            // wake the UI when the activity label is unchanged.
                            if events.iter().all(local_model::reasoning_deltas_only) && view.thinking == model.thinking { continue; }
                        } else if value["type"] == "error" { view.todos.stale(); model.stop_thinking(); model.stale(); view.chat_issue=true; view.chat_status = "Local chat unavailable; details omitted for privacy.".into(); }
                    } else if value["type"] == "projects" {
                        match local_model::projects(&value["projects"]) {
                            Ok(projects)=>{view.projects=Arc::new(projects);view.projects_loaded=true;view.projects_error=None;},
                            Err(error)=>view.projects_error=Some(error),
                        }
                    } else if value["type"] == "sessions" {
                        crate::mission_inspector::Metadata::accept(&mut view.mission_metadata, &value);
                        view.list_loaded=true;
                        let mut chats = value["sessions"].as_array().map(|values| values.iter().filter_map(local_model::chat).collect::<Vec<_>>()).unwrap_or_default();
                        crate::chat_order::sort(&mut chats);
                        view.chats = Arc::new(chats);
                    } else if value["type"] == "session" && let Some(chat) = local_model::chat(&value["session"]) {
                        crate::mission_inspector::Metadata::accept(&mut view.mission_metadata, &value);
                        crate::chat_order::upsert(Arc::make_mut(&mut view.chats), chat);
                    } else if value["type"] == "missions" && let Some(titles) = local_model::mission_titles(&value["missions"]) {
                        view.mission_titles = Some(Arc::new(titles));
                    }
                }
            }
        }
        settle = if model.departed.is_empty() {
            None
        } else {
            settle.or_else(|| Some(tokio::time::Instant::now() + DEPARTED_SETTLE))
        };
        if !model.prefix_pending && model.presentation_dirty {
            view.rows = model.rows();
        }
        view.cursor = if fenced || model.prefix_pending || !model.has_capacity() {
            None
        } else {
            model.cursor
        };
        view.limited = model.limited;
        view.behind = model.behind;
        view.omitted = model.unsupported;
        view.loaded = model.loaded && !model.prefix_pending && !awaiting_snapshot;
        view.queued = model.queued;
        view.user_queue = if fenced {
            Arc::new(crate::queued_message::Snapshot {
                unavailable: true,
                ..Default::default()
            })
        } else {
            model.user_queue.clone()
        };
        view.thinking = model.thinking && !fenced;
        view.compacting = model.compacting() && !fenced;
        view.failure_run_serial = model.failure_run_serial;
        view.question = if fenced {
            crate::question::Projection::Unavailable
        } else {
            model.question()
        };
        view.question_awaited = !fenced && model.question_awaited();
        #[cfg(test)]
        {
            view.test_publications += 1;
        }
        publish(&updates, &replace, view.for_display(selected.as_deref()));
    }
    control.abort();
    if let Some(task) = chat_socket {
        task.abort();
    }
    if let Some(task) = page_task {
        task.abort();
    }
}

/// Explicit opt-in, content-free Local read smoke. Never used by the ordinary test suite.
/// No GUI, daemon startup, files written, IDs/titles/content or errors from the wire printed.
pub fn check_local_read(options: LocalOptions) -> Result<(), &'static str> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "Cannot start read check")?;
    runtime.block_on(async move {
        let (client,updates)=LocalClient::start(options);
        async fn wait(updates:&async_channel::Receiver<Presentation>, predicate:impl Fn(&Presentation)->bool)->Result<Presentation,&'static str> {
            tokio::time::timeout(Duration::from_secs(10),async {
                loop { let value=updates.recv().await.map_err(|_|"Local read worker closed")?;
                    if predicate(&value) { return Ok(value); }
                }
            }).await.map_err(|_|"Local read check timed out. No data or credentials were logged.")?
        }
        let list=wait(&updates,|v|v.list_loaded).await?;
        let chosen=list.chats.iter().find(|c|!c.archived&&c.state=="working").or_else(||list.chats.iter().find(|c|!c.archived));
        let Some(chat)=chosen else { println!("Local identity verified; {} summaries; no active chat opened.",list.chats.len()); return Ok(()); };
        client.command(Command::Open{id:chat.id.clone(),generation:1});
        let mut view=wait(&updates,|v|v.generation==1&&v.loaded).await?;
        let mut paged=false;
        if let Some(before)=view.cursor {
            let revision=view.page_revision;
            client.command(Command::Earlier{before,generation:1});
            view=wait(&updates,|v|v.page_revision>revision).await?; paged=true;
        }
        let bytes:usize=view.rows.iter().map(crate::model::Message::retained_bytes).sum();
        println!("Local identity verified before sockets. {} summaries; one chat opened; {} rows; {bytes} projected source bytes; {} event batches; history request: {paged}. No content/IDs/titles logged.",list.chats.len(),view.rows.len(),view.batches);
        Ok(())
    })
}

/// Explicit read-only capture input. Contains private transcript data; never log or publish it.
pub struct LocalCapture {
    pub(crate) state: Presentation,
    pub(crate) chat: Chat,
}
/// Blocking diagnostic helper, run before creating an offscreen context, never on the live UI thread.
pub fn read_local_capture(options: LocalOptions, id: &str) -> Result<LocalCapture, &'static str> {
    if !local_model::valid_id(id) {
        return Err("Invalid capture chat ID");
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "Cannot start capture read")?;
    runtime.block_on(async {
        let(client,updates)=LocalClient::start(options);
        async fn wait(rx:&async_channel::Receiver<Presentation>,selected:bool)->Result<Presentation,&'static str> {
            tokio::time::timeout(Duration::from_secs(15),async{loop{let view=rx.recv().await.map_err(|_|"Capture reader closed")?;if if selected{view.generation==1&&view.loaded}else{view.list_loaded}{return Ok(view);}}}).await.map_err(|_|"Read-only capture timed out; no wire data logged")?
        }
        let list=wait(&updates,false).await?;
        let chat=list.chats.iter().find(|chat|chat.id==id).cloned().ok_or("Requested capture chat is not in the bounded Local list. No other chat was opened.")?;
        if !client.command(Command::Open{id:chat.id.clone(),generation:1}){return Err("Capture read queue unavailable");}
        let state=wait(&updates,true).await?;Ok(LocalCapture{state,chat})
    })
}

#[cfg(test)]
#[path = "local_network_tests.rs"]
mod network_tests;

#[cfg(test)]
#[path = "artifact_image_transport_tests.rs"]
mod artifact_image_transport_tests;

#[cfg(test)]
#[path = "local_read_transport_tests.rs"]
mod read_transport_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn pending_question_attention_overrides_work_only_with_fresh_canonical_evidence() {
        use crate::{
            attention::Kind,
            question::Projection,
            state_mark::{Mark, Signal},
        };
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"snapshot","entries":[{"id":4,"kind":"pilot.question","model":[],"data":{"question":"Choose a layout 日本語 👩‍💻","blocking":true}}],"run":{"startedAt":1}}));
        let mut raw = Presentation {
            chats: Arc::new(vec![local_model::chat(&json!({"id":"a","state":"working","working":true,"outcome":"question","outcomeReason":"Old question"})).unwrap()]),
            loaded: true,
            generation: 5,
            question: model.question(),
            question_awaited: model.question_awaited(),
            ..Default::default()
        };
        let shown = raw.for_display(Some("a"));
        let c = &shown.chats[0];
        assert_eq!(c.signal, Some(Signal::NeedsYou));
        assert_eq!(c.attention.as_ref().unwrap().kind, Kind::Question);
        assert!(
            c.attention
                .as_ref()
                .unwrap()
                .label
                .contains("Choose a layout")
        );
        assert_eq!(Mark::of(c), Some(Mark::Question));
        let mut rollup = crate::sidebar_tree::Rollup::default();
        rollup.add(Mark::of(c));
        assert_eq!(rollup.counts(), vec![(Mark::NeedsYou, 1)]);
        assert_eq!(
            (c.state.as_str(), c.busy, c.writable),
            ("working", true, true)
        );
        assert!(shown.question_fresh(Some("a"), 5));
        assert!(!shown.question_fresh(Some("a"), 4));
        assert_eq!(
            raw.chats[0].signal,
            Some(Signal::Working),
            "Raw summary is never rewritten"
        );
        assert!(!Arc::ptr_eq(&raw.chats, &shown.chats));
        assert!(Arc::ptr_eq(
            &raw.chats,
            &raw.for_display(Some("other")).chats
        ));
        for case in 0..4 {
            let mut stale = raw.clone();
            match case {
                0 => stale.loaded = false,
                1 => stale.chat_issue = true,
                2 => stale.question_awaited = false,
                _ => stale.question = Projection::Unavailable,
            }
            assert!(Arc::ptr_eq(&raw.chats, &stale.for_display(Some("a")).chats));
        }
        let mut paging = raw.clone();
        paging.page_busy = true;
        assert!(
            paging.question_fresh(Some("a"), 5),
            "older-page work is not incomplete live metadata"
        );
        // The exact user answer clears attention even while the run continues.
        model.apply(&json!({"type":"entry_appended","entry":{"id":5,"kind":"pi.user","model":[{"role":"user","content":"Threads"}]}}));
        raw.question = model.question();
        raw.question_awaited = model.question_awaited();
        let answered = raw.for_display(Some("a"));
        assert_eq!(answered.chats[0].signal, Some(Signal::Working));
        assert!(answered.chats[0].attention.is_none());
        assert!(!answered.chats[0].order.question);
        // Turn-ending/idle questions share the same display priority.
        raw.chats = Arc::new(vec![
            local_model::chat(&json!({"id":"a","state":"parked"})).unwrap(),
        ]);
        raw.question = shown.question;
        assert_eq!(
            raw.for_display(Some("a")).chats[0].signal,
            Some(Signal::NeedsYou)
        );
        // The same exact pending question outranks a usage hold, without
        // mutating busy/admission or making the hold sticky after the answer.
        raw.chats = Arc::new(vec![
            local_model::chat(&json!({"id":"a","state":"working","working":false,"subscriptionPause":{"windows":[]}})).unwrap(),
        ]);
        raw.question_awaited = true;
        let pending = raw.for_display(Some("a"));
        assert_eq!(Mark::of(&pending.chats[0]), Some(Mark::Question));
        assert_eq!(raw.chats[0].signal, Some(Signal::Paused));
        assert_eq!(raw.chats[0].busy, pending.chats[0].busy);
        raw.question = Projection::Unavailable;
        assert_eq!(
            raw.for_display(Some("a")).chats[0].signal,
            Some(Signal::Paused)
        );
    }
    #[test]
    fn identity_protocol_and_allowlist_fail_closed() {
        let options = LocalOptions {
            externally_managed: false,
            port: 4319,
            daemon_id: "daemon".into(),
            lineage_id: "lineage".into(),
            native_home: None,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            update_policy: Default::default(),
        };
        let mut hello = json!({"daemonId":"daemon","lineageId":"lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}});
        assert!(options.verify(&hello).is_ok());
        hello["lineageId"] = json!("other");
        assert!(options.verify(&hello).is_err());
        hello["lineageId"] = json!("lineage");
        hello["minimumClientProtocolVersion"] = json!(2);
        assert!(options.verify(&hello).is_err());
        hello["minimumClientProtocolVersion"] = json!(1);
        hello["capabilities"]["independentExecution"] = json!(false);
        assert!(options.verify(&hello).is_err());
        for id in ["../stop", "id?send=1", "id/archive", "", "remote:123"] {
            assert!(options.ws_path(Some(id), None).is_err());
        }
        assert_eq!(
            options.http_url(&ReadRoute::History {
                id: "abc-123".into(),
                context: None,
                before: 4
            }),
            "http://127.0.0.1:4319/api/sessions/abc-123/history?before=4&limit=24"
        );
    }
    #[test]
    fn projections_coalesce_without_an_unbounded_queue() {
        let (tx, rx) = async_channel::bounded(1);
        for generation in 1..10000 {
            publish(
                &tx,
                &rx,
                Presentation {
                    generation,
                    ..Default::default()
                },
            );
        }
        assert_eq!(rx.len(), 1);
        assert_eq!(rx.try_recv().unwrap().generation, 9999);
    }
    #[test]
    fn daemon_version_is_bounded_display_text_or_unknown() {
        assert_eq!(
            daemon_version(&json!({"daemonVersion":"1.91.0"})).as_deref(),
            Some("1.91.0")
        );
        assert_eq!(
            daemon_version(&json!({"daemonVersion":"2.0.0-rc.1+abc"})).as_deref(),
            Some("2.0.0-rc.1+abc")
        );
        for hello in [
            json!({}),
            json!({"daemonVersion":null}),
            json!({"daemonVersion":1}),
            json!({"daemonVersion":""}),
            json!({"daemonVersion":"1.0\n0"}),
            json!({"daemonVersion":"1.0.0 (latest)"}),
            json!({"daemonVersion":"9".repeat(65)}),
        ] {
            assert_eq!(daemon_version(&hello), None, "{hello}");
        }
    }
}

#[cfg(test)]
#[path = "session_failure_reader_tests.rs"]
mod session_failure_reader_tests;
