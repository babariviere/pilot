//! Synthetic HTTP only. No service discovery or production filesystem state.
use crate::LocalOptions;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

#[derive(Clone, Copy)]
#[allow(dead_code)] // Shared fault corpus; tests and native probes each use a subset.
pub(crate) enum Behavior {
    Accept,
    Lost,
    ErrorAfter,
    WrongId,
    Slow,
}
pub(crate) struct Seen {
    pub(crate) source: Value,
    pub(crate) hello: Value,
    pub(crate) requests: Vec<(String, String, Value)>,
    pub(crate) behavior: Behavior,
}
pub(crate) struct Daemon {
    pub(crate) options: LocalOptions,
    pub(crate) seen: Arc<Mutex<Seen>>,
    pub(crate) released: Arc<tokio::sync::Notify>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Daemon {
    fn drop(&mut self) {
        self.released.notify_waiters();
        self.task.abort();
    }
}
pub(crate) fn source() -> Value {
    json!({"id":"source","projectId":"project","title":"Unselected chat 👩‍💻 é","cwd":"/synthetic/project","mode":"ask","state":"idle"})
}
impl Daemon {
    pub(crate) async fn start(behavior: Behavior) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Seen {
            source: source(),
            hello: json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"guardedMissionConversion":true}}),
            requests: Vec::new(),
            behavior,
        }));
        let released = Arc::new(tokio::sync::Notify::new());
        let record = seen.clone();
        let release = released.clone();
        let task = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break; };
                        let record = record.clone(); let release = release.clone();
                        tasks.spawn(async move {
                            let mut reader = BufReader::new(stream); let mut first = String::new();
                            if reader.read_line(&mut first).await.unwrap_or(0) == 0 { return; }
                            let words: Vec<_> = first.split_whitespace().collect(); assert_eq!(words.len(),3);
                            let (method,path) = (words[0].to_owned(), words[1].to_owned()); let mut length = 0;
                            loop { let mut line = String::new(); if reader.read_line(&mut line).await.unwrap_or(0) == 0 {return;}
                                if line == "\r\n" { break; } assert!(!line.to_ascii_lowercase().starts_with("origin:"));
                                if let Some(s) = line.to_ascii_lowercase().strip_prefix("content-length:") { length = s.trim().parse::<usize>().unwrap(); }
                                assert!(length <= 64*1024);
                            }
                            let mut bytes = vec![0;length]; if reader.read_exact(&mut bytes).await.is_err() {return;}
                            let payload = if bytes.is_empty() {Value::Null} else {serde_json::from_slice(&bytes).unwrap()};
                            let mut stream = reader.into_inner();
                            let (status, value, slow) = {
                                let mut s = record.lock().unwrap(); s.requests.push((method.clone(),path.clone(),payload.clone()));
                                match (method.as_str(), path.as_str()) {
                                    ("GET", "/api/hello") => (200,s.hello.clone(),false),
                                    ("GET", "/api/sessions/source") => (200,s.source.clone(),false),
                                    ("GET", "/api/projects/project") => (200,json!({"id":"project","name":"Exact project","path":"/synthetic/project"}),false),
                                    ("POST", "/api/missions") => {
                                        assert_eq!(payload["fromSessionId"],"source"); assert_eq!(payload["projectId"],"project");
                                        assert!(payload["draft"].is_boolean() && payload["coordinator"].is_boolean());
                                        assert!(s.source["missionId"].is_null()); s.source["missionId"]=json!("mission-exact");
                                        (201,json!({"mission":{"id":"mission-exact","projectId":"project"}}),matches!(s.behavior,Behavior::Slow))
                                    }
                                    ("POST", "/api/sessions/source/title") => {
                                        s.source["title"] = payload["title"].clone();
                                        match s.behavior {
                                            Behavior::Lost => return,
                                            Behavior::ErrorAfter => (500,json!({"error":"synthetic post-commit failure"}),false),
                                            Behavior::WrongId => {let mut v=s.source.clone();v["id"]=json!("other");(200,v,false)}
                                            Behavior::Slow => (200,s.source.clone(),true),
                                            Behavior::Accept => (200,s.source.clone(),false),
                                        }
                                    }
                                    _ => panic!("unexpected synthetic route {method} {path}"),
                                }
                            };
                            if slow {release.notified().await;}
                            let body=value.to_string();let message=format!("HTTP/1.1 {status} Synthetic\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                            let _=tokio::time::timeout(std::time::Duration::from_secs(2),stream.write_all(message.as_bytes())).await;
                        });
                    },
                    _ = tasks.join_next(), if !tasks.is_empty() => {},
                }
            }
        });
        Self {
            options,
            seen,
            released,
            task,
        }
    }
}
