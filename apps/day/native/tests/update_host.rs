//! Released JSON -> canonical host -> real native lifecycle. Offline only.
//! No signature bypass, fake successful update, launchd call or provider send.
use nsh_core::prelude::*;
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, compile_tsx};
use pilot_day_native::{
    bridge::{Bridge, METHODS},
    contract::Home,
    host::{
        NativeHost, Options, Source,
        updates::{AppTarget, Selection},
    },
    root::DayRoot,
};
use pilot_desktop_updater::{app_update::Connection, coordination::Location, manifest::Trust};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};

struct Fixture {
    path: PathBuf,
    source: Source,
    selection: Selection,
    bridge: Bridge,
    host: NativeHost,
    stop: Arc<AtomicBool>,
    server: Option<JoinHandle<()>>,
}
impl Fixture {
    fn new(fresh: bool) -> Self {
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("day-updates-{}", uuid::Uuid::new_v4()));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .unwrap();
        let profile = path.join("profile");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&profile)
            .unwrap();
        if !fresh {
            std::fs::write(profile.join("daemon-id"), "synthetic-daemon").unwrap();
            std::fs::write(profile.join("storage-lineage"), "synthetic-lineage").unwrap();
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(profile.join("github-app-capability"))
                .unwrap();
            write!(f,"{}",json!({"daemonId":"synthetic-daemon","lineageId":"synthetic-lineage","token":"a".repeat(64)})).unwrap();
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let project = path.display().to_string();
        let server = std::thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(s) => s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::park_timeout(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => panic!("fixture listener: {e}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                assert!(
                    line.starts_with("GET "),
                    "no native/daemon mutation: {line}"
                );
                let hello = line.starts_with("GET /api/hello ");
                let project_read = line.starts_with("GET /api/projects/synthetic-project ");
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                        break;
                    }
                }
                let value = if hello {
                    json!({"daemonId":"synthetic-daemon","lineageId":"synthetic-lineage","protocolVersion":1,
                    "minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"dayOverview":1}})
                } else if project_read {
                    json!({"id":"synthetic-project","path":project})
                } else {
                    json!({})
                };
                let body = value.to_string();
                let status = if hello || project_read {
                    "200 OK"
                } else {
                    "404 Not Found"
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        let source = Source {
            profile: profile.clone(),
            port,
            home: Home {
                daemon_id: "synthetic-daemon".into(),
                lineage_id: "synthetic-lineage".into(),
            },
            project_id: "synthetic-project".into(),
            project_path: path.display().to_string(),
        };
        let selection = Selection {
            connection: Connection::new(
                Location {
                    home: profile,
                    port,
                    policy: Default::default(),
                },
                "synthetic-daemon".into(),
                "synthetic-lineage".into(),
            ),
            trust: Trust {
                repository: "synthetic/offline".into(),
                application_id: "com.example.synthetic.day".into(),
                channel: "desktop-stable".into(),
                current_build: "1.0".into(),
                bundle_name: "Pilot Next.app".into(),
                public_key: [42; 32],
                code_requirement: "identifier com.example.synthetic.day".into(),
            },
            installed: path.join("unpublished.app"),
            capsule: Some(path.join("missing-capsule")),
            binding: Some(json!({})),
            app: Some(AppTarget {
                transaction: path.join("missing-transaction"),
                target: path.join("unpublished.app"),
                build: "2.0".into(),
                source: "a".repeat(40),
            }),
            restore_transaction: None,
        };
        let host = Self::open(&path, &source, &selection);
        let bridge = Bridge::new(DayRoot::new(host.clone()));
        Self {
            path,
            source,
            selection,
            host,
            bridge,
            stop,
            server: Some(server),
        }
    }
    fn open(path: &std::path::Path, source: &Source, selection: &Selection) -> NativeHost {
        NativeHost::open_with_options(
            source.clone(),
            path.join("journal"),
            Options {
                updates: Some(selection.clone()),
                ..Default::default()
            },
        )
        .unwrap()
    }
    fn app(&self, body: &str, caps: Value) -> Headless {
        std::fs::write(
            self.path.join("nsh.json"),
            json!({"name":"Offline updates","id":"test.day.updates","capabilities":caps})
                .to_string(),
        )
        .unwrap();
        let file = self.path.join("App.tsx");
        std::fs::write(&file,format!(r#"import {{mount,signal,Text,host}} from "nsh";
const shown=signal('waiting'); const window=host.params.day.window;
const call=(name,args={{}},extra={{}})=>host.call(name,{{version:1,window,args,...extra}});
mount(()=><Text>{{shown()}}</Text>);
host.on('fixture.flush',async (p)=>{{ const r=await call('day.flush.ack',p); shown.set('done:'+JSON.stringify(r)); }});
host.on('fixture.reset',()=>shown.set('waiting'));
setTimeout(()=>{{(async()=>{{{body}}})().then(v=>shown.set('done:'+JSON.stringify(v)),e=>shown.set('failed:'+e.code));}},0);
"#)).unwrap();
        let mut config = EngineConfig::new(
            pilot_day_native::bridge::restrict(compile_tsx(file, &[]).unwrap()).unwrap(),
        );
        config.clock = nsh_engine::Clock::manual(std::time::UNIX_EPOCH);
        config.host = self.bridge.channel();
        Headless::start(config).unwrap()
    }
    fn result(app: &mut Headless) -> Value {
        app.wait_until("update reply", Duration::from_secs(15), |s| {
            s.texts()
                .iter()
                .any(|s| s.starts_with("done:") || s.starts_with("failed:"))
        })
        .unwrap();
        let screen = app.screen();
        let texts = screen.texts();
        let text = texts
            .iter()
            .find(|s| s.starts_with("done:"))
            .unwrap_or_else(|| panic!("{texts:?}"));
        serde_json::from_str(text.strip_prefix("done:").unwrap()).unwrap()
    }
    fn run(&self, body: &str) -> Value {
        Self::result(&mut self.app(body, json!({"host":METHODS})))
    }
    fn reopen(&mut self) {
        self.bridge.close().recv_blocking().unwrap().unwrap();
        self.host = Self::open(&self.path, &self.source, &self.selection);
        self.bridge = Bridge::new(DayRoot::new(self.host.clone()));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.bridge.close().recv_blocking();
        self.stop.store(true, Ordering::SeqCst);
        if let Some(s) = self.server.take() {
            s.join().unwrap();
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
const VIEW: &str = r#"{place:'new',id:'',update:true,goal:'  unsent 👩🏽‍💻\nexact  ',focused:'decision',questions:['round/question']}"#;

#[component]
fn NativeFeedProbe() -> impl IntoElement {
    let window =
        nsh_core::element::engine_context::<pilot_day_native::bridge::UpdateWindow>().unwrap();
    let status = signal("waiting".to_owned());
    spawn(async move {
        use pilot_day_native::{
            OutcomeStatus, UpdateFeed,
            update::{ConfirmIntent, PrepareIntent, SavedView, UpdateKind},
        };
        let feed = Instance::new(UpdateFeed::from_host(window.as_ref().clone()));
        UpdateFeed::check(feed.clone()).await;
        let revision = feed.with(|f| f.snapshot().revision);
        feed.with_mut(|f| {
            f.prepare(PrepareIntent {
                kind: UpdateKind::App,
                revision,
            })
        });
        UpdateFeed::check(feed.clone()).await; // FIFO barrier after prepare, not a mutation retry
        let confirmation = feed.with(|f| f.snapshot().pending.unwrap().id);
        let result = UpdateFeed::confirm(
            feed.clone(),
            ConfirmIntent {
                confirmation,
                view: SavedView {
                    goal: "native exact form".into(),
                    ..Default::default()
                },
            },
        )
        .await;
        assert_eq!(result.status, OutcomeStatus::Accepted);
        status.set("feed-confirmed".into());
    });
    text(move || status.get())
}

#[test]
fn from_host_confirmation_uses_the_same_gate_and_wakes_the_native_capture_owner() {
    let f = Fixture::new(false);
    let wake = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = wake.clone();
    f.bridge.set_flush_wakeup(Arc::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
    }));
    let mut config = EngineConfig::new(nsh_engine::Root::of::<NativeFeedProbe>());
    config.clock = nsh_engine::Clock::manual(std::time::UNIX_EPOCH);
    config.context = nsh_core::element::EngineContext::default().with(f.bridge.update_window());
    let mut app = Headless::start(config).unwrap();
    app.wait_for("feed-confirmed").unwrap();
    assert!(f.bridge.pending_update().is_some());
    assert_eq!(wake.load(Ordering::SeqCst), 1);
    assert!(
        std::fs::read_to_string(f.path.join("journal"))
            .unwrap()
            .contains("native exact form")
    );
    assert!(!f.source.profile.join(".daemon-upgrade.json").exists());
}

#[test]
fn update_methods_are_exact_capabilities_not_paths_or_grants() {
    let f = Fixture::new(false);
    let mut app = f.app(
        "try {await call('day.update.read');return 'bad'} catch(e){return e.code}",
        json!({}),
    );
    assert_eq!(Fixture::result(&mut app), "ERR_ACCESS_DENIED");
    let r=f.run("return [await call('day.update.read',{path:'/tmp'}),await call('day.update.prepare',{kind:'app',revision:1,pid:1}),await call('day.update.confirm',{confirmation:'forged',view:{}})];");
    for value in r.as_array().unwrap() {
        assert_eq!(value["error"], "invalid");
    }
}

#[test]
fn fresh_profile_registration_is_explicit_and_confirmation_is_one_use() {
    let f = Fixture::new(true);
    let r=f.run(&format!("const read=await call('day.update.read');const p=await call('day.update.prepare',{{kind:'register',revision:read.value.snapshot.revision}});const id=p.value.snapshot.pending.id;return [read,await call('day.update.confirm',{{confirmation:id,view:{VIEW}}}),await call('day.update.confirm',{{confirmation:id,view:{VIEW}}})];"));
    assert_eq!(r[0]["value"]["snapshot"]["state"], "absent");
    assert_eq!(r[1]["value"]["snapshot"]["run"]["phase"], "unknown");
    assert_eq!(r[2]["error"], "stale");
    assert!(
        std::fs::read_dir(&f.source.profile)
            .unwrap()
            .next()
            .is_none(),
        "confirmation cannot register"
    );
}

#[test]
fn capture_and_cold_restore_are_durable_but_never_execution_authority() {
    let mut f = Fixture::new(false);
    let r=f.run(&format!("const p=await call('day.update.prepare',{{kind:'app',revision:1}});const id=p.value.snapshot.pending.id;return await call('day.update.confirm',{{confirmation:id,view:{VIEW}}});"));
    assert!(
        r["value"]["snapshot"]["restore"].is_null(),
        "a live confirmation is not startup restore"
    );
    let operation = r["value"]["snapshot"]["operation"]
        .as_str()
        .unwrap()
        .to_owned();
    f.reopen();
    let first = f.run("return await call('day.update.check');");
    let saved = first["value"]["snapshot"]["restore"].clone();
    assert_eq!(saved["id"], operation);
    assert!(
        saved["view"]["goal"]
            .as_str()
            .unwrap()
            .starts_with("  unsent")
    );
    let bytes = std::fs::read_to_string(f.path.join("journal")).unwrap();
    assert!(bytes.contains("unsent"));
    assert!(!bytes.contains("\"entered\""));
    f.reopen();
    let read = f.run("return await call('day.update.check');");
    assert_eq!(read["value"]["snapshot"]["restore"], saved);
    assert_eq!(read["value"]["snapshot"]["run"]["phase"], "unknown");
    let id = saved["id"].as_str().unwrap();
    let ack = f.run(&format!(
        "return await call('day.update.restored',{{id:'{id}'}});"
    ));
    assert!(ack["value"]["snapshot"]["restore"].is_null());
    assert_eq!(
        f.run(&format!(
            "return await call('day.update.restored',{{id:'{id}'}});"
        ))["error"],
        "stale"
    );
    assert!(
        !std::fs::read_to_string(f.path.join("journal"))
            .unwrap()
            .contains("\"entered\"")
    );
}

#[test]
fn changed_credentials_and_stale_or_cancelled_confirmations_never_enter() {
    let f = Fixture::new(false);
    assert_eq!(
        f.run("return await call('day.update.prepare',{kind:'app',revision:0});")["error"],
        "stale"
    );
    let p = f.run("return await call('day.update.prepare',{kind:'app',revision:1});");
    let id = p["value"]["snapshot"]["pending"]["id"].as_str().unwrap();
    f.run(&format!(
        "return await call('day.update.cancel',{{id:'{id}'}});"
    ));
    assert_eq!(
        f.run(&format!(
            "return await call('day.update.confirm',{{confirmation:'{id}',view:{VIEW}}});"
        ))["error"],
        "stale"
    );
    let p=f.run("const r=await call('day.update.read');return await call('day.update.prepare',{kind:'app',revision:r.value.snapshot.revision});");
    let id = p["value"]["snapshot"]["pending"]["id"].as_str().unwrap();
    let capability = f.source.profile.join("github-app-capability");
    std::fs::write(capability,json!({"daemonId":"synthetic-daemon","lineageId":"synthetic-lineage","token":"b".repeat(64)}).to_string()).unwrap();
    assert_eq!(
        f.run(&format!(
            "return await call('day.update.confirm',{{confirmation:'{id}',view:{VIEW}}});"
        ))["error"],
        "identity"
    );
    assert_eq!(std::fs::metadata(f.path.join("journal")).unwrap().len(), 0);
}

#[test]
fn native_seal_requires_final_view_and_refuses_an_unverified_app_without_daemon_effects() {
    let f = Fixture::new(false);
    let confirmed=f.run(&format!("const p=await call('day.update.prepare',{{kind:'app',revision:1}});return await call('day.update.confirm',{{confirmation:p.value.snapshot.pending.id,view:{VIEW}}});"));
    let id = confirmed["value"]["snapshot"]["operation"]
        .as_str()
        .unwrap();
    let mut app = f.app("return await new Promise(()=>{});", json!({"host":METHODS}));
    let generation = f.bridge.request_flush().unwrap();
    f.bridge.native_capture_finished(generation).unwrap(); // fixture owner, not a VM field
    f.bridge
        .channel()
        .send("fixture.flush", json!({"generation":generation}))
        .unwrap();
    assert_eq!(
        Fixture::result(&mut app)["error"],
        "busy",
        "missing SavedView cannot ACK an update"
    );
    assert!(!f.bridge.flush_ready(generation));
    f.bridge.channel().send("fixture.reset", json!({})).unwrap();
    app.wait_for("waiting").unwrap();
    f.bridge.channel().send("fixture.flush",json!({"generation":generation,"view":{"place":"new","id":"","update":true,"goal":"final exact capture","focused":"","questions":[]}})).unwrap();
    Fixture::result(&mut app);
    assert!(f.bridge.flush_ready(generation));
    let seal = f.bridge.seal_flush(generation).unwrap();
    drop(app);
    let result = f
        .bridge
        .commit_update(id.into(), seal)
        .unwrap()
        .recv_blocking()
        .unwrap()
        .unwrap();
    assert_eq!(result.status, pilot_day_native::OutcomeStatus::Rejected);
    let journal = std::fs::read_to_string(f.path.join("journal")).unwrap();
    assert!(journal.contains("final exact capture"));
    assert!(journal.contains("\"state\":\"stopped\""));
    assert!(!f.source.profile.join(".daemon-upgrade.json").exists());
    assert!(
        f.bridge
            .commit_update(id.into(), seal)
            .unwrap()
            .recv_blocking()
            .unwrap()
            .is_err()
    );
}

#[test]
fn failed_journal_save_consumes_no_native_authority() {
    let f = Fixture::new(false);
    let p = f.run("return await call('day.update.prepare',{kind:'app',revision:1});");
    let id = p["value"]["snapshot"]["pending"]["id"].as_str().unwrap();
    std::fs::write(f.path.join("journal"), "unexpected writer\n").unwrap();
    let r = f.run(&format!(
        "return await call('day.update.confirm',{{confirmation:'{id}',view:{VIEW}}});"
    ));
    assert_eq!(r["error"], "storage");
    assert!(f.bridge.pending_update().is_none());
    assert!(!f.source.profile.join(".daemon-upgrade.json").exists());
}

#[test]
fn a_lost_confirmation_reply_is_only_checked_after_restart() {
    let mut f = Fixture::new(false);
    let body = format!(
        "const p=await call('day.update.prepare',{{kind:'app',revision:1}});void call('day.update.confirm',{{confirmation:p.value.snapshot.pending.id,view:{VIEW}}});shown.set('sent');await new Promise(()=>{{}});"
    );
    let mut app = f.app(&body, json!({"host":METHODS}));
    app.wait_for("sent").unwrap();
    drop(app);
    f.reopen(); // joined old host, including any entered journal work
    let r = f.run("return await call('day.update.check');");
    assert_eq!(r["value"]["snapshot"]["run"]["phase"], "unknown");
    let operation = r["value"]["snapshot"]["operation"].as_str().unwrap();
    let bytes = std::fs::read_to_string(f.path.join("journal")).unwrap();
    assert_eq!(
        bytes
            .lines()
            .filter(|l| l.contains("\"state\":\"capture\""))
            .count(),
        1
    );
    assert_eq!(
        f.run(&format!(
            "return await call('day.update.confirm',{{confirmation:'{operation}',view:{VIEW}}});"
        ))["error"],
        "stale"
    );
    assert!(!f.source.profile.join(".daemon-upgrade.json").exists());
}
