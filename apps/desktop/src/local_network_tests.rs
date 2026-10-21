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
    BadIdentity,
    Redirect,
    Resume,
    Refused,
}
struct Mock {
    options: LocalOptions,
    requests: Arc<Mutex<Vec<String>>>,
    sockets: Arc<AtomicUsize>,
    task: JoinHandle<()>,
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
            port: listener.local_addr().unwrap().port(),
            daemon_id: "synthetic-daemon".into(),
            lineage_id: "synthetic-lineage".into(),
        };
        let requests = Arc::new(Mutex::new(Vec::new()));
        let sockets = Arc::new(AtomicUsize::new(0));
        let (record, active) = (requests.clone(), sockets.clone());
        let attempts = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn(async move {
            let mut handlers = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept() => {
                        let Ok((stream,_))=accepted else { break; };
                        let (record,active,attempts)=(record.clone(),active.clone(),attempts.clone());
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
                                let body=json!({"daemonId":if matches!(scenario,Scenario::BadIdentity) {"wrong"}else{"synthetic-daemon"},"lineageId":"synthetic-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}).to_string();
                                let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                                stream.write_all(response.as_bytes()).await.unwrap(); return;
                            }
                            if path.contains("/history?") {
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
                                socket.send(Frame::Text(json!({"type":"sessions","sessions":[{"id":"a","title":"Synthetic A","state":"working"},{"id":"b","title":"Synthetic B","state":"idle"}]}).to_string().into())).await.unwrap();
                            } else {
                                let id=if path.contains("/b/"){ "b" }else{ "a" };
                                if matches!(scenario,Scenario::Refused) {
                                    let _=socket.close(Some(CloseFrame{code:CloseCode::Library(4404),reason:"synthetic refusal".into()})).await; return;
                                }
                                let attempt=attempts.fetch_add(1,Ordering::SeqCst);
                                let resumed=matches!(scenario,Scenario::Resume)&&attempt>0;
                                socket.send(Frame::Text(json!({"type":"chat.stream","sessionId":id,"streamId":"synthetic-stream","resumed":resumed}).to_string().into())).await.unwrap();
                                if resumed {
                                    assert!(path.ends_with("?stream=synthetic-stream&after=2"));
                                    socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":3,"events":[{"type":"entry_appended","entry":entry(8,"resumed")}]}).to_string().into())).await.unwrap();
                                } else {
                                    let mut head=entry(5,&format!("{id} tail")); head["head"]=json!(5);
                                    socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":1,"events":[{"type":"snapshot","entries":[head]}]}).to_string().into())).await.unwrap();
                                    if matches!(scenario,Scenario::Resume) {
                                        socket.send(Frame::Text(json!({"type":"events","sessionId":id,"seq":2,"events":[{"type":"entry_appended","entry":entry(7,"before disconnect")}]}).to_string().into())).await.unwrap();
                                        let _=socket.close(Some(CloseFrame{code:CloseCode::Again,reason:"synthetic restart".into()})).await; return;
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
async fn real_sockets_are_readonly_paged_switch_fenced_and_cancelled() {
    let mock = Mock::start(Scenario::Normal).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    until(&rx, |v| v.chats.len() == 2).await;
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
        .position(|r| r.contains("?stream=synthetic-stream&after=2"))
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
