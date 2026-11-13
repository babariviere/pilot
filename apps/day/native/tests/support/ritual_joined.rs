//! Readable Today over a real native host. Synthetic HTTP only, no Node/provider.
use super::*;
use pilot_day_native::{
    model::FreshnessState,
    ritual::{RitualAvailability, RitualMark},
};
use std::{
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    os::unix::fs::OpenOptionsExt,
    sync::atomic::{AtomicBool, Ordering},
    thread::JoinHandle,
};

struct Joined {
    path: PathBuf,
    entry: PathBuf,
    source: Source,
    clock: Clock,
    host: Option<NativeHost>,
    bridge: Option<Bridge>,
    stopped: Arc<AtomicBool>,
    server: Option<JoinHandle<()>>,
}

impl Joined {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("day-joined-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let project = path.display().to_string();
        let server = std::thread::spawn(move || {
            // Keep upgraded sockets until joined host close. No generated events
            // or provider subprocesses, and writes are forbidden by the fixture.
            let mut sockets = Vec::new();
            for connection in listener.incoming() {
                let mut stream = connection.unwrap();
                if stop.load(Ordering::SeqCst) {
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
                assert!(request.starts_with("GET "), "unexpected effect: {request}");
                let mut key = String::new();
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header == "\r\n" {
                        break;
                    }
                    assert!(!header.is_empty());
                    if let Some((name, value)) = header.split_once(':')
                        && name.eq_ignore_ascii_case("sec-websocket-key")
                    {
                        key = value.trim().into();
                    }
                }
                if request.starts_with("GET /api/ws ") {
                    let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(
                        key.as_bytes(),
                    );
                    write!(stream,"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").unwrap();
                    stream.flush().unwrap();
                    sockets.push(stream);
                    continue;
                }
                let body = if request.starts_with("GET /api/hello ") {
                    json!({"daemonId":"synthetic-daemon","lineageId":"synthetic-lineage","protocolVersion":1,
                        "minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"dayOverview":1}})
                } else if request.starts_with("GET /api/projects/synthetic-project ") || request.starts_with("GET /api/projects/other-project ") {
                    let id = if request.contains("/other-project ") { "other-project" } else { "synthetic-project" };
                    json!({"id":id,"path":project})
                } else if request.contains("/day ") {
                    let id = if request.contains("/other-project/") { "other-project" } else { "synthetic-project" };
                    json!({"version":1,"projectId":id,"observedAt":1,"complete":true,
                        "dashboard":{"projectId":id,"missions":{"total":0,"items":[]},"working":{"total":0,"items":[]}},
                        "reports":[],"controls":[]})
                } else {
                    let body = "{}";
                    write!(stream,"HTTP/1.1 503 Unavailable\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len()).unwrap();
                    continue;
                }.to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len()).unwrap();
                stream.flush().unwrap();
            }
        });
        let mut f = Self {
            entry: entry(),
            source: Source {
                profile: path.join("profile"),
                port,
                home: Home {
                    daemon_id: "synthetic-daemon".into(),
                    lineage_id: "synthetic-lineage".into(),
                },
                project: Some(pilot_day_native::host::Project {
                    project_id: "synthetic-project".into(),
                    project_path: path.display().to_string(),
                }),
            },
            path,
            clock: Arc::new(Mutex::new(Ok(morning()))),
            host: None,
            bridge: None,
            stopped,
            server: Some(server),
        };
        f.credentials();
        f.reopen();
        f
    }
    fn credentials(&self) {
        std::fs::create_dir_all(&self.source.profile).unwrap();
        std::fs::write(
            self.source.profile.join("daemon-id"),
            &self.source.home.daemon_id,
        )
        .unwrap();
        std::fs::write(
            self.source.profile.join("storage-lineage"),
            &self.source.home.lineage_id,
        )
        .unwrap();
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.source.profile.join("github-app-capability"))
            .unwrap();
        write!(file,"{}", json!({"daemonId":self.source.home.daemon_id,"lineageId":self.source.home.lineage_id,"token":"a".repeat(64)})).unwrap();
    }
    fn host(&self) -> &NativeHost {
        self.host.as_ref().unwrap()
    }
    fn bridge(&self) -> &Bridge {
        self.bridge.as_ref().unwrap()
    }
    fn close(&mut self) -> Result<(), Error> {
        let result = self
            .bridge
            .take()
            .map(|b| b.close().recv_blocking().unwrap())
            .unwrap_or(Ok(()));
        self.host = None;
        result
    }
    fn reopen(&mut self) {
        self.close().unwrap();
        let clock = self.clock.clone();
        let host = NativeHost::open_day(
            self.source.clone(),
            self.path.join("journal"),
            DaySource {
                user_id: me(),
                clock: Arc::new(move || clock.lock().unwrap().clone()),
            },
        )
        .unwrap();
        let changes = host.changes();
        // The initial WS handshake advances the generation and triggers its
        // own authoritative read. Join it before requesting another refresh.
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                tokio::time::timeout(WAIT, async {
                    while host.snapshot().freshness.state != FreshnessState::Live {
                        changes.recv().await.unwrap();
                    }
                })
                .await
                .expect("synthetic WS handshake and authoritative refresh joined");
            });
        assert_eq!(host.snapshot().freshness.state, FreshnessState::Live);
        host.refresh().recv_blocking().unwrap().unwrap();
        self.bridge = Some(Bridge::new(DayRoot::new(host.clone())));
        self.host = Some(host);
    }
    fn open(&self) -> Headless {
        open_on(&self.entry, self.bridge().channel())
    }
    fn read_clock(&self) {
        self.host().read_ritual().recv_blocking().unwrap().unwrap();
    }
    fn records(&self) -> Vec<Value> {
        std::fs::read_to_string(self.path.join("journal"))
            .unwrap()
            .lines()
            .filter_map(|s| serde_json::from_str::<Value>(s).ok())
            .filter(|v| v["kind"] == "ritual")
            .collect()
    }
    fn until(&self, app: &mut Headless, what: &str, done: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + WAIT;
        while !done() {
            assert!(
                std::time::Instant::now() < deadline,
                "{what}: {:?}",
                app.screen().texts()
            );
            app.wait(Duration::from_millis(50)).unwrap();
        }
    }
}
impl Drop for Joined {
    fn drop(&mut self) {
        let _ = self.close();
        self.stopped.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.source.port));
        self.server.take().unwrap().join().unwrap();
        let _ = std::fs::remove_dir_all(&self.path);
        let _ = std::fs::remove_dir_all(self.entry.parent().unwrap());
    }
}

#[test]
fn real_connected_today_saves_steps_skip_and_done_across_joined_cold_reopen() {
    let mut f = Joined::new();
    f.read_clock();
    assert!(
        f.records().is_empty(),
        "readable Today and root clock alone are not visits"
    );
    let mut app = f.open();
    wait(&mut app, "id:start-day");
    f.until(&mut app, "displayed visit", || {
        f.host().ritual_snapshot().revision == 1
    });
    assert_eq!(f.records().len(), 1);
    app.press("id:start-day").unwrap();
    wait(&mut app, "Step 1 of 3 · Since you looked");
    app.press("role:button[Next]").unwrap();
    wait(&mut app, "Step 2 of 3 · Needs you");
    f.until(&mut app, "saved step", || {
        f.host().ritual_snapshot().start.step == 1
    });
    let before = f.records().len();
    app.press_key("escape").unwrap();
    wait(&mut app, "id:start-day");
    settle(&mut app);
    assert_eq!(f.records().len(), before, "Escape writes nothing");
    drop(app);
    f.reopen();
    let mut app = f.open();
    wait(&mut app, "id:start-day");
    f.until(&mut app, "reopened visit", || {
        f.host().ritual_snapshot().revision == 3
    });
    assert_eq!(f.host().ritual_snapshot().last_looked_at, "1000");
    app.press("id:start-day").unwrap();
    wait(&mut app, "Step 2 of 3 · Needs you");
    app.press("role:button[Skip for today]").unwrap();
    wait(&mut app, "id:standup");
    assert_eq!(f.host().ritual_snapshot().start.mark, RitualMark::Skipped);
    assert!(!has(&app, "id:start-day"));
    drop(app);
    f.clock.lock().unwrap().as_mut().unwrap().hour = 19;
    f.reopen();
    let mut app = f.open();
    wait(&mut app, "id:end-day");
    app.press("id:end-day").unwrap();
    wait(&mut app, "Wrapping up.");
    app.press("role:button[Close the day]").unwrap();
    wait(&mut app, "Done for today.");
    assert_eq!(f.host().ritual_snapshot().end.mark, RitualMark::Done);
    drop(app);
    f.reopen();
    f.read_clock();
    assert_eq!(f.host().ritual_snapshot().start.mark, RitualMark::Skipped);
    assert_eq!(f.host().ritual_snapshot().end.mark, RitualMark::Done);
}

#[test]
fn real_clock_changes_fence_open_ritual_and_only_focused_today_visits() {
    let f = Joined::new();
    let mut app = f.open();
    wait(&mut app, "id:start-day");
    f.until(&mut app, "initial visit", || {
        f.host().ritual_snapshot().revision == 1
    });
    app.press("id:start-day").unwrap();
    wait(&mut app, "Step 1 of 3 · Since you looked");
    f.clock.lock().unwrap().as_mut().unwrap().date = "2026-11-11".into();
    f.read_clock();
    wait(
        &mut app,
        "The day changed since you opened this, so Pilot saves nothing here. Back to Today shows the new day.",
    );
    app.press("role:button[Skip for today]").unwrap();
    settle(&mut app);
    assert_eq!(
        f.records().len(),
        1,
        "stale ritual and non-Today screen write nothing"
    );
    set_lifecycle(&mut app, Lifecycle::Background);
    app.press_key("escape").unwrap();
    wait(&mut app, "id:start-day");
    settle(&mut app);
    assert_eq!(f.records().len(), 1, "background Today is not a visit");
    set_lifecycle(&mut app, Lifecycle::Active);
    f.until(&mut app, "new focused day visit", || f.records().len() == 2);
    set_lifecycle(&mut app, Lifecycle::Inactive);
    f.clock.lock().unwrap().as_mut().unwrap().time_zone = "America/New_York".into();
    f.read_clock();
    settle(&mut app);
    assert_eq!(f.records().len(), 2, "inactive zone read writes nothing");
    set_lifecycle(&mut app, Lifecycle::Active);
    f.until(&mut app, "zone visit", || f.records().len() == 3);
    *f.clock.lock().unwrap() = Err(Error::Unavailable);
    assert_eq!(
        f.host().read_ritual().recv_blocking().unwrap(),
        Err(Error::Unavailable)
    );
    wait(
        &mut app,
        "Start and end of day are not available: Pilot cannot read the local day here.",
    );
    assert!(!has(&app, "id:start-day"));
    assert_eq!(
        f.host().ritual_snapshot().availability,
        RitualAvailability::Unavailable
    );
    assert_eq!(f.records().len(), 3);
}

#[test]
fn real_lost_save_stays_unknown_without_replay_and_close_reports_failure() {
    let mut f = Joined::new();
    let mut app = f.open();
    wait(&mut app, "id:start-day");
    f.until(&mut app, "visit", || {
        f.host().ritual_snapshot().revision == 1
    });
    app.press("id:start-day").unwrap();
    app.press("role:button[Next]").unwrap();
    wait(&mut app, "Step 2 of 3 · Needs you");
    f.until(&mut app, "step", || {
        f.host().ritual_snapshot().start.step == 1
    });
    // Force the existing journal's uncertain-write path, not a fake bridge ACK.
    std::fs::OpenOptions::new()
        .append(true)
        .open(f.path.join("journal"))
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    let before = std::fs::read(f.path.join("journal")).unwrap();
    app.press("role:button[Skip for today]").unwrap();
    wait(
        &mut app,
        "Pilot could not confirm this was saved. It will not save it again; Read again checks.",
    );
    app.press("role:button[Skip for today]").unwrap();
    settle(&mut app);
    assert_eq!(std::fs::read(f.path.join("journal")).unwrap(), before);
    drop(app);
    assert_eq!(f.close(), Err(Error::Storage));
    f.reopen();
    let mut app = f.open();
    wait(&mut app, "id:start-day");
    app.press("id:start-day").unwrap();
    wait(&mut app, "Step 2 of 3 · Needs you");
    assert_eq!(
        f.host().ritual_snapshot().start.mark,
        RitualMark::Unmarked,
        "lost Skip never replayed"
    );
}

#[test]
fn a_durable_save_with_a_masked_ack_is_never_resent_and_cold_open_reads_it() {
    use pilot_day_native::ritual::{RitualKind, RitualWrite};
    use std::sync::atomic::AtomicUsize;
    let mut f = Joined::new();
    let mut app = f.open();
    wait(&mut app, "id:start-day");
    f.until(&mut app, "visit", || {
        f.host().ritual_snapshot().revision == 1
    });
    app.press("id:start-day").unwrap();
    wait(&mut app, "Step 1 of 3 · Since you looked");
    // Test-only ACK-loss boundary: keep the real bridge for every other call;
    // this one handler sends the same typed write to the real serialized host,
    // then masks its durable ACK. No production fault switch or replay path.
    let sends = Arc::new(AtomicUsize::new(0));
    let count = sends.clone();
    let threads = Arc::new(Mutex::new(Vec::new()));
    let joins = threads.clone();
    let host = f.host().clone();
    let window = f.bridge().window_identity().to_owned();
    f.bridge()
        .channel()
        .handle("day.ritual.save", move |call: HostCall| {
            assert_eq!(call.data()["window"], window);
            assert_eq!(
                count.fetch_add(1, Ordering::SeqCst),
                0,
                "never replay a lost ACK"
            );
            let args = &call.data()["args"];
            assert_eq!(args["ritual"], "start");
            assert_eq!(args["mark"], "skipped");
            let reply = host.save_ritual(RitualWrite {
                context: args["context"].as_str().unwrap().into(),
                revision: args["revision"].as_u64().unwrap().try_into().unwrap(),
                ritual: RitualKind::Start,
                mark: RitualMark::Skipped,
                step: 0,
            });
            joins.lock().unwrap().push(std::thread::spawn(move || {
                reply.recv_blocking().unwrap().unwrap(); // actual append + fsync
                call.resolve(json!({"version":1,"error":"unknown"}));
            }));
        });
    app.press("role:button[Skip for today]").unwrap();
    wait(
        &mut app,
        "Pilot could not confirm this was saved. It will not save it again; Read again checks.",
    );
    app.press("role:button[Skip for today]").unwrap();
    settle(&mut app);
    for thread in threads.lock().unwrap().drain(..) {
        thread.join().unwrap();
    }
    assert_eq!(sends.load(Ordering::SeqCst), 1);
    assert_eq!(f.host().ritual_snapshot().start.mark, RitualMark::Skipped);
    drop(app);
    f.reopen();
    let mut app = f.open();
    wait(&mut app, "id:standup");
    settle(&mut app);
    assert!(!has(&app, "id:start-day"));
    assert_eq!(f.host().ritual_snapshot().start.mark, RitualMark::Skipped);
    assert_eq!(sends.load(Ordering::SeqCst), 1);
}

#[test]
fn replacement_joins_old_root_preserves_project_progress_and_separates_profile() {
    let mut f = Joined::new();
    let mut app = f.open();
    wait(&mut app, "id:start-day");
    f.until(&mut app, "visit", || {
        f.host().ritual_snapshot().revision == 1
    });
    app.press("id:start-day").unwrap();
    app.press("role:button[Next]").unwrap();
    f.until(&mut app, "step", || {
        f.host().ritual_snapshot().start.step == 1
    });
    let old = f.host().clone();
    let old_context = old.ritual_snapshot().context;
    drop(app);
    f.source.project.as_mut().unwrap().project_id = "other-project".into();
    f.reopen();
    f.read_clock();
    assert_eq!(
        old.read_ritual().recv_blocking().unwrap(),
        Err(Error::Closed)
    );
    assert_eq!(
        f.host().ritual_snapshot().start.step,
        1,
        "project switches keep daily identity"
    );
    assert_ne!(f.host().ritual_snapshot().context, old_context);
    f.source.profile = f.path.join("other-profile");
    f.credentials();
    f.reopen();
    let mut app = f.open();
    wait(&mut app, "id:start-day");
    f.until(&mut app, "profile visit", || {
        f.host().ritual_snapshot().revision == 1
    });
    assert_eq!(
        f.host().ritual_snapshot().start.step,
        0,
        "profile cannot adopt old marks"
    );
    assert_eq!(
        f.host().ritual_snapshot().visit,
        pilot_day_native::model::Visit::Unknown
    );
    app.press("id:start-day").unwrap();
    wait(&mut app, "Step 1 of 3 · Since you looked");
}
