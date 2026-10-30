//! Isolated source-shaped HTTP/control/chat daemon. No provider or real profile.
use crate::LocalOptions;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{Message as Frame, handshake::derive_accept_key, protocol::Role},
};

pub(crate) const ORIGINAL: &str = "Captured ordinary 日本語 👩‍💻 e\u{301}";
pub(crate) const NEWER: &str = "Newer unsent 🦀 e\u{301} 日本語";
pub(crate) const OLDER: &str = "Needle only in older history";

#[derive(Clone, Copy, Debug, Default)]
pub(crate) enum Receipt {
    #[default]
    Exact,
    Absent,
    Error,
    Ambiguous,
    Operation,
    Hash,
    Destination,
    Target,
    Result,
    Pending,
}
#[derive(Default)]
pub(crate) struct Seen {
    pub(crate) requests: Vec<(String, String)>,
    pub(crate) envelope: Option<Value>,
    pub(crate) executes: usize,
    pub(crate) accept_execute: bool,
    pub(crate) lookups: usize,
    pub(crate) receipt: Receipt,
    pub(crate) wrong_daemon: bool,
    pub(crate) wrong_lineage: bool,
    pub(crate) panic: Option<String>,
}
#[derive(Clone)]
struct Channels {
    seen: Arc<Mutex<Seen>>,
    entered: async_channel::Sender<()>,
    release: async_channel::Receiver<()>,
    responded: async_channel::Sender<()>,
    control: async_channel::Receiver<Option<Value>>,
    chat: async_channel::Receiver<Option<Value>>,
    pages: async_channel::Receiver<()>,
}
pub(crate) struct Server {
    pub(crate) options: LocalOptions,
    pub(crate) seen: Arc<Mutex<Seen>>,
    pub(crate) entered: async_channel::Receiver<()>,
    pub(crate) release: async_channel::Sender<()>,
    pub(crate) responded: async_channel::Receiver<()>,
    pub(crate) control: async_channel::Sender<Option<Value>>,
    pub(crate) chat: async_channel::Sender<Option<Value>>,
    pub(crate) pages: async_channel::Sender<()>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub(crate) fn start() -> Self {
        let seen = Arc::new(Mutex::new(Seen::default()));
        let (entered, reached) = async_channel::bounded(1);
        let (release, released) = async_channel::bounded(1);
        let (responded, responses) = async_channel::bounded(1);
        let (control, controls) = async_channel::bounded(8);
        let (chat, chats) = async_channel::bounded(8);
        let (pages, page_steps) = async_channel::bounded(8);
        let channels = Channels {
            seen: seen.clone(),
            entered,
            release: released,
            responded,
            control: controls,
            chat: chats,
            pages: page_steps,
        };
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let (shutdown, done) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async move {
                let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
                send.send(LocalOptions::synthetic(listener.local_addr().unwrap().port())).unwrap();
                let mut tasks = tokio::task::JoinSet::new();
                tokio::pin!(done);
                loop { tokio::select! {
                    _ = &mut done => break,
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        tasks.spawn(serve(stream, channels.clone()));
                    },
                    result = tasks.join_next(), if !tasks.is_empty() => {
                        if let Some(Err(error)) = result { channels.seen.lock().unwrap().panic = Some(error.to_string()); }
                    },
                }}
                tasks.abort_all();
                while tasks.join_next().await.is_some() {}
            });
        });
        Self {
            options: receive.recv_timeout(Duration::from_secs(5)).unwrap(),
            seen,
            entered: reached,
            release,
            responded: responses,
            control,
            chat,
            pages,
            shutdown: Some(shutdown),
            thread: Some(thread),
        }
    }
    pub(crate) fn assert_no_replay(&self) {
        let seen = self.seen.lock().unwrap();
        assert!(seen.panic.is_none(), "fixture handler: {:?}", seen.panic);
        assert_eq!(seen.executes, 1, "only the explicit native Send executes");
        assert!(seen.requests.iter().all(|(method, path)| method == "GET"
            || path == "/api/operations"
            || path == "/api/operations/receipt"));
        assert!(
            !seen
                .requests
                .iter()
                .any(|(_, path)| path.contains("/archive/ws")
                    || path.contains("/messages")
                    || path.contains("/restore"))
        );
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.shutdown.take().unwrap().send(());
        self.thread.take().unwrap().join().unwrap();
    }
}
pub(crate) fn summary(id: &str) -> Value {
    json!({"id":id,"title":"Same title 日本語 👩‍💻","mode":"build","state":"idle","cwd":"/synthetic","archivedAt":if id=="archive"{Some(1)}else{None}})
}
pub(crate) fn baseline() -> Value {
    json!({"type":"sessions","sessions":[summary("a"),summary("b"),summary("archive")]})
}
pub(crate) fn entry(id: u64, text: &str) -> Value {
    json!({"id":id,"kind":"pi.user","model":[{"role":"user","content":text}]})
}
async fn response(stream: &mut TcpStream, status: &str, value: Value) {
    let body = value.to_string();
    let _ = stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
}
async fn frame(socket: &mut WebSocketStream<TcpStream>, value: Value) -> bool {
    socket
        .send(Frame::Text(value.to_string().into()))
        .await
        .is_ok()
}
async fn serve(stream: TcpStream, c: Channels) {
    let mut reader = BufReader::new(stream);
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
            return;
        }
        if line == "\r\n" {
            break;
        }
        headers.push_str(&line);
        assert!(headers.len() < 8192);
    }
    let first = headers.lines().next().unwrap();
    let mut words = first.split_whitespace();
    let method = words.next().unwrap();
    let path = words.next().unwrap();
    c.seen
        .lock()
        .unwrap()
        .requests
        .push((method.into(), path.into()));
    let length = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|v| v.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    assert!(length < 128 * 1024);
    let mut body = vec![0; length];
    if reader.read_exact(&mut body).await.is_err() {
        return;
    }
    let mut stream = reader.into_inner();
    if let Some(key) = headers.lines().find_map(|line| {
        line.to_ascii_lowercase()
            .starts_with("sec-websocket-key:")
            .then(|| line.split_once(':').unwrap().1.trim())
    }) {
        stream.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {}\r\n\r\n",derive_accept_key(key.as_bytes())).as_bytes()).await.unwrap();
        let mut socket = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
        let feed = if path == "/api/ws" {
            // Baseline is deliberately held, even after a valid hello.
            c.control
        } else {
            let id = if path.starts_with("/api/sessions/a/ws?") {
                "a"
            } else {
                assert!(path.starts_with("/api/sessions/b/ws?"));
                "b"
            };
            assert!(path.contains("history=paged-v1"));
            frame(&mut socket,json!({"type":"chat.stream","sessionId":id,"streamId":format!("stream-{id}"),"resumed":false})).await;
            // Identical prose in both chats is deliberately NOT delivery evidence.
            let rows = (25..=84).map(|n|entry(n,if n==84 {ORIGINAL}else{"Retained page 日本語. Long paragraph for native scrolling and stable reading anchors. Retained page 日本語. Long paragraph for native scrolling and stable reading anchors."})).collect::<Vec<_>>();
            frame(&mut socket,json!({"type":"events","sessionId":id,"seq":1,"events":[{"type":"snapshot","entries":rows,"history":{"context":{"conversationId":if id=="a"{7}else{8},"tail":84},"more":true,"before":25,"question":null}}]})).await;
            c.chat
        };
        loop {
            tokio::select! {
                next = feed.recv() => match next {
                    Ok(Some(value)) => { if !frame(&mut socket,value).await {return;} },
                    _ => {let _=socket.close(None).await;return;},
                },
                next = socket.next() => if !matches!(next,Some(Ok(Frame::Ping(_) | Frame::Pong(_)))) {return;},
            }
        }
    }
    let value = match (method, path) {
        ("GET", "/api/hello") => {
            let s = c.seen.lock().unwrap();
            json!({"daemonId":if s.wrong_daemon{"wrong-daemon"}else{"test-daemon"},"lineageId":if s.wrong_lineage{"wrong-lineage"}else{"test-lineage"},"protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}})
        }
        ("GET", "/api/projects") => json!([]),
        ("GET", "/api/sessions/a") => summary("a"),
        ("GET", "/api/sessions/b") => summary("b"),
        ("POST", "/api/operations") => {
            let op: Value = serde_json::from_slice(&body).unwrap();
            {
                let mut s = c.seen.lock().unwrap();
                s.executes += 1;
                assert_eq!(op["kind"], "chat-send");
                assert_eq!(op["targetId"], "a");
                assert_eq!(
                    serde_json::from_str::<Value>(op["payload"].as_str().unwrap()).unwrap()["message"],
                    ORIGINAL
                );
                s.envelope = Some(op.clone());
            }
            c.entered.send(()).await.unwrap();
            let _ = c.release.recv().await;
            let accepted = c.seen.lock().unwrap().accept_execute;
            if accepted {
                response(&mut stream, "200 OK", json!({"operationId":op["operationId"],"payloadHash":op["payloadHash"],"destination":op["destination"],"targetId":op["targetId"],"state":"accepted","result":{"sessionId":"a"}})).await;
            }
            let _ = c.responded.try_send(());
            return; // The daemon admitted it but the exact ACK is lost.
        }
        ("POST", "/api/operations/receipt") => {
            let op: Value = serde_json::from_slice(&body).unwrap();
            let (mode, captured) = {
                let mut s = c.seen.lock().unwrap();
                s.lookups += 1;
                (s.receipt, s.envelope.clone())
            };
            let Some(captured) = captured else {
                response(&mut stream, "200 OK", json!({"state":"unknown"})).await;
                return;
            };
            assert_eq!(
                op, captured,
                "Check must use exact captured bytes/operation, not the visible chat"
            );
            let mut r = json!({"operationId":op["operationId"],"payloadHash":op["payloadHash"],"destination":op["destination"],"targetId":op["targetId"],"state":"accepted","result":{"sessionId":"a"}});
            match mode {
                Receipt::Exact => {}
                Receipt::Absent => r = json!({"state":"unknown"}),
                Receipt::Error => {
                    response(
                        &mut stream,
                        "503 Unavailable",
                        json!({"error":"Synthetic lookup unavailable"}),
                    )
                    .await;
                    return;
                }
                Receipt::Ambiguous => r = json!({"state":"accepted","result":{"sessionId":"a"}}),
                Receipt::Operation => r["operationId"] = json!("different-operation"),
                Receipt::Hash => r["payloadHash"] = json!("different-hash"),
                Receipt::Destination => r["destination"] = json!({}),
                Receipt::Target => r["targetId"] = json!("b"),
                Receipt::Result => r["result"]["sessionId"] = json!("b"),
                Receipt::Pending => {
                    r["state"] = json!("pending");
                    r["result"] = Value::Null;
                }
            }
            r
        }
        ("GET", _) if path.contains("/history?") => {
            let url = reqwest::Url::parse(&format!("http://localhost{path}")).unwrap();
            let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
            assert_eq!(q["limit"], "24");
            if c.pages.recv().await.is_err() {
                return;
            }
            if path.starts_with("/api/sessions/archive/") {
                assert_eq!(q.len(), 2, "Archive never uses an interactive snapshot");
                json!({"entries":[entry(1,"Passive archived source")],"more":false})
            } else {
                let context: Value = serde_json::from_str(&q["view"]).unwrap();
                let before = q["before"].parse::<u64>().unwrap();
                assert_eq!(before, 25);
                assert_eq!(context, json!({"conversationId":7,"tail":84}));
                json!({"context":context,"before":before,"entries":(1..25).map(|n|entry(n,if n==2{OLDER}else{"Earlier retained text"})).collect::<Vec<_>>(),"more":false})
            }
        }
        _ => panic!("Unexpected isolated lost-ACK route {method} {path}"),
    };
    response(&mut stream, "200 OK", value).await;
}
