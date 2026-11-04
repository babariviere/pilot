//! Synthetic loopback fixtures only. No existing Local or account is contacted.
use super::*;
use crate::{
    delivery_store::Store,
    interaction::{Interaction, WriteCommand, WriteState},
};
use std::{
    io::{BufRead, Read as _, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

const KEY: &str = "12345678-1234-4234-8234-123456789abc";
const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
fn create() -> Request {
    Request::Create {
        project_id: "project-1".into(),
        mission_id: "mission-1".into(),
        model: "test/model".into(),
        thinking: None,
    }
}
fn status_json() -> Value {
    json!({"sessionId":"report-1","enabled":true,"revision":3,"projectId":"project-1","missionId":"mission-1","setupPending":false,"archived":false,"available":true,"disclosure":DISCLOSURE})
}
fn finding_json() -> Value {
    json!({"key":KEY,"revision":2,"taskId":"task-1","lifecycle":"in_progress","title":"Reduce repeated work 日本語","priority":"medium","targets":[{"projectId":"project-1","label":"Project"}],"cost":{"baseline":"ten calls","assumptions":"same workload","estimate":"five calls","qualityRisks":"cache freshness","laterResult":""}})
}

#[test]
fn insights_parse_strictness_and_bounds() {
    let valid = status_json();
    assert_eq!(status(&valid, "report-1").unwrap().revision, 3);
    assert!(status(&valid, "report-2").is_err());
    for (field, value) in [
        ("enabled", json!(1)),
        ("revision", json!(-1)),
        ("revision", json!(u64::MAX)),
        ("sessionId", json!("../bad")),
        ("missionId", json!("x".repeat(129))),
        ("disclosure", json!("other")),
    ] {
        let mut bad = valid.clone();
        bad[field] = value;
        assert!(status(&bad, "report-1").is_err(), "{field}");
    }
    for field in [
        "enabled",
        "revision",
        "projectId",
        "missionId",
        "setupPending",
        "archived",
        "available",
        "disclosure",
    ] {
        let mut bad = valid.clone();
        bad.as_object_mut().unwrap().remove(field);
        assert!(status(&bad, "report-1").is_err(), "missing {field}");
    }
    let valid = json!({"items":[finding_json()],"nextCursor":20});
    let parsed = findings(&valid).unwrap();
    assert_eq!(parsed.next_cursor, Some(20));
    assert_eq!(parsed.items[0].lifecycle, Lifecycle::InProgress);
    for (field, value) in [
        ("key", json!(KEY.to_uppercase())),
        ("lifecycle", json!("InProgress")),
        ("title", json!("x".repeat(2001))),
        ("priority", json!("urgent")),
        ("taskId", json!("bad/path")),
        ("targets", json!(null)),
        ("cost", json!({"baseline":"missing fields"})),
    ] {
        let mut bad = valid.clone();
        bad["items"][0][field] = value;
        assert!(findings(&bad).is_err(), "{field}");
    }
    assert!(findings(&json!({"items":vec![finding_json();21],"nextCursor":null})).is_err());
    assert!(findings(&json!({"items":[],"nextCursor":-1})).is_err());
    assert!(findings(&json!({"items":[]})).is_err());
    let mut no_cost = valid.clone();
    no_cost["items"][0]["cost"] = Value::Null;
    assert!(findings(&no_cost).unwrap().items[0].cost.is_none());
    for lifecycle in Lifecycle::ALL {
        assert_eq!(Lifecycle::parse(lifecycle.wire()), Some(lifecycle));
        assert_eq!(serde_json::to_value(lifecycle).unwrap(), lifecycle.wire());
        assert!(!lifecycle.label().is_empty());
    }
    assert!(supported(&json!({"capabilities":{"insights":1}})));
    for flag in [json!(true), json!("1"), json!(2), Value::Null] {
        assert!(!supported(&json!({"capabilities":{"insights":flag}})));
    }
}

#[test]
fn insights_payload_canonical_bytes_and_slots() {
    let request = create();
    assert_eq!(
        request.payload(),
        r#"{"disclosure":"insights-history-v1","missionId":"mission-1","model":"test/model","projectId":"project-1"}"#
    );
    assert_eq!(request.slot(), "create:mission-1");
    assert_eq!(request.kind(), "insights-create");
    assert_eq!(request.target(), None);
    let Request::Create {
        project_id,
        mission_id,
        model,
        ..
    } = request
    else {
        unreachable!()
    };
    assert_eq!(
        Request::Create {
            project_id,
            mission_id,
            model,
            thinking: Some("low".into())
        }
        .payload(),
        r#"{"disclosure":"insights-history-v1","missionId":"mission-1","model":"test/model","projectId":"project-1","thinking":"low"}"#
    );
    let revoke = Request::Revoke {
        session_id: "report-1".into(),
        expected_revision: 3,
    };
    assert_eq!(revoke.payload(), r#"{"expectedRevision":3}"#);
    assert_eq!(revoke.slot(), "revoke:report-1");
    assert_eq!(revoke.target().as_deref(), Some("report-1"));
    let lifecycle = Request::Lifecycle {
        session_id: "report-1".into(),
        key: KEY.into(),
        expected_revision: 4,
        lifecycle: Lifecycle::InProgress,
    };
    assert_eq!(lifecycle.slot(), format!("lifecycle:report-1:{KEY}"));
    assert_eq!(
        lifecycle.payload(),
        format!(r#"{{"expectedRevision":4,"key":"{KEY}","lifecycle":"in_progress"}}"#)
    );
}

struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("insights-test-{}", uuid::Uuid::new_v4())))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn receipt(op: &Operation, result: Value) -> Value {
    json!({"operationId":op.operation_id,"payloadHash":op.payload_hash,"targetId":op.target_id,"destination":op.destination,"state":"accepted","result":result})
}

#[test]
fn insights_adopt_requires_exact_echoes_and_valid_result() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), LocalOptions::synthetic(1).host()).unwrap();
    let op = store.prepare_insights(&create()).unwrap();
    let result = json!({"sessionId":op.target_id});
    let valid = receipt(&op, result.clone());
    assert_eq!(adopt(&op, &valid), Outcome::Accepted(result));
    for field in [
        "operationId",
        "payloadHash",
        "targetId",
        "destination",
        "result",
    ] {
        let mut bad = valid.clone();
        bad[field] = json!("wrong");
        assert!(matches!(adopt(&op, &bad), Outcome::Unknown(_)), "{field}");
    }
    let mut bad = valid.clone();
    bad["result"]["sessionId"] = json!("different");
    assert!(matches!(adopt(&op, &bad), Outcome::Unknown(_)));
    let mut huge = valid.clone();
    huge["result"]["extra"] = json!("x".repeat(RESULT_CAP));
    assert!(matches!(adopt(&op, &huge), Outcome::Unknown(_)));
    let request = Request::Lifecycle {
        session_id: "report-1".into(),
        key: KEY.into(),
        expected_revision: 3,
        lifecycle: Lifecycle::Approved,
    };
    let op = store.prepare_insights(&request).unwrap();
    let result = json!({"sessionId":"report-1","operationId":op.operation_id,"kind":"finding","key":KEY,"revision":4,"taskId":"task-1"});
    assert_eq!(
        adopt(&op, &receipt(&op, result.clone())),
        Outcome::Accepted(result.clone())
    );
    for field in ["key", "operationId", "kind", "revision", "taskId"] {
        let mut bad = result.clone();
        bad[field] = json!("wrong/path");
        assert!(
            matches!(adopt(&op, &receipt(&op, bad)), Outcome::Unknown(_)),
            "{field}"
        );
    }
}

#[test]
fn insights_store_open_protection_settlement_and_reload_validation() {
    let temp = Temp::new();
    let host = LocalOptions::synthetic(1).host();
    let mut store = Store::open(temp.0.clone(), host.clone()).unwrap();
    let request = create();
    let slot = request.slot();
    let op = store.prepare_insights(&request).unwrap();
    assert_eq!(
        store.prepare_insights(&request).err(),
        Some("An Insights action is still unconfirmed. Check it; nothing new was sent.")
    );
    store
        .finish_insights(&slot, &op.operation_id, State::Pending, None, None)
        .unwrap();
    assert!(store.prepare_insights(&request).is_err());
    drop(store);
    let mut store = Store::open(temp.0.clone(), host.clone()).unwrap();
    assert!(store.book.insights[&slot].operation == op);
    let result = json!({"sessionId":op.target_id});
    assert!(
        store
            .finish_insights(
                &slot,
                &op.operation_id,
                State::Accepted,
                None,
                Some(json!({"sessionId":"other"}))
            )
            .is_err()
    );
    store
        .finish_insights(
            &slot,
            &op.operation_id,
            State::Accepted,
            None,
            Some(result.clone()),
        )
        .unwrap();
    assert_eq!(
        outcome(&store.book.insights[&slot]),
        Outcome::Accepted(result)
    );
    assert!(
        store
            .finish_insights(&slot, &op.operation_id, State::Rejected, None, None)
            .is_err()
    );
    let replacement = store.prepare_insights(&request).unwrap();
    assert_ne!(op.operation_id, replacement.operation_id);
    drop(store);
    let original = std::fs::read(temp.0.join("state-v1.json")).unwrap();
    for mutation in 0..7 {
        let mut data: Value = serde_json::from_slice(&original).unwrap();
        let attempt = &mut data["insights"][&slot];
        match mutation {
            0 => attempt["slot"] = json!("create:other"),
            1 => attempt["operation"]["payloadHash"] = json!("bad"),
            2 => attempt["operation"]["destination"]["daemonId"] = json!("other"),
            3 => attempt["state"] = json!("accepted"),
            4 => attempt["result"] = json!({"sessionId":replacement.target_id}),
            5 => attempt["operation"]["kind"] = json!("chat-create"),
            _ => {
                let mut payload: Value =
                    serde_json::from_str(attempt["operation"]["payload"].as_str().unwrap())
                        .unwrap();
                payload["extra"] = json!(true);
                let payload = payload.to_string();
                attempt["operation"]["payloadHash"] = json!(crate::delivery_store::hash(&payload));
                attempt["operation"]["payload"] = json!(payload);
            }
        }
        std::fs::write(temp.0.join("state-v1.json"), data.to_string()).unwrap();
        assert!(
            Store::open(temp.0.clone(), host.clone()).is_err(),
            "mutation {mutation}"
        );
    }
}

#[test]
fn insights_store_capacity_never_discards_open_attempts() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), LocalOptions::synthetic(1).host()).unwrap();
    for i in 0..64 {
        store
            .prepare_insights(&Request::Revoke {
                session_id: format!("report-{i}"),
                expected_revision: 0,
            })
            .unwrap();
    }
    assert!(store.prepare_insights(&create()).is_err());
    assert_eq!(store.book.insights.len(), 64);
    let op = store.book.insights["revoke:report-0"].operation.clone();
    store
        .finish_insights(
            "revoke:report-0",
            &op.operation_id,
            State::Rejected,
            Some("denied".into()),
            None,
        )
        .unwrap();
    store.prepare_insights(&create()).unwrap();
    assert_eq!(store.book.insights.len(), 64);
    assert!(!store.book.insights.contains_key("revoke:report-0"));
}

type Handler = Box<dyn Fn(&str, &Value) -> Option<(u16, Value)> + Send>;
type Seen = Arc<Mutex<Vec<(String, bool, Vec<u8>)>>>;
struct Faux {
    options: LocalOptions,
    handler: Arc<Mutex<Handler>>,
    seen: Seen,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    _home: Temp,
}
impl Faux {
    fn new(handler: Handler) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let home = Temp::new();
        std::fs::create_dir_all(&home.0).unwrap();
        let cap = home.0.join("github-app-capability");
        std::fs::write(
            &cap,
            json!({"daemonId":"test-daemon","lineageId":"test-lineage","token":TOKEN}).to_string(),
        )
        .unwrap();
        std::fs::set_permissions(cap, std::fs::Permissions::from_mode(0o600)).unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port())
            .with_scope_home(home.0.clone());
        let handler = Arc::new(Mutex::new(handler));
        let seen: Seen = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let (respond, record, stopping) = (handler.clone(), seen.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("fake accept: {error}"),
                };
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut reader = std::io::BufReader::new(&mut stream);
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let path = line.split_whitespace().nth(1).unwrap().to_owned();
                let (mut length, mut authorized) = (0, false);
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    let lower = line.to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                    authorized |= lower.trim() == format!("x-pilot-github-capability: {TOKEN}");
                }
                assert!(length <= 64 * 1024);
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                record
                    .lock()
                    .unwrap()
                    .push((path.clone(), authorized, bytes));
                let reply = if path == "/api/hello" {
                    Some((
                        200,
                        json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"insights":1}}),
                    ))
                } else {
                    (respond.lock().unwrap())(&path, &value)
                };
                if let Some((status, value)) = reply {
                    let body = value.to_string();
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} x\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                }
            }
        });
        Self {
            options,
            handler,
            seen,
            stop,
            thread: Some(thread),
            _home: home,
        }
    }
    fn requests(&self, path: &str) -> Vec<(bool, Vec<u8>)> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(p, ..)| p == path)
            .map(|(_, a, b)| (*a, b.clone()))
            .collect()
    }
}
impl Drop for Faux {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}
async fn until(
    updates: &async_channel::Receiver<WriteState>,
    done: impl Fn(&WriteState) -> bool,
) -> WriteState {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let state = updates.recv().await.unwrap();
            if done(&state) {
                return state;
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn insights_writer_lost_ack_only_explicit_check_resends_identical_bytes() {
    let server = Faux::new(Box::new(|path, _| {
        assert_eq!(path, "/api/operations");
        None
    }));
    let temp = Temp::new();
    let (writer, updates) = Interaction::start(server.options.clone(), Ok(temp.0.clone()));
    until(&updates, |s| s.book.is_some()).await;
    assert!(writer.command(WriteCommand::Insights {
        request: 1,
        action: Action::Start(create())
    }));
    let pending = until(&updates, |s| {
        s.insights
            .as_ref()
            .is_some_and(|r| r.request == 1 && r.outcome.is_none())
    })
    .await;
    assert_eq!(pending.insights.unwrap().slot, "create:mission-1");
    let settled = |n| {
        move |s: &WriteState| {
            s.insights
                .as_ref()
                .is_some_and(|r| r.request == n && r.outcome.is_some())
        }
    };
    let state = until(&updates, settled(1)).await;
    assert!(matches!(
        state.insights.unwrap().outcome,
        Some(Outcome::Unknown(_))
    ));
    let op = state.book.unwrap().insights["create:mission-1"]
        .operation
        .clone();
    assert!(writer.command(WriteCommand::Insights {
        request: 2,
        action: Action::Start(create())
    }));
    assert!(matches!(
        until(&updates, settled(2)).await.insights.unwrap().outcome,
        Some(Outcome::Refused(_))
    ));
    assert_eq!(server.requests("/api/operations").len(), 1);
    assert!(writer.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
    drop(writer);
    let (writer, updates) = Interaction::start(server.options.clone(), Ok(temp.0.clone()));
    until(&updates, |s| s.book.is_some()).await;
    assert_eq!(server.requests("/api/operations").len(), 1);
    let saved = op.clone();
    *server.handler.lock().unwrap() = Box::new(move |path, body| {
        assert_eq!(body, &serde_json::to_value(&saved).unwrap());
        match path {
            "/api/operations/receipt" => Some((200, json!({"state":"unknown"}))),
            "/api/operations" => Some((200, receipt(&saved, json!({"sessionId":saved.target_id})))),
            _ => panic!("unexpected fixture route {path}"),
        }
    });
    assert!(writer.command(WriteCommand::Insights {
        request: 3,
        action: Action::Check {
            slot: create().slot()
        }
    }));
    let state = until(&updates, settled(3)).await;
    assert_eq!(
        state.insights.unwrap().outcome,
        Some(Outcome::Accepted(json!({"sessionId":op.target_id})))
    );
    assert_eq!(
        state.book.unwrap().insights["create:mission-1"].state,
        State::Accepted
    );
    let sent = server.requests("/api/operations");
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0], sent[1]);
    assert!(sent[0].0);
    let looked_up = server.requests("/api/operations/receipt");
    assert_eq!(looked_up.len(), 1);
    assert!(!looked_up[0].0);
    assert_eq!(looked_up[0].1, sent[0].1);
    assert!(writer.command(WriteCommand::Insights {
        request: 4,
        action: Action::Check {
            slot: create().slot()
        }
    }));
    until(&updates, settled(4)).await;
    assert_eq!(server.requests("/api/operations").len(), 2);
    assert_eq!(server.requests("/api/operations/receipt").len(), 1);
    assert!(writer.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
    drop(writer);
    let store = Store::open(temp.0.clone(), server.options.host()).unwrap();
    assert_eq!(
        store.book.insights["create:mission-1"].state,
        State::Accepted
    );
}

#[tokio::test]
async fn insights_reads_classify_unavailable_old_routes_and_bound_bodies() {
    let server = Faux::new(Box::new(|path, _| match path {
        "/api/insights/sessions/report-1" => Some((200, status_json())),
        "/api/insights/sessions/report-1/findings?cursor=20" => {
            Some((200, json!({"items":[finding_json()],"nextCursor":null})))
        }
        "/api/insights/sessions/revoked/findings" => {
            Some((409, json!({"error":"insights_unavailable"})))
        }
        "/api/insights/sessions/ordinary" => Some((404, json!({"error":"not_insights"}))),
        "/api/insights/sessions/old" => Some((404, json!({"error":"not_found"}))),
        "/api/insights/sessions/huge" => Some((200, json!({"extra":"x".repeat(BODY_CAP)}))),
        _ => panic!("unexpected fixture route {path}"),
    }));
    let client = crate::chat_settings::client().unwrap();
    assert!(matches!(
        run_read(
            &client,
            &server.options,
            &Read::Status {
                session: "report-1".into()
            }
        )
        .await,
        ReadReply::Status(Ok(_))
    ));
    assert!(matches!(
        run_read(
            &client,
            &server.options,
            &Read::Findings {
                session: "report-1".into(),
                cursor: Some(20)
            }
        )
        .await,
        ReadReply::Findings(Ok(_))
    ));
    assert!(matches!(
        run_read(
            &client,
            &server.options,
            &Read::Findings {
                session: "revoked".into(),
                cursor: None
            }
        )
        .await,
        ReadReply::Unavailable
    ));
    for (session, expected) in [
        ("ordinary", "not_insights"),
        ("old", "unsupported"),
        ("huge", "bounded"),
    ] {
        let reply = read(
            server.options.clone(),
            Read::Status {
                session: session.into(),
            },
        )
        .unwrap()
        .recv()
        .await
        .unwrap();
        assert!(match expected {
            "not_insights" => matches!(reply, ReadReply::NotInsights),
            "unsupported" => matches!(reply, ReadReply::Unsupported),
            _ => matches!(reply, ReadReply::Status(Err(_))),
        });
    }
    assert!(matches!(
        run_read(
            &client,
            &server.options,
            &Read::Status {
                session: "../bad".into()
            }
        )
        .await,
        ReadReply::Status(Err(_))
    ));
    assert!(
        server
            .seen
            .lock()
            .unwrap()
            .iter()
            .all(|(_, capability, _)| !capability)
    );
}
