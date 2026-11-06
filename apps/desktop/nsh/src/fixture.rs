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
    pub work_events: BTreeMap<String, Vec<Value>>,
    pub stops: Vec<String>,
    pub questions: BTreeMap<String, Value>,
    pub decisions: Vec<(String, Value)>,
    pub lose_decision_ack: bool,
    pub refuse_decision: bool,
    pub histories: BTreeMap<String, Vec<Value>>,
    pub history_failure: bool,
    pub history_delay_ms: u64,
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
    pub fn images(&self, session: &str) {
        let mut content = Vec::new();
        for (index, image) in pilot_desktop::nsh_adapter::synthetic_images()
            .into_iter()
            .enumerate()
        {
            content.push(json!({"type":"text","text":format!("Stored image {}. Original bytes and upright geometry.",index+1)}));
            content.push(image);
        }
        self.state.lock().unwrap().histories.insert(session.into(), vec![
            entry(10,"assistant","Reader anchor before images. 日本語 👩🏽‍💻"),
            json!({"id":11,"kind":"pi.message","model":[{"role":if session=="b"{"user"}else{"assistant"},"content":content}]}),
            entry(12,"user","Reader anchor after images. Original draft stays separate."),
        ]);
        self.changed();
    }
    /// Multiple real reader pages; the old-only query preserves exact Unicode.
    pub fn history(&self, session: &str, count: u64) {
        self.state.lock().expect("fixture state").histories.insert(session.into(),
            (1..=count).map(|id| entry(id, if id % 2 == 0 { "user" } else { "assistant" },
                &if id == 3 || id == 7 { format!("Older {id}: {HISTORY_QUERY} and {HISTORY_QUERY}  ") }
                else { format!("History message {id}. Exact source 日本語 👩🏽‍💻.\n\nA readable paragraph for the native reader.") })).collect());
        self.changed();
    }
    pub fn append_history(&self, session: &str) {
        let mut state = self.state.lock().expect("fixture state");
        let entries = state.histories.get_mut(session).expect("paged fixture");
        let next = entries.last().unwrap()["id"].as_u64().unwrap() + 1;
        entries.push(entry(
            next,
            "assistant",
            &format!("Concurrent append {next}. 日本語"),
        ));
        drop(state);
        self.changed();
    }
    pub fn question(&self, session: &str, id: u64, data: Value) {
        self.state.lock().expect("fixture state").questions.insert(
            session.into(),
            json!({"id":id,"kind":"pilot.question","model":[],"data":data}),
        );
        self.changed();
    }
    /// Mixed production-shaped entries and live events, never Markdown tool state.
    pub fn work(&self, session: &str) {
        let mut entries = vec![entry(10, "assistant", "Visible Note before work. 日本語")];
        let mut next = 11;
        let mut call = |id: &str, name: &str, args: Value, output: Option<(&str, bool)>| {
            entries.push(json!({"id":next,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":id,"name":name,"arguments":args}]}]}));
            next += 1;
            if let Some((text, error)) = output {
                entries.push(json!({"id":next,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":id,"toolName":name,"isError":error,"content":[{"type":"text","text":text}]}]}));
                next += 1;
            }
        };
        call(
            "edited",
            "edit",
            json!({"path":"src/main.rs","oldText":"old","newText":"new\nline"}),
            Some(("Edited", false)),
        );
        call(
            "failed",
            "codemode",
            json!({"code":WORK_CODE}),
            Some((WORK_OUTPUT, true)),
        );
        entries.push(entry(
            next,
            "assistant",
            "Visible interleaved Note. Not hidden work or Thinking.",
        ));
        next += 1;
        for (offset, (id, name, args, output)) in [
            ("read-a", "read", json!({"path":"src/a.rs"}), Some(("read a", false))),
            ("read-b", "read", json!({"path":"src/b.rs"}), Some(("read b", false))),
            ("search", "web", json!({"action":"search","query":"literal query"}), Some(("found", false))),
            ("command", "bash", json!({"command":"cargo check"}), Some(("checked", false))),
            ("script", "codemode", json!({"code":"await tools.read({path: '日本.rs'});\nawait tools.bash({command: 'printf test'});"}), Some(("Script completed\nWall time 0.2 seconds\nOutput:\n\nNested output says failed, but the script completed.", false))),
            ("unknown", "codemode", json!({"code":"// Inspect original operation\nawait tools.read({path: 'unknown.rs'});"}), None),
            ("read-c", "read", json!({"path":"src/c.rs"}), Some(("read c", false))),
            ("read-d", "read", json!({"path":"src/d.rs"}), Some(("read d", false))),
            ("fetch", "web", json!({"action":"fetch","url":"https://example.invalid"}), Some(("offline fixture", false))),
        ].into_iter().enumerate() {
            let n = next + offset as u64 * 2;
            entries.push(json!({"id":n,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":id,"name":name,"arguments":args}]}]}));
            if let Some((text, error)) = output {
                entries.push(json!({"id":n+1,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":id,"toolName":name,"isError":error,"content":[{"type":"text","text":text}]}]}));
            }
        }
        let mut state = self.state.lock().expect("fixture state");
        state.messages.insert(session.into(), entries);
        state.work_events.insert(session.into(), vec![
            json!({"type":"run_start"}),
            json!({"type":"message_start","message":{"role":"assistant","timestamp":1,"content":[{"type":"thinking","thinking":"Private reasoning stays transient"},{"type":"toolCall","id":"pending","name":"read","arguments":{"path":"pending.rs"}},{"type":"toolCall","id":"running","name":"codemode","arguments":{"code":"// Stream exact output\nawait tools.read({path: 'running.rs'});"}}]}}),
            json!({"type":"tool_execution_start","toolCallId":"running","toolName":"codemode"}),
            json!({"type":"tool_execution_update","toolCallId":"running","output":{"set":"  live 日本語\n<&> 👩🏽‍💻  "}}),
        ]);
        drop(state);
        self.changed();
    }
}
pub const WORK_CODE: &str = "// Verify focused checks\nconst x = await tools.read({path: 'src/main.rs'});\ntext(await tools.bash({command: 'cargo test'}));\n// exact <&> 日本語 👩🏽‍💻  ";
pub const WORK_OUTPUT: &str = "Script failed\nWall time 0.125 seconds\nOutput:\n\nprinted success first\nScript error:\nError: exact failure <&> 日本語 👩🏽‍💻\n  ";
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

pub const HISTORY_QUERY: &str = "cafe\u{301} 👩🏽‍💻 <&> 日本語";
fn entry(id: u64, role: &str, text: &str) -> Value {
    json!({"id":id,"kind":format!("pi.{role}"),"model":[{"role":role,"content":[{"type":"text","text":text}]}]})
}
fn summary(id: &str, state: &State) -> Value {
    json!({"id":id,"title":match id {"a"=>"Native chat and streaming","b"=>"Keep exact drafts","ask"=>"Legacy Ask","restricted"=>"Restricted chat",_=>"Coordinator"},
        "state":if state.working.as_deref()==Some(id) || state.work_events.get(id).is_some_and(|e| e.iter().any(|e| e["type"]=="run_start")) || state.questions.get(id).is_some_and(|q|q["data"]["blocking"]==true){"working"}else{"idle"},"mode":if id=="ask" {"ask"}else{"build"},
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
        let mut history_sent = 0;
        loop {
            let publication = {
                let state = state.lock().expect("fixture state");
                if let Some(id) = &id {
                    seq += 1;
                    if let Some(history) = state.histories.get(id) {
                        let tail = history.last().unwrap()["id"].as_u64().unwrap();
                        let events = if history_sent == 0 {
                            let start = history.len().saturating_sub(24);
                            let before = history[start]["id"].clone();
                            vec![
                                json!({"type":"snapshot","entries":&history[start..],"history":{"context":{"conversationId":0,"tail":tail},"more":start>0,"before":before,"question":null}}),
                            ]
                        } else {
                            history
                                .iter()
                                .filter(|entry| entry["id"].as_u64().unwrap() > history_sent)
                                .map(|entry| json!({"type":"message_end","entry":entry}))
                                .collect()
                        };
                        history_sent = tail;
                        json!({"type":"events","sessionId":id,"seq":seq,"events":events})
                    } else {
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
                        let question = state.questions.get(id).cloned().unwrap_or(Value::Null);
                        if !question.is_null() {
                            entries.push(question.clone());
                        }
                        let events = if let Some(work) = state.work_events.get(id) {
                            let mut events = vec![
                                json!({"type":"snapshot","entries":entries,"history":{"context":{"conversationId":0,"tail":100},"more":false}}),
                            ];
                            events.extend(work.clone());
                            events
                        } else if let Some(live) = live {
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
                                json!({"type":"snapshot","entries":entries,"run":if question["data"]["blocking"]==true {json!({"startedAt":1})}else{Value::Null},"history":{"context":{"conversationId":0,"tail":100},"more":false,"question":question}}),
                            ]
                        };
                        json!({"type":"events","sessionId":id,"seq":seq,"events":events})
                    }
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
    if path.contains("/history?") {
        let delay = state.lock().unwrap().history_delay_ms;
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    let mut lost = false;
    let mut notify = false;
    let mut status = 200;
    let response = {
        let mut state = state.lock().expect("fixture state");
        state.requests.push((method.clone(), path.clone()));
        match (method.as_str(), path.as_str()) {
            ("GET", "/api/hello") => {
                json!({"daemonId":if state.bad_identity{"other-daemon"}else{"test-daemon"},"lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"durableInputGeneration":1,"questionReplies":1}})
            }
            ("GET", "/api/projects") => projects(),
            ("GET", "/api/sessions?archived=all") => summaries(&state),
            ("GET", path) if path.contains("/history?") => {
                if state.history_failure {
                    status = 503;
                    json!({"error":"synthetic reader failure"})
                } else if let Some(entries) = path
                    .strip_prefix("/api/sessions/")
                    .and_then(|s| s.split('/').next())
                    .and_then(|id| state.histories.get(id))
                {
                    let parameter = |name: &str| {
                        path.split_once('?').unwrap().1.split('&').find_map(|p| {
                            p.strip_prefix(&format!("{name}="))
                                .and_then(|n| n.parse::<u64>().ok())
                        })
                    };
                    let before = parameter("before").unwrap();
                    let view = path.split_once("view=").map(|(_, value)| {
                        let mut bytes = Vec::new();
                        let mut parts = value.as_bytes().iter().copied();
                        while let Some(byte) = parts.next() {
                            bytes.push(if byte == b'%' {
                                let hex = [parts.next().unwrap(), parts.next().unwrap()];
                                u8::from_str_radix(std::str::from_utf8(&hex).unwrap(), 16).unwrap()
                            } else {
                                byte
                            });
                        }
                        serde_json::from_slice::<Value>(&bytes).unwrap()
                    });
                    let tail = view
                        .as_ref()
                        .and_then(|v| v["tail"].as_u64())
                        .unwrap_or_else(|| entries.last().unwrap()["id"].as_u64().unwrap());
                    let older: Vec<_> = entries
                        .iter()
                        .filter(|e| e["id"].as_u64().unwrap() < before)
                        .collect();
                    let start = older.len().saturating_sub(24);
                    json!({"context":{"conversationId":0,"tail":tail},"before":before,"entries":&older[start..],"more":start>0,"nextBefore":(start>0).then(|| older[start]["id"].clone())})
                } else {
                    json!({"entries":[entry(1,"user","Read-only history"),entry(2,"assistant","Legacy Ask stays passive.")],"more":false})
                }
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
                lost = state.lose_ack;
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
                    if !request["questionReplyId"].is_null()
                        && !state
                            .questions
                            .get(target)
                            .is_some_and(|q| q["id"] == request["questionReplyId"])
                    {
                        let receipt = json!({"operationId":id,"payloadHash":payload["payloadHash"],"destination":payload["destination"],"targetId":payload["targetId"],"state":"rejected","error":"Question is no longer pending"});
                        state.receipts.insert(id, receipt.clone());
                        receipt
                    } else {
                        let next = state
                            .questions
                            .remove(target)
                            .and_then(|q| q["id"].as_u64())
                            .unwrap_or(2)
                            + 1
                            + state.messages.get(target).map_or(0, |m| m.len() as u64);
                        let entries = state.messages.entry(target.into()).or_default();
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
                        state.receipts[&id].clone()
                    }
                } else {
                    state.receipts[&id].clone()
                }
            }
            ("POST", path) if path.ends_with("/database-access") => {
                let id = path
                    .trim_start_matches("/api/sessions/")
                    .trim_end_matches("/database-access");
                state.decisions.push((id.into(), payload.clone()));
                lost = state.lose_decision_ack;
                if state.refuse_decision
                    || !state
                        .questions
                        .get(id)
                        .is_some_and(|q| q["data"]["databaseAccess"]["id"] == payload["id"])
                {
                    status = 409;
                    json!({"error":"This database access request is no longer pending"})
                } else {
                    status = 202;
                    // Keep it projected briefly, as a real reader can lag its ACK.
                    json!({"ok":true})
                }
            }
            ("POST", path) if path.ends_with("/stop") => {
                let id = path
                    .trim_start_matches("/api/sessions/")
                    .trim_end_matches("/stop");
                state.stops.push(id.into());
                state.working = None;
                if let Some(events) = state.work_events.get_mut(id) {
                    *events = vec![json!({"type":"run_end"})];
                }
                if let Some(q) = state.questions.get_mut(id) {
                    q["data"]["blocking"] = false.into();
                }
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
        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
}
