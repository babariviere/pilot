//! Synthetic loopback daemon. No production data, credentials or service lifecycle.
use super::*;
use futures_util::SinkExt;
use serde_json::json;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};
use tokio_tungstenite::tungstenite::{
    handshake::derive_accept_key,
    protocol::{CloseFrame, Role, frame::coding::CloseCode},
};

#[derive(Clone, Copy)]
enum Scenario {
    Normal,
    Paged,
    Incompatible,
    BadIdentity,
    Redirect,
    Resume,
    Refused,
    Thinking,
    Compacting,
    CompactionResume,
    ContextUsage,
    ProviderUsage,
    Todos,
    ListAdmission,
    ListSnapshot,
    AttentionFreshness,
    MissionTitles,
    LargeFrame,
    LargeFragmentedMessage,
    /// Hello reports 1.91.0, then 1.92.0 once the daemon "restarts" upgraded.
    DaemonVersion,
}

#[tokio::test]
async fn explicit_existing_connection_is_get_only_and_rejects_changed_or_vanished_daemons() {
    for scenario in [
        Scenario::Normal,
        Scenario::BadIdentity,
        Scenario::Incompatible,
        Scenario::Redirect,
    ] {
        let mock = Mock::start(scenario).await;
        let options = mock.options.clone();
        let result = tokio::task::spawn_blocking(move || options.verify_existing())
            .await
            .unwrap();
        if matches!(scenario, Scenario::Normal) {
            let options = result.expect("matching hello permits explicit external connection");
            assert!(options.externally_managed);
            assert!(
                options.update_location().is_none(),
                "external connection cannot supply retained-runtime authority"
            );
        } else {
            assert!(
                result.is_err(),
                "incompatible, changed or redirected hello is refused"
            );
        }
        assert_eq!(*mock.requests.lock().unwrap(), ["GET /api/hello HTTP/1.1"]);
        assert_eq!(mock.sockets.load(Ordering::SeqCst), 0);
    }
    let mock = Mock::start(Scenario::Normal).await;
    let mut options = mock.options.clone();
    options.lineage_id = "previous-lineage".into();
    assert!(
        tokio::task::spawn_blocking(move || options.verify_existing())
            .await
            .unwrap()
            .is_err()
    );
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let mut options = mock.options.clone();
    options.port = listener.local_addr().unwrap().port();
    drop(listener);
    assert!(
        tokio::task::spawn_blocking(move || options.verify_existing())
            .await
            .unwrap()
            .is_err(),
        "vanished daemon is not started or replaced"
    );
}

#[tokio::test]
async fn capture_opens_only_the_exact_requested_chat_and_never_a_fallback() {
    let mock = Mock::start(Scenario::Normal).await;
    let options = mock.options.clone();
    let capture = tokio::task::spawn_blocking(move || read_local_capture(options, "b"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(capture.chat.id, "b");
    assert!(capture.state.loaded);
    let requests = mock.requests.lock().unwrap().clone();
    assert!(requests.iter().any(|r| r.contains("/api/sessions/b/ws")));
    assert!(!requests.iter().any(|r| r.contains("/api/sessions/a/")));
    assert!(requests.iter().all(|r| r.starts_with("GET ")));
    drop(requests);
    let missing = Mock::start(Scenario::Normal).await;
    let options = missing.options.clone();
    assert!(
        tokio::task::spawn_blocking(move || read_local_capture(options, "not-listed"))
            .await
            .unwrap()
            .is_err()
    );
    assert!(
        !missing
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("/api/sessions/"))
    );
}
struct Mock {
    options: LocalOptions,
    requests: Arc<Mutex<Vec<String>>>,
    sockets: Arc<AtomicUsize>,
    task: JoinHandle<()>,
    step: async_channel::Sender<()>,
    page_step: async_channel::Sender<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Mock {
    async fn start(scenario: Scenario) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let options = LocalOptions {
            externally_managed: false,
            port: listener.local_addr().unwrap().port(),
            daemon_id: "synthetic-daemon".into(),
            lineage_id: "synthetic-lineage".into(),
            native_home: None,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            update_policy: Default::default(),
        };
        let requests = Arc::new(Mutex::new(Vec::new()));
        let sockets = Arc::new(AtomicUsize::new(0));
        let (record, active) = (requests.clone(), sockets.clone());
        let attempts = Arc::new(AtomicUsize::new(0));
        let hellos = Arc::new(AtomicUsize::new(0));
        let (step, steps) = async_channel::bounded::<()>(2);
        let (page_step, page_steps) = async_channel::bounded::<()>(2);
        let task = tokio::spawn(async move {
            let mut handlers = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept() => {
                        let Ok((stream,_))=accepted else { break; };
                        let (record,active,attempts)=(record.clone(),active.clone(),attempts.clone());
                        let hellos=hellos.clone();
                        let steps=steps.clone();
                        let page_steps=page_steps.clone();
                        handlers.spawn(async move {
                            let mut reader=BufReader::new(stream);
                            let mut headers=String::new();
                            loop {
                                let mut line=String::new();
                                if reader.read_line(&mut line).await.unwrap_or(0)==0 { return; }
                                if line=="\r\n" { break; }
                                headers.push_str(&line);
                                if headers.len()>8192 { return; }
                            }
                            assert!(!headers.to_lowercase().contains("\norigin:"));
                            let first=headers.lines().next().unwrap().to_string();
                            record.lock().unwrap().push(first.clone());
                            let path=first.split_whitespace().nth(1).unwrap();
                            assert!(first.starts_with("GET "));
                            let mut stream=reader.into_inner();
                            if path=="/api/hello" {
                                if matches!(scenario,Scenario::Redirect) {
                                    stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap(); return;
                                }
                                let mut body=json!({"daemonId":if matches!(scenario,Scenario::BadIdentity) {"wrong"}else{"synthetic-daemon"},"lineageId":"synthetic-lineage","protocolVersion":1,"minimumClientProtocolVersion":if matches!(scenario,Scenario::Incompatible) {2}else{1},"capabilities":{"independentExecution":true}});
                                if matches!(scenario,Scenario::DaemonVersion) {
                                    body["daemonVersion"]=json!(if hellos.fetch_add(1,Ordering::SeqCst)==0 {"1.91.0"} else {"1.92.0"});
                                }
                                let body=body.to_string();
                                let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                                stream.write_all(response.as_bytes()).await.unwrap(); return;
                            }
                            if path.contains("/history?") {
                                if matches!(scenario,Scenario::Paged) {
                                    let url=reqwest::Url::parse(&format!("http://localhost{path}")).unwrap();
                                    let query:std::collections::HashMap<_,_>=url.query_pairs().into_owned().collect();
                                    let context:Value=serde_json::from_str(&query["view"]).unwrap();
                                    let before=query["before"].parse::<u64>().unwrap();
                                    assert_eq!(context["conversationId"],0);
                                    assert_eq!(query["limit"],"24");
                                    let index=record.lock().unwrap().iter().filter(|r|r.contains("/history?")).count();
                                    if page_steps.recv().await.is_err(){return;}
                                    let body=json!({"context":context,"before":before,"entries":[entry(3,"earlier"),entry(4,"older")],"more":true,"nextBefore":3}).to_string();
                                    let status=if index==4 {"500 Synthetic failure"} else {"200 OK"};
                                    let _=stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
                                    return;
                                }
                                assert_eq!(path,"/api/sessions/a/history?before=5&limit=24");
                                let body=json!({"entries":[entry(3,"earlier"),entry(4,"older")],"more":true}).to_string();
                                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap(); return;
                            }
                            let key=headers.lines().find_map(|line| line.strip_prefix("Sec-WebSocket-Key: ").or_else(||line.strip_prefix("sec-websocket-key: "))).unwrap();
                            let response=format!("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {}\r\n\r\n",derive_accept_key(key.trim().as_bytes()));
                            stream.write_all(response.as_bytes()).await.unwrap();
                            active.fetch_add(1,Ordering::SeqCst);
                            struct Guard(Arc<AtomicUsize>); impl Drop for Guard { fn drop(&mut self){ self.0.fetch_sub(1,Ordering::SeqCst); } }
                            let _guard=Guard(active);
                            let mut socket=tokio_tungstenite::WebSocketStream::from_raw_socket(stream,Role::Server,None).await;
                            if path=="/api/ws" {
                                socket.send(Frame::Text(json!({"type":"projects","projects":[{"id":"p-a","name":"Synthetic project A","path":"/synthetic/a","environment":{"ignore":"synthetic-only"}},{"id":"p-b","name":"Synthetic project B","path":"/synthetic/b"}]}).to_string().into())).await.unwrap();
                                if matches!(scenario, Scenario::AttentionFreshness) && steps.recv().await.is_err() { return; }
                                if matches!(scenario, Scenario::ListAdmission | Scenario::ListSnapshot) {
                                    let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                                    let count = if matches!(scenario, Scenario::ListSnapshot) { 10005 } else { 1000 };
                                    let mut summaries: Vec<_> = (0..count).map(|i| json!({"id":format!("old-{i}"),"title":"Existing chat","state":"idle","projectId":"p-a","updatedAt":i})).collect();
                                    if attempt > 0 {
                                        summaries.push(json!({"id":"New-Canonical","title":"Reconnect snapshot","state":"idle","projectId":"p-b","missionId":"Mission-New","createdAt":20000}));
                                    }
                                    socket.send(Frame::Text(json!({"type":"sessions","sessions":summaries}).to_string().into())).await.unwrap();
                                    if steps.recv().await.is_err() { return; }
                                    for title in ["Created elsewhere", "Updated once"] {
                                        socket.send(Frame::Text(json!({"type":"session","session":{"id":"New-Canonical","title":title,"state":"idle","projectId":"p-b","missionId":"Mission-New","createdAt":20000}}).to_string().into())).await.unwrap();
                                    }
                                    if matches!(scenario, Scenario::ListSnapshot) {
                                        for i in 0..64 {
                                            socket.send(Frame::Text(json!({"type":"session","session":{"id":format!("burst-{i}"),"title":"Synthetic burst","state":"working","projectId":"p-a","updatedAt":30000+i}}).to_string().into())).await.unwrap();
                                        }
                                    }
                                    // Ordered marker proves the preceding new-session frames were consumed.
                                    socket.send(Frame::Text(json!({"type":"session","session":{"id":"old-0","title":"After new events","state":"idle","projectId":"p-a"}}).to_string().into())).await.unwrap();
                                } else if matches!(scenario, Scenario::MissionTitles) {
                                    // The daemon's own mission list frame: on connection, then after every change.
                                    let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                                    socket.send(Frame::Text(json!({"type":"sessions","sessions":[{"id":"coord","title":"Coordinator","state":"idle","projectId":"p-a","missionId":"m-0","missionCoordinator":true},{"id":"member","title":"Member","state":"idle","projectId":"p-a","missionId":"m-1"},{"id":"orphan","title":"Orphan","state":"idle","projectId":"p-a","missionId":"m-gone"}]}).to_string().into())).await.unwrap();
                                    let mut missions: Vec<_> = (0..1500).map(|i| json!({"id":format!("m-{i}"),"projectId":"p-a","title":format!("Mission {i}"),"goal":"","status":"active","briefRevision":0,"needsYouCount":0,"tasksDone":0,"tasksTotal":0,"createdAt":i,"updatedAt":i})).collect();
                                    missions.push(json!({"id":"m-bad","title":7}));
                                    missions.push(json!({"title":"No identity"}));
                                    if attempt > 0 { missions[0]["title"] = json!("Reconnected name"); }
                                    socket.send(Frame::Text(json!({"type":"missions","missions":missions}).to_string().into())).await.unwrap();
                                    if attempt == 0 {
                                        if steps.recv().await.is_err() { return; }
                                        missions[0]["title"] = json!("Renamed 日本語");
                                        socket.send(Frame::Text(json!({"type":"missions","missions":missions}).to_string().into())).await.unwrap();
                                        socket.send(Frame::Text(json!({"type":"session","session":{"id":"member","title":"Member","state":"idle","projectId":"p-a","missionId":"m-2"}}).to_string().into())).await.unwrap();
                                        // A malformed list keeps the previous names rather than erasing them.
                                        socket.send(Frame::Text(json!({"type":"missions","missions":{}}).to_string().into())).await.unwrap();
                                        socket.send(Frame::Text(json!({"type":"session","session":{"id":"coord","title":"After mission frames","state":"idle","projectId":"p-a","missionId":"m-0","missionCoordinator":true}}).to_string().into())).await.unwrap();
                                    }
                                } else {
                                socket.send(Frame::Text(json!({"type":"sessions","sessions":[{"id":"a","title":"Synthetic A","state":"working","projectId":"p-a"},{"id":"b","title":"Synthetic B","state":"idle","projectId":"p-b"}]}).to_string().into())).await.unwrap();
                                }
                                if matches!(scenario, Scenario::ProviderUsage) {
                                    for usage in [
                                        json!({"subscription":{"provider":"anthropic","fetchedAt":1000,"windows":[{"label":"5h","usedPercent":96}]}}),
                                        json!({"subscription":{"provider":"anthropic","fetchedAt":2000,"windows":[{"label":"5h","usedPercent":0},{"label":"Week","usedPercent":30}]}}),
                                        json!({"subscription":{"provider":"anthropic","fetchedAt":3000,"windows":[],"error":"private provider response"}}),
                                        json!({}),
                                    ] {
                                        if steps.recv().await.is_err() { return; }
                                        socket.send(Frame::Text(json!({"type":"session","session":{"id":"a","title":"Synthetic A","usage":usage}}).to_string().into())).await.unwrap();
                                    }
                                }
                                if matches!(scenario, Scenario::ContextUsage) {
                                    for usage in [json!({"context":{"tokens":42,"contextWindow":100}}), json!({"context":{"tokens":80,"contextWindow":100}}), json!({})] {
                                        if steps.recv().await.is_err() { return; }
                                        socket.send(Frame::Text(json!({"type":"session","session":{"id":"a","title":"Synthetic A","usage":usage}}).to_string().into())).await.unwrap();
                                    }
                                }
                            } else {
                                let id=if path.contains("/b/"){ "b" }else{ "a" };
                                if matches!(scenario,Scenario::Refused) {
                                    let _=socket.close(Some(CloseFrame{code:CloseCode::Library(4404),reason:"synthetic refusal".into()})).await; return;
                                }
                                let attempt=attempts.fetch_add(1,Ordering::SeqCst);
                                let resumed=matches!(scenario,Scenario::Resume | Scenario::CompactionResume)&&attempt>0;
                                socket.send(Frame::Text(json!({"type":"chat.stream","sessionId":id,"streamId":"synthetic-stream","resumed":resumed}).to_string().into())).await.unwrap();
                                if resumed {
                                    assert!(path.ends_with("&stream=synthetic-stream&after=2"));
                                    socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":3,"events":[{"type":"entry_appended","entry":entry(8,"resumed")}]}).to_string().into())).await.unwrap();
                                } else {
                                    let mut head=entry(5,&format!("{id} tail")); head["head"]=json!(5);
                                    let mut initial=json!({"type":"snapshot","entries":[head]});
                                    if matches!(scenario,Scenario::Paged) {initial["history"]=json!({"context":{"conversationId":if id=="a"{0}else{1},"tail":5},"more":true,"before":5,"question":null});}
                                    socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":1,"events":[initial]}).to_string().into())).await.unwrap();
                                    if matches!(scenario,Scenario::Paged)&&attempt==0 {
                                        if steps.recv().await.is_err(){return;}
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":2,"events":[{"type":"entry_appended","entry":entry(6,"live while paging")}]}).to_string().into())).await.unwrap();
                                        if steps.recv().await.is_err(){return;}
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":3,"events":[{"type":"snapshot","entries":[entry(9,"replacement tail")],"history":{"context":{"conversationId":0,"tail":9},"more":true,"before":9,"question":null}}]}).to_string().into())).await.unwrap();
                                    }
                                    if matches!(scenario,Scenario::LargeFrame | Scenario::LargeFragmentedMessage) {
                                        let payload=json!({"type":"events","sessionId":id,"seq":2,"events":[{"type":"entry_appended","entry":entry(6,&large_stream_text())}]}).to_string();
                                        assert!(payload.len()>8*1024*1024);
                                        if matches!(scenario,Scenario::LargeFragmentedMessage) {
                                            use tokio_tungstenite::tungstenite::protocol::frame::{Frame as RawFrame, coding::{Data, OpCode}};
                                            let chunks:Vec<_>=payload.as_bytes().chunks(3*1024*1024).collect();
                                            for (index,chunk) in chunks.iter().enumerate() {
                                                socket.send(Frame::Frame(RawFrame::message(
                                                    chunk.to_vec(),
                                                    OpCode::Data(if index==0 {Data::Text} else {Data::Continue}),
                                                    index+1==chunks.len(),
                                                ))).await.unwrap();
                                            }
                                        } else {
                                            socket.send(Frame::Text(payload.into())).await.unwrap();
                                        }
                                        if steps.recv().await.is_err() {return;}
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":3,"events":[{"type":"entry_appended","entry":entry(7,"after large message")}]}).to_string().into())).await.unwrap();
                                    }
                                    if matches!(scenario,Scenario::CompactionResume) {
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":2,"events":[{"type":"compaction_start","taskId":20}]}).to_string().into())).await.unwrap();
                                        if steps.recv().await.is_err() {return;}
                                        let _=socket.close(Some(CloseFrame{code:CloseCode::Again,reason:"synthetic restart".into()})).await; return;
                                    }
                                    if matches!(scenario,Scenario::Resume) {
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":2,"events":[{"type":"entry_appended","entry":entry(7,"before disconnect")}]}).to_string().into())).await.unwrap();
                                        let _=socket.close(Some(CloseFrame{code:CloseCode::Again,reason:"synthetic restart".into()})).await; return;
                                    }
                                    if matches!(scenario,Scenario::Todos) {
                                        let row=json!({"id":"TODO-a","title":"Only public progress","status":"open","createdAt":"2026-10-26","assignedToSession":id});
                                        // Wrong owner and duplicate sequence must never replace the selected feed.
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":"foreign","seq":2,"events":[{"type":"todos_update","items":[]}]}).to_string().into())).await.unwrap();
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":2,"events":[{"type":"todos_update","items":[row]}]}).to_string().into())).await.unwrap();
                                        if steps.recv().await.is_err() {return;}
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":3,"events":[{"type":"todos_update","items":null}]}).to_string().into())).await.unwrap();
                                        if steps.recv().await.is_err() {return;}
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":4,"events":[{"type":"todos_update","items":[]}]}).to_string().into())).await.unwrap();
                                    }
                                    if matches!(scenario,Scenario::Compacting) {
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":2,"events":[{"type":"compaction_start","taskId":10}]}).to_string().into())).await.unwrap();
                                        if steps.recv().await.is_err() {return;}
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":3,"events":[{"type":"compaction_end","taskId":10,"error":"synthetic failure"}]}).to_string().into())).await.unwrap();
                                        if steps.recv().await.is_err() {return;}
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":4,"events":[{"type":"snapshot","entries":[head.clone()],"compactions":[{"taskId":11}]}]}).to_string().into())).await.unwrap();
                                        if steps.recv().await.is_err() {return;}
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":5,"events":[{"type":"snapshot","entries":[head],"compactions":[]}]}).to_string().into())).await.unwrap();
                                    }
                                    if matches!(scenario,Scenario::Thinking) {
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":2,"events":[{"type":"message_start","message":{"content":[{"type":"thinking","thinking":"synthetic"}]}}]}).to_string().into())).await.unwrap();
                                        if steps.recv().await.is_err() {return;}
                                        let changes:Vec<_>=(0..1024).map(|_|json!({"type":"thinking_delta","contentIndex":0,"delta":"x".repeat(4096)})).collect();
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":3,"events":[{"type":"message_update","changes":changes}]}).to_string().into())).await.unwrap();
                                        if steps.recv().await.is_err() {return;}
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":4,"events":[{"type":"run_end"}]}).to_string().into())).await.unwrap();
                                    }
                                }
                            }
                            while let Some(Ok(frame))=socket.next().await {
                                assert!(!matches!(frame,Frame::Text(_) | Frame::Binary(_)),"viewer must not send application WS messages");
                            }
                        });
                    }
                    _=handlers.join_next(), if !handlers.is_empty()=>{}
                }
            }
        });
        Self {
            options,
            requests,
            sockets,
            task,
            step,
            page_step,
        }
    }
}
fn entry(id: u64, text: &str) -> Value {
    json!({"id":id,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":text}]}]})
}
async fn until(
    rx: &async_channel::Receiver<Presentation>,
    predicate: impl Fn(&Presentation) -> bool,
) -> Presentation {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = rx.recv().await.unwrap();
            if predicate(&value) {
                return value;
            }
        }
    })
    .await
    .expect("bounded synthetic update")
}

#[tokio::test]
async fn thinking_deltas_do_not_publish_transcripts_or_wake_the_ui() {
    let mock = Mock::start(Scenario::Thinking).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    until(&rx, |v| v.list_loaded).await;
    client.command(Command::Open {
        id: "a".into(),
        generation: 1,
    });
    let thinking = until(&rx, |v| v.thinking).await;
    assert_eq!(thinking.rows.len(), 1);
    assert_eq!(thinking.rows[0].source(), "a tail");
    mock.step.send(()).await.unwrap();
    mock.step.send(()).await.unwrap();
    let done = until(&rx, |v| v.batches == 4).await;
    assert!(!done.thinking);
    assert!(done.rows == thinking.rows);
    assert_eq!(
        done.test_publications,
        thinking.test_publications + 1,
        "only run_end publishes; 1024 reasoning deltas do not clone rows or wake the UI, even if the receiver coalesces"
    );
    drop(client);
    assert!(
        mock.requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.starts_with("GET "))
    );
}

#[tokio::test]
async fn mission_titles_follow_the_session_socket_mission_list() {
    // An older contract without a mission list leaves names unknown, not empty.
    let old = Mock::start(Scenario::Normal).await;
    let (_old_client, old_rx) = LocalClient::start(old.options.clone());
    let listed = until(&old_rx, |v| v.list_loaded).await;
    assert!(listed.mission_titles.is_none());

    let mock = Mock::start(Scenario::MissionTitles).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    let initial = until(&rx, |v| v.mission_titles.is_some()).await;
    let titles = initial.mission_titles.clone().unwrap();
    assert_eq!(titles.len(), 1500, "every mission is named, no count cap");
    assert_eq!(titles.get("m-0").map(String::as_str), Some("Mission 0"));
    assert_eq!(
        titles.get("m-1499").map(String::as_str),
        Some("Mission 1499")
    );
    assert!(!titles.contains_key("m-gone") && !titles.contains_key("m-bad"));
    assert!(initial.list_loaded || until(&rx, |v| v.list_loaded).await.list_loaded);

    mock.step.send(()).await.unwrap();
    let renamed = until(&rx, |v| {
        v.chats.iter().any(|c| c.title == "After mission frames")
    })
    .await;
    let titles = renamed.mission_titles.clone().unwrap();
    assert_eq!(
        titles.get("m-0").map(String::as_str),
        Some("Renamed 日本語")
    );
    assert_eq!(
        titles.len(),
        1500,
        "malformed list keeps the previous names"
    );
    let member = renamed.chats.iter().find(|c| c.id == "member").unwrap();
    assert_eq!(
        member.mission,
        crate::local_model::MissionAssociation::Linked("m-2".into())
    );
    assert_eq!(titles.get("m-2").map(String::as_str), Some("Mission 2"));

    assert!(client.command(Command::Reconnect));
    let recovered = until(&rx, |v| {
        v.mission_titles
            .as_ref()
            .is_some_and(|t| t.get("m-0").map(String::as_str) == Some("Reconnected name"))
    })
    .await;
    assert_eq!(recovered.mission_titles.unwrap().len(), 1500);
    assert!(
        mock.requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.starts_with("GET ") && !r.contains("mission"))
    );
}

#[tokio::test]
async fn connected_daemon_follows_the_live_control_socket_hello() {
    // An older daemon without a version is connected but unknown, never assumed.
    let legacy = Mock::start(Scenario::Normal).await;
    let (legacy_client, legacy_rx) = LocalClient::start(legacy.options.clone());
    assert_eq!(legacy_client.daemon(), ConnectedDaemon::NotConnected);
    until(&legacy_rx, |_| {
        legacy_client.daemon() != ConnectedDaemon::NotConnected
    })
    .await;
    assert_eq!(legacy_client.daemon(), ConnectedDaemon::Connected(None));

    let mock = Mock::start(Scenario::DaemonVersion).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    let connected = until(&rx, |_| client.daemon() != ConnectedDaemon::NotConnected).await;
    assert_eq!(connected.status, "Connected · Local");
    assert_eq!(
        client.daemon(),
        ConnectedDaemon::Connected(Some("1.91.0".into()))
    );
    // Reconnecting reports the daemon now answering, not the one seen before.
    assert!(client.command(Command::Reconnect));
    until(&rx, |_| {
        client.daemon() == ConnectedDaemon::Connected(Some("1.92.0".into()))
    })
    .await;
    // A vanished daemon is not connected; its last version is not kept.
    drop(mock);
    let gone = until(&rx, |_| client.daemon() == ConnectedDaemon::NotConnected).await;
    assert_ne!(gone.status, "Connected · Local");
}

#[tokio::test]
async fn real_sockets_are_readonly_paged_switch_fenced_and_cancelled() {
    let mock = Mock::start(Scenario::Normal).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    let catalog = until(&rx, |v| v.chats.len() == 2 && v.projects_loaded).await;
    assert_eq!(catalog.projects.len(), 2);
    assert_eq!(catalog.projects[0].id, "p-a");
    assert_eq!(catalog.projects[1].path, "/synthetic/b");
    assert_eq!(catalog.chats[0].project_id.as_deref(), Some("p-a"));
    assert!(catalog.projects_error.is_none());
    assert!(client.command(Command::Open {
        id: "a".into(),
        generation: 1
    }));
    until(&rx, |v| v.generation == 1 && v.rows.len() == 1).await;
    assert!(client.command(Command::Earlier {
        before: 5,
        generation: 1
    }));
    let page = until(&rx, |v| v.rows.len() == 3).await;
    assert_eq!(page.cursor, Some(3));
    assert!(client.command(Command::Open {
        id: "a".into(),
        generation: 2
    }));
    assert!(client.command(Command::Open {
        id: "b".into(),
        generation: 3
    }));
    let selected = until(&rx, |v| v.generation == 3 && !v.rows.is_empty()).await;
    assert_eq!(selected.rows[0].source(), "b tail");
    drop(client);
    tokio::time::timeout(Duration::from_secs(2), async {
        while mock.sockets.load(Ordering::SeqCst) > 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    for request in mock.requests.lock().unwrap().iter() {
        assert!(
            request.starts_with("GET /api/hello ")
                || request.starts_with("GET /api/ws ")
                || request.starts_with("GET /api/sessions/")
        );
        assert!(
            !request.contains("/messages")
                && !request.contains("/read")
                && !request.contains("/archive")
        );
    }
}

#[tokio::test]
async fn captured_pages_keep_live_tail_and_fence_snapshot_navigation_reconnect_and_failure() {
    async fn requested(mock: &Mock, n: usize) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while mock
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.contains("/history?"))
                .count()
                < n
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    let mock = Mock::start(Scenario::Paged).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    until(&rx, |v| v.list_loaded).await;
    client.command(Command::Open {
        id: "a".into(),
        generation: 1,
    });
    let recent = until(&rx, |v| v.generation == 1 && v.loaded).await;
    assert_eq!(recent.rows.len(), 1);
    assert_eq!(recent.cursor, Some(5));
    assert!(
        !mock
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("/history?")),
        "initial readiness cannot crawl history"
    );
    client.command(Command::Earlier {
        before: 5,
        generation: 1,
    });
    requested(&mock, 1).await;
    mock.step.send(()).await.unwrap();
    let streaming = until(&rx, |v| v.rows.len() == 2).await;
    assert!(streaming.loaded && streaming.page_busy);
    assert_eq!(streaming.rows[1].source(), "live while paging");
    mock.step.send(()).await.unwrap();
    let replacement = until(&rx, |v| v.cursor == Some(9) && !v.page_busy).await;
    assert_eq!(replacement.rows.len(), 1);
    assert_eq!(replacement.rows[0].source(), "replacement tail");
    mock.page_step.send(()).await.unwrap(); // Obsolete pre-replacement response.
    client.command(Command::Earlier {
        before: 9,
        generation: 1,
    });
    requested(&mock, 2).await;
    client.command(Command::Open {
        id: "b".into(),
        generation: 2,
    });
    until(&rx, |v| v.generation == 2 && v.loaded).await;
    client.command(Command::Open {
        id: "a".into(),
        generation: 3,
    });
    let back = until(&rx, |v| v.generation == 3 && v.loaded).await;
    assert_eq!(back.rows.len(), 1);
    assert_eq!(back.rows[0].source(), "a tail");
    mock.page_step.send(()).await.unwrap(); // A/B/A cannot accept generation1.
    client.command(Command::Earlier {
        before: 5,
        generation: 3,
    });
    requested(&mock, 3).await;
    let batches = back.batches;
    client.command(Command::Reconnect);
    let reconnected = until(&rx, |v| {
        v.generation == 3 && v.loaded && !v.page_busy && v.batches > batches
    })
    .await;
    assert_eq!(reconnected.rows.len(), 1);
    mock.page_step.send(()).await.unwrap(); // Old connection epoch cannot replace new snapshot.
    client.command(Command::Earlier {
        before: 5,
        generation: 3,
    });
    requested(&mock, 4).await;
    mock.page_step.send(()).await.unwrap();
    let failure = until(&rx, |v| v.page_error).await;
    assert!(failure.loaded && !failure.page_busy);
    assert_eq!(failure.cursor, Some(5));
    assert_eq!(failure.rows.len(), 1);
    client.command(Command::Earlier {
        before: 5,
        generation: 3,
    });
    requested(&mock, 5).await;
    mock.page_step.send(()).await.unwrap();
    let retried = until(&rx, |v| v.cursor == Some(3)).await;
    assert_eq!(retried.rows.len(), 3);
    assert!(!retried.page_error);
    assert!(
        mock.requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.starts_with("GET "))
    );
}

#[tokio::test]
async fn hello_is_validated_before_any_socket_and_redirects_are_not_followed() {
    for scenario in [Scenario::BadIdentity, Scenario::Redirect] {
        let mock = Mock::start(scenario).await;
        let (client, rx) = LocalClient::start(mock.options.clone());
        until(&rx, |v| {
            v.status.contains("identity changed") || v.status.contains("HTTP status")
        })
        .await;
        assert_eq!(mock.sockets.load(Ordering::SeqCst), 0);
        assert!(
            mock.requests
                .lock()
                .unwrap()
                .iter()
                .all(|r| r == "GET /api/hello HTTP/1.1")
        );
        drop(client);
    }
}

#[tokio::test]
async fn reconnect_resumes_after_applied_sequence_without_duplicate_rows() {
    let mock = Mock::start(Scenario::Resume).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    until(&rx, |v| v.chats.len() == 2).await;
    client.command(Command::Open {
        id: "a".into(),
        generation: 1,
    });
    let view = until(&rx, |v| v.rows.len() == 3).await;
    assert_eq!(view.rows[2].source(), "resumed");
    let requests = mock.requests.lock().unwrap();
    let second = requests
        .iter()
        .position(|r| r.contains("&stream=synthetic-stream&after=2"))
        .unwrap();
    assert!(requests[..second].last().unwrap().contains("/api/hello"));
}

#[tokio::test]
async fn final_close_does_not_automatically_reopen() {
    let mock = Mock::start(Scenario::Refused).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    until(&rx, |v| v.chats.len() == 2).await;
    client.command(Command::Open {
        id: "a".into(),
        generation: 1,
    });
    until(&rx, |v| v.chat_status.contains("subscription refused")).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        mock.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.contains("/sessions/a/ws"))
            .count(),
        1
    );
}

#[path = "provider_usage_reader_tests.rs"]
mod provider_usage_reader_tests;

#[path = "context_usage_reader_tests.rs"]
mod context_usage_reader_tests;

#[tokio::test]
async fn session_todos_use_only_selected_public_stream_and_retain_bad_replacements() {
    use crate::session_todos::Phase;
    let mock = Mock::start(Scenario::Todos).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    until(&rx, |v| v.list_loaded).await;
    client.command(Command::Open {
        id: "a".into(),
        generation: 7,
    });
    let ready = until(&rx, |v| v.todos.phase == Phase::Ready).await;
    assert!(ready.todos.visible(Some(&mock.options), Some("a"), 7));
    let before = ready.todos.snapshot.unwrap();
    assert_eq!(before.count, 1);
    assert!(before.rows[0].working);
    mock.step.send(()).await.unwrap();
    let bad = until(&rx, |v| v.todos.phase == Phase::Retained).await;
    assert!(Arc::ptr_eq(&before, bad.todos.snapshot.as_ref().unwrap()));
    mock.step.send(()).await.unwrap();
    until(&rx, |v| {
        v.todos.phase == Phase::Ready && v.todos.snapshot.as_ref().is_some_and(|s| s.count == 0)
    })
    .await;
    client.command(Command::Open {
        id: "b".into(),
        generation: 8,
    });
    let next = until(&rx, |v| v.generation == 8 && v.todos.phase == Phase::Ready).await;
    assert!(next.todos.visible(Some(&mock.options), Some("b"), 8));
    assert!(!next.todos.visible(Some(&mock.options), Some("a"), 7));
    let requests = mock.requests.lock().unwrap();
    assert!(requests.iter().all(|r| r.starts_with("GET ")));
    assert!(requests.iter().all(|r| r.contains("/api/hello ")
        || r.contains("/api/ws ")
        || r.contains("/api/sessions/a/ws?history=paged-v1 ")
        || r.contains("/api/sessions/b/ws?history=paged-v1 ")));
}
#[test]
fn session_todos_source_equality_includes_exact_home_daemon_lineage_port() {
    let options = LocalOptions::synthetic(123);
    assert!(options.same_todo_source(&options));
    for field in 0..4 {
        let mut other = options.clone();
        match field {
            0 => other.port += 1,
            1 => other.daemon_id = "other".into(),
            2 => other.lineage_id = "other".into(),
            _ => other.native_home = Some("/synthetic/other".into()),
        }
        assert!(!options.same_todo_source(&other));
    }
}

fn large_stream_text() -> String {
    // UTF-8 exactness as well as size. Greater than the removed 8 MiB limit.
    "Exact 日本語 🦀\n".repeat(500_000)
}

async fn large_stream_is_intact(scenario: Scenario) {
    let mock = Mock::start(scenario).await;
    let (client, updates) = LocalClient::start(mock.options.clone());
    until(&updates, |view| !view.chats.is_empty()).await;
    assert!(client.command(Command::Open {
        id: "a".into(),
        generation: 1
    }));
    let loaded = until(&updates, |view| {
        view.rows
            .iter()
            .any(|row| row.reader_key() == Some(crate::model::ReaderKey::model(6, 0, Some(0))))
    })
    .await;
    let source = loaded
        .rows
        .iter()
        .find(|row| row.reader_key() == Some(crate::model::ReaderKey::model(6, 0, Some(0))))
        .unwrap()
        .shared_source();
    assert!(source.len() > 8 * 1024 * 1024);
    assert_eq!(source.as_str(), large_stream_text());
    mock.step.send(()).await.unwrap();
    let continued = until(&updates, |view| {
        view.rows
            .iter()
            .any(|row| row.source() == "after large message")
    })
    .await;
    assert_eq!(
        continued
            .rows
            .iter()
            .find(|row| row.reader_key() == Some(crate::model::ReaderKey::model(6, 0, Some(0))))
            .unwrap()
            .source(),
        source.as_str()
    );
    assert_eq!(
        mock.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.contains("/api/sessions/a/ws"))
            .count(),
        1,
        "same subscription survives"
    );
    drop(client);
    tokio::time::timeout(Duration::from_secs(2), async {
        while mock.sockets.load(Ordering::SeqCst) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("large subscription cancels");
}

#[tokio::test]
async fn websocket_single_frame_above_eight_mib_preserves_source_and_continues() {
    large_stream_is_intact(Scenario::LargeFrame).await;
}

#[tokio::test]
async fn websocket_fragmented_message_above_eight_mib_preserves_source_and_continues() {
    large_stream_is_intact(Scenario::LargeFragmentedMessage).await;
}

#[tokio::test]
async fn attention_waits_for_new_control_snapshot_after_reconnect() {
    let mock = Mock::start(Scenario::AttentionFreshness).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    let admitted = until(&rx, |v| v.status == "Connected · Local").await;
    assert!(!admitted.summary_fresh, "Hello is not fresh reason evidence");
    mock.step.send(()).await.unwrap();
    let initial = until(&rx, |v| v.summary_fresh).await;
    assert!(initial.list_loaded && !initial.chats.is_empty());
    assert!(client.command(Command::Reconnect));
    let retained = until(&rx, |v| {
        !v.summary_fresh && v.list_loaded
            && matches!(client.daemon(), ConnectedDaemon::Connected(_))
    }).await;
    assert_eq!(retained.chats.len(), initial.chats.len(), "Cached rows remain readable during hello/list gap");
    mock.step.send(()).await.unwrap();
    let current = until(&rx, |v| v.summary_fresh).await;
    assert_eq!(current.chats.len(), initial.chats.len());
}

#[tokio::test]
async fn list_admission_keeps_new_events_at_capacity_and_reconciles_reconnect() {
    let mock = Mock::start(Scenario::ListAdmission).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    let initial = until(&rx, |v| v.list_loaded).await;
    assert_eq!(initial.chats.len(), 1000);
    mock.step.send(()).await.unwrap();
    let live = until(&rx, |v| {
        v.chats.iter().any(|c| c.title == "After new events")
    })
    .await;
    assert_eq!(
        live.chats.len(),
        1001,
        "new identities must not be refused at 1000"
    );
    assert_eq!(live.chats[0].id, "New-Canonical");
    assert_eq!(live.chats[0].title, "Updated once");
    assert_eq!(live.chats[0].project_id.as_deref(), Some("p-b"));
    assert_eq!(
        live.mission_metadata.link("New-Canonical"),
        &crate::mission_inspector::Link::Mission {
            project: "p-b".into(),
            mission: "Mission-New".into()
        }
    );
    assert_eq!(
        live.chats
            .iter()
            .filter(|c| c.id == "New-Canonical")
            .count(),
        1
    );
    assert!(client.command(Command::Reconnect));
    let recovered = until(&rx, |v| {
        v.chats.iter().any(|c| c.title == "Reconnect snapshot")
    })
    .await;
    assert_eq!(recovered.chats.len(), 1001);
    assert_eq!(recovered.chats[0].id, "New-Canonical");
    assert!(
        mock.requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.starts_with("GET "))
    );
}

#[tokio::test]
async fn list_admission_initial_snapshot_keeps_every_project_summary() {
    let mock = Mock::start(Scenario::ListSnapshot).await;
    let started = std::time::Instant::now();
    let (_client, rx) = LocalClient::start(mock.options.clone());
    let initial = until(&rx, |v| v.list_loaded).await;
    let snapshot_time = started.elapsed();
    assert_eq!(
        initial.chats.len(),
        10005,
        "snapshot admission must not truncate before sorting/filtering"
    );
    assert_eq!(initial.chats[0].id, "old-10004");
    assert!(initial.chats.iter().any(|c| c.id == "old-0"));
    assert_eq!(
        initial.mission_metadata.link("old-10004"),
        &crate::mission_inspector::Link::Unlinked
    );
    let started = std::time::Instant::now();
    mock.step.send(()).await.unwrap();
    let streamed = until(&rx, |v| {
        v.chats.iter().any(|c| c.title == "After new events")
    })
    .await;
    println!(
        "synthetic summary workload: 10005-row initial snapshot {:?}, 67 ordered live frames {:?} (debug, loopback, worker projection only)",
        snapshot_time,
        started.elapsed()
    );
    assert_eq!(streamed.chats.len(), 10070);
    assert_eq!(streamed.chats[0].id, "burst-63");
    assert_eq!(
        streamed.mission_metadata.link("New-Canonical"),
        &crate::mission_inspector::Link::Mission {
            project: "p-b".into(),
            mission: "Mission-New".into()
        }
    );
}

#[tokio::test]
async fn live_compaction_publishes_without_transcript_spinners() {
    let mock = Mock::start(Scenario::Compacting).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    until(&rx, |v| v.list_loaded).await;
    client.command(Command::Open {
        id: "a".into(),
        generation: 1,
    });
    let active = until(&rx, |v| v.compacting).await;
    assert_eq!(active.rows.len(), 1);
    mock.step.send(()).await.unwrap();
    let ended = until(&rx, |v| v.batches == 3).await;
    assert!(!ended.compacting);
    assert!(ended.rows == active.rows);
    mock.step.send(()).await.unwrap();
    assert!(until(&rx, |v| v.batches == 4).await.compacting);
    mock.step.send(()).await.unwrap();
    assert!(!until(&rx, |v| v.batches == 5).await.compacting);
    drop(client);
    assert!(
        mock.requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.starts_with("GET "))
    );
}

#[tokio::test]
async fn compaction_resumes_only_with_the_validated_live_stream() {
    let mock = Mock::start(Scenario::CompactionResume).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    until(&rx, |v| v.list_loaded).await;
    client.command(Command::Open {
        id: "a".into(),
        generation: 1,
    });
    until(&rx, |v| v.compacting).await;
    mock.step.send(()).await.unwrap();
    until(&rx, |v| !v.compacting && v.chat_issue).await;
    let resumed = until(&rx, |v| v.batches == 3).await;
    assert!(resumed.compacting, "resume did not replay compaction_start");
    drop(client);
}
