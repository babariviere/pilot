//! Owned subagent HTTP gates. No real daemon, provider or subagent is contacted.
pub(crate) use crate::model_wait_fixture::Behavior;
use crate::{LocalOptions, delivery_store::Draft};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

pub(crate) const POST: &str =
    "/api/sessions/Parent-A/subagents/Review%2F%E6%97%A5%E6%9C%AC%20%25%3F%23/messages";
pub(crate) fn target() -> crate::session_subagents::Target {
    crate::session_subagents::Target {
        parent: "Parent-A".into(),
        name: "Review/日本 %?#".into(),
        created_at: 1f64.to_bits(),
    }
}
pub(crate) fn captured() -> Draft {
    let question = crate::question::Question::parse(
        7,
        &json!({"question":"Existing question?","options":[{"label":"Keep"}],"blocking":true}),
    )
    .unwrap();
    Draft {
        revision: 2,
        text: "Original child 日本語 👩‍💻".into(),
        cwd: "/synthetic/project".into(),
        project_id: Some("project-a".into()),
        model_choice: Some(crate::chat_models::DraftChoice {
            project_id: "project-a".into(),
            cwd: "/synthetic/project".into(),
            choice: crate::chat_models::Choice {
                model: "p/a".into(),
                thinking: Some("high".into()),
            },
        }),
        answer: Some(
            crate::question::AnswerDraft::capture(
                &question,
                2,
                std::collections::BTreeSet::from([0]),
                "Existing answer".into(),
            )
            .unwrap(),
        ),
        ..Default::default()
    }
}
type Requests = Arc<Mutex<Vec<(String, String, Value)>>>;
pub(crate) struct Server {
    pub(crate) options: LocalOptions,
    pub(crate) entered: async_channel::Receiver<()>,
    pub(crate) release: async_channel::Sender<()>,
    pub(crate) completed: async_channel::Receiver<()>,
    pub(crate) seen: Requests,
    pub(crate) bodies: Arc<Mutex<Vec<Vec<u8>>>>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub(crate) fn start(behavior: Behavior, hold: &'static str) -> Self {
        Self::with_generation(behavior, hold, 1)
    }
    pub(crate) fn with_generation(behavior: Behavior, hold: &'static str, generation: u64) -> Self {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let (shutdown, done) = tokio::sync::oneshot::channel();
        let (entered, reached) = async_channel::bounded(1);
        let (release, released) = async_channel::bounded(1);
        let (complete, completed) = async_channel::bounded(1);
        let seen: Requests = Default::default();
        let record = seen.clone();
        let bodies: Arc<Mutex<Vec<Vec<u8>>>> = Default::default();
        let raw = bodies.clone();
        let thread = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async move {
                let listener=TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,0)).await.unwrap();
                send.send(LocalOptions::synthetic(listener.local_addr().unwrap().port())).unwrap();
                let claimed=Arc::new(std::sync::atomic::AtomicBool::new(false));
                let mut tasks=tokio::task::JoinSet::new(); tokio::pin!(done);
                loop {tokio::select! {
                    _=&mut done => break,
                    accepted=listener.accept() => {
                        let (stream,_)=accepted.unwrap();
                        let entered=entered.clone();let released=released.clone();let complete=complete.clone();let record=record.clone();let raw=raw.clone();
                        let claimed=claimed.clone();
                        tasks.spawn(async move {
                            let mut reader=BufReader::new(stream);let mut first=String::new();
                            if reader.read_line(&mut first).await.unwrap()==0 {return;}
                            let words=first.split_whitespace().collect::<Vec<_>>();let (method,path)=(words[0],words[1]);
                            let mut length=0;
                            loop {
                                let mut line=String::new();
                                reader.read_line(&mut line).await.unwrap();
                                if line=="\r\n" {break;}
                                if let Some(s)=line.to_ascii_lowercase().strip_prefix("content-length:") {
                                    length=s.trim().parse::<usize>().unwrap();
                                }
                                assert!(length<4096);
                            }
                            let mut bytes=vec![0;length];reader.read_exact(&mut bytes).await.unwrap();
                            if method=="POST" {raw.lock().unwrap().push(bytes.clone());}
                            let payload=if bytes.is_empty(){json!(null)}else{serde_json::from_slice(&bytes).unwrap()};
                            record.lock().unwrap().push((method.into(),path.into(),payload));
                            let held=path==hold && !claimed.swap(true,std::sync::atomic::Ordering::SeqCst);
                            if held {entered.send(()).await.unwrap();if released.recv().await.is_err(){return;}}
                            if method=="POST" && behavior==Behavior::Lost {return;}
                            let mut body=match (method,path) {
                                ("GET","/api/hello") => json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}),
                                ("GET","/api/sessions/Parent-A") => json!({"id":"Parent-A","cwd":"/synthetic/project","mode":"build","state":"idle","subagents":[{"name":"Review/日本 %?#","state":"idle","createdAt":generation}]}),
                                ("POST",POST) => json!({"ok":behavior!=Behavior::Wrong}),
                                _ => panic!("Unexpected child fixture route {method} {path}"),
                            }.to_string();
                            if method=="POST" && behavior==Behavior::Malformed {body="{broken".into();}
                            let code=if method=="POST" {if behavior==Behavior::Reject {409}else{202}}else{200};
                            let _=reader.into_inner().write_all(format!("HTTP/1.1 {code} Synthetic\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
                            if held {let _=complete.send(()).await;}
                        });
                    },
                    result=tasks.join_next(),if !tasks.is_empty()=>{result.unwrap().unwrap();},
                }}
            });
        });
        Self {
            options: receive.recv_timeout(Duration::from_secs(3)).unwrap(),
            entered: reached,
            release,
            completed,
            seen,
            bodies,
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
