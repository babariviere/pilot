//! Shared owned faux daemon for courier and native integration tests only.
use crate::LocalOptions;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Behavior {
    Accept,
    LostBefore,
    LostAfter,
    BadReceipt,
    AfterCommitFailure,
    Slow,
}
pub(crate) struct Seen {
    pub(crate) source: Value,
    pub(crate) hello: Value,
    pub(crate) posts: Vec<Value>,
    pub(crate) stops: usize,
    pub(crate) requests: Vec<(String, String)>,
    pub(crate) behavior: Behavior,
}
pub(crate) struct Daemon {
    pub(crate) options: LocalOptions,
    pub(crate) seen: Arc<Mutex<Seen>>,
    #[cfg(test)]
    pub(crate) posted: Arc<tokio::sync::Notify>,
    task: tokio::task::JoinHandle<()>,
    pub(crate) released: Arc<tokio::sync::Notify>,
}
impl Drop for Daemon {
    fn drop(&mut self) {
        self.released.notify_waiters();
        self.task.abort();
    }
}
impl Daemon {
    pub(crate) async fn start(behavior: Behavior) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Seen {
            source: json!({"id":"source","projectId":"project","title":"Source title","mode":"ask","state":"working"}),
            hello: json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"guardedMissionConversion":true}}),
            posts: Vec::new(),
            stops: 0,
            requests: Vec::new(),
            behavior,
        }));
        let record = seen.clone();
        let posted = Arc::new(tokio::sync::Notify::new());
        let signal = posted.clone();
        let released = Arc::new(tokio::sync::Notify::new());
        let release = released.clone();
        let task = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>{
                        let Ok((stream,_))=accepted else{break;};let record=record.clone();let signal=signal.clone();let release=release.clone();
                        tasks.spawn(async move {
                            let mut reader=BufReader::new(stream);let mut first=String::new();if reader.read_line(&mut first).await.unwrap()==0{return;}
                            let words:Vec<_>=first.split_whitespace().collect();assert_eq!(words.len(),3);
                            let (method,path)=(words[0].to_owned(),words[1].to_owned());let mut length=0;
                            loop {let mut line=String::new();if reader.read_line(&mut line).await.unwrap()==0{return;}
                                if line=="\r\n"{break;}
                                assert!(!line.to_ascii_lowercase().starts_with("origin:"));
                                if let Some(v)=line.to_ascii_lowercase().strip_prefix("content-length:"){length=v.trim().parse::<usize>().unwrap();}assert!(length<=64*1024);
                            }
                            let mut bytes=vec![0;length];reader.read_exact(&mut bytes).await.unwrap();let payload=if bytes.is_empty(){Value::Null}else{serde_json::from_slice::<Value>(&bytes).unwrap()};
                            let mut stream=reader.into_inner();
                            let (status,response,slow)={
                                let mut s=record.lock().unwrap();s.requests.push((method.clone(),path.clone()));
                                match (method.as_str(),path.as_str()) {
                                    ("GET","/api/hello")=>(200,s.hello.clone(),false),
                                    ("GET","/api/sessions/source")=>(200,s.source.clone(),false),
                                    ("GET","/api/projects/project")=>(200,json!({"id":"project","name":"Exact project","path":"/synthetic/project"}),false),
                                    ("GET","/api/missions/mission-exact")=>(200,json!({"mission":{"id":"mission-exact","projectId":"project"}}),false),
                                    ("POST","/api/sessions/source/stop")=>{s.stops+=1;(200,json!({"ok":true,"draft":null}),false)},
                                    ("POST","/api/missions")=>{
                                        s.posts.push(payload.clone());signal.notify_one();
                                        if s.behavior==Behavior::LostBefore{return;}
                                        assert_eq!(payload["fromSessionId"],"source");assert_eq!(payload["projectId"],"project");
                                        assert!(payload["coordinator"].is_boolean()&&payload["draft"].is_boolean());
                                        assert!(payload.get("startCoordinator").is_none()&&payload.get("cwd").is_none());
                                        if !s.source["missionId"].is_null(){(409,json!({"error":"already linked"}),false)}
                                        else {
                                            s.source["missionId"]=json!("mission-exact");
                                            if s.behavior==Behavior::LostAfter{return;}
                                            (if s.behavior==Behavior::AfterCommitFailure{503}else{201},json!({"mission":{"id":"mission-exact","projectId":if s.behavior==Behavior::BadReceipt{"another-project"}else{"project"}}}),s.behavior==Behavior::Slow)
                                        }
                                    },
                                    _=>panic!("unallowlisted synthetic mission route {method} {path}"),
                                }
                            };
                            if slow {release.notified().await;}
                            let body=response.to_string();let headers=format!("HTTP/1.1 {status} Synthetic\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());let _=stream.write_all(headers.as_bytes()).await;
                        });
                    },
                    _=tasks.join_next(),if !tasks.is_empty()=>{},
                }
            }
        });
        Self {
            options,
            seen,
            #[cfg(test)]
            posted,
            released,
            task,
        }
    }
}
