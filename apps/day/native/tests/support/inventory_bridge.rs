//! Synthetic HTTP/WS inventory. No Node, real daemon, provider or visible app.
use super::*;
use pilot_day_native::plan::{PlanAvailability, Planning};
use std::{
    io::{BufRead, BufReader, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
};

struct State {
    inventory: Value,
    inventory_status: u16,
    requests: usize,
    websocket: Option<TcpStream>,
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
            inventory: inventory("First interview"),
            inventory_status: 200,
            requests: 0,
            websocket: None,
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
                assert!(
                    request.starts_with("GET "),
                    "snapshot must not write: {request}"
                );
                let mut key = String::new();
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
                }
                let mut state = data.lock().unwrap();
                state.requests += 1;
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
                let body = if request.starts_with("GET /api/hello ") {
                    json!({"daemonId":"synthetic-daemon","lineageId":"synthetic-lineage","protocolVersion":1,
                        "minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"dayOverview":1}})
                } else if request.starts_with("GET /api/projects/synthetic-project ") {
                    json!({"id":"synthetic-project","path":project})
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
        (401, capacity.clone(), "unavailable"),
        (403, capacity.clone(), "unavailable"),
        (409, capacity.clone(), "unavailable"),
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
    fixture.wait(|read| read.availability == PlanAvailability::Unavailable);
    let result = fixture.snapshot();
    assert_eq!(result["value"]["snapshot"]["availability"], "unavailable");
    assert_eq!(
        result["value"]["snapshot"]["plans"],
        json!([]),
        "stale rows are never presented as current"
    );
    assert_eq!(fixture.f.bridge.close().recv_blocking().unwrap(), Ok(()));
    assert_eq!(fixture.f.run("try { await call('day.plan.inventorySnapshot'); return 'unexpected'; } catch(e) { return e.code; }", Fixture::caps()),json!("ERR_NSH_HOST_ERROR"));
}
