//! Owned synthetic brief HTTP, including post-commit errors. Never a real Local profile.
use crate::{LocalOptions, mission_browser_fixture as f};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[derive(Clone)]
pub(crate) struct Reply {
    pub(crate) status: Option<u16>,
    pub(crate) bytes: Vec<u8>,
    pub(crate) delay: u64,
    pub(crate) chunked: bool,
    pub(crate) after_commit: bool,
}
impl Reply {
    pub(crate) fn json(status: u16, value: Value) -> Self {
        Self {
            status: Some(status),
            bytes: serde_json::to_vec(&value).unwrap(),
            delay: 0,
            chunked: false,
            after_commit: false,
        }
    }
}
#[derive(Default)]
pub(crate) struct State {
    pub(crate) seen: Vec<(String, String, Value)>,
    pub(crate) replies: BTreeMap<(String, String), Reply>,
    pub(crate) versions: BTreeMap<u64, String>,
    pub(crate) current: u64,
}
pub(crate) struct Server {
    pub(crate) options: LocalOptions,
    pub(crate) state: Arc<Mutex<State>>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    done: std::sync::mpsc::Receiver<()>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub(crate) fn start(initial: Option<&str>) -> Self {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let mut data = State::default();
        if let Some(text) = initial {
            data.current = 1;
            data.versions.insert(1, text.into());
        }
        let state = Arc::new(Mutex::new(data));
        let shared = state.clone();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let (done, finished) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                let listener=tokio::net::TcpListener::from_std(listener).unwrap();let mut handlers=tokio::task::JoinSet::new();tokio::pin!(stopped);
                loop {tokio::select! {biased;_=&mut stopped=>break,_=handlers.join_next(),if !handlers.is_empty()=>{},connection=listener.accept(),if handlers.len()<8=>{
                    let Ok((stream,_))=connection else {break;};let state=shared.clone();handlers.spawn(async move{let _=tokio::time::timeout(Duration::from_secs(2),serve(stream,state)).await;});
                }}}
                handlers.abort_all();while handlers.join_next().await.is_some(){}
            });
            let _ = done.send(());
        });
        Self {
            options,
            state,
            stop: Some(stop),
            done: finished,
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
    pub(crate) fn puts(&self) -> usize {
        self.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .filter(|(m, _, _)| m == "PUT")
            .count()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.done
            .recv_timeout(Duration::from_secs(3))
            .expect("owned brief HTTP fixture must stop within its teardown budget");
        self.thread.take().unwrap().join().unwrap();
    }
}
pub(crate) fn brief(number: u64, text: &str) -> Value {
    json!({"missionId":"mission-A","revision":number,"markdown":text,"createdAt":1000+number,"authorSessionId":null})
}
fn response(state: &mut State, method: &str, path: &str, body: Value) -> Reply {
    state.seen.push((method.into(), path.into(), body.clone()));
    let override_reply = state.replies.get(&(method.into(), path.into())).cloned();
    if let Some(r) = &override_reply
        && !r.after_commit
    {
        return r.clone();
    }
    let result = if method == "GET" && path == "/api/hello" {
        json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}})
    } else if method == "GET" && path == "/api/mission-catalog" {
        f::catalog()
    } else if method == "GET" && path == "/api/missions/mission-A" {
        let mut d = f::detail("mission-A");
        d["mission"]["briefRevision"] = state.current.into();
        d["brief"] = state
            .versions
            .get(&state.current)
            .map(|t| brief(state.current, t))
            .unwrap_or(Value::Null);
        d
    } else if method == "GET" && path == "/api/sessions?archived=all&missionId=mission-A" {
        f::members("mission-A")
    } else if method == "GET" && path == "/api/missions/mission-A/brief/revisions" {
        json!(
            state
                .versions
                .keys()
                .rev()
                .map(|n| json!({"revision":n,"createdAt":1000+n,"authorSessionId":null}))
                .collect::<Vec<_>>()
        )
    } else if method == "GET"
        && (path == "/api/missions/mission-A/brief"
            || path.starts_with("/api/missions/mission-A/brief?revision="))
    {
        let n = path
            .split_once("?revision=")
            .and_then(|(_, n)| n.parse().ok())
            .unwrap_or(state.current);
        let Some(t) = state.versions.get(&n) else {
            return Reply::json(404, json!({"error":"No brief revision"}));
        };
        brief(n, t)
    } else if method == "PUT" && path == "/api/missions/mission-A/brief" {
        if body["expectedRevision"].as_u64() != Some(state.current) {
            return Reply::json(409, json!({"error":"Brief revision conflict"}));
        }
        let Some(text) = body["markdown"].as_str() else {
            return Reply::json(400, json!({"error":"Invalid markdown"}));
        };
        let text = crate::mission_conversion::trim_text(text).to_owned();
        if state.current == 0 || state.versions.get(&state.current) != Some(&text) {
            state.current += 1;
            state.versions.insert(state.current, text.clone());
        }
        brief(state.current, &text)
    } else {
        return Reply::json(404, json!({"error":"Unsupported owned fixture path"}));
    };
    override_reply.unwrap_or_else(|| Reply::json(200, result))
}
async fn serve(mut stream: tokio::net::TcpStream, state: Arc<Mutex<State>>) -> std::io::Result<()> {
    let mut bytes = Vec::new();
    let header_end;
    loop {
        let mut b = [0; 1024];
        let n = stream.read(&mut b).await?;
        if n == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&b[..n]);
        if let Some(n) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = n + 4;
            break;
        }
        if bytes.len() > 8192 {
            return Ok(());
        }
    }
    let headers = String::from_utf8_lossy(&bytes[..header_end]);
    let line = headers.lines().next().unwrap();
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap().to_owned();
    let path = parts.next().unwrap().to_owned();
    assert!(
        method == "GET" || method == "PUT",
        "fixture permits only scoped reads and explicit brief saves"
    );
    let lower = headers.to_ascii_lowercase();
    assert!(!lower.contains("authorization:") && !lower.contains("cookie:"));
    let len = lower
        .lines()
        .find_map(|l| l.strip_prefix("content-length:").map(str::trim))
        .and_then(|n| n.parse::<usize>().ok())
        .unwrap_or(0);
    if len > 1024 * 1024 {
        return Ok(());
    }
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
    let reply = { response(&mut state.lock().unwrap(), &method, &path, body) };
    if reply.delay > 0 {
        tokio::time::sleep(Duration::from_millis(reply.delay)).await;
    }
    let Some(status) = reply.status else {
        return Ok(());
    };
    if reply.chunked {
        stream.write_all(format!("HTTP/1.1 {status} fixture\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").as_bytes()).await?;
        for chunk in reply.bytes.chunks(16 * 1024) {
            stream
                .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                .await?;
            stream.write_all(chunk).await?;
            stream.write_all(b"\r\n").await?;
        }
        return stream.write_all(b"0\r\n\r\n").await;
    }
    let head = format!(
        "HTTP/1.1 {status} fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        reply.bytes.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&reply.bytes).await
}
