//! Released QuickJS/HostChannel fixture, without Node, a live daemon or a window.
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, compile_tsx};
use pilot_day_native::{
    bridge::{Bridge, MAX_REQUEST, METHODS},
    contract::Home,
    host::{NativeHost, Source},
    root::DayRoot,
};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};

struct Fixture {
    path: PathBuf,
    bridge: Bridge,
    host: NativeHost,
}
impl Fixture {
    fn new() -> Self {
        Self::at_port(1)
    }
    fn at_port(port: u16) -> Self {
        let path = std::env::temp_dir().join(format!("day-channel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let host = NativeHost::open(
            Source {
                profile: path.join("missing-profile"),
                port,
                home: Home {
                    daemon_id: "synthetic-daemon".into(),
                    lineage_id: "synthetic-lineage".into(),
                },
                project_id: "synthetic-project".into(),
                project_path: path.display().to_string(),
            },
            path.join("journal"),
        )
        .unwrap();
        Self {
            path,
            bridge: Bridge::new(DayRoot::new(host.clone())),
            host,
        }
    }
    fn app(&self, body: &str, capabilities: Value) -> Headless {
        std::fs::write(
            self.path.join("nsh.json"),
            json!({"name":"Channel fixture","id":"test.day.channel","capabilities":capabilities})
                .to_string(),
        )
        .unwrap();
        let source = format!(
            r#"import {{ mount, signal, Text, host }} from "nsh";
const shown = signal("waiting");
const window = host.params.day.window;
const call = (name, args={{}}, extra={{}}) => host.call(name, {{version:1,window,args,...extra}});
mount(() => <Text>{{shown()}}</Text>);
setTimeout(() => {{ (async () => {{ {body} }})().then(value => shown.set("done:"+JSON.stringify(value)), error => shown.set("failed:"+error.code+":"+error.message)); }},0);
"#
        );
        let file = self.path.join("App.tsx");
        std::fs::write(&file, source).unwrap();
        let bundle = pilot_day_native::bridge::restrict(compile_tsx(file, &[]).unwrap()).unwrap();
        let mut config = EngineConfig::new(bundle);
        config.clock = nsh_engine::Clock::manual(std::time::UNIX_EPOCH);
        config.host = self.bridge.channel();
        Headless::start(config).unwrap()
    }
    fn run(&self, body: &str, capabilities: Value) -> Value {
        let mut app = self.app(body, capabilities);
        app.wait_until("channel reply", Duration::from_secs(10), |s| {
            s.texts()
                .iter()
                .any(|s| s.starts_with("done:") || s.starts_with("failed:"))
        })
        .unwrap();
        let texts = app.screen().texts();
        let text = texts
            .iter()
            .find(|s| s.starts_with("done:"))
            .unwrap_or_else(|| panic!("{texts:?}"));
        serde_json::from_str(text.strip_prefix("done:").unwrap()).unwrap()
    }
    fn caps() -> Value {
        json!({"host":METHODS})
    }
}

#[test]
fn losing_the_engine_does_not_skip_entered_io_or_joined_close() {
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        os::unix::fs::OpenOptionsExt,
        sync::mpsc,
    };
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let f = Fixture::at_port(listener.local_addr().unwrap().port());
    // First let the disconnected synthetic watcher finish. It must not race
    // a second participant onto this deliberately tiny HTTP fixture.
    let changes = f.host.changes();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            while f.host.snapshot().freshness.state != pilot_day_native::FreshnessState::Unavailable
            {
                changes.recv().await.unwrap();
            }
        })
        .await
        .unwrap();
    });
    let profile = f.path.join("missing-profile");
    std::fs::create_dir(&profile).unwrap();
    std::fs::write(profile.join("daemon-id"), "synthetic-daemon").unwrap();
    std::fs::write(profile.join("storage-lineage"), "synthetic-lineage").unwrap();
    let mut capability = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(profile.join("github-app-capability"))
        .unwrap();
    write!(capability,"{}",json!({"daemonId":"synthetic-daemon","lineageId":"synthetic-lineage","token":"a".repeat(64)})).unwrap();
    drop(capability);
    let (entered_tx, entered) = mpsc::channel();
    let engine = f.bridge.channel();
    let (release, release_rx) = mpsc::channel();
    let project_path = f.path.display().to_string();
    let server = std::thread::spawn(move || {
        for n in 0..4 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            let mut length = 0;
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).unwrap();
                if header == "\r\n" {
                    break;
                }
                if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            assert!(length <= 65536);
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let value = if n == 0 || n == 2 {
                assert!(request.starts_with("GET /api/hello "));
                json!({"daemonId":"synthetic-daemon","lineageId":"synthetic-lineage",
                    "protocolVersion":1,"minimumClientProtocolVersion":1,
                    "capabilities":{"nativeAttention":1,"dayOverview":1,"independentExecution":true}})
            } else if n == 1 {
                assert!(request.starts_with("GET /api/projects/synthetic-project "));
                json!({"id":"synthetic-project","path":project_path})
            } else {
                assert!(request.starts_with("POST /api/native-attention "));
                assert_eq!(
                    serde_json::from_slice::<Value>(&body).unwrap()["kind"],
                    "read"
                );
                entered_tx.send(()).unwrap();
                engine.send("fixture.entered", Value::Null).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                json!({"ok":false})
            };
            let body = value.to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",body.len(),body).unwrap();
            stream.flush().unwrap();
        }
    });
    let mut app = f.app(
        "host.on('fixture.entered',()=>shown.set('entered')); shown.set('requesting'); return await call('day.attention.read');",
        Fixture::caps(),
    );
    app.wait_for("requesting").unwrap();
    app.wait_for_within("entered", Duration::from_secs(5))
        .unwrap();
    assert!(
        !app.screen()
            .texts()
            .iter()
            .any(|s| s.starts_with("done:") || s.starts_with("failed:")),
        "request failed before HTTP: {:?}",
        app.screen().texts()
    );
    entered.recv_timeout(Duration::from_secs(1)).unwrap();
    drop(app); // The request has entered native I/O; VM disposal is not cancellation.
    let closed = f.bridge.close();
    assert_eq!(
        closed.try_recv(),
        Err(async_channel::TryRecvError::Empty),
        "close must await entered I/O"
    );
    release.send(()).unwrap();
    assert_eq!(closed.recv_blocking().unwrap(), Ok(()));
    server.join().unwrap();
}
impl Drop for Fixture {
    fn drop(&mut self) {
        assert_eq!(
            self.bridge.close().recv_blocking().unwrap(),
            Ok(()),
            "explicit root close joins"
        );
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[test]
fn a_valid_read_is_projected_without_credential_or_context_injection() {
    let f = Fixture::new();
    let result = f.run("return await call('day.today.read');", Fixture::caps());
    assert_eq!(result["version"], 1);
    assert!(result["value"]["snapshot"]["moving"].is_array(), "{result}");
    let encoded = result.to_string();
    for secret in [
        "missing-profile",
        "synthetic-daemon",
        "synthetic-lineage",
        "synthetic-project",
        f.path.to_str().unwrap(),
    ] {
        assert!(
            !encoded.contains(secret),
            "native selection leaked: {encoded}"
        );
    }
}

#[test]
fn restricting_a_bundle_never_widens_an_existing_native_grant() {
    let mut bundle = nsh_engine::Bundle::source(String::new())
        .with_capabilities_json(Some(&Fixture::caps().to_string()))
        .unwrap();
    bundle.policy.granted = Some(nsh_engine::parse_capabilities("{}").unwrap());
    let bundle = pilot_day_native::bridge::restrict(bundle).unwrap();
    for name in METHODS {
        assert!(!bundle.policy.access().allows_host(name), "widened {name}");
    }
}

#[test]
fn native_invalidations_are_coalesced_until_the_mirror_reads_again() {
    let f = Fixture::new();
    let mut app=f.app(r#"
let events=0;
host.on('day.changed', event => { if(event.window!==window) throw new Error('wrong root'); shown.set('events:'+(++events)); });
host.on('fixture.read', async () => { await call('day.today.read'); shown.set('reset'); });
shown.set('ready');
return await new Promise(()=>{});"#,Fixture::caps());
    // The missing synthetic source fails locally. No daemon or network is used.
    let _ = f.host.refresh().recv_blocking();
    app.wait_for("text:events:1").unwrap();
    for _ in 0..100 {
        let _ = f.host.refresh().recv_blocking();
    }
    app.run_for(Duration::from_millis(20)).unwrap();
    assert!(app.screen().shows("events:1"));
    f.bridge
        .channel()
        .send("fixture.read", Value::Null)
        .unwrap();
    app.wait_for("reset").unwrap();
    let _ = f.host.refresh().recv_blocking();
    app.wait_for("text:events:2").unwrap();
    drop(app);
}

#[test]
fn deny_all_and_exact_names_are_enforced_by_the_released_runtime() {
    let f = Fixture::new();
    let denial = "try { await call('day.today.read'); return 'unexpected'; } catch(e) { return [e.code,e.permission,e.resource]; }";
    assert_eq!(
        f.run(denial, json!({})),
        json!(["ERR_ACCESS_DENIED", "host", "day.today.read"])
    );
    assert_eq!(Fixture::new().run("try { await call('day.today.admin'); return 'unexpected'; } catch(e) { return e.code; }",Fixture::caps()),json!("ERR_ACCESS_DENIED"));
}

#[test]
fn inventory_is_one_exact_passive_method_with_no_selection_or_write_arguments() {
    let f = Fixture::new();
    let result = f.run(r#"return [await call('day.plan.inventory', {missionId:'forged'}), await call('day.today.read')];"#, Fixture::caps());
    assert_eq!(result[0]["error"], "invalid");
    assert!(
        result[1]["value"]["snapshot"].is_object(),
        "invalid inventory arguments do not poison Today"
    );
    assert_eq!(Fixture::new().run("try { await call('day.plan.inventory'); return 'unexpected'; } catch(e) { return e.code; }", json!({})), json!("ERR_ACCESS_DENIED"));
}

#[test]
fn forged_roots_versions_fields_types_and_ids_are_refused_without_poisoning_reads() {
    let f = Fixture::new();
    let foreign = Fixture::new();
    let other = foreign.bridge.channel().params()["day"]["window"]
        .as_str()
        .unwrap()
        .to_owned();
    let body = format!(
        r#"return [
await call('day.today.read',{{}},{{window:{}}}),
await call('day.today.read',{{}},{{version:2}}),
await call('day.today.read',{{}},{{token:'forged'}}),
await call('day.mission.pause',{{missionId:'../forged',revision:1}}),
await call('day.mission.pause',{{missionId:'forged',revision:'1'}}),
await call('day.mission.pause',{{missionId:'forged',revision:1,home:'forged'}}),
await call('day.mission.pause',{{missionId:'forged',revision:1}}),
await call('day.today.read')];"#,
        json!(other)
    );
    let result = f.run(&body, Fixture::caps());
    for (i, error) in [
        "identity", "identity", "invalid", "invalid", "invalid", "invalid", "stale",
    ]
    .iter()
    .enumerate()
    {
        assert_eq!(result[i]["error"], *error, "case {i}: {result}");
    }
    assert!(
        result[7]["value"]["snapshot"].is_object(),
        "errors stay isolated: {result}"
    );
}

#[test]
fn payload_limit_and_post_cannot_admit_an_effect() {
    let f = Fixture::new();
    let body = format!(
        "host.post('day.mission.pause',{{version:1,window,args:{{missionId:'forged',revision:1}}}}); return await call('day.today.read',{{x:'x'.repeat({MAX_REQUEST})}});"
    );
    assert_eq!(f.run(&body, Fixture::caps())["error"], "invalid");
    assert_eq!(
        std::fs::read_to_string(f.path.join("journal")).unwrap(),
        "",
        "no mutation journaled"
    );
}

#[test]
fn flush_needs_current_worker_ack_and_separate_native_capture() {
    let f = Fixture::new();
    let mut app = f.app(
        r#"
const unsolicited = await call('day.flush.ack',{generation:1});
shown.set('ready');
return await new Promise(resolve => host.on('day.flush', async event => {
  const stale = await call('day.flush.ack',{generation:event.generation+1});
  const pause = await call('day.mission.pause',{missionId:'forged',revision:1});
  const ack = await call('day.flush.ack',{generation:event.generation});
  resolve({unsolicited,stale,pause,ack});
}));"#,
        Fixture::caps(),
    );
    app.wait_for("ready").unwrap();
    let generation = f.bridge.request_flush().unwrap();
    assert!(!f.bridge.flush_ready(generation));
    app.wait_until("flush reply", Duration::from_secs(5), |s| {
        s.texts().iter().any(|s| s.starts_with("done:"))
    })
    .unwrap();
    let result: Value = serde_json::from_str(
        app.screen()
            .texts()
            .iter()
            .find(|s| s.starts_with("done:"))
            .unwrap()
            .strip_prefix("done:")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result["unsolicited"]["error"], "stale");
    assert_eq!(result["stale"]["error"], "stale");
    assert_eq!(result["pause"]["error"], "busy");
    assert_eq!(result["ack"]["value"]["snapshot"]["generation"], generation);
    assert!(
        !f.bridge.flush_ready(generation),
        "JS ACK does not prove native preedit capture"
    );
    f.bridge.native_capture_finished(generation).unwrap();
    assert!(f.bridge.flush_ready(generation));
    f.bridge.cancel_flush(generation).unwrap();
    let next = f.bridge.request_flush().unwrap();
    assert_eq!(
        f.bridge.native_capture_finished(generation),
        Err(pilot_day_native::host::Error::Stale)
    );
    assert!(!f.bridge.flush_ready(next));
    drop(app);
}

#[test]
fn disposed_and_partially_loaded_engines_still_require_joined_close() {
    let f = Fixture::new();
    let channel = f.bridge.channel();
    let mut config = EngineConfig::new(nsh_engine::Bundle::source(
        "throw new Error('isolated partial load');".into(),
    ));
    config.host = channel;
    if let Ok(mut app) = Headless::start(config) {
        assert!(
            app.wait_for_within("never", Duration::from_secs(1))
                .is_err()
        );
        drop(app);
    }
    assert_eq!(f.bridge.close().recv_blocking().unwrap(), Ok(()));
    assert_eq!(
        f.bridge.request_flush(),
        Err(pilot_day_native::host::Error::Closed)
    );
    // Fixture Drop joins close a second time. No reload/replay is attempted.
}

#[test]
fn json_projections_round_trip_through_the_existing_exact_js_types() {
    for scenario in [
        pilot_day_native::Scenario::Decisions,
        pilot_day_native::Scenario::Actions,
        pilot_day_native::Scenario::Trouble,
        pilot_day_native::Scenario::Large,
    ] {
        let model = pilot_day_native::desk::Desk::new(scenario).today().clone();
        let value = serde_json::to_value(&model).unwrap();
        let decoded: pilot_day_native::Today = nsh_core::element::from_json(&value).unwrap();
        assert_eq!(decoded, model);
    }
    let planning =
        pilot_day_native::plan_desk::PlanDesk::new(pilot_day_native::plan::PlanScenario::Interview);
    let model = planning.planning().clone();
    let value = serde_json::to_value(&model).unwrap();
    let decoded: pilot_day_native::plan::Planning = nsh_core::element::from_json(&value).unwrap();
    assert_eq!(decoded, model);
}
