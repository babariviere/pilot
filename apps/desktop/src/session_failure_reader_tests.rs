//! Actual hello-pinned Local reader against bounded synthetic sockets. GET only.
use super::*;
use futures_util::SinkExt;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};
use tokio_tungstenite::tungstenite::{handshake::derive_accept_key, protocol::Role};

async fn next(
    rx: &async_channel::Receiver<Presentation>,
    predicate: impl Fn(&Presentation) -> bool,
) -> Presentation {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let v = rx.recv().await.unwrap();
            if predicate(&v) {
                return v;
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn session_failure_summary_updates_and_reader_errors_stay_separate_and_chat_fenced() {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let options = LocalOptions {
        port: listener.local_addr().unwrap().port(),
        daemon_id: "failure-daemon".into(),
        lineage_id: "failure-lineage".into(),
        native_home: None,
    };
    let (send, updates) = async_channel::bounded::<Value>(4);
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let server = tokio::spawn(async move {
        let mut handlers = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted=listener.accept()=>{
                    let (stream,_)=accepted.unwrap(); let updates=updates.clone(); let seen=seen.clone();
                    handlers.spawn(async move {
                        let mut reader=BufReader::new(stream); let mut headers=String::new();
                        loop { let mut line=String::new(); if reader.read_line(&mut line).await.unwrap_or(0)==0 {return;} if line=="\r\n" {break;} headers.push_str(&line); assert!(headers.len()<8192); }
                        let first=headers.lines().next().unwrap(); assert!(first.starts_with("GET ")); seen.lock().unwrap().push(first.to_owned());
                        let path=first.split_whitespace().nth(1).unwrap(); let mut stream=reader.into_inner();
                        if path=="/api/hello" {
                            let body=json!({"daemonId":"failure-daemon","lineageId":"failure-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}).to_string();
                            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap(); return;
                        }
                        let key=headers.lines().find_map(|l| l.strip_prefix("Sec-WebSocket-Key: ").or_else(||l.strip_prefix("sec-websocket-key: "))).unwrap();
                        stream.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {}\r\n\r\n",derive_accept_key(key.trim().as_bytes())).as_bytes()).await.unwrap();
                        let mut socket=tokio_tungstenite::WebSocketStream::from_raw_socket(stream,Role::Server,None).await;
                        if path=="/api/ws" {
                            socket.send(Frame::Text(json!({"type":"sessions","sessions":[{"id":"A","state":"parked","outcome":"failed","outcomeAt":42,"outcomeReason":"Public cause\n第二 cause 👩🏽‍💻","error":"alternate public error"},{"id":"B","state":"idle"}]}).to_string().into())).await.unwrap();
                            while let Ok(update)=updates.recv().await { if socket.send(Frame::Text(update.to_string().into())).await.is_err() {break;} }
                        } else {
                            let id=if path.contains("/A/") {"A"} else {"B"};
                            for value in [json!({"type":"chat.stream","sessionId":id,"streamId":format!("stream-{id}"),"resumed":false}),json!({"type":"events","sessionId":id,"seq":1,"events":[{"type":"snapshot","entries":[]}]}),json!({"type":"error","sessionId":id,"message":"PRIVATE transport exception, never a run reason"})] {
                                if socket.send(Frame::Text(value.to_string().into())).await.is_err() {return;}
                            }
                            while let Some(Ok(frame))=socket.next().await { assert!(!matches!(frame, Frame::Text(_) | Frame::Binary(_))); }
                        }
                    });
                },
                _=handlers.join_next(),if !handlers.is_empty()=>{}
            }
        }
    });
    let (client, rx) = LocalClient::start(options);
    let initial = next(&rx, |v| v.list_loaded).await;
    let f = initial
        .chats
        .iter()
        .find(|c| c.id == "A")
        .unwrap()
        .failure
        .clone()
        .unwrap();
    assert_eq!(f.reason, "Public cause\n第二 cause 👩🏽‍💻");
    assert_eq!(f.at, Some(42));
    assert!(client.command(Command::Open {
        id: "A".into(),
        generation: 1
    }));
    let loaded = next(&rx, |v| {
        v.generation == 1 && v.chat_status.contains("details omitted")
    })
    .await;
    assert_eq!(
        loaded.chats.iter().find(|c| c.id == "A").unwrap().failure,
        Some(f.clone())
    );
    send.send(json!({"type":"session","session":{"id":"A","state":"working","working":true}}))
        .await
        .unwrap();
    next(&rx, |v| {
        v.chats
            .iter()
            .any(|c| c.id == "A" && c.busy && c.failure.is_none())
    })
    .await;
    assert!(client.command(Command::Open {
        id: "B".into(),
        generation: 2
    }));
    send.send(json!({"type":"session","session":{"id":"A","state":"failed","outcome":"failed","outcomeAt":43}})).await.unwrap();
    let late = next(&rx, |v| {
        v.generation == 2 && v.loaded && v.chats.iter().any(|c| c.id == "A" && c.failure.is_some())
    })
    .await;
    assert!(
        late.chats
            .iter()
            .find(|c| c.id == "B")
            .unwrap()
            .failure
            .is_none()
    );
    assert_eq!(
        late.chats
            .iter()
            .find(|c| c.id == "A")
            .unwrap()
            .failure
            .as_ref()
            .unwrap()
            .reason,
        crate::session_failure::MISSING
    );
    drop(client);
    server.abort();
    let _ = server.await;
    assert!(
        requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.starts_with("GET "))
    );
}
