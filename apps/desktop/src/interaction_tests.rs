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
    ProjectsUnavailable,
    ProjectRemoved,
    ProjectPathChanged,
}
#[derive(Default)]
struct Seen {
    requests: Vec<(String, String)>,
    operations: BTreeMap<String, Value>,
    envelopes: Vec<Value>,
    executions: usize,
    stops: usize,
    projects: BTreeMap<String, String>,
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
                                else if method=="GET"&&path=="/api/projects" {
                                    if behavior==Behavior::ProjectsUnavailable {json!({"error":"Synthetic unavailable"})}
                                    else if behavior==Behavior::ProjectRemoved {json!([{"id":"project-a","name":"Synthetic Atlas","path":"/tmp"}])}
                                    else {json!([{"id":"project-a","name":"Synthetic Atlas","path":"/tmp"},{"id":"project-ab","name":"Synthetic Boreal","path":if behavior==Behavior::ProjectPathChanged{"/changed"}else{"/tmp"}}])}
                                }
                                else if method=="GET"&&path.starts_with("/api/sessions/") {
                                    let id=path.rsplit('/').next().unwrap();
                                    json!({"id":id,"mode":"ask","control":behavior==Behavior::Readonly,"state":"working","projectId":seen.projects.get(id)})
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
                                        if !seen.operations.contains_key(&id){
                                            if payload["kind"]=="chat-create"&&state=="accepted" {
                                                let request:Value=serde_json::from_str(payload["payload"].as_str().unwrap()).unwrap();
                                                if let Some(project)=request["projectId"].as_str() {seen.projects.insert(payload["targetId"].as_str().unwrap().into(),project.into());}
                                            }
                                            seen.executions+=1;seen.operations.insert(id.clone(),receipt);
                                        }
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
        project_id: Some("project-a".into()),
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
async fn same_folder_projects_use_exact_supported_identity_and_canonical_readback() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    let mut captured = draft(1, "Synthetic project-bound create 日本語");
    captured.project_id = Some("project-ab".into());
    assert!(client.command(WriteCommand::Submit {
        key: "new:project".into(),
        draft: Box::new(captured),
        follow_up: true,
        stop: false,
        request: 1
    }));
    let state = until(&updates, |s| s.handled.get("new:project") == Some(&1)).await;
    let target = state.book.as_ref().unwrap().drafts["new:project"]
        .created
        .clone()
        .unwrap();
    {
        let seen = daemon.seen.lock().unwrap();
        assert_eq!(seen.executions, 1);
        let payload: Value =
            serde_json::from_str(seen.envelopes[0]["payload"].as_str().unwrap()).unwrap();
        assert_eq!(payload["projectId"], "project-ab");
        assert!(payload.get("cwd").is_none());
        assert_eq!(
            seen.projects.get(&target).map(String::as_str),
            Some("project-ab")
        );
    }
    let readback = read_json(reqwest::Client::new().get(format!(
        "{}/api/sessions/{target}",
        daemon.options.loopback()
    )))
    .await
    .unwrap();
    assert_eq!(readback["projectId"], "project-ab");
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
}

#[tokio::test]
async fn invalid_or_stale_project_catalog_never_reserves_or_posts_creation() {
    for behavior in [
        Behavior::ProjectsUnavailable,
        Behavior::ProjectRemoved,
        Behavior::ProjectPathChanged,
    ] {
        let daemon = Daemon::start(behavior).await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        let mut captured = draft(1, "Keep draft when project changes");
        captured.project_id = Some("project-ab".into());
        assert!(client.edit("new:project".into(), captured.clone()));
        assert!(client.command(WriteCommand::Submit {
            key: "new:project".into(),
            draft: Box::new(captured),
            follow_up: true,
            stop: false,
            request: 1
        }));
        let state = until(&updates, |s| s.handled.get("new:project") == Some(&1)).await;
        let book = state.book.as_ref().unwrap();
        assert!(book.pending.is_empty());
        assert_eq!(
            book.drafts["new:project"].text,
            "Keep draft when project changes"
        );
        assert!(daemon.seen.lock().unwrap().envelopes.is_empty());
        assert!(client.command(WriteCommand::Close));
        until(&updates, |s| s.flushed).await;
    }
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

#[test]
fn autosave_keeps_short_bursts_fast_and_sustained_edits_bounded() {
    let start = tokio::time::Instant::now();
    let ms = |n| start + Duration::from_millis(n);
    let mut save = Autosave::default();
    assert!(save.deadline.is_none());
    save.edited(start);
    assert_eq!(save.deadline, Some(ms(250)));
    save.edited(ms(100));
    assert_eq!(save.deadline, Some(ms(350)));
    for n in [200, 400, 600, 800, 990] {
        save.edited(ms(n));
        assert_eq!(save.deadline, Some(ms((n + 250).min(1000))));
    }
    // Commands and timer flushes both start a fresh bounded batch.
    save = Autosave::default();
    save.edited(ms(1100));
    assert_eq!(save.deadline, Some(ms(1350)));
}

#[test]
fn failed_flush_retains_latest_mailbox_input_and_fences_further_writes() {
    let temp = Temp::new();
    let options = LocalOptions::synthetic(1);
    let mut store = Store::open(temp.0.clone(), options.host()).unwrap();
    store
        .save_edits(BTreeMap::from([("chat:a".into(), draft(1, "committed"))]))
        .unwrap();
    let edits = Mutex::new(BTreeMap::from([(
        "chat:a".into(),
        draft(3, "latest unsaved"),
    )]));
    store.fail_write = true;
    assert!(flush(&mut store, &edits).is_err());
    assert_eq!(edits.lock().unwrap()["chat:a"].revision, 3);
    assert_eq!(store.book.drafts["chat:a"].revision, 1);
    assert!(flush(&mut store, &edits).is_err());
    assert_eq!(edits.lock().unwrap()["chat:a"].text, "latest unsaved");
    drop(store);
    assert_eq!(
        Store::open(temp.0.clone(), options.host())
            .unwrap()
            .book
            .drafts["chat:a"]
            .text,
        "committed"
    );
}

#[tokio::test]
async fn queued_close_bypasses_the_autosave_deadline() {
    let daemon = Daemon::start(Behavior::Accept).await;
    // A ready Close must flush without waiting for any autosave timer.
    let temp = Temp::new();
    let store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    let (commands, receiver) = async_channel::bounded(8);
    let (wake, wake_receiver) = async_channel::bounded(1);
    let (close, close_receiver) = async_channel::bounded(1);
    let (updates, output) = async_channel::bounded(1);
    let edits = Arc::new(Mutex::new(BTreeMap::from([(
        "chat:a".into(),
        draft(1, "close now"),
    )])));
    wake.try_send(()).unwrap();
    close.try_send(()).unwrap();
    let task = tokio::spawn(run(
        daemon.options.clone(),
        Ok(store),
        WorkerChannels {
            commands: receiver,
            wake: wake_receiver,
            edits,
            updates,
            replace: output.clone(),
            close: close_receiver,
        },
    ));
    task.await.unwrap();
    assert!(output.recv().await.unwrap().flushed);
    drop(commands);
    let restored = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    assert_eq!(restored.book.drafts["chat:a"].text, "close now");
    assert!(daemon.seen.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn disconnected_clients_exit_in_one_poll_even_when_the_final_save_fails() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    for mode in ["healthy", "write-failure", "faulted", "failed-open"] {
        let options = LocalOptions::synthetic(1); // No network commands.
        let temp = Temp::new();
        let mut store = Store::open(temp.0.clone(), options.host()).unwrap();
        store
            .save_edits(BTreeMap::from([("chat:a".into(), draft(1, "committed"))]))
            .unwrap();
        let committed = fs::read(temp.0.join("state-v1.json")).unwrap();
        let store = match mode {
            "failed-open" => {
                drop(store);
                fs::write(temp.0.join("state-v1.json"), b"{corrupt").unwrap();
                let result = Store::open(temp.0.clone(), options.host());
                assert!(result.is_err());
                result
            }
            "write-failure" | "faulted" => {
                store.fail_write = true;
                if mode == "faulted" {
                    assert!(
                        store
                            .save_edits(BTreeMap::from([("chat:a".into(), draft(2, "failed"))]))
                            .is_err()
                    );
                    assert!(store.is_faulted());
                }
                Ok(store)
            }
            _ => Ok(store),
        };
        let (commands, receiver) = async_channel::bounded(8);
        let (wake, wake_receiver) = async_channel::bounded(1);
        let (close, close_receiver) = async_channel::bounded(1);
        let (updates, output) = async_channel::bounded(1);
        let edits = Arc::new(Mutex::new(BTreeMap::from([(
            "chat:a".into(),
            draft(3, "latest unsaved"),
        )])));
        drop((commands, wake, close));
        let mut worker = std::pin::pin!(run(
            options.clone(),
            store,
            WorkerChannels {
                commands: receiver,
                wake: wake_receiver,
                edits: edits.clone(),
                updates,
                replace: output.clone(),
                close: close_receiver,
            }
        ));
        // No wall-clock timeout or scheduler luck: disconnected close must be a
        // terminal branch, not an endless series of ready failed-Close requests.
        assert!(
            matches!(
                worker
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop())),
                Poll::Ready(())
            ),
            "{mode}"
        );
        assert!(
            !output.try_recv().unwrap().flushed,
            "disconnection must not invent a save acknowledgment: {mode}"
        );
        if mode == "healthy" {
            assert!(edits.lock().unwrap().is_empty());
            let restored = Store::open(temp.0.clone(), options.host()).unwrap();
            assert_eq!(restored.book.drafts["chat:a"].revision, 3);
        } else {
            assert_eq!(edits.lock().unwrap()["chat:a"].text, "latest unsaved");
            assert_eq!(
                fs::read(temp.0.join("state-v1.json")).unwrap(),
                if mode == "failed-open" {
                    b"{corrupt".to_vec()
                } else {
                    committed
                }
            );
        }
    }
}

#[tokio::test]
async fn explicit_failed_close_reports_error_waits_without_spinning_and_then_disconnects() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    for failed_open in [false, true] {
        let options = LocalOptions::synthetic(1);
        let temp = Temp::new();
        let mut store = Store::open(temp.0.clone(), options.host()).unwrap();
        store
            .save_edits(BTreeMap::from([("chat:a".into(), draft(1, "committed"))]))
            .unwrap();
        let store = if failed_open {
            drop(store);
            fs::write(temp.0.join("state-v1.json"), b"{corrupt").unwrap();
            let result = Store::open(temp.0.clone(), options.host());
            assert!(result.is_err());
            result
        } else {
            store.fail_write = true;
            Ok(store)
        };
        let (commands, receiver) = async_channel::bounded(8);
        let (wake, wake_receiver) = async_channel::bounded(1);
        let (close, close_receiver) = async_channel::bounded(1);
        let (updates, output) = async_channel::bounded(1);
        let edits = Arc::new(Mutex::new(BTreeMap::from([(
            "chat:a".into(),
            draft(2, "keep unsaved input"),
        )])));
        close.try_send(()).unwrap();
        let mut worker = std::pin::pin!(run(
            options,
            store,
            WorkerChannels {
                commands: receiver,
                wake: wake_receiver,
                edits: edits.clone(),
                updates,
                replace: output.clone(),
                close: close_receiver,
            }
        ));
        let mut cx = Context::from_waker(Waker::noop());
        assert!(matches!(worker.as_mut().poll(&mut cx), Poll::Pending));
        let error = output.try_recv().unwrap();
        assert!(error.error.is_some());
        assert!(!error.flushed);
        assert_eq!(edits.lock().unwrap()["chat:a"].text, "keep unsaved input");
        // Live clients must have time to inspect/copy the error, not be forced
        // closed or busy-looped merely because their explicit save failed.
        assert!(matches!(worker.as_mut().poll(&mut cx), Poll::Pending));
        assert!(matches!(
            output.try_recv(),
            Err(async_channel::TryRecvError::Empty)
        ));
        drop((commands, wake, close));
        assert!(matches!(worker.as_mut().poll(&mut cx), Poll::Ready(())));
        assert!(output.try_recv().is_err());
    }
}

#[tokio::test]
async fn queued_command_flushes_in_its_first_poll_without_waiting_for_a_timer() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    let options = LocalOptions::synthetic(1); // No network work is requested.
    let temp = Temp::new();
    let store = Store::open(temp.0.clone(), options.host()).unwrap();
    let (commands, receiver) = async_channel::bounded(8);
    let (wake, wake_receiver) = async_channel::bounded(1);
    let (_close, close_receiver) = async_channel::bounded(1);
    let (updates, output) = async_channel::bounded(1);
    let edits = Arc::new(Mutex::new(BTreeMap::from([(
        "chat:a".into(),
        draft(1, "save before action"),
    )])));
    wake.try_send(()).unwrap();
    commands
        .try_send(WriteCommand::RetireEmpty {
            key: "chat:a".into(),
            revision: 0,
        })
        .unwrap();
    let mut worker = std::pin::pin!(run(
        options.clone(),
        Ok(store),
        WorkerChannels {
            commands: receiver,
            wake: wake_receiver,
            edits,
            updates,
            replace: output.clone(),
            close: close_receiver,
        }
    ));
    assert!(matches!(
        worker
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    let status = output.try_recv().unwrap();
    assert_eq!(
        status.book.unwrap().drafts["chat:a"].text,
        "save before action"
    );
    let disk: Book =
        serde_json::from_slice(&fs::read(temp.0.join("state-v1.json")).unwrap()).unwrap();
    assert_eq!(disk.drafts["chat:a"].revision, 1);
}

#[tokio::test]
async fn sustained_edits_autosave_before_idle_and_close_flushes_the_latest() {
    use std::sync::atomic::{AtomicU64, Ordering};
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let (commands, receiver) = async_channel::bounded(8);
    let (wake, wake_receiver) = async_channel::bounded(1);
    let (close, close_receiver) = async_channel::bounded(1);
    let (updates_tx, updates) = async_channel::bounded(1);
    let edits = Arc::new(Mutex::new(BTreeMap::new()));
    let client = Interaction {
        commands,
        edits: edits.clone(),
        wake,
        close,
    };
    let worker = tokio::spawn(run(
        daemon.options.clone(),
        Store::open(temp.0.clone(), daemon.options.host()),
        WorkerChannels {
            commands: receiver,
            wake: wake_receiver,
            edits,
            updates: updates_tx,
            replace: updates.clone(),
            close: close_receiver,
        },
    ));
    until(&updates, |s| s.book.is_some()).await;
    let latest = Arc::new(AtomicU64::new(0));
    let recorded = latest.clone();
    let writer = client.clone();
    let producer = tokio::spawn(async move {
        for revision in 1..=200 {
            assert!(writer.edit(
                "chat:a".into(),
                draft(revision, "synthetic sustained input")
            ));
            recorded.store(revision, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });
    let saved = until(&updates, |s| {
        s.book
            .as_ref()
            .is_some_and(|b| b.drafts.contains_key("chat:a"))
    })
    .await;
    assert!(
        !producer.is_finished(),
        "autosave must not wait until continuous typing ends"
    );
    assert!(saved.book.as_ref().unwrap().drafts["chat:a"].revision > 1);
    let disk: Book =
        serde_json::from_slice(&fs::read(temp.0.join("state-v1.json")).unwrap()).unwrap();
    assert!(
        disk.drafts["chat:a"].revision >= saved.book.as_ref().unwrap().drafts["chat:a"].revision
    );
    producer.abort();
    let _ = producer.await;
    let final_revision = latest.load(Ordering::SeqCst) + 1;
    assert!(client.edit(
        "chat:a".into(),
        draft(final_revision, "final unsaved input")
    ));
    assert!(client.command(WriteCommand::Close));
    let closed = until(&updates, |s| s.flushed).await;
    assert_eq!(
        closed.book.unwrap().drafts["chat:a"].revision,
        final_revision
    );
    drop(client);
    // Join before reopening: channel/status delivery alone does not guarantee
    // that the worker has dropped the persistent ownership lock yet.
    worker.await.unwrap();
    let restored = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    assert_eq!(restored.book.drafts["chat:a"].text, "final unsaved input");
    assert_eq!(restored.book.drafts["chat:a"].revision, final_revision);
    assert!(daemon.seen.lock().unwrap().requests.is_empty());
}

#[test]
#[ignore = "explicit isolated synthetic autosave disk replay, not real-time or GUI evidence"]
fn coalesced_snapshot_writer_workload() {
    use crate::delivery_store::{DRAFT_CAP, TEXT_CAP};
    use std::os::unix::fs::MetadataExt;
    struct Observation {
        writes: u64,
        bytes: u64,
        elapsed: Duration,
    }
    let replay = |legacy: bool| {
        let temp = Temp::new();
        let mut store = Store::open(temp.0.clone(), LocalOptions::synthetic(1).host()).unwrap();
        let text = "x".repeat(TEXT_CAP);
        store
            .save_edits(
                (0..DRAFT_CAP)
                    .map(|i| (format!("chat:synthetic-{i}"), draft(1, &text)))
                    .collect(),
            )
            .unwrap();
        let edits = Mutex::new(BTreeMap::new());
        let mut writes = 0;
        let mut bytes = 0;
        let mut persist = |store: &mut Store| {
            let path = temp.0.join("state-v1.json");
            let before = fs::metadata(&path).unwrap().ino();
            flush(store, &edits).unwrap();
            let after = fs::metadata(path).unwrap();
            if before != after.ino() {
                writes += 1;
                bytes += after.len();
            }
        };
        let start = tokio::time::Instant::now();
        let wall = std::time::Instant::now();
        let mut autosave = Autosave::default();
        // Identical 10 logical seconds of sustained 20 Hz edits. Advance a
        // logical clock, but actually serialize/fsync/rename every due snapshot.
        for tick in 0..200 {
            let now = start + Duration::from_millis(tick * 50);
            if autosave.deadline.is_some_and(|due| due <= now) {
                persist(&mut store);
                autosave = Autosave::default();
            }
            edits
                .lock()
                .unwrap()
                .insert("chat:synthetic-0".into(), draft(tick + 2, &text));
            if legacy {
                // Exact previous first-edit + 250ms fixed batching policy.
                autosave
                    .deadline
                    .get_or_insert(now + Duration::from_millis(250));
            } else {
                autosave.edited(now);
            }
        }
        // Normal close always saves the latest input, even before an idle timer.
        persist(&mut store);
        let elapsed = wall.elapsed();
        assert_eq!(store.book.drafts["chat:synthetic-0"].revision, 201);
        drop(store);
        let restored = Store::open(temp.0.clone(), LocalOptions::synthetic(1).host()).unwrap();
        assert_eq!(restored.book.drafts["chat:synthetic-0"].revision, 201);
        assert_eq!(restored.book.drafts["chat:synthetic-0"].text, text);
        Observation {
            writes,
            bytes,
            elapsed,
        }
    };
    let before = replay(true);
    let after = replay(false);
    assert_eq!(before.writes, 40);
    assert_eq!(after.writes, 10);
    assert!(after.bytes * 3 < before.bytes);
    for (label, observation) in [("legacy250ms", before), ("idle250ms/max1s", after)] {
        eprintln!(
            "Synthetic 128x32KiB / 10 logical seconds / 200 edits {label}: {} atomic replacements; {} encoded bytes; {:.3} ms actual replay wall",
            observation.writes,
            observation.bytes,
            observation.elapsed.as_secs_f64() * 1000.
        );
    }
}
