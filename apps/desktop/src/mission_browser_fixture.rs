//! Owned faux GET-only daemon, never production options or state.
use crate::{
    LocalOptions,
    mission_browser::{Home, Key},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    thread::JoinHandle,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
pub(crate) fn home() -> Home {
    Home {
        daemon: "test-daemon".into(),
        lineage: "test-lineage".into(),
    }
}
pub(crate) fn key(id: &str) -> Key {
    Key {
        home: home(),
        id: id.into(),
    }
}
pub(crate) fn catalog() -> Value {
    let host = json!({"hostId":"local-alias","daemonId":"test-daemon","lineageId":"test-lineage"});
    let foreign =
        json!({"hostId":"foreign","daemonId":"foreign-daemon","lineageId":"test-lineage"});
    let row = |id: &str, project: &str, home: Value, kind: &str| json!({"id":serde_json::to_string(&[home["daemonId"].as_str().unwrap(),home["lineageId"].as_str().unwrap(),id]).unwrap(),"mission":{"home":home,"missionId":id},"title":"Same mission 日本語","status":"active","tasksDone":1,"tasksTotal":2,"provenance":[{"kind":kind,"sourceHost":host,"projectId":project}]});
    json!({"logicalMissions":[row("mission-A","project-A",host.clone(),"canonical"),row("mission-B","project-B",host.clone(),"canonical"),row("mission-A","project-A",foreign,"replica")],"totals":{"logicalMissions":3},"truncated":false,"sharedTasks":[],"missions":[],"replicaMissions":[]})
}
pub(crate) fn detail(id: &str) -> Value {
    json!({"mission":{"id":id,"projectId":if id=="mission-A"{"project-A"}else{"project-B"},"title":"Same mission 日本語","goal":"Keep the existing chat and its draft. 私の目標 👩‍💻","status":"active","briefRevision":1,"coordinatorSessionId":"chat-A","tasksDone":1,"tasksTotal":2},"brief":{"missionId":id,"revision":1,"markdown":"# Private fixture brief\n\n![Never fetch](https://invalid.example/image.png)\n<script>Never execute</script>\n\nUnicode: 日本語 👩‍💻"},"tasks":[{"id":"task-B","number":2,"title":"Preserve the reader","status":"todo","order":2},{"id":"task-A","number":1,"title":"Keep the draft","status":"done","order":1,"sessionId":"chat-A"}],"decisions":[],"comments":[],"resources":[],"events":[],"artifacts":[],"phases":[]})
}
pub(crate) fn members(id: &str) -> Value {
    let project = if id == "mission-A" {
        "project-A"
    } else {
        "project-B"
    };
    json!([{"id":"chat-A","title":"Same chat title","missionId":id,"projectId":project,"state":"idle"},{"id":"chat-B","title":"Same chat title","missionId":id,"projectId":project,"state":"idle"},{"id":"not-loaded","title":"Unavailable member","missionId":id,"projectId":project,"state":"idle"}])
}
#[derive(Clone)]
pub(crate) struct Reply {
    pub(crate) status: u16,
    pub(crate) bytes: Vec<u8>,
    pub(crate) chunked: bool,
    pub(crate) delay_ms: u64,
}
impl Reply {
    pub(crate) fn json(status: u16, value: Value) -> Self {
        Self {
            status,
            bytes: serde_json::to_vec(&value).unwrap(),
            chunked: false,
            delay_ms: 0,
        }
    }
}
#[derive(Default)]
pub(crate) struct State {
    pub(crate) seen: Vec<(String, String)>,
    pub(crate) overrides: BTreeMap<String, Reply>,
}
pub(crate) struct Server {
    pub(crate) options: LocalOptions,
    pub(crate) state: Arc<Mutex<State>>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    join: Option<JoinHandle<()>>,
}
impl Server {
    pub(crate) fn start() -> Self {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let join = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move{
            let listener=TcpListener::from_std(listener).unwrap();let mut tasks=tokio::task::JoinSet::new();
            tokio::pin!(stopped);
            loop {tokio::select!{biased;_= &mut stopped=>break,
                _=tasks.join_next(),if !tasks.is_empty()=>{},
                connection=listener.accept(),if tasks.len()<8=>{let (socket,_)=connection.unwrap();let shared=shared.clone();tasks.spawn(async move{let _=serve(socket,shared).await;});}
            }}
            tasks.abort_all();while tasks.join_next().await.is_some(){}
        });
        });
        Self {
            options: LocalOptions::synthetic(port),
            state,
            stop: Some(stop),
            join: Some(join),
        }
    }
    pub(crate) fn reply(&self, path: &str, reply: Reply) {
        self.state
            .lock()
            .unwrap()
            .overrides
            .insert(path.into(), reply);
    }
    pub(crate) fn all_gets(&self) -> bool {
        self.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .all(|(method, _)| method == "GET")
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.stop.take().unwrap().send(());
        self.join.take().unwrap().join().unwrap();
    }
}
async fn serve(mut socket: TcpStream, state: Arc<Mutex<State>>) -> std::io::Result<()> {
    let mut bytes = Vec::new();
    let mut buf = [0; 1024];
    while bytes.len() < 8192 && !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = socket.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&buf[..n]);
    }
    let request = String::from_utf8_lossy(&bytes);
    let mut words = request.split_whitespace();
    let method = words.next().unwrap_or("");
    let path = words.next().unwrap_or("");
    let reply = {
        let mut state = state.lock().unwrap();
        assert!(state.seen.len() < 256, "bounded faux request budget");
        state.seen.push((method.into(), path.into()));
        state.overrides.get(path).cloned()
    };
    let reply=reply.unwrap_or_else(||{
        if method!="GET"{return Reply::json(405,json!({"error":"No mutation fixture"}));}
        if path=="/api/hello"{return Reply::json(200,json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}));}
        if path=="/api/mission-catalog"{return Reply::json(200,catalog());}
        for id in ["mission-A", "mission-B"] {
            if path == format!("/api/missions/{id}") { return Reply::json(200, detail(id)); }
            if path == format!("/api/sessions?archived=all&missionId={id}") { return Reply::json(200, members(id)); }
        }
        Reply::json(404,json!({"error":"unsupported"}))
    });
    if reply.delay_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(reply.delay_ms)).await;
    }
    let framing = if reply.chunked {
        "Transfer-Encoding: chunked".to_owned()
    } else {
        format!("Content-Length: {}", reply.bytes.len())
    };
    let redirect = if reply.status == 302 {
        format!(
            "Location: http://127.0.0.1:{}/redirect-target\r\n",
            socket.local_addr()?.port()
        )
    } else {
        String::new()
    };
    socket.write_all(format!("HTTP/1.1 {} Fixture\r\n{framing}\r\n{redirect}Connection: close\r\nContent-Type: application/json\r\n\r\n",reply.status).as_bytes()).await?;
    if reply.chunked {
        for chunk in reply.bytes.chunks(16384) {
            socket
                .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                .await?;
            socket.write_all(chunk).await?;
            socket.write_all(b"\r\n").await?;
        }
        socket.write_all(b"0\r\n\r\n").await?;
    } else {
        socket.write_all(&reply.bytes).await?;
    }
    socket.shutdown().await
}
