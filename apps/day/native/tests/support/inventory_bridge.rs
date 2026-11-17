//! Synthetic HTTP/WS inventory. No Node, real daemon, provider or visible app.
use super::*;
use pilot_day_native::plan::{PlanAvailability, Planning};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
};

struct State {
    feedback: Value,
    inventory: Value,
    inventory_status: u16,
    requests: usize,
    websocket: Option<TcpStream>,
    feedback_receipts: Vec<Value>,
    feedback_posts: usize,
    feedback_lookups: usize,
    lose_feedback_reply: bool,
}
struct InventoryFixture {
    f: Fixture,
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    port: u16,
}
fn inventory(title: &str) -> Value {
    json!({"version":1,"projectId":"synthetic-project","status":"available","limit":100,"total":1,
        "items":[{"missionId":"mission-one","title":title,"stage":"questions","needsYou":true,
            "round":{"missionId":"mission-one","ownerSessionId":"owner","enrollmentId":"enrollment",
                "questionSetRevision":2,"answerRevision":1},"interviewRevision":4,"planRevision":null}]})
}
impl InventoryFixture {
    fn new() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let f = Fixture::selected(port, true);
        let state = Arc::new(Mutex::new(State {
            feedback: json!({"items":[],"more":false,"before":null}),
            inventory: inventory("First interview"),
            inventory_status: 200,
            requests: 0,
            websocket: None,
            feedback_receipts: vec![],
            feedback_posts: 0,
            feedback_lookups: 0,
            lose_feedback_reply: false,
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let data = state.clone();
        let stopped = stop.clone();
        let project = f.path.display().to_string();
        let thread = std::thread::spawn(move || {
            loop {
                let (mut stream, _) = listener.accept().unwrap();
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                let mut key = String::new();
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header == "\r\n" {
                        break;
                    }
                    assert!(!header.is_empty(), "incomplete HTTP request");
                    if let Some((name, value)) = header.split_once(':')
                        && name.eq_ignore_ascii_case("sec-websocket-key")
                    {
                        key = value.trim().to_owned();
                    }
                    if let Some((name, value)) = header.split_once(':')
                        && name.eq_ignore_ascii_case("content-length")
                    {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let mut state = data.lock().unwrap();
                state.requests += 1;
                if request.starts_with("POST /api/operations ")
                    || request.starts_with("POST /api/operations/receipt ")
                {
                    let op: Value = serde_json::from_slice(&bytes).unwrap();
                    let lookup = request.starts_with("POST /api/operations/receipt ");
                    let body = if lookup {
                        state.feedback_lookups += 1;
                        state.feedback_receipts.iter().find(|r| r["operationId"] == op["operationId"]).unwrap().clone()
                    } else {
                        state.feedback_posts += 1;
                        let p: Value = serde_json::from_str(op["payload"].as_str().unwrap()).unwrap();
                        if p["purpose"] == "feedback-work" {
                            let result = if p["action"] == "triage" {
                                let work = json!({"operationId":op["operationId"],"kind":"triage","sessionId":op["targetId"],"projectId":p["projectId"],"recordedAt":1});
                                let item = state.feedback["items"].as_array_mut().unwrap().iter_mut().find(|i|i["id"]==p["feedbackId"]).unwrap();
                                item["work"].as_array_mut().unwrap().push(work.clone());
                                work
                            } else {
                                assert_eq!(p["action"], "correct");
                                json!({"operationId":op["operationId"],"kind":"correction","sessionId":op["targetId"],"proposalDigest":p["proposalDigest"],"text":p["message"],"recordedAt":1})
                            };
                            let receipt = json!({"operationId":op["operationId"],"payloadHash":op["payloadHash"],"destination":op["destination"],"targetId":op["targetId"],"state":"accepted","result":result});
                            state.feedback_receipts.push(receipt.clone());
                            if state.lose_feedback_reply {
                                state.lose_feedback_reply = false;
                                stream.shutdown(Shutdown::Both).unwrap();
                                continue;
                            }
                            receipt
                        } else {
                        assert_eq!(p["purpose"], "user-feedback");
                        let mut item = json!({"id":op["targetId"],"operationId":op["operationId"],"text":p["text"],"origin":null,"recordedAt":1});
                        if let Some(investigation) = p.get("investigation") { item["investigation"] = investigation.clone(); }
                        if let Some(images) = p.get("attachments") { item["attachments"] = images.clone(); }
                        let receipt = json!({"operationId":op["operationId"],"payloadHash":op["payloadHash"],"destination":op["destination"],"targetId":op["targetId"],"state":"accepted","result":item});
                        state.feedback_receipts.push(receipt.clone());
                        item["sequence"] = json!(state.feedback_posts);
                        item["work"] = json!([]);
                        state.feedback["items"].as_array_mut().unwrap().insert(0, item);
                        if state.lose_feedback_reply {
                            state.lose_feedback_reply = false;
                            stream.shutdown(Shutdown::Both).unwrap();
                            continue;
                        }
                        receipt
                        }
                    }.to_string();
                    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len()).unwrap();
                    stream.flush().unwrap();
                    continue;
                }
                assert!(
                    request.starts_with("GET "),
                    "snapshot must not write: {request}"
                );
                let status = if request
                    .starts_with("GET /api/projects/synthetic-project/planning-inventory ")
                {
                    state.inventory_status
                } else {
                    200
                };
                if request.starts_with("GET /api/ws ") {
                    let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(
                        key.as_bytes(),
                    );
                    write!(stream,"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").unwrap();
                    stream.flush().unwrap();
                    state.websocket = Some(stream);
                    continue;
                }
                let body = if request.starts_with("GET /api/feedback?limit=20 ") {
                    state.feedback.clone()
                } else if request.starts_with("GET /api/telemetry ") {
                    // The connection now reads diagnostic controls before declaring Live.
                    // This fixture grants no logging or telemetry capability.
                    json!({"localDiagnostics":false,"localFeatureUsage":false,"remoteOperational":false,"productAnalytics":false})
                } else if request.starts_with("GET /api/hello ") {
                    json!({"daemonId":"synthetic-daemon","lineageId":"synthetic-lineage","protocolVersion":1,
                        "minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"dayOverview":1}})
                } else if request.starts_with("GET /api/projects/synthetic-project ") {
                    json!({"id":"synthetic-project","path":project})
                } else if request.starts_with("GET /api/projects/synthetic-project/chat-profile?mode=ask ") {
                    json!({"projectId":"synthetic-project","projectPath":project,"contextDigest":"d".repeat(64),"mode":"ask","model":"fake/model","thinking":"high","fundingRequired":true,"allowanceMicros":null})
                } else if request.starts_with("GET /api/projects/synthetic-project/day ") {
                    json!({"version":1,"projectId":"synthetic-project","observedAt":1,"complete":true,
                        "dashboard":{"projectId":"synthetic-project","missions":{"total":0,"items":[]},"working":{"total":0,"items":[]}},"reports":[],"controls":[]})
                } else {
                    assert!(request.starts_with("GET /api/projects/synthetic-project/planning-inventory "), "unexpected request: {request}");
                    state.inventory.clone()
                }.to_string();
                drop(state);
                write!(stream,"HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len()).unwrap();
                stream.flush().unwrap();
            }
        });
        let fixture = Self {
            f,
            state,
            stop,
            thread: Some(thread),
            port,
        };
        let _ = fixture.f.host.read_planning_inventory().recv_blocking();
        fixture.wait(|read| read.availability == PlanAvailability::Live);
        fixture
    }
    fn wait(&self, predicate: impl Fn(&Planning) -> bool) {
        let changes = self.f.host.changes();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                tokio::time::timeout(Duration::from_secs(5), async {
                    loop {
                        if predicate(&self.f.host.planning_inventory_snapshot()) {
                            break;
                        }
                        changes.recv().await.unwrap();
                    }
                })
                .await
                .unwrap();
            });
    }
    fn invalidate(&self, read: Value) {
        let mut state = self.state.lock().unwrap();
        state.inventory = read;
        // A complete unmasked server text frame; no inventory data is in the event.
        let event = br#"{"type":"mission-catalog.changed"}"#;
        let ws = state.websocket.as_mut().unwrap();
        ws.write_all(&[0x81, event.len() as u8]).unwrap();
        ws.write_all(event).unwrap();
        ws.flush().unwrap();
    }
    fn snapshot(&self) -> Value {
        self.f.run(
            "return await call('day.plan.inventorySnapshot');",
            Fixture::caps(),
        )
    }
}

#[test]
fn unknown_feedback_holds_only_its_payload_and_images_and_check_never_resends() {
    let mut fixture = InventoryFixture::new();
    fixture.state.lock().unwrap().lose_feedback_reply = true;
    let image = json!({"uploadId":"00000000-0000-4000-8000-000000000001","sha256":"a".repeat(64),"bytes":70});
    let intent = json!({"text":"First report 日本語","origin":null,"attachments":[image.clone()]});
    let first = fixture.f.run(
        &format!("return await call('day.feedback.send', {intent});"),
        Fixture::caps(),
    );
    let outcome = &first["value"]["outcome"];
    assert_eq!(outcome["state"], "unknown");
    let id = outcome["operationId"].as_str().unwrap();
    assert_eq!(
        first["value"]["operations"][0]["attachments"],
        json!([image.clone()])
    );
    let removal = fixture.f.run(
        "return await call('day.feedback.image', {uploadId:'00000000-0000-4000-8000-000000000001'});",
        Fixture::caps(),
    );
    assert_eq!(
        removal["error"], "unknown",
        "an uncertain owner protects its upload without DELETE"
    );
    for blocked in [
        intent,
        json!({"text":"Changed report","origin":null,"attachments":[image]}),
    ] {
        let reply = fixture.f.run(
            &format!("return await call('day.feedback.send', {blocked});"),
            Fixture::caps(),
        );
        assert_eq!(reply["error"], "unknown");
    }
    let other = fixture.f.run(
        "return await call('day.feedback.send', {text:'Independent report',origin:null});",
        Fixture::caps(),
    );
    assert_eq!(other["value"]["outcome"]["state"], "accepted");
    assert_eq!(other["value"]["operations"].as_array().unwrap().len(), 1);
    assert_eq!(fixture.f.bridge.close().recv_blocking().unwrap(), Ok(()));
    fixture.f.host = NativeHost::open(
        Source {
            profile: fixture.f.path.join("missing-profile"),
            port: fixture.port,
            home: Home {
                daemon_id: "synthetic-daemon".into(),
                lineage_id: "synthetic-lineage".into(),
            },
            project: Some(pilot_day_native::host::Project {
                project_id: "synthetic-project".into(),
                project_path: fixture.f.path.display().to_string(),
            }),
        },
        fixture.f.path.join("journal"),
    )
    .unwrap();
    fixture.f.bridge = Bridge::new(DayRoot::new(fixture.f.host.clone()));
    let _ = fixture.f.host.read_planning_inventory().recv_blocking();
    fixture.wait(|p| p.availability == PlanAvailability::Live);
    let restored = fixture
        .f
        .run("return await call('day.feedback.read');", Fixture::caps());
    assert_eq!(restored["value"]["operations"][0]["operationId"], id);
    let checked = fixture.f.run(
        &format!("return await call('day.feedback.check', {{operationId:'{id}'}});"),
        Fixture::caps(),
    );
    assert_eq!(checked["value"]["outcome"]["state"], "accepted");
    assert_eq!(
        checked["value"]["outcome"]["receipt"]["result"]["text"],
        "First report 日本語"
    );
    assert_eq!(checked["value"]["operations"], json!([]));
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.feedback_posts, 2);
    assert_eq!(state.feedback_lookups, 1);
}

#[test]
fn unknown_feedback_retains_its_original_investigation_and_starts_it_once_after_check() {
    let mut fixture = InventoryFixture::new();
    fixture.state.lock().unwrap().lose_feedback_reply = true;
    let first = fixture.f.run(&format!("return await call('day.feedback.send', {{text:'Investigate once 日本語',origin:null,investigation:{{projectId:'synthetic-project',contextDigest:'{}'}}}});", "d".repeat(64)), Fixture::caps());
    assert_eq!(first["value"]["outcome"]["state"], "unknown");
    let parent = first["value"]["outcome"]["operationId"]
        .as_str()
        .unwrap()
        .to_owned();
    let child = first["value"]["snapshot"]["items"][0]["investigation"]["operation"]["operationId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(fixture.state.lock().unwrap().feedback_posts, 1);
    assert_eq!(fixture.f.bridge.close().recv_blocking().unwrap(), Ok(()));
    fixture.f.host = NativeHost::open(
        Source {
            profile: fixture.f.path.join("missing-profile"),
            port: fixture.port,
            home: Home {
                daemon_id: "synthetic-daemon".into(),
                lineage_id: "synthetic-lineage".into(),
            },
            project: Some(pilot_day_native::host::Project {
                project_id: "synthetic-project".into(),
                project_path: fixture.f.path.display().to_string(),
            }),
        },
        fixture.f.path.join("journal"),
    )
    .unwrap();
    fixture.f.bridge = Bridge::new(DayRoot::new(fixture.f.host.clone()));
    let _ = fixture.f.host.read_planning_inventory().recv_blocking();
    fixture.wait(|p| p.availability == PlanAvailability::Live);
    fixture
        .f
        .run("return await call('day.feedback.read');", Fixture::caps());
    assert_eq!(
        fixture.state.lock().unwrap().feedback_posts,
        1,
        "reopening and reading never dispatch work"
    );
    for _ in 0..2 {
        let checked = fixture.f.run(
            &format!("return await call('day.feedback.check', {{operationId:'{parent}'}});"),
            Fixture::caps(),
        );
        assert_eq!(checked["value"]["outcome"]["state"], "accepted");
        assert_eq!(
            checked["value"]["investigationOutcome"]["state"],
            "accepted"
        );
        assert_eq!(
            checked["value"]["investigationOutcome"]["operationId"],
            child
        );
    }
    let state = fixture.state.lock().unwrap();
    assert_eq!(
        state.feedback_posts, 2,
        "one feedback save and one exact investigation, never another start"
    );
    assert_eq!(state.feedback["items"][0]["work"][0]["kind"], "triage");
}

#[test]
fn correction_lost_reply_reopens_and_checks_without_another_send() {
    let mut fixture = InventoryFixture::new();
    fixture.state.lock().unwrap().lose_feedback_reply = true;
    let digest = "d".repeat(64);
    let first = fixture.f.run(&format!("return await call('day.feedback.step', {{action:'correct',feedbackId:'f1',triageSessionId:'triage-1',proposalDigest:'{digest}',message:'Restart, not navigation 日本語'}});"), Fixture::caps());
    assert_eq!(first["value"]["outcome"]["state"], "unknown");
    let id = first["value"]["operations"][0]["operationId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        first["value"]["operations"][0]["replyKey"],
        format!("triage-1/correction-{digest}")
    );
    let blocked = fixture.f.run(&format!("return await call('day.feedback.step', {{action:'correct',feedbackId:'f1',triageSessionId:'triage-1',proposalDigest:'{digest}',message:'Other correction'}});"), Fixture::caps());
    assert_eq!(blocked["error"], "unknown");
    assert_eq!(fixture.f.bridge.close().recv_blocking().unwrap(), Ok(()));
    fixture.f.host = NativeHost::open(
        Source {
            profile: fixture.f.path.join("missing-profile"),
            port: fixture.port,
            home: Home {
                daemon_id: "synthetic-daemon".into(),
                lineage_id: "synthetic-lineage".into(),
            },
            project: Some(pilot_day_native::host::Project {
                project_id: "synthetic-project".into(),
                project_path: fixture.f.path.display().to_string(),
            }),
        },
        fixture.f.path.join("journal"),
    )
    .unwrap();
    fixture.f.bridge = Bridge::new(DayRoot::new(fixture.f.host.clone()));
    let _ = fixture.f.host.read_planning_inventory().recv_blocking();
    fixture.wait(|p| p.availability == PlanAvailability::Live);
    let checked = fixture.f.run(
        &format!("return await call('day.feedback.check', {{operationId:'{id}'}});"),
        Fixture::caps(),
    );
    assert_eq!(checked["value"]["outcome"]["state"], "accepted");
    assert_eq!(checked["value"]["operations"], json!([]));
    assert_eq!(
        checked["value"]["outcome"]["receipt"]["result"]["text"],
        "Restart, not navigation 日本語"
    );
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.feedback_posts, 1);
    assert_eq!(state.feedback_lookups, 1);
}

#[test]
fn feedback_cache_reads_do_not_get_or_write_and_follow_daemon_events() {
    let fixture = InventoryFixture::new();
    let first = fixture
        .f
        .run("return await call('day.feedback.read');", Fixture::caps());
    assert_eq!(first["value"]["snapshot"]["items"], json!([]));
    let requests = fixture.state.lock().unwrap().requests;
    let journal = std::fs::read(fixture.f.path.join("journal")).unwrap();
    let replies = fixture.f.run("const replies=[]; for(let i=0;i<10;i++) replies.push(await call('day.feedback.read',{cached:true})); return replies;", Fixture::caps());
    for reply in replies.as_array().unwrap() {
        assert_eq!(reply["value"]["snapshot"], first["value"]["snapshot"]);
    }
    assert_eq!(fixture.state.lock().unwrap().requests, requests);
    assert_eq!(
        std::fs::read(fixture.f.path.join("journal")).unwrap(),
        journal
    );
    fixture.state.lock().unwrap().feedback = json!({"items":[{
        "id":"f1","operationId":"op1","sequence":1,"recordedAt":1,
        "text":"Feedback arrived","origin":null,"work":[]
    }],"more":false,"before":null});
    fixture.invalidate(inventory("Feedback refreshed"));
    fixture.wait(|read| {
        read.plans
            .first()
            .is_some_and(|p| p.title == "Feedback refreshed")
    });
    let requests = fixture.state.lock().unwrap().requests;
    let next = fixture.f.run(
        "return await call('day.feedback.read',{cached:true});",
        Fixture::caps(),
    );
    assert_eq!(
        next["value"]["snapshot"]["items"][0]["text"],
        "Feedback arrived"
    );
    assert_eq!(fixture.state.lock().unwrap().requests, requests);
}

#[test]
fn inventory_capacity_requires_the_exact_typed_status_project_version_and_limit() {
    let fixture = InventoryFixture::new();
    let capacity = json!({"version":1,"code":"planning_inventory_capacity",
        "projectId":"synthetic-project","limit":100,"error":"Planning inventory exceeds limit"});
    let mut cases = vec![
        (503, capacity.clone(), "capacity"),
        (
            503,
            json!({"error":"Planning inventory exceeds limit"}),
            "unavailable",
        ),
        (
            503,
            json!({"error":"Native planning unavailable"}),
            "unavailable",
        ),
        (401, capacity.clone(), "identity"),
        (403, capacity.clone(), "identity"),
        (409, capacity.clone(), "invalid"),
    ];
    for (key, value) in [
        ("version", json!(2)),
        ("code", json!("capacity")),
        ("projectId", json!("another-project")),
        ("limit", json!(101)),
        ("items", json!([])),
        ("total", json!(0)),
    ] {
        let mut bad = capacity.clone();
        bad[key] = value;
        cases.push((503, bad, "unavailable"));
    }
    for (status, body, expected) in cases {
        {
            let mut state = fixture.state.lock().unwrap();
            state.inventory_status = status;
            state.inventory = body.clone();
        }
        let result = fixture.f.run(
            "return [await call('day.plan.inventory'),await call('day.plan.inventorySnapshot')];",
            Fixture::caps(),
        );
        assert_eq!(
            result[0],
            json!({"version":1,"error":expected}),
            "HTTP {status}: {body}"
        );
        assert_eq!(
            result[1]["value"]["snapshot"]["availability"],
            "unavailable"
        );
        assert_eq!(result[1]["value"]["snapshot"]["plans"], json!([]));
        assert_eq!(result[1]["value"]["outcome"], Value::Null);
    }
}
impl Drop for InventoryFixture {
    fn drop(&mut self) {
        assert_eq!(self.f.bridge.close().recv_blocking().unwrap(), Ok(()));
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        self.thread.take().unwrap().join().unwrap();
    }
}

#[test]
fn inventory_snapshot_has_no_get_or_journal_effect_and_observes_native_ws_refresh() {
    let fixture = InventoryFixture::new();
    for title in ["First interview", "Refreshed interview"] {
        if title.starts_with("Refreshed") {
            fixture.invalidate(inventory(title));
            fixture.wait(|read| {
                read.availability == PlanAvailability::Live && read.plans[0].title == title
            });
        }
        let requests = fixture.state.lock().unwrap().requests;
        let journal = std::fs::read(fixture.f.path.join("journal")).unwrap();
        let expected = serde_json::to_value(fixture.f.host.planning_inventory_snapshot()).unwrap();
        let result = fixture.f.run("const reads=[]; for(let i=0;i<10;i++) reads.push(await call('day.plan.inventorySnapshot')); return reads;", Fixture::caps());
        for reply in result.as_array().unwrap() {
            assert_eq!(reply["value"]["snapshot"], expected);
            assert_eq!(reply["value"]["outcome"], Value::Null);
            assert_eq!(
                reply["value"]["snapshot"]["plans"][0]["identity"]["interviewRevision"],
                4
            );
            assert_eq!(reply["value"]["snapshot"]["canStart"], false);
        }
        assert_eq!(
            fixture.state.lock().unwrap().requests,
            requests,
            "cache reads must not GET"
        );
        assert_eq!(
            std::fs::read(fixture.f.path.join("journal")).unwrap(),
            journal,
            "cache reads must not journal"
        );
    }
}

#[test]
fn inventory_snapshot_never_blesses_refused_overflow_or_disconnected_reads() {
    let fixture = InventoryFixture::new();
    for bad in [
        json!({"status":"unavailable"}),
        json!({"total":101,"items":[]}),
    ] {
        fixture.invalidate(bad);
        fixture.wait(|read| read.availability == PlanAvailability::Unavailable);
        let result = fixture.snapshot();
        assert_eq!(result["value"]["snapshot"]["availability"], "unavailable");
        assert!(
            !result["value"]["snapshot"]["reason"]
                .as_str()
                .unwrap()
                .is_empty()
        );
        assert_eq!(result["value"]["snapshot"]["canStart"], false);
        assert_eq!(result["value"]["outcome"], Value::Null);
        fixture.invalidate(inventory("Restored"));
        fixture.wait(|read| read.availability == PlanAvailability::Live);
    }
    fixture
        .state
        .lock()
        .unwrap()
        .websocket
        .take()
        .unwrap()
        .shutdown(Shutdown::Both)
        .unwrap();
    fixture.wait(|read| read.availability == PlanAvailability::Stale);
    let result = fixture.snapshot();
    assert_eq!(result["value"]["snapshot"]["availability"], "stale");
    assert_eq!(
        result["value"]["snapshot"]["plans"][0]["title"], "Restored",
        "disconnect keeps the last complete read, explicitly not current"
    );
    assert_eq!(fixture.f.bridge.close().recv_blocking().unwrap(), Ok(()));
    assert_eq!(fixture.f.run("try { await call('day.plan.inventorySnapshot'); return 'unexpected'; } catch(e) { return e.code; }", Fixture::caps()),json!("ERR_NSH_HOST_ERROR"));
}

#[test]
fn complete_rows_survive_sustained_503_and_recover_but_authority_loss_clears_them() {
    let fixture = InventoryFixture::new();
    for _ in 0..3 {
        {
            let mut state = fixture.state.lock().unwrap();
            state.inventory_status = 503;
            state.inventory = json!({"error":"Temporary read failure"});
        }
        let result = fixture.f.run(
            "return [await call('day.plan.inventory'),await call('day.plan.inventorySnapshot')];",
            Fixture::caps(),
        );
        assert_eq!(result[0]["error"], "unavailable");
        assert_eq!(result[1]["value"]["snapshot"]["availability"], "stale");
        assert_eq!(
            result[1]["value"]["snapshot"]["plans"][0]["title"],
            "First interview"
        );
        assert_eq!(result[1]["value"]["snapshot"]["canStart"], false);
    }
    {
        let mut state = fixture.state.lock().unwrap();
        state.inventory_status = 200;
        state.inventory = inventory("Recovered");
    }
    let recovered = fixture
        .f
        .run("return await call('day.plan.inventory');", Fixture::caps());
    assert_eq!(recovered["value"]["snapshot"]["availability"], "live");
    assert_eq!(
        recovered["value"]["snapshot"]["plans"][0]["title"],
        "Recovered"
    );
    fixture.state.lock().unwrap().inventory_status = 403;
    let denied = fixture.f.run(
        "return [await call('day.plan.inventory'),await call('day.plan.inventorySnapshot')];",
        Fixture::caps(),
    );
    assert_eq!(denied[0]["error"], "identity");
    assert_eq!(
        denied[1]["value"]["snapshot"]["availability"],
        "unavailable"
    );
    assert_eq!(denied[1]["value"]["snapshot"]["plans"], json!([]));
}
