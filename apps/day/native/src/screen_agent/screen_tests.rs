//! Screen agent window side against a synthetic local HTTP peer, not a daemon or provider.
use super::*;
use crate::host::Source;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::fs::OpenOptionsExt,
};

const WINDOW: &str = "11111111-1111-4111-8111-111111111111";
const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==";

/// Answers the screen routes the way the contract says. Logs "METHOD route" and the JSON body.
struct Peer {
    path: std::path::PathBuf,
    port: u16,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    requests: Arc<Mutex<Value>>,
}
impl Peer {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("day-screen-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("daemon-id"), "daemon").unwrap();
        std::fs::write(path.join("storage-lineage"), "lineage").unwrap();
        let mut token = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path.join("github-app-capability"))
            .unwrap();
        write!(
            token,
            "{}",
            json!({"daemonId":"daemon","lineageId":"lineage","token":"a".repeat(64)})
        )
        .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let calls: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
        let requests = Arc::new(Mutex::new(json!([])));
        let (log, waiting) = (calls.clone(), requests.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut parts = first.split_whitespace();
                let method = parts.next().unwrap_or("").to_owned();
                let route = parts.next().unwrap_or("").to_owned();
                let (mut size, mut authorized) = (0, false);
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    let lower = line.to_lowercase();
                    if lower.starts_with("content-length:") {
                        size = line.split(':').nth(1).unwrap().trim().parse().unwrap();
                    }
                    if lower.starts_with("x-pilot-github-capability:") {
                        authorized = line.contains(&"a".repeat(64));
                    }
                }
                let mut body = vec![0; size];
                reader.read_exact(&mut body).unwrap();
                let (status, value) = if !authorized {
                    (403, json!({}))
                } else if route == "/api/hello" {
                    (
                        200,
                        json!({"daemonId":"daemon","lineageId":"lineage","minimumClientProtocolVersion":1,
                        "protocolVersion":1,"capabilities":{"independentExecution":true}}),
                    )
                } else if route.starts_with("/api/attachments/") && method == "PUT" {
                    let id = route.rsplit('/').next().unwrap();
                    (
                        200,
                        json!({"uploadId":id,"sha256":format!("{:x}", Sha256::digest(&body)),"bytes":body.len()}),
                    )
                } else if route == format!("/api/screen/requests?windowId={WINDOW}") {
                    (200, json!({"requests":waiting.lock().unwrap().clone()}))
                } else if route.starts_with("/api/screen/requests/gone") {
                    (404, json!({}))
                } else if route.starts_with("/api/screen/") {
                    (204, Value::Null)
                } else {
                    (404, json!({}))
                };
                let logged = if route.starts_with("/api/attachments/") {
                    json!(body.len())
                } else {
                    serde_json::from_slice(&body).unwrap_or(Value::Null)
                };
                log.lock()
                    .unwrap()
                    .push((format!("{method} {route}"), logged));
                let data = if status == 204 {
                    String::new()
                } else {
                    value.to_string()
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}",
                    data.len()
                );
            }
        });
        Self {
            path,
            port,
            calls,
            requests,
        }
    }
    fn transport(&self) -> Transport {
        Transport::new(Source {
            profile: self.path.clone(),
            port: self.port,
            home: crate::contract::Home {
                daemon_id: "daemon".into(),
                lineage_id: "lineage".into(),
            },
            project: None,
        })
        .unwrap()
    }
    fn calls(&self) -> Vec<(String, Value)> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn block<T>(f: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

fn request(id: &str, op: Value) -> Value {
    json!({"id":id,"sessionId":"chat-1","windowId":WINDOW,"operation":op,"deadline":now() + 60_000})
}

fn bound() -> Mutex<State> {
    let state = State {
        window: Some(WINDOW.into()),
        ..State::default()
    };
    Mutex::new(state)
}

#[test]
fn a_notice_keeps_tsx_requests_once_and_the_host_answers_pictures_itself() {
    let peer = Peer::new();
    let t = peer.transport();
    let state = bound();
    let heard = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = heard.clone();
    let notice: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
    });
    state.lock().unwrap().notice = Some(Arc::downgrade(&notice));
    let taker: Taker = Arc::new(|reply| {
        let _ = reply.try_send(Ok(Picture {
            png: STANDARD.decode(PNG).unwrap(),
            width: 1,
            height: 1,
        }));
    });
    state.lock().unwrap().taker = Some(taker);
    let mut other = request("r-other", json!({"op":"snapshot"}));
    other["windowId"] = json!("another-window");
    let mut extra = request("r-extra", json!({"op":"snapshot"}));
    extra["more"] = json!(true);
    *peer.requests.lock().unwrap() = json!([
        request("r1", json!({"op":"snapshot"})),
        request(
            "r2",
            json!({"op":"act","steps":[{"ref":"c1","action":"press"}]})
        ),
        request("r3", json!({"op":"screenshot"})),
        request("r4", json!({"op":"draw"})),
        other,
        extra,
    ]);
    block(read(&t, &state)).unwrap();
    assert_eq!(
        heard.load(Ordering::SeqCst),
        1,
        "one event for new TSX requests"
    );
    let calls = peer.calls();
    assert_eq!(
        calls[0].0,
        format!("GET /api/screen/requests?windowId={WINDOW}")
    );
    assert!(calls[1].0.starts_with("PUT /api/attachments/"), "{calls:?}");
    assert_eq!(calls[1].1, json!(STANDARD.decode(PNG).unwrap().len()));
    assert_eq!(calls[2].0, "GET /api/hello");
    assert_eq!(
        calls[3].0,
        format!("POST /api/screen/requests/r3?windowId={WINDOW}")
    );
    let answer = &calls[3].1;
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(answer["value"]["mimeType"], "image/png");
    assert_eq!(answer["value"]["width"], 1);
    assert_eq!(answer["value"]["attachment"].as_object().unwrap().len(), 3);
    assert_eq!(calls.len(), 4);
    let taken = state.lock().unwrap().take(now());
    let ids: Vec<_> = taken
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].clone())
        .collect();
    assert_eq!(
        ids,
        [json!("r1"), json!("r2")],
        "only this window's TSX requests"
    );
    assert_eq!(state.lock().unwrap().take(now()), json!([]), "taken once");
    assert_eq!(
        state
            .lock()
            .unwrap()
            .pictures
            .front()
            .map(|(s, p)| (s.clone(), p.clone())),
        Some(("chat-1".into(), answer["value"].clone()))
    );
    // A second notice reads again but hands nothing out twice.
    block(read(&t, &state)).unwrap();
    assert_eq!(peer.calls().len(), 1);
    assert_eq!(heard.load(Ordering::SeqCst), 1);
    assert!(state.lock().unwrap().waiting.is_empty());
}

#[test]
fn without_a_camera_a_picture_request_is_refused_with_a_sentence() {
    let peer = Peer::new();
    let t = peer.transport();
    let state = bound();
    *peer.requests.lock().unwrap() = json!([request("r1", json!({"op":"screenshot"}))]);
    block(read(&t, &state)).unwrap();
    let calls = peer.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(calls[1].1, json!({"ok":false,"error":NO_PICTURE}));
    assert!(state.lock().unwrap().pictures.is_empty());
}

#[test]
fn an_unbound_window_reads_nothing_and_answers_name_their_window() {
    let peer = Peer::new();
    let t = peer.transport();
    block(read(&t, &Mutex::new(State::default()))).unwrap();
    assert!(peer.calls().is_empty());
    let ok = json!({"ok":true,"value":{"entries":[]}});
    block(answer_once(&t, WINDOW, "r1", &ok)).unwrap();
    assert_eq!(
        block(answer_once(&t, WINDOW, "gone", &ok)),
        Err(Error::Stale),
        "unknown or expired"
    );
    let calls = peer.calls();
    assert_eq!(
        calls[0],
        (
            format!("POST /api/screen/requests/r1?windowId={WINDOW}"),
            ok
        )
    );
    block(bind(&t, WINDOW, Some("chat-1"))).unwrap();
    block(bind(&t, WINDOW, None)).unwrap();
    let calls = peer.calls();
    assert_eq!(
        calls[0],
        (
            "PUT /api/screen/bindings".into(),
            json!({"windowId":WINDOW,"sessionId":"chat-1"})
        )
    );
    assert_eq!(calls[1].0, format!("DELETE /api/screen/bindings/{WINDOW}"));
}

#[test]
fn a_notice_wakes_only_the_window_it_names() {
    let state = bound();
    let wake = state.lock().unwrap().wake.1.clone();
    let check = |frame: Value| state.lock().unwrap().notice(&frame);
    check(json!({"type":"screen.requested","windowId":"another"}));
    assert!(wake.try_recv().is_err());
    check(json!({"type":"screen.requested","windowId":WINDOW}));
    check(json!({"type":"screen.requested","windowId":WINDOW}));
    assert!(wake.try_recv().is_ok());
    assert!(wake.try_recv().is_err(), "bursts cost one read");
    // A late request past its deadline is not handed out.
    let mut s = State::default();
    let mut late = request("late", json!({"op":"snapshot"}));
    late["deadline"] = json!(1);
    s.waiting = vec![late, request("r1", json!({"op":"query","text":"New"}))];
    assert_eq!(s.take(now()).as_array().unwrap().len(), 1);
}

#[test]
fn answers_are_exact_and_limited() {
    for good in [
        json!({"ok":true,"value":null}),
        json!({"ok":true,"value":{"entries":[1,2]}}),
        json!({"ok":false,"error":"Needs a person: Send."}),
    ] {
        assert!(valid_answer(&good), "{good}");
    }
    for bad in [
        json!({"ok":true}),
        json!({"ok":"yes","value":1}),
        json!({"ok":true,"value":1,"error":"x"}),
        json!({"ok":false,"error":"  "}),
        json!({"ok":false,"error":"x".repeat(MAX_ERROR + 1)}),
        json!({"ok":true,"value":"x".repeat(MAX_ANSWER)}),
        json!([]),
    ] {
        assert!(!valid_answer(&bad), "{bad}");
    }
    assert_eq!(status(204), Ok(()));
    assert_eq!(status(404), Err(Error::Stale));
    assert_eq!(status(409), Err(Error::Invalid));
    assert_eq!(status(413), Err(Error::Capacity));
}

#[test]
fn the_last_picture_is_kept_per_chat_within_a_limit() {
    let mut s = State::default();
    for n in 0..=PICTURES {
        s.keep_picture(&format!("chat-{n}"), json!(n));
    }
    s.keep_picture("chat-3", json!("newer"));
    assert_eq!(s.pictures.len(), PICTURES);
    assert!(!s.pictures.iter().any(|(c, _)| c == "chat-0"));
    assert_eq!(
        s.pictures.back().unwrap(),
        &("chat-3".into(), json!("newer"))
    );
    for n in 0..=SEEN {
        assert!(!s.seen(&format!("r{n}")));
    }
    assert!(s.seen(&format!("r{SEEN}")));
    assert!(!s.seen("r0"), "the oldest ID leaves first");
}
