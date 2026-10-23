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

const HTTP_CAP: usize = 4 * 1024 * 1024;
const FRAME_CAP: usize = 8 * 1024 * 1024;
type Failure = &'static str;

#[derive(Clone)]
pub struct LocalOptions {
    port: u16,
    daemon_id: String,
    lineage_id: String,
}

impl LocalOptions {
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn synthetic(port: u16) -> Self {
        Self {
            port,
            daemon_id: "test-daemon".into(),
            lineage_id: "test-lineage".into(),
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
            port,
            daemon_id: identity_file(home.join("daemon-id"))?,
            lineage_id: identity_file(home.join("storage-lineage"))?,
        })
    }

    fn verify(&self, hello: &Value) -> Result<(), Failure> {
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
                let mut path = format!("/api/sessions/{id}/ws");
                if let Some(resume) = resume
                    && local_model::valid_id(&resume.stream)
                {
                    path.push_str(&format!("?stream={}&after={}", resume.stream, resume.seq));
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
    History {
        id: String,
        before: u64,
    },
    Artifact {
        owner: String,
        id: String,
        revision: u32,
    },
}
impl ReadRoute {
    fn path(&self) -> String {
        match self {
            Self::Hello => "/api/hello".into(),
            Self::Artifact {
                owner,
                id,
                revision,
            } => format!("/api/sessions/{owner}/artifacts/{id}?revision={revision}"),
            Self::History { id, before } => {
                format!("/api/sessions/{id}/history?before={before}&limit=24")
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
    pub(crate) projects: Arc<Vec<local_model::Project>>,
    pub(crate) projects_loaded: bool,
    pub(crate) projects_error: Option<&'static str>,
    pub(crate) artifacts: Arc<Vec<crate::artifact_model::Reference>>,
    pub(crate) chats: Arc<Vec<Chat>>,
    pub(crate) rows: Vec<Message>,
    pub(crate) generation: u64,
    pub(crate) cursor: Option<u64>,
    pub(crate) page_busy: bool,
    pub(crate) status: String,
    pub(crate) chat_status: String,
    pub(crate) limited: bool,
    pub(crate) omitted: usize,
    pub(crate) loaded: bool,
    pub(crate) list_loaded: bool,
    pub(crate) page_revision: u64,
    pub(crate) batches: u64,
    pub(crate) queued: usize,
    pub(crate) thinking: bool,
    #[cfg(test)]
    pub(crate) test_publications: u64,
}

/// Drop closes the command source; the runtime aborts every task and socket.
/// No joins, HTTP reads or file I/O occur on the UI thread.
pub(crate) struct LocalClient {
    commands: async_channel::Sender<Command>,
}
impl LocalClient {
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn synthetic_commands() -> (Self, async_channel::Receiver<Command>) {
        let (commands, receiver) = async_channel::bounded(4);
        (Self { commands }, receiver)
    }
    pub(crate) fn start(options: LocalOptions) -> (Self, async_channel::Receiver<Presentation>) {
        let (commands, receiver) = async_channel::bounded(4);
        let (updates, output) = async_channel::bounded(1);
        let replace = output.clone();
        std::thread::Builder::new()
            .name("local-read-viewer".into())
            .spawn(move || {
                if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    runtime.block_on(run(options, receiver, updates, replace));
                }
            })
            .expect("start isolated read worker");
        (Self { commands }, output)
    }
    pub(crate) fn command(&self, command: Command) -> bool {
        self.commands.try_send(command).is_ok()
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
        result: Result<Value, Failure>,
    },
}

async fn get(
    client: &reqwest::Client,
    options: &LocalOptions,
    route: ReadRoute,
) -> Result<Value, Failure> {
    let mut response = client
        .get(options.http_url(&route))
        .send()
        .await
        .map_err(|_| "Local read failed. Check that Pilot is running.")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("Local read refused (HTTP status). No redirect or authentication fallback.");
    }
    if response
        .content_length()
        .is_some_and(|n| n > HTTP_CAP as u64)
    {
        return Err("Local HTTP response exceeds the 4 MiB viewer limit.");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local response interrupted")?
    {
        if body.len() + chunk.len() > HTTP_CAP {
            return Err("Local HTTP response exceeds the 4 MiB viewer limit.");
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "Invalid Local JSON response")
}

pub(crate) async fn gate(client: &reqwest::Client, options: &LocalOptions) -> Result<(), Failure> {
    hello(client, options).await.map(|_| ())
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
    let value = get(
        &client,
        options,
        ReadRoute::Artifact {
            owner: reference.session.clone(),
            id: reference.id.clone(),
            revision: reference.revision,
        },
    )
    .await?;
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
            if let Err(error) = gate(&client, &options).await {
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
            } else {
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
                        .max_message_size(Some(FRAME_CAP))
                        .max_frame_size(Some(FRAME_CAP));
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
                                let _ = inbox.send(status("Stream exceeds the 8 MiB viewer frame limit; subscription stopped.")).await;
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
) {
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
    let mut selected: Option<String> = None;
    let mut model = LiveTranscript::default();
    let mut view = Presentation {
        status: "Connecting to Local…".into(),
        ..Default::default()
    };
    publish(&updates, &replace, view.clone());
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Err(_) => break,
                Ok(Command::Clear {generation})=>{
                    if let Some(task)=chat_socket.take(){task.abort();}
                    if let Some(task)=page_task.take(){task.abort();}
                    selected=None;model=LiveTranscript::default();model.presentation_dirty=true;view.generation=generation;view.page_busy=false;view.chat_status.clear();view.batches=0;view.queued=0;view.artifacts=Arc::new(Vec::new());
                }
                Ok(Command::Open { id, generation }) => {
                    if fenced || !local_model::valid_id(&id) { continue; }
                    if let Some(task) = chat_socket.take() { task.abort(); }
                    if let Some(task) = page_task.take() { task.abort(); }
                    selected = Some(id.clone());
                    view.artifacts=Arc::new(Vec::new());
                    model = LiveTranscript::default();
                    model.presentation_dirty = true;
                    view.generation = generation; view.page_busy = false; view.chat_status = "Loading chat…".into(); view.batches=0;view.queued=0;
                    chat_socket = Some(socket_task(options.clone(),client.clone(),Some(id),generation,inbox.clone()));
                }
                Ok(Command::Earlier { before, generation }) => {
                    if fenced || generation != view.generation || view.page_busy || model.cursor != Some(before) || model.prefix_pending || !model.has_capacity() { continue; }
                    let Some(id) = selected.clone() else { continue; };
                    let (options, client, inbox) = (options.clone(),client.clone(),inbox.clone());
                    view.page_busy = true;
                    page_task = Some(tokio::spawn(async move {
                        let result = match gate(&client,&options).await {
                            Ok(()) => get(&client,&options,ReadRoute::History { id,before }).await,
                            Err(e) => Err(e),
                        };
                        let _ = inbox.send(Incoming::Page { generation,before,result }).await;
                    }));
                }
                Ok(Command::Reconnect) => {
                    model.thinking=false;
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
                    model.stop_thinking();
                    fenced=true; control.abort();
                    if let Some(task)=chat_socket.take() {task.abort();}
                    if let Some(task)=page_task.take() {task.abort();}
                    view.page_busy=false; view.status=text.into(); view.chat_status=text.into();
                },
                Ok((_, Incoming::Status {generation, chat, text})) => {
                    if !chat || generation == view.generation { model.thinking=false; }
                    if chat { if generation != view.generation { continue; } view.chat_status = text.into(); }
                    else { view.status = text.into(); }
                }
                Ok((_, Incoming::Page { generation,before,result })) => {
                    if generation != view.generation { continue; }
                    view.page_busy = false;
                    view.page_revision+=1;
                    match result { Ok(value) => model.page(before,&value), Err(e) => view.chat_status = e.into() }
                }
                Ok((_, Incoming::Wire {generation,chat: is_chat,value})) => {
                    if is_chat {
                        if generation != view.generation { continue; }
                        if value["type"] == "artifacts" && value["sessionId"].as_str()==selected.as_deref(){view.artifacts=crate::artifact_model::summaries(&value["artifacts"],selected.as_deref().unwrap_or(""));}
                        else if value["type"] == "events" && let Some(events) = value["events"].as_array() {
                            view.batches+=1;
                            for event in events { model.apply(event); }
                            // Repeated reasoning deltas only update bounded
                            // counters. Do not publish/clone a transcript or
                            // wake the UI when the activity label is unchanged.
                            if events.iter().all(local_model::reasoning_deltas_only) && view.thinking == model.thinking { continue; }
                        } else if value["type"] == "error" { model.stop_thinking(); view.chat_status = "Local chat unavailable; details omitted for privacy.".into(); }
                    } else if value["type"] == "projects" {
                        match local_model::projects(&value["projects"]) {
                            Ok(projects)=>{view.projects=Arc::new(projects);view.projects_loaded=true;view.projects_error=None;},
                            Err(error)=>view.projects_error=Some(error),
                        }
                    } else if value["type"] == "sessions" {
                        view.list_loaded=true;
                        let mut chats = value["sessions"].as_array().map(|values| values.iter().filter_map(local_model::chat).take(local_model::SESSION_CAP).collect::<Vec<_>>()).unwrap_or_default();
                        chats.sort_by(|a,b| a.title.to_lowercase().cmp(&b.title.to_lowercase()).then(a.id.cmp(&b.id)));
                        view.chats = Arc::new(chats);
                    } else if value["type"] == "session" && let Some(chat) = local_model::chat(&value["session"]) {
                        let chats = Arc::make_mut(&mut view.chats);
                        if let Some(old) = chats.iter_mut().find(|c| c.id == chat.id) { *old = chat; }
                        else if chats.len() < local_model::SESSION_CAP { chats.push(chat); }
                    }
                }
            }
        }
        if !model.prefix_pending && model.presentation_dirty {
            view.rows = model.rows();
        }
        view.cursor = if fenced || model.prefix_pending || !model.has_capacity() {
            None
        } else {
            model.cursor
        };
        view.limited = model.limited;
        view.omitted = model.unsupported;
        view.loaded = model.loaded && !model.prefix_pending;
        view.queued = model.queued;
        view.thinking = model.thinking && !fenced;
        #[cfg(test)]
        {
            view.test_publications += 1;
        }
        publish(&updates, &replace, view.clone());
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
        let bytes:usize=view.rows.iter().map(|r|r.source().len()).sum();
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
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn identity_protocol_and_allowlist_fail_closed() {
        let options = LocalOptions {
            port: 4319,
            daemon_id: "daemon".into(),
            lineage_id: "lineage".into(),
        };
        let mut hello = json!({"daemonId":"daemon","lineageId":"lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}});
        assert!(options.verify(&hello).is_ok());
        hello["lineageId"] = json!("other");
        assert!(options.verify(&hello).is_err());
        hello["lineageId"] = json!("lineage");
        hello["minimumClientProtocolVersion"] = json!(2);
        assert!(options.verify(&hello).is_err());
        for id in ["../stop", "id?send=1", "id/archive", "", "remote:123"] {
            assert!(options.ws_path(Some(id), None).is_err());
        }
        assert_eq!(
            options.http_url(&ReadRoute::History {
                id: "abc-123".into(),
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
}
