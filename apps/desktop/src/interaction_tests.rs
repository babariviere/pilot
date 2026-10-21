//! Isolated synthetic daemon writes only. Never targets a running Local daemon.
use super::*;
use serde_json::json;
use std::fs;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    task::JoinHandle,
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("desktop-courier-test-{}", uuid::Uuid::new_v4())))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Behavior {
    Accept,
    Pending,
    Reject,
    LostAccepted,
    LostBeforeAdmission,
    BadIdentity,
    Readonly,
    WrongReceipt,
    Slow,
    LostStop,
}
#[derive(Default)]
struct Seen {
    requests: Vec<(String, String)>,
    operations: BTreeMap<String, Value>,
    envelopes: Vec<Value>,
    executions: usize,
    stops: usize,
}
struct Daemon {
    options: LocalOptions,
    seen: Arc<Mutex<Seen>>,
    task: JoinHandle<()>,
}
impl Drop for Daemon {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Daemon {
    async fn start(behavior: Behavior) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Seen::default()));
        let record = seen.clone();
        let task = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>{
                        let Ok((stream,_))=accepted else{break;};let record=record.clone();
                        tasks.spawn(async move {
                            let mut reader=BufReader::new(stream);let mut first=String::new();reader.read_line(&mut first).await.unwrap();
                            let words:Vec<_>=first.split_whitespace().collect();if words.len()<2{return;}
                            let (method,path)=(words[0].to_string(),words[1].to_string());
                            let mut length=0;
                            loop {let mut line=String::new();if reader.read_line(&mut line).await.unwrap()==0{return;}
                            if line=="\r\n"{break;}
                                assert!(!line.to_ascii_lowercase().starts_with("origin:"));
                                if let Some(value)=line.to_ascii_lowercase().strip_prefix("content-length:"){length=value.trim().parse::<usize>().unwrap();}
                                assert!(length<128*1024);
                            }
                            let mut body=vec![0;length];reader.read_exact(&mut body).await.unwrap();
                            let payload=if body.is_empty(){Value::Null}else{serde_json::from_slice::<Value>(&body).unwrap()};
                            let mut stream=reader.into_inner();
                            if behavior==Behavior::Slow&&path=="/api/operations"{tokio::time::sleep(Duration::from_secs(30)).await;return;}
                            let response={
                                let mut seen=record.lock().unwrap();seen.requests.push((method.clone(),path.clone()));
                                if method=="GET"&&path=="/api/hello" {json!({"daemonId":if behavior==Behavior::BadIdentity{"wrong"}else{"test-daemon"},"lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}})}
                                else if method=="GET"&&path.starts_with("/api/sessions/") {
                                    json!({"id":path.rsplit('/').next().unwrap(),"mode":"ask","control":behavior==Behavior::Readonly,"state":"working"})
                                } else if method=="POST"&&path.ends_with("/stop") {
                                    seen.stops+=1;if behavior==Behavior::LostStop{return;}json!({"ok":true,"draft":"synthetic queued input"})
                                } else if method=="POST"&&matches!(path.as_str(),"/api/operations"|"/api/operations/receipt") {
                                    let id=payload["operationId"].as_str().unwrap().to_string();
                                    assert_eq!(payload["payloadHash"],crate::delivery_store::hash(payload["payload"].as_str().unwrap()));
                                    if path.ends_with("/receipt") {seen.operations.get(&id).cloned().unwrap_or_else(||json!({"state":"unknown"}))}
                                    else {
                                        seen.envelopes.push(payload.clone());
                                        if behavior==Behavior::LostBeforeAdmission&&seen.envelopes.len()==1{return;}
                                        let state=if behavior==Behavior::Pending{"pending"}else if behavior==Behavior::Reject{"rejected"}else{"accepted"};
                                        let receipt=json!({"operationId":id,"payloadHash":payload["payloadHash"],"destination":payload["destination"],"targetId":payload["targetId"],"state":state,"result":{"sessionId":payload["targetId"]}});
                                        if !seen.operations.contains_key(&id){seen.executions+=1;seen.operations.insert(id.clone(),receipt);}
                                        if behavior==Behavior::LostAccepted&&seen.envelopes.len()==1{return;}
                                        let mut receipt=seen.operations[&id].clone();
                                        if behavior==Behavior::WrongReceipt {receipt["targetId"]=json!("another-target");}
                                        receipt
                                    }
                                } else {panic!("unallowlisted synthetic write route: {method} {path}")}
                            };
                            let body=response.to_string();let headers=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                            let _=stream.write_all(headers.as_bytes()).await;
                        });
                    },
                    _=tasks.join_next(),if !tasks.is_empty()=>{}
                }
            }
        });
        Self {
            options,
            seen,
            task,
        }
    }
}
fn draft(revision: u64, text: &str) -> Draft {
    Draft {
        revision,
        text: text.into(),
        cwd: "/tmp".into(),
        ..Default::default()
    }
}
async fn until(
    rx: &async_channel::Receiver<WriteState>,
    predicate: impl Fn(&WriteState) -> bool,
) -> WriteState {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = rx.recv().await.unwrap();
            if predicate(&value) {
                return value;
            }
        }
    })
    .await
    .expect("bounded synthetic courier update")
}
async fn ready(daemon: &Daemon, temp: &Temp) -> (Interaction, async_channel::Receiver<WriteState>) {
    let (client, updates) = Interaction::start(daemon.options.clone(), Ok(temp.0.clone()));
    until(&updates, |s| s.book.is_some()).await;
    (client, updates)
}
fn submit(client: &Interaction, key: &str, revision: u64, text: &str, request: u64, stop: bool) {
    let draft = draft(revision, text);
    assert!(client.edit(key.into(), draft.clone()));
    assert!(client.command(WriteCommand::Submit {
        key: key.into(),
        draft: Box::new(draft),
        follow_up: true,
        stop,
        request
    }));
}

#[tokio::test]
async fn create_send_and_stop_use_only_allowlisted_user_driven_routes() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    assert!(
        daemon.seen.lock().unwrap().requests.is_empty(),
        "load must not send anything"
    );
    submit(&client, "new:slot", 1, "synthetic create", 1, false);
    let accepted = until(&updates, |s| s.handled.get("new:slot") == Some(&1)).await;
    let target = accepted.book.as_ref().unwrap().drafts["new:slot"]
        .created
        .clone()
        .unwrap();
    let key = format!("chat:{target}");
    submit(&client, &key, 1, "synthetic follow-up", 2, false);
    until(&updates, |s| s.handled.get(&key) == Some(&2)).await;
    submit(&client, &key, 2, "unsent composer", 3, true);
    let stopped = until(&updates, |s| s.handled.get(&key) == Some(&3)).await;
    assert_eq!(
        stopped.book.as_ref().unwrap().drafts[&key].text,
        "unsent composer"
    );
    assert_eq!(
        *stopped.book.as_ref().unwrap().drafts[&key].recovered,
        vec!["synthetic queued input"]
    );
    let seen = daemon.seen.lock().unwrap();
    assert_eq!(seen.executions, 2);
    assert_eq!(seen.stops, 1);
    assert!(!seen.requests.iter().any(|(_, p)| p.ends_with("/messages")
        || p == "/api/sessions"
        || p.contains("archive")
        || p.contains("read-status")));
}

#[tokio::test]
async fn lost_response_is_reconciled_by_receipt_without_duplicate_admission() {
    let daemon = Daemon::start(Behavior::LostAccepted).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    submit(&client, "new:slot", 1, "lost response fixture", 1, false);
    let unknown = until(&updates, |s| s.handled.get("new:slot") == Some(&1)).await;
    let id = unknown.book.as_ref().unwrap().drafts["new:slot"]
        .pending
        .clone()
        .unwrap();
    assert_eq!(
        unknown.book.as_ref().unwrap().drafts["new:slot"].text,
        "lost response fixture"
    );
    client.command(WriteCommand::Check {
        id: id.clone(),
        retry: true,
    });
    let accepted = until(&updates, |s| {
        s.book
            .as_ref()
            .is_some_and(|b| b.pending.is_empty() && b.drafts["new:slot"].created.is_some())
    })
    .await;
    assert!(
        accepted.book.as_ref().unwrap().drafts["new:slot"]
            .text
            .is_empty()
    );
    let seen = daemon.seen.lock().unwrap();
    assert_eq!(seen.executions, 1);
    assert_eq!(seen.envelopes.len(), 1);
}

#[tokio::test]
async fn explicit_retry_reuses_original_envelope_when_no_receipt_exists() {
    let daemon = Daemon::start(Behavior::LostBeforeAdmission).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    submit(&client, "new:slot", 1, "retry same intent", 1, false);
    let unknown = until(&updates, |s| s.handled.get("new:slot") == Some(&1)).await;
    let id = unknown.book.as_ref().unwrap().drafts["new:slot"]
        .pending
        .clone()
        .unwrap();
    client.command(WriteCommand::Check { id, retry: true });
    until(&updates, |s| {
        s.book
            .as_ref()
            .is_some_and(|b| b.pending.is_empty() && b.drafts["new:slot"].created.is_some())
    })
    .await;
    let seen = daemon.seen.lock().unwrap();
    assert_eq!(seen.executions, 1);
    assert_eq!(seen.envelopes.len(), 2);
    assert_eq!(seen.envelopes[0], seen.envelopes[1]);
}

#[tokio::test]
async fn pending_never_reposts_and_restart_never_automatically_executes() {
    let daemon = Daemon::start(Behavior::Pending).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    submit(&client, "chat:a", 1, "pending fixture", 1, false);
    let pending = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
    let id = pending.book.as_ref().unwrap().drafts["chat:a"]
        .pending
        .clone()
        .unwrap();
    client.command(WriteCommand::Check {
        id: id.clone(),
        retry: true,
    });
    until(&updates, |s| s.notice.starts_with("Pending:")).await;
    assert_eq!(daemon.seen.lock().unwrap().envelopes.len(), 1);
    client.command(WriteCommand::Close);
    until(&updates, |s| s.flushed).await;
    drop(client);
    tokio::time::sleep(Duration::from_millis(10)).await;
    let before = daemon.seen.lock().unwrap().requests.len();
    let (client, updates) = ready(&daemon, &temp).await;
    assert_eq!(daemon.seen.lock().unwrap().requests.len(), before);
    client.command(WriteCommand::Check { id, retry: false });
    until(&updates, |s| s.notice.starts_with("Pending:")).await;
    assert_eq!(daemon.seen.lock().unwrap().envelopes.len(), 1);
}

#[tokio::test]
async fn identity_readonly_and_bad_receipt_refuse_without_draft_loss() {
    for behavior in [
        Behavior::BadIdentity,
        Behavior::Readonly,
        Behavior::WrongReceipt,
        Behavior::Reject,
    ] {
        let daemon = Daemon::start(behavior).await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        submit(&client, "chat:a", 1, "retained synthetic draft", 1, false);
        let result = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
        assert_eq!(
            result.book.as_ref().unwrap().drafts["chat:a"].text,
            "retained synthetic draft"
        );
        if matches!(behavior, Behavior::BadIdentity | Behavior::Readonly) {
            assert_eq!(daemon.seen.lock().unwrap().executions, 0);
        }
        if behavior == Behavior::WrongReceipt {
            assert!(!result.book.as_ref().unwrap().pending.is_empty());
        }
    }
}

#[tokio::test]
async fn close_flushes_drafts_and_cancels_inflight_request_without_retry() {
    let daemon = Daemon::start(Behavior::Slow).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    submit(&client, "chat:a", 1, "close in flight", 1, false);
    until(&updates, |s| {
        s.book
            .as_ref()
            .is_some_and(|b| b.drafts.contains_key("chat:a"))
    })
    .await;
    client.edit("chat:b".into(), draft(2, "other latest draft"));
    client.command(WriteCommand::Close);
    until(&updates, |s| s.flushed).await;
    drop(client);
    tokio::time::sleep(Duration::from_millis(10)).await;
    let restored = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    assert_eq!(restored.book.drafts["chat:b"].text, "other latest draft");
    assert_eq!(restored.book.drafts["chat:a"].text, "close in flight");
    assert!(daemon.seen.lock().unwrap().executions == 0);
}

#[tokio::test]
async fn uncertain_stop_is_not_replayed_by_check_retry_or_local_acknowledgement() {
    let daemon = Daemon::start(Behavior::LostStop).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    submit(&client, "chat:a", 1, "keep composer", 1, true);
    let unknown = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
    let id = unknown.book.as_ref().unwrap().drafts["chat:a"]
        .pending
        .clone()
        .unwrap();
    client.command(WriteCommand::Check {
        id: id.clone(),
        retry: true,
    });
    until(&updates, |s| s.notice.starts_with("Stop has no receipt")).await;
    assert_eq!(daemon.seen.lock().unwrap().stops, 1);
    client.command(WriteCommand::DismissStop { id });
    let dismissed = until(&updates, |s| {
        s.book.as_ref().is_some_and(|b| b.pending.is_empty())
    })
    .await;
    assert_eq!(
        dismissed.book.as_ref().unwrap().drafts["chat:a"].text,
        "keep composer"
    );
    assert_eq!(daemon.seen.lock().unwrap().stops, 1);
}
