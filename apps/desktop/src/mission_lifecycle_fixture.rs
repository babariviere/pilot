//! Owned lifecycle HTTP fixture. No production options, profile or writes.
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
}
impl Reply {
    pub(crate) fn json(status: u16, value: Value) -> Self {
        Self {
            status: Some(status),
            bytes: serde_json::to_vec(&value).unwrap(),
            delay: 0,
            chunked: false,
        }
    }
}
#[derive(Default)]
pub(crate) struct State {
    pub(crate) seen: Vec<(String, String, Value)>,
    replies: BTreeMap<(String, String), Reply>,
}
pub(crate) struct Server {
    pub(crate) options: LocalOptions,
    pub(crate) state: Arc<Mutex<State>>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    done: std::sync::mpsc::Receiver<()>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub(crate) fn start() -> Self {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let state = Arc::new(Mutex::new(State::default()));
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
                loop {tokio::select!{biased;_=&mut stopped=>break,_=handlers.join_next(),if !handlers.is_empty()=>{}, connection=listener.accept(),if handlers.len()<8=>{
                    let Ok((stream,_))=connection else {break;};let state=shared.clone();handlers.spawn(async move {let _=tokio::time::timeout(Duration::from_secs(2),serve(stream,state)).await;});
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
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.done
            .recv_timeout(Duration::from_secs(3))
            .expect("bounded lifecycle fixture teardown");
        self.thread.take().unwrap().join().unwrap();
    }
}
fn response(state: &mut State, method: &str, path: &str, body: Value) -> Reply {
    assert!(state.seen.len() < 256);
    state.seen.push((method.into(), path.into(), body.clone()));
    if let Some(r) = state.replies.get(&(method.into(), path.into())) {
        return r.clone();
    }
    if method == "POST" {
        let mut mission = f::detail("mission-A")["mission"].clone();
        mission["status"] = json!(if body["action"] == "archive" {
            "archived"
        } else if body["action"] == "complete" {
            "done"
        } else {
            "active"
        });
        mission["passiveLifecycle"] = json!(true);
        let mut r = Reply::json(
            200,
            json!({"operationId":body["operationId"],"mission":mission}),
        );
        r.delay = 150;
        return r;
    }
    if method == "GET" {
        if path == "/api/hello" {
            return Reply::json(
                200,
                json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"passiveMissionLifecycle":true,"passiveMissionCompletion":true}}),
            );
        }
        if path == "/api/mission-catalog" {
            return Reply::json(200, f::catalog());
        }
        for id in ["mission-A", "mission-B"] {
            if path == format!("/api/missions/{id}") {
                return Reply::json(200, f::detail(id));
            }
            if path == format!("/api/sessions?archived=all&missionId={id}") {
                return Reply::json(200, f::members(id));
            }
        }
    }
    Reply::json(404, json!({"error":"Unsupported synthetic path"}))
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
    let mut words = headers.split_whitespace();
    let method = words.next().unwrap().to_owned();
    let path = words.next().unwrap().to_owned();
    assert!(
        method == "GET"
            || (method == "POST"
                && [
                    "/api/missions/mission-A/lifecycle",
                    "/api/missions/mission-B/lifecycle"
                ]
                .contains(&path.as_str())),
        "only explicit lifecycle POST allowed"
    );
    let lower = headers.to_ascii_lowercase();
    assert!(!lower.contains("authorization:") && !lower.contains("cookie:"));
    let len = lower
        .lines()
        .find_map(|l| l.strip_prefix("content-length:").map(str::trim))
        .and_then(|n| n.parse::<usize>().ok())
        .unwrap_or(0);
    if len > 64 * 1024 {
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
    let reply = response(&mut state.lock().unwrap(), &method, &path, body);
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
    let location = if status == 302 {
        "Location: /redirect-target\r\n"
    } else {
        ""
    };
    stream.write_all(format!("HTTP/1.1 {status} fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{location}Connection: close\r\n\r\n",reply.bytes.len()).as_bytes()).await?;
    stream.write_all(&reply.bytes).await
}
