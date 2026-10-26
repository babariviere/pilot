//! Owned synthetic model API. Never reads credentials or a production profile.
use crate::LocalOptions;
use serde_json::{Value, json};
use std::{
    io::{BufRead, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
#[derive(Clone, Copy, Debug)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum Mode {
    Accept,
    Parked,
    Failed,
    Lost,
    Denied,
    Busy,
    Queued,
    Paused,
    Stale,
    ScopeChanged,
    Empty,
    Bad,
    Oversized,
    Chunked,
    Foreign,
}
pub(crate) struct Seen {
    pub(crate) mode: Mode,
    pub(crate) model: String,
    pub(crate) thinking: String,
    pub(crate) clock: u64,
    pub(crate) requests: Vec<(String, String, Value)>,
}
pub(crate) struct Server {
    pub(crate) options: LocalOptions,
    pub(crate) home: PathBuf,
    pub(crate) seen: Arc<Mutex<Seen>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
pub(crate) fn catalog() -> Value {
    json!({"defaultModel":"p/a","models":[
    {"id":"p/a","provider":"p","name":"Atlas 日本語","thinkingLevels":["off","low","high"]},
    {"id":"p/b","provider":"p","name":"Boreal 日本語","thinkingLevels":["off","low","high"],"thinking":"low"},
    {"id":"q/c","provider":"q","name":"Boreal 日本語","thinkingLevels":["off"]},
    {"id":"q/d","provider":"q","name":"Legacy levels not reported"}]})
}
impl Seen {
    pub(crate) fn session(&self) -> Value {
        json!({"id":"source","cwd":"/synthetic/project","mode":"ask","state":match self.mode {Mode::Busy=>"working",Mode::Parked=>"parked",Mode::Failed=>"failed",_=>"idle"},"working":matches!(self.mode,Mode::Busy),"model":if matches!(self.mode,Mode::Stale){"q/c"}else{&self.model},"thinking":self.thinking,"updatedAt":self.clock,"error":if matches!(self.mode,Mode::Parked){json!("Retained kernel diagnostic")}else{Value::Null},"subscriptionPause":if matches!(self.mode,Mode::Paused){json!({"forced":false})}else{Value::Null}})
    }
}
impl Server {
    pub(crate) fn start(mode: Mode) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let home = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("synthetic-chat-models-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&home).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let seen = Arc::new(Mutex::new(Seen {
            mode,
            model: "p/a".into(),
            thinking: "high".into(),
            clock: 1,
            requests: vec![],
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
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut reader = std::io::BufReader::new(&mut stream);
                let mut first = String::new();
                if reader.read_line(&mut first).unwrap_or(0) == 0 {
                    continue;
                }
                let mut parts = first.split_whitespace();
                let method = parts.next().unwrap().to_string();
                let path = parts.next().unwrap().to_string();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    let n = reader.read_line(&mut line).unwrap();
                    assert!(n > 0);
                    if line == "\r\n" {
                        break;
                    }
                    let line = line.to_ascii_lowercase();
                    assert!(
                        !line.starts_with("origin:")
                            && !line.starts_with("authorization:")
                            && !line.starts_with("x-pilot-github-capability:")
                    );
                    if let Some(n) = line.strip_prefix("content-length:") {
                        length = n.trim().parse().unwrap();
                        assert!(length <= 64 * 1024);
                    }
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let payload = if bytes.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes).unwrap()
                };
                let (code, body, chunked) = {
                    let mut s = record.lock().unwrap();
                    s.requests
                        .push((method.clone(), path.clone(), payload.clone()));
                    if path == "/api/hello" {
                        assert_eq!(method, "GET");
                        (200,json!({"daemonId":if matches!(s.mode,Mode::Foreign){"foreign"}else{"test-daemon"},"lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}).to_string(),false)
                    } else if path.starts_with("/api/models?") {
                        assert_eq!(method, "GET");
                        let url = reqwest::Url::parse(&format!("http://127.0.0.1{path}")).unwrap();
                        let q: Vec<_> = url.query_pairs().collect();
                        assert_eq!(q.len(), 1);
                        assert_eq!(q[0].0, "cwd");
                        assert!(q[0].1.starts_with("/synthetic/"));
                        if matches!(s.mode, Mode::Empty) {
                            (
                                200,
                                json!({"models":[],"defaultModel":null}).to_string(),
                                false,
                            )
                        } else if matches!(s.mode, Mode::Bad) {
                            (200, "{bad".into(), false)
                        } else if matches!(s.mode, Mode::Oversized | Mode::Chunked) {
                            (
                                200,
                                " ".repeat(2 * 1024 * 1024 + 1),
                                matches!(s.mode, Mode::Chunked),
                            )
                        } else {
                            let mut c = catalog();
                            if matches!(s.mode, Mode::ScopeChanged) {
                                c["models"]
                                    .as_array_mut()
                                    .unwrap()
                                    .retain(|m| m["id"] != "p/b");
                            }
                            (200, c.to_string(), false)
                        }
                    } else if method == "GET" && path == "/api/sessions/source" {
                        (200, s.session().to_string(), false)
                    } else if method == "POST" && path == "/api/sessions/source/model" {
                        assert!(payload["model"].is_string());
                        assert!(
                            payload
                                .as_object()
                                .unwrap()
                                .keys()
                                .all(|k| k == "model" || k == "thinking")
                        );
                        if matches!(s.mode, Mode::Denied | Mode::Queued) {
                            (
                                if matches!(s.mode, Mode::Denied) {
                                    403
                                } else {
                                    409
                                },
                                "{}".into(),
                                false,
                            )
                        } else {
                            s.model = payload["model"].as_str().unwrap().into();
                            s.thinking = payload["thinking"]
                                .as_str()
                                .unwrap_or(if s.model == "q/c" { "off" } else { "low" })
                                .into();
                            s.clock += 1;
                            if matches!(s.mode, Mode::Lost) {
                                continue;
                            }
                            (200, s.session().to_string(), false)
                        }
                    } else {
                        panic!("unallowlisted model fixture route {method} {path}")
                    }
                };
                if chunked {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {code} result\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n",
                        body.len()
                    );
                } else {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {code} result\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                }
            }
        });
        Self {
            options,
            home,
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
        let addr = self
            .options
            .loopback()
            .strip_prefix("http://")
            .unwrap()
            .parse()
            .unwrap();
        let _ = TcpStream::connect_timeout(&addr, Duration::from_secs(2));
        if let Some(t) = self.thread.take() {
            t.join().unwrap();
        }
        let _ = std::fs::remove_dir_all(&self.home);
    }
}
