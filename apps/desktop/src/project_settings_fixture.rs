//! Owned synthetic project daemon for Settings tests. No production options, profile or writes.
use crate::LocalOptions;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone)]
pub(crate) struct Reply {
    /// None drops the connection without a response.
    pub(crate) status: Option<u16>,
    pub(crate) body: Value,
    /// Apply a PATCH before replying, as the daemon may before a persistence failure.
    pub(crate) apply: bool,
    pub(crate) delay_ms: u64,
}
impl Reply {
    pub(crate) fn status(status: Option<u16>, apply: bool) -> Self {
        Self {
            status,
            body: json!({"error":"synthetic"}),
            apply,
            delay_ms: 0,
        }
    }
}
#[derive(Default)]
pub(crate) struct State {
    pub(crate) seen: Vec<(String, String, Value)>,
    pub(crate) projects: BTreeMap<String, Value>,
    pub(crate) replies: BTreeMap<(String, String), Reply>,
}
impl State {
    pub(crate) fn patches(&self) -> Vec<Value> {
        self.seen
            .iter()
            .filter(|(m, _, _)| m == "PATCH")
            .map(|(_, _, b)| b.clone())
            .collect()
    }
}
pub(crate) struct Server {
    pub(crate) options: LocalOptions,
    pub(crate) state: Arc<Mutex<State>>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
pub(crate) fn project(id: &str, name: &str) -> Value {
    json!({"id":id,"name":name,"path":format!("/synthetic/{id}"),"createdAt":1,
        "tracking":{"slackChannels":["C1"]},"environment":{"secret":"never shown"}})
}
impl Server {
    pub(crate) fn start(projects: &[Value]) -> Self {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let state = Arc::new(Mutex::new(State {
            projects: projects
                .iter()
                .map(|p| (p["id"].as_str().unwrap().to_owned(), p.clone()))
                .collect(),
            ..Default::default()
        }));
        let shared = state.clone();
        let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
        let thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                let mut handlers = tokio::task::JoinSet::new();
                loop {
                    tokio::select! {
                        biased;
                        _ = &mut stopped => break,
                        _ = handlers.join_next(), if !handlers.is_empty() => {}
                        connection = listener.accept(), if handlers.len() < 8 => {
                            let Ok((stream, _)) = connection else { break };
                            let state = shared.clone();
                            handlers.spawn(async move {
                                let _ = tokio::time::timeout(Duration::from_secs(5), serve(stream, state)).await;
                            });
                        }
                    }
                }
                handlers.abort_all();
                while handlers.join_next().await.is_some() {}
            });
        });
        Self {
            options,
            state,
            stop: Some(stop),
            thread: Some(thread),
        }
    }
    pub(crate) fn reply(&self, method: &str, path: &str, reply: Reply) {
        self.state
            .lock()
            .unwrap()
            .replies
            .insert((method.into(), path.into()), reply);
    }
    pub(crate) fn set(&self, project: Value) {
        let id = project["id"].as_str().unwrap().to_owned();
        self.state.lock().unwrap().projects.insert(id, project);
    }
    pub(crate) fn remove(&self, id: &str) {
        self.state.lock().unwrap().projects.remove(id);
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.thread.take().unwrap().join().unwrap();
    }
}
fn apply(state: &mut State, id: &str, body: &Value) -> Option<Value> {
    let project = state.projects.get_mut(id)?;
    let object = project.as_object_mut().unwrap();
    if let Some(name) = body["name"].as_str() {
        object.insert("name".into(), json!(name.trim()));
    }
    match body["workspace"].as_str() {
        Some("direct") => {
            object.insert("workspace".into(), json!("direct"));
        }
        Some(_) => {
            object.remove("workspace");
        }
        None => {}
    }
    if let Some(require) = body["requirePullRequest"].as_bool() {
        object.insert("requirePullRequest".into(), json!(require));
    }
    Some(project.clone())
}
fn respond(state: &mut State, method: &str, path: &str, body: Value) -> (Option<u16>, Value, u64) {
    assert!(state.seen.len() < 256);
    state.seen.push((method.into(), path.into(), body.clone()));
    let id = path.strip_prefix("/api/projects/").map(str::to_owned);
    if let Some(reply) = state.replies.get(&(method.into(), path.into())).cloned() {
        if reply.apply
            && let Some(id) = &id
        {
            apply(state, id, &body);
        }
        return (reply.status, reply.body, reply.delay_ms);
    }
    match (method, path, id) {
        ("GET", "/api/hello", _) => (
            Some(200),
            json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}),
            0,
        ),
        ("GET", _, Some(id)) => match state.projects.get(&id) {
            Some(p) => (Some(200), p.clone(), 0),
            None => (Some(404), json!({"error":"Unknown project"}), 0),
        },
        ("PATCH", _, Some(id)) => match apply(state, &id, &body) {
            Some(p) => (Some(200), p, 0),
            None => (Some(404), json!({"error":"Unknown project"}), 0),
        },
        _ => (Some(404), json!({"error":"Unsupported synthetic path"}), 0),
    }
}
async fn serve(mut stream: tokio::net::TcpStream, state: Arc<Mutex<State>>) -> std::io::Result<()> {
    let mut bytes = Vec::new();
    let header_end = loop {
        let mut b = [0; 1024];
        let n = stream.read(&mut b).await?;
        if n == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&b[..n]);
        if let Some(n) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            break n + 4;
        }
        if bytes.len() > 8192 {
            return Ok(());
        }
    };
    let headers = String::from_utf8_lossy(&bytes[..header_end]).into_owned();
    let mut words = headers.split_whitespace();
    let method = words.next().unwrap().to_owned();
    let path = words.next().unwrap().to_owned();
    assert!(
        method == "GET" || method == "PATCH",
        "project settings only read and patch"
    );
    let lower = headers.to_ascii_lowercase();
    let len = lower
        .lines()
        .find_map(|l| l.strip_prefix("content-length:").map(str::trim))
        .and_then(|n| n.parse::<usize>().ok())
        .unwrap_or(0);
    while bytes.len() - header_end < len {
        let mut b = [0; 4096];
        let n = stream.read(&mut b).await?;
        if n == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&b[..n]);
    }
    let body = if len == 0 {
        Value::Null
    } else {
        serde_json::from_slice(&bytes[header_end..header_end + len]).unwrap()
    };
    let (status, body, delay) = respond(&mut state.lock().unwrap(), &method, &path, body);
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    let Some(status) = status else {
        return Ok(());
    };
    let body = serde_json::to_vec(&body).unwrap();
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status} fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .as_bytes(),
        )
        .await?;
    stream.write_all(&body).await
}
