//! Owned faux loopback server. Never connects to a real service or opens a dialog.
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
#[derive(Clone, Copy)]
#[allow(dead_code)]
pub(crate) enum Behavior {
    Accept,
    Lost,
    Malformed,
    InvalidReceipt,
    Oversized,
    Chunked,
    Status(u16),
}
pub(crate) struct Seen {
    pub(crate) created_id: String,
    pub(crate) requests: Vec<(String, String, Value)>,
    pub(crate) projects: Vec<Value>,
    pub(crate) hello: Value,
    pub(crate) behavior: Behavior,
}
pub(crate) struct Server {
    pub(crate) options: LocalOptions,
    pub(crate) seen: Arc<Mutex<Seen>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub(crate) fn start(behavior: Behavior) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Seen {
            created_id: "registered-project".into(),
            requests: vec![],
            projects: vec![],
            behavior,
            hello: json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}),
        }));
        let record = seen.clone();
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
                    if line == "\r\n" {
                        break;
                    }
                    assert!(!line.to_ascii_lowercase().starts_with("origin:"));
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap();
                    }
                    assert!(length < 32769);
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let payload = if bytes.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes).unwrap()
                };
                let (status, body, chunked) = {
                    let mut s = record.lock().unwrap();
                    s.requests
                        .push((method.clone(), path.clone(), payload.clone()));
                    match (method.as_str(), path.as_str()) {
                        ("GET", "/api/hello") => (200, s.hello.to_string(), false),
                        ("GET", "/api/projects") => {
                            (200, serde_json::to_string(&s.projects).unwrap(), false)
                        }
                        ("POST", "/api/projects") => {
                            assert_eq!(payload.as_object().unwrap().len(), 1);
                            assert!(payload["path"].as_str().is_some());
                            let project = json!({"id":s.created_id,"name":"Existing 日本語","path":payload["path"]});
                            s.projects = vec![project.clone()];
                            match s.behavior {
                                Behavior::Lost => continue,
                                Behavior::Malformed => (201, "{bad".into(), false),
                                Behavior::InvalidReceipt => (
                                    201,
                                    json!({"id":"bad/id","path":payload["path"]}).to_string(),
                                    false,
                                ),
                                Behavior::Oversized => (201, " ".repeat(65537), false),
                                Behavior::Chunked => (201, " ".repeat(65537), true),
                                Behavior::Status(status) => (
                                    status,
                                    json!({"error":"post-mutation failure"}).to_string(),
                                    false,
                                ),
                                Behavior::Accept => (201, project.to_string(), false),
                            }
                        }
                        _ => panic!("unexpected faux project route {method} {path}"),
                    }
                };
                if chunked {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} response\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n",
                        body.len()
                    );
                } else {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                }
            }
        });
        Self {
            options,
            seen,
            stop,
            thread: Some(thread),
        }
    }
    pub(crate) fn posts(&self) -> usize {
        self.seen
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(m, _, _)| m == "POST")
            .count()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.options.loopback().strip_prefix("http://").unwrap());
        if let Some(t) = self.thread.take() {
            t.join().unwrap();
        }
    }
}
