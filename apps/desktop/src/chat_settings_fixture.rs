//! Owned faux daemon for chat settings. Loopback only, no real Local state or accounts.
use crate::LocalOptions;
use serde_json::{Value, json};
use std::{
    io::{BufRead, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))] // Some faults are exercised only by transport tests.
pub(crate) enum Mode {
    Accept,
    /// An older daemon: the route does not exist.
    Unsupported,
    /// Another client wrote first: the revision moves and the PATCH gets 409.
    Conflict,
    /// The store is unavailable or could not confirm a write (503).
    Unavailable,
    Rejected,
    /// 200 that does not echo the requested value.
    Mismatch,
    /// GET carries an unknown field.
    Malformed,
}
pub(crate) struct State {
    pub(crate) auto_handoff: bool,
    pub(crate) revision: u32,
    pub(crate) mode: Mode,
    /// While set, a PATCH waits before answering so the in-flight state can be observed.
    pub(crate) hold: bool,
    pub(crate) requests: Vec<(String, String, Value)>,
}
impl State {
    fn document(&self) -> Value {
        json!({"schemaVersion":1,"autoHandoff":self.auto_handoff,"revision":format!("r{}",self.revision)})
    }
    pub(crate) fn count(&self, method: &str) -> usize {
        self.requests
            .iter()
            .filter(|(m, p, _)| m == method && p == "/api/chat-settings")
            .count()
    }
    pub(crate) fn patches(&self) -> Vec<Value> {
        self.requests
            .iter()
            .filter(|(m, _, _)| m == "PATCH")
            .map(|(_, _, body)| body.clone())
            .collect()
    }
}
pub(crate) struct Server {
    pub(crate) options: LocalOptions,
    pub(crate) state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub(crate) fn start(mode: Mode) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let state = Arc::new(Mutex::new(State {
            auto_handoff: false,
            revision: 1,
            mode,
            hold: false,
            requests: vec![],
        }));
        let shared = state.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let halt = stop.clone();
        let thread = std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                if halt.load(Ordering::SeqCst) {
                    break;
                }
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut reader = std::io::BufReader::new(&mut stream);
                let mut first = String::new();
                if reader.read_line(&mut first).unwrap_or(0) == 0 {
                    continue;
                }
                let mut parts = first.split_whitespace();
                let method = parts.next().unwrap().to_owned();
                let path = parts.next().unwrap().to_owned();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap();
                    }
                }
                assert!(length <= 1024, "chat settings bodies are tiny");
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let payload = if bytes.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes).unwrap()
                };
                if method == "PATCH" {
                    while shared.lock().unwrap().hold && !halt.load(Ordering::SeqCst) {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                }
                let (code, body) = {
                    let mut s = shared.lock().unwrap();
                    s.requests
                        .push((method.clone(), path.clone(), payload.clone()));
                    match (method.as_str(), path.as_str(), s.mode) {
                        ("GET", "/api/hello", _) => (200, json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}).to_string()),
                        (_, "/api/chat-settings", Mode::Unsupported) => (404, json!({"error":"Not found"}).to_string()),
                        (_, "/api/chat-settings", Mode::Unavailable) => (503, json!({"error":"Chat settings are unavailable"}).to_string()),
                        ("GET", "/api/chat-settings", Mode::Malformed) => {
                            let mut doc = s.document();
                            doc["extra"] = json!(true);
                            (200, doc.to_string())
                        }
                        ("GET", "/api/chat-settings", _) => (200, s.document().to_string()),
                        ("PATCH", "/api/chat-settings", mode) => {
                            let fields = payload.as_object().map(|o| o.len());
                            assert_eq!(fields, Some(2), "exactly autoHandoff and expectedRevision");
                            let requested = payload["autoHandoff"].as_bool().unwrap();
                            let expected = payload["expectedRevision"].as_str().unwrap().to_owned();
                            match mode {
                                Mode::Rejected => (400, json!({"error":"Invalid chat settings"}).to_string()),
                                Mode::Conflict => {
                                    s.revision += 1;
                                    (409, json!({"error":"conflict"}).to_string())
                                }
                                _ if expected != format!("r{}", s.revision) => (409, json!({"error":"conflict"}).to_string()),
                                Mode::Mismatch => (200, s.document().to_string()),
                                _ => {
                                    s.auto_handoff = requested;
                                    s.revision += 1;
                                    (200, s.document().to_string())
                                }
                            }
                        }
                        _ => panic!("unallowlisted faux chat-settings route {method} {path}"),
                    }
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {code} result\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        Self {
            options,
            state,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let addr = self
            .options
            .loopback()
            .strip_prefix("http://")
            .unwrap()
            .parse()
            .unwrap();
        let _ = TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(2));
        if let Some(t) = self.thread.take() {
            t.join().unwrap();
        }
    }
}
