//! Isolated HTTP/WebSocket host. Clients always use production adapters.
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::broadcast,
};
use tokio_tungstenite::tungstenite::Message as Frame;

/// Recorded fixture effects, with independent identity/ACK controls.
#[derive(Default)]
pub struct State {
    pub bad_identity: bool,
    pub lose_ack: bool,
    pub hide_receipt: bool,
    pub envelopes: Vec<Value>,
    pub requests: Vec<(String, String)>,
    pub receipts: BTreeMap<String, Value>,
    pub messages: BTreeMap<String, Vec<Value>>,
    pub working: Option<String>,
    pub stops: Vec<String>,
}

/// A process-local synthetic daemon on an OS-assigned loopback port.
pub struct Fixture {
    pub port: u16,
    pub state: Arc<Mutex<State>>,
    changes: broadcast::Sender<()>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Fixture {
    pub fn start() -> Self {
        let (ready, receive) = std::sync::mpsc::sync_channel(1);
        let state = Arc::new(Mutex::new(State::default()));
        let owned = state.clone();
        let (changes, _) = broadcast::channel(16);
        let changes_worker = changes.clone();
        let (shutdown, closed) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("fixture runtime");
            runtime.block_on(async move {
                let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,0)).await.expect("fixture listener");
                ready.send(listener.local_addr().expect("fixture address").port()).expect("fixture ready");
                tokio::pin!(closed);
                let mut tasks = tokio::task::JoinSet::new();
                let streaming=owned.clone(); let streaming_changes=changes_worker.clone();
                tasks.spawn(async move {
                    let mut tick=tokio::time::interval(Duration::from_millis(100));
                    loop {
                        tick.tick().await;
                        let changed={
                            let mut state=streaming.lock().expect("fixture state");
                            let id=state.working.clone();
                            id.and_then(|id|state.messages.get_mut(&id)).and_then(|entries|entries.last_mut()).is_some_and(|entry| {
                                let text=entry["model"][0]["content"][0]["text"].as_str().unwrap_or("");
                                if text.len()>512{return false;}
                                entry["model"][0]["content"][0]["text"]=format!("{text} Continuing.").into(); true
                            })
                        };
                        if changed {let _=streaming_changes.send(());}
                    }
                });
                loop {
                    tokio::select! {
                        _ = &mut closed => break,
                        connection = listener.accept() => {
                            let Ok((stream,_)) = connection else {break};
                            let state = owned.clone(); let changes = changes_worker.clone();
                            tasks.spawn(async move { connection_task(stream,state,changes).await; });
                        },
                        _ = tasks.join_next(), if !tasks.is_empty() => {},
                    }
                }
                tasks.abort_all();
                while tasks.join_next().await.is_some() {}
            });
        });
        Self {
            port: receive.recv().expect("fixture port"),
            state,
            changes,
            shutdown: Some(shutdown),
            thread: Some(thread),
        }
    }
    pub fn options(&self) -> pilot_desktop::LocalOptions {
        pilot_desktop::nsh_adapter::synthetic_options(self.port)
    }
    pub fn changed(&self) {
        let _ = self.changes.send(());
    }
}
impl Default for Fixture {
    fn default() -> Self {
        Self::start()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn entry(id: u64, role: &str, text: &str) -> Value {
    json!({"id":id,"kind":format!("pi.{role}"),"model":[{"role":role,"content":[{"type":"text","text":text}]}]})
}
fn summary(id: &str, state: &State) -> Value {
    json!({"id":id,"title":match id {"a"=>"Native chat and streaming","b"=>"Keep exact drafts","ask"=>"Legacy Ask","restricted"=>"Restricted chat",_=>"Coordinator"},
        "state":if state.working.as_deref()==Some(id){"working"}else{"idle"},"mode":if id=="ask" {"ask"}else{"build"},
        "control":id=="restricted","missionCoordinator":id=="coordinator", "missionId":if id=="coordinator"{Some("mission")}else{None},
        "projectId":if id=="b"{"project-b"}else{"project-a"},"cwd":"/synthetic/project","createdAt":100,"lastUserMessageAt":if id=="a"{500}else{200},"inputGeneration":0})
}
fn summaries(state: &State) -> Value {
    json!([
        summary("a", state),
        summary("b", state),
        summary("ask", state),
        summary("restricted", state),
        summary("coordinator", state)
    ])
}
fn projects() -> Value {
    json!([{"id":"project-a","name":"Pilot","path":"/synthetic/project"},{"id":"project-b","name":"Website","path":"/synthetic/website"}])
}

async fn connection_task(
    mut stream: TcpStream,
    state: Arc<Mutex<State>>,
    changes: broadcast::Sender<()>,
) {
    let mut peek = vec![0; 8192];
    let Ok(Ok(size)) = tokio::time::timeout(Duration::from_secs(5), stream.peek(&mut peek)).await
    else {
        return;
    };
    let header = String::from_utf8_lossy(&peek[..size]);
    let path = header
        .lines()
        .next()
        .and_then(|s| s.split_whitespace().nth(1))
        .unwrap_or("")
        .to_owned();
    if header.to_ascii_lowercase().contains("upgrade: websocket") {
        let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
            return;
        };
        state
            .lock()
            .expect("fixture state")
            .requests
            .push(("WS".into(), path.clone()));
        let mut changed = changes.subscribe();
        let id = path
            .strip_prefix("/api/sessions/")
            .and_then(|s| s.split('/').next())
            .map(str::to_owned);
        if let Some(id) = &id {
            let welcome = json!({"type":"chat.stream","sessionId":id,"streamId":"fixture-stream","resumed":false});
            if socket
                .send(Frame::Text(welcome.to_string().into()))
                .await
                .is_err()
            {
                return;
            }
        }
        let mut seq = 0;
        let mut last_text: Option<String> = None;
        loop {
            let publication = {
                let state = state.lock().expect("fixture state");
                if let Some(id) = &id {
                    seq += 1;
                    let mut entries = vec![
                        entry(1, "user", "Keep the current app usable."),
                        entry(
                            2,
                            "assistant",
                            "This chat uses the production Local reader and courier.\n\n日本語 and **native Markdown** stay readable.",
                        ),
                    ];
                    let mut saved = state.messages.get(id).cloned().unwrap_or_default();
                    let working = state.working.as_deref() == Some(id);
                    let live = working.then(|| saved.pop()).flatten();
                    entries.extend(saved);
                    let events = if let Some(live) = live {
                        let text = live["model"][0]["content"][0]["text"]
                            .as_str()
                            .unwrap_or("")
                            .to_owned();
                        let events = if let Some(previous) = &last_text {
                            vec![
                                json!({"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":text.strip_prefix(previous).unwrap_or("")}]}),
                            ]
                        } else {
                            vec![
                                json!({"type":"snapshot","entries":entries,"history":{"context":{"conversationId":0,"tail":100},"more":false,"question":null}}),
                                json!({"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"A"}]}}),
                                json!({"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":text.strip_prefix('A').unwrap_or(&text)}]}),
                            ]
                        };
                        last_text = Some(text);
                        events
                    } else if last_text.take().is_some() {
                        vec![
                            json!({"type":"message_end","entry":entries.last()}),
                            json!({"type":"run_end"}),
                        ]
                    } else {
                        vec![
                            json!({"type":"snapshot","entries":entries,"history":{"context":{"conversationId":0,"tail":100},"more":false,"question":null}}),
                        ]
                    };
                    json!({"type":"events","sessionId":id,"seq":seq,"events":events})
                } else {
                    json!({"type":"sessions","sessions":summaries(&state)})
                }
            };
            if socket
                .send(Frame::Text(publication.to_string().into()))
                .await
                .is_err()
            {
                return;
            }
            if id.is_none() {
                for publication in [
                    json!({"type":"projects","projects":projects()}),
                    json!({"type":"missions","missions":[{"id":"mission","title":"Native migration"}]}),
                ] {
                    if socket
                        .send(Frame::Text(publication.to_string().into()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }
            tokio::select! {
                _ = changed.recv() => {},
                frame = socket.next() => match frame {
                    Some(Ok(Frame::Ping(data))) => {if socket.send(Frame::Pong(data)).await.is_err(){return;}},
                    Some(Ok(Frame::Close(_)))|None|Some(Err(_)) => return,
                    _ => {},
                },
            }
        }
    }
    let mut reader = BufReader::new(&mut stream);
    let mut first = String::new();
    if reader.read_line(&mut first).await.is_err() {
        return;
    }
    let method = first.split_whitespace().next().unwrap_or("").to_owned();
    let mut length = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
            return;
        }
        if line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse::<usize>().unwrap_or(0);
        }
    }
    if length > 128 * 1024 {
        return;
    }
    let mut bytes = vec![0; length];
    if reader.read_exact(&mut bytes).await.is_err() {
        return;
    }
    let payload: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let mut lost = false;
    let mut notify = false;
    let response = {
        let mut state = state.lock().expect("fixture state");
        state.requests.push((method.clone(), path.clone()));
        match (method.as_str(), path.as_str()) {
            ("GET", "/api/hello") => {
                json!({"daemonId":if state.bad_identity{"other-daemon"}else{"test-daemon"},"lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"durableInputGeneration":1}})
            }
            ("GET", "/api/projects") => projects(),
            ("GET", "/api/sessions?archived=all") => summaries(&state),
            ("GET", path) if path.contains("/history?") => {
                json!({"entries":[entry(1,"user","Read-only history"),entry(2,"assistant","Legacy Ask stays passive.")],"more":false})
            }
            ("POST", "/api/operations/receipt") => {
                if state.hide_receipt {
                    json!({"state":"unknown"})
                } else {
                    state
                        .receipts
                        .get(payload["operationId"].as_str().unwrap_or(""))
                        .cloned()
                        .unwrap_or_else(|| json!({"state":"unknown"}))
                }
            }
            ("POST", "/api/operations") => {
                state.envelopes.push(payload.clone());
                let id = payload["operationId"]
                    .as_str()
                    .expect("operation id")
                    .to_owned();
                if !state.receipts.contains_key(&id) {
                    let target = payload["targetId"].as_str().expect("target id");
                    let request: Value =
                        serde_json::from_str(payload["payload"].as_str().expect("payload"))
                            .expect("payload JSON");
                    let entries = state.messages.entry(target.into()).or_default();
                    let next = 3 + entries.len() as u64;
                    entries.push(entry(
                        next,
                        "user",
                        request["message"].as_str().expect("message"),
                    ));
                    entries.push(entry(
                        next + 1,
                        "assistant",
                        "A retained partial answer. 日本語 👩🏽‍💻",
                    ));
                    state.working = Some(target.into());
                    state.receipts.insert(id.clone(),json!({"operationId":id,"payloadHash":payload["payloadHash"],"destination":payload["destination"],"targetId":payload["targetId"],"state":"accepted","result":{"sessionId":target}}));
                    notify = true;
                }
                lost = state.lose_ack;
                state.receipts[&id].clone()
            }
            ("POST", path) if path.ends_with("/stop") => {
                let id = path
                    .trim_start_matches("/api/sessions/")
                    .trim_end_matches("/stop");
                state.stops.push(id.into());
                state.working = None;
                notify = true;
                json!({"ok":true})
            }
            ("GET", path) if path.starts_with("/api/sessions/") => {
                summary(path.trim_start_matches("/api/sessions/"), &state)
            }
            _ => json!({"error":"Unsupported fixture route"}),
        }
    };
    if notify {
        let _ = changes.send(());
    }
    if lost {
        return;
    }
    let body = response.to_string();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
}
