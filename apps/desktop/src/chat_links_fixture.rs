//! Private synthetic GET-only daemon for chat-link dispatch.
use crate::LocalOptions;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

pub(crate) struct State {
    pub(crate) chat: Value,
    pub(crate) hello: Value,
    pub(crate) status: u16,
    pub(crate) slow: bool,
    pub(crate) requests: Vec<String>,
}
pub(crate) struct Daemon {
    pub(crate) options: LocalOptions,
    pub(crate) state: Arc<Mutex<State>>,
    pub(crate) release: Arc<tokio::sync::Notify>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Daemon {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Daemon {
    pub(crate) async fn start() -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let state = Arc::new(Mutex::new(State {
            chat: json!({"id":"unloaded-ID","title":"Same title","projectId":"project","mode":"ask","state":"idle","cwd":"/synthetic/project"}),
            hello: json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}),
            status: 200,
            slow: false,
            requests: Vec::new(),
        }));
        let release = Arc::new(tokio::sync::Notify::new());
        let recorded = state.clone();
        let released = release.clone();
        let task = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        let state = recorded.clone(); let release = released.clone();
                        tasks.spawn(async move {
                            let mut reader = BufReader::new(stream); let mut headers = String::new();
                            loop {
                                let mut line = String::new();
                                if reader.read_line(&mut line).await.unwrap_or(0) == 0 { return; }
                                if line == "\r\n" { break; }
                                headers.push_str(&line); assert!(headers.len() < 8192);
                            }
                            let first = headers.lines().next().unwrap().to_owned();
                            assert!(first.starts_with("GET "));
                            let path = first.split_whitespace().nth(1).unwrap();
                            let (status, body, slow) = {
                                let mut state = state.lock().unwrap(); state.requests.push(first.clone());
                                match path {
                                    "/api/hello" => (200, state.hello.clone(), false),
                                    "/api/sessions/unloaded-ID" => (state.status, state.chat.clone(), state.slow),
                                    _ => panic!("unexpected read {first}"),
                                }
                            };
                            if slow { release.notified().await; }
                            let body = body.to_string();
                            let response = format!("HTTP/1.1 {status} Synthetic\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), reader.into_inner().write_all(response.as_bytes())).await;
                        });
                    },
                    _ = tasks.join_next(), if !tasks.is_empty() => {},
                }
            }
        });
        Self {
            options,
            state,
            release,
            task,
        }
    }
}

#[cfg(feature = "native-probes")]
pub(crate) struct Running {
    pub(crate) options: LocalOptions,
    pub(crate) state: Arc<Mutex<State>>,
    pub(crate) release: Arc<tokio::sync::Notify>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
#[cfg(feature = "native-probes")]
impl Running {
    pub(crate) fn start() -> Self {
        let (send, recv) = std::sync::mpsc::sync_channel(1);
        let (stop, shutdown) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let daemon = Daemon::start().await;
                    send.send((
                        daemon.options.clone(),
                        daemon.state.clone(),
                        daemon.release.clone(),
                    ))
                    .unwrap();
                    let _ = shutdown.await;
                    drop(daemon);
                });
        });
        let (options, state, release) = recv
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        Self {
            options,
            state,
            release,
            stop: Some(stop),
            thread: Some(thread),
        }
    }
}
#[cfg(feature = "native-probes")]
impl Drop for Running {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
