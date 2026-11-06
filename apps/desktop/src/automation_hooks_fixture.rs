//! Owned faux daemon for the Hooks section. Loopback only, no real Local state or accounts.
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

/// The project hooks the fixture starts with.
pub(crate) fn sample() -> Value {
    json!({
        "revision": 3,
        "items": [
            {"id":"install","name":"Install dependencies","enabled":true,"on":["workspace.created","workspace.restored"],
             "action":{"type":"shell","run":{"argv":["pnpm","install","--frozen-lockfile"]},"timeoutMs":900000}},
            {"id":"checks","name":"Lint and test 日本語 👩‍💻","enabled":true,"on":["run.finished"],
             "when":{"filesChanged":{"paths":["packages/**","apps/web/**"]}},
             "action":{"type":"shell","run":{"shell":"pnpm fmt:check && pnpm test:fast"},"onFailure":"followUp","cwd":"apps","env":{"CI":"1"}}},
            {"id":"continue","name":"Continue on open todos","enabled":false,"on":["run.finished"],
             "when":{"openTodos":true},"action":{"type":"followUp"}}
        ]
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum Mode {
    Accept,
    /// Another client saved first: the revision moves and the PUT gets 409 with the current list.
    #[cfg(feature = "native-probes")]
    Conflict,
    /// 400 with the daemon's validation message.
    Rejected,
    /// The connection closes after the body arrives: the save is unknown.
    Lost,
    /// The host switch is off: 404 automations_unavailable.
    Off,
}
pub(crate) struct State {
    /// project ID → ProjectAutomations, in list order.
    pub(crate) projects: Vec<(String, Option<Value>)>,
    pub(crate) enabled: bool,
    pub(crate) mode: Mode,
    /// (method, path, body, had capability)
    pub(crate) requests: Vec<(String, String, Value, bool)>,
}
impl State {
    pub(crate) fn puts(&self) -> Vec<Value> {
        self.requests
            .iter()
            .filter(|(m, ..)| m == "PUT")
            .map(|(_, _, body, _)| body.clone())
            .collect()
    }
    pub(crate) fn hooks(&self, project: &str) -> Value {
        self.projects
            .iter()
            .find(|(id, _)| id == project)
            .and_then(|(_, a)| a.clone())
            .unwrap_or(Value::Null)
    }
    fn list(&self) -> Value {
        Value::Array(
            self.projects
                .iter()
                .map(|(id, automations)| {
                    let mut p = json!({"id": id, "name": id, "path": format!("/synthetic/{id}")});
                    if let Some(a) = automations {
                        p["automations"] = a.clone();
                    }
                    p
                })
                .collect(),
        )
    }
}
pub(crate) struct Server {
    pub(crate) options: LocalOptions,
    pub(crate) state: Arc<Mutex<State>>,
    home: std::path::PathBuf,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub(crate) fn start() -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let home = std::env::temp_dir().join(format!("automation-hooks-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&home).unwrap();
        let cap = home.join("github-app-capability");
        std::fs::write(
            &cap,
            json!({"daemonId":"test-daemon","lineageId":"test-lineage","token":"a".repeat(64)})
                .to_string(),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cap, std::fs::Permissions::from_mode(0o600)).unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port())
            .with_scope_home(home.clone());
        let state = Arc::new(Mutex::new(State {
            projects: vec![
                ("project-a".into(), Some(sample())),
                ("project-b".into(), None),
            ],
            enabled: true,
            mode: Mode::Accept,
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
                let mut capability = false;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    let lower = line.to_ascii_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap();
                    }
                    if lower.starts_with("x-pilot-github-capability:") {
                        capability = true;
                    }
                }
                assert!(length <= 1024 * 1024, "bounded hook bodies");
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let payload = if bytes.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes).unwrap()
                };
                let reply = {
                    let mut s = shared.lock().unwrap();
                    assert!(s.requests.len() < 512, "bounded faux request budget");
                    s.requests
                        .push((method.clone(), path.clone(), payload.clone(), capability));
                    let project = path
                        .strip_prefix("/api/projects/")
                        .and_then(|p| p.strip_suffix("/automations"))
                        .map(str::to_owned);
                    match (method.as_str(), path.as_str(), project) {
                        ("GET", "/api/hello", _) => Some((
                            200,
                            json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}),
                        )),
                        ("GET", "/api/schedules", _) => Some((200, json!([]))),
                        ("GET", "/api/projects", _) => Some((200, s.list())),
                        ("GET", "/api/chat-settings", _) => Some((
                            200,
                            json!({"schemaVersion":1,"autoHandoff":false,"automations":s.enabled,"revision":"r1"}),
                        )),
                        ("PUT", _, Some(project)) => {
                            assert!(capability, "hook writes carry the native capability");
                            let fields = payload.as_object().map(|o| o.len());
                            assert_eq!(fields, Some(2), "exactly expectedRevision and items");
                            let current = s.hooks(&project);
                            let revision = current["revision"].as_u64().unwrap_or(0);
                            let current = if current.is_null() {
                                json!({"revision":0,"items":[]})
                            } else {
                                current
                            };
                            match s.mode {
                                Mode::Off => {
                                    Some((404, json!({"error":"automations_unavailable"})))
                                }
                                Mode::Rejected => {
                                    Some((400, json!({"error":"checks: cwd must be relative"})))
                                }
                                Mode::Lost => None,
                                #[cfg(feature = "native-probes")]
                                Mode::Conflict => {
                                    let mut moved = current.clone();
                                    moved["revision"] = json!(revision + 1);
                                    if let Some((_, a)) =
                                        s.projects.iter_mut().find(|(id, _)| *id == project)
                                    {
                                        *a = Some(moved.clone());
                                    }
                                    s.mode = Mode::Accept;
                                    Some((
                                        409,
                                        json!({"error":"automations_conflict","current":moved}),
                                    ))
                                }
                                Mode::Accept if payload["expectedRevision"] != revision => Some((
                                    409,
                                    json!({"error":"automations_conflict","current":current}),
                                )),
                                Mode::Accept => {
                                    let next = json!({"revision": revision + 1, "items": payload["items"]});
                                    if let Some((_, a)) =
                                        s.projects.iter_mut().find(|(id, _)| *id == project)
                                    {
                                        *a = Some(next.clone());
                                    }
                                    Some((200, next))
                                }
                            }
                        }
                        _ => panic!("unallowlisted faux hooks route {method} {path}"),
                    }
                };
                if let Some((code, body)) = reply {
                    let body = body.to_string();
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {code} result\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                }
            }
        });
        Self {
            options,
            home,
            state,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.home);
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
