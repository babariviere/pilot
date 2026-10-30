//! Owned loopback model-change waits, shared by unit and mounted native fixtures.
use crate::LocalOptions;
#[cfg(test)]
use crate::chat_models::{Attempt, Choice, FailedSource, Target};
use serde_json::json;
use std::time::Duration;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Behavior {
    Accept,
    Lost,
    Reject,
    Wrong,
    Malformed,
}
pub(crate) fn session(failed: bool, choice: Option<&serde_json::Value>) -> serde_json::Value {
    let mut value = json!({"id":"a","cwd":"/synthetic/project","mode":"build","state":"idle","model":"p/a","thinking":"high","updatedAt":1});
    if failed {
        value["state"] = json!("failed");
        value["outcome"] = json!("failed");
        value["outcomeAt"] = json!(100);
        value["outcomeReason"] = json!("Original failure");
        value["failedModelSource"] = json!({"token":format!("{:064x}",1),"source":"startup"});
        if let Some(choice) = choice {
            value["nextAttemptModel"] = {
                let mut v = json!({"model":choice["model"]});
                if let Some(level) = choice.get("thinking") {
                    v["thinking"] = level.clone();
                }
                v
            };
        }
    } else if let Some(choice) = choice {
        value["model"] = choice["model"].clone();
        value["thinking"] = choice.get("thinking").cloned().unwrap_or(json!("low"));
    }
    value
}
#[cfg(test)]
pub(crate) fn attempt(failed: bool) -> Attempt {
    Attempt {
        id: "model-one".into(),
        target: Target {
            session: "a".into(),
            cwd: "/synthetic/project".into(),
            model: Some("p/a".into()),
            thinking: Some("high".into()),
            failed_source: failed.then(|| FailedSource {
                token: format!("{:064x}", 1),
                source: "startup".into(),
            }),
        },
        choice: Choice {
            model: "p/b".into(),
            thinking: Some("low".into()),
        },
    }
}
type Requests = std::sync::Arc<std::sync::Mutex<Vec<(String, String, serde_json::Value)>>>;
pub(crate) struct Server {
    pub(crate) options: LocalOptions,
    pub(crate) entered: async_channel::Receiver<()>,
    pub(crate) release: async_channel::Sender<()>,
    pub(crate) seen: Requests,
    pub(crate) completed: async_channel::Receiver<()>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub(crate) fn start(failed: bool, behavior: Behavior, hold: &'static str) -> Self {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let (shutdown, done) = tokio::sync::oneshot::channel();
        let (entered, reached) = async_channel::bounded(1);
        let (release, released) = async_channel::bounded(1);
        let (complete, completed) = async_channel::bounded(32);
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let record = seen.clone();
        let thread = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async move {
                let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
                send.send(LocalOptions::synthetic(listener.local_addr().unwrap().port())).unwrap();
                let claimed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                let mut tasks = tokio::task::JoinSet::new();
                tokio::pin!(done);
                loop { tokio::select! {
                    _ = &mut done => break,
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        let entered = entered.clone(); let released = released.clone(); let record = record.clone(); let claimed = claimed.clone(); let complete = complete.clone();
                        tasks.spawn(async move {
                            let mut reader = BufReader::new(stream); let mut first = String::new();
                            if reader.read_line(&mut first).await.unwrap() == 0 { return; }
                            let words: Vec<_> = first.split_whitespace().collect();
                            let (method, path) = (words[0], words[1]);
                            let mut length = 0;
                            loop {
                                let mut line = String::new(); reader.read_line(&mut line).await.unwrap();
                                if line == "\r\n" { break; }
                                if let Some(s) = line.to_ascii_lowercase().strip_prefix("content-length:") { length = s.trim().parse::<usize>().unwrap(); }
                                assert!(length < 1024);
                            }
                            let mut bytes = vec![0;length]; reader.read_exact(&mut bytes).await.unwrap();
                            record.lock().unwrap().push((method.into(), path.into(), if bytes.is_empty() {json!(null)} else {serde_json::from_slice(&bytes).unwrap()}));
                            let held = path == hold && !claimed.swap(true, std::sync::atomic::Ordering::SeqCst);
                            if held {
                                entered.send(()).await.unwrap();
                                if released.recv().await.is_err() { return; }
                            }
                            let mutation = method == "POST";
                            if mutation && behavior == Behavior::Lost { return; }
                            let payload: serde_json::Value = if mutation { serde_json::from_slice(&bytes).unwrap() } else { json!(null) };
                            let mut body = match (method,path) {
                                ("GET", "/api/hello") => json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"passiveFailedModel":true}}),
                                ("GET", "/api/sessions/a") => session(failed, None),
                                ("GET", "/api/sessions/b") => { let mut v = session(false, None); v["id"] = json!("b"); v["model"] = json!("q/c"); v["thinking"] = json!("off"); v },
                                ("GET", p) if p.starts_with("/api/models?") => crate::chat_models_fixture::catalog(),
                                ("POST", "/api/sessions/a/model" | "/api/sessions/a/failed-model") => {
                                    assert_eq!(path.ends_with("/failed-model"), failed);
                                    assert!(matches!(payload["model"].as_str(),Some("p/a" | "p/b")));
                                    if failed {
                                        assert_eq!(payload["source"], session(true, None)["failedModelSource"]);
                                        assert_eq!(payload["daemonId"], "test-daemon");
                                        assert_eq!(payload["lineageId"], "test-lineage");
                                        let mut ack = payload.clone();
                                        ack["sessionId"] = json!("a");
                                        ack["session"] = session(true, Some(&payload));
                                        if behavior == Behavior::Wrong { ack["operationId"] = json!("other"); }
                                        ack
                                    } else {
                                        assert!(payload.as_object().unwrap().keys().all(|k| k == "model" || k == "thinking"));
                                        let mut ack = session(false, Some(&payload));
                                        if behavior == Behavior::Wrong { ack["id"] = json!("other"); }
                                        ack
                                    }
                                },
                                _ => panic!("Unexpected model fixture route {method} {path}"),
                            }.to_string();
                            if mutation && behavior == Behavior::Malformed { body = "{broken".into(); }
                            let status = if mutation && behavior == Behavior::Reject {"409 Conflict"} else {"200 OK"};
                            let _ = reader.into_inner().write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
                            if held { let _ = complete.send(()).await; }
                        });
                    },
                    result = tasks.join_next(), if !tasks.is_empty() => { result.unwrap().unwrap(); },
                }}
            });
        });
        Self {
            options: receive.recv_timeout(Duration::from_secs(3)).unwrap(),
            entered: reached,
            release,
            seen,
            completed,
            shutdown: Some(shutdown),
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.shutdown.take().unwrap().send(());
        self.thread.take().unwrap().join().unwrap();
    }
}
