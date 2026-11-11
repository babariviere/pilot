//! Original sources through released NSH, the real native bridge and isolated daemon.
use nsh_core::prelude::*;
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, compile_tsx};
use pilot_day_native::{
    bridge::{Bridge, METHODS, restrict},
    host::{Error, NativeHost, Source},
    root::DayRoot,
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

const WAIT: Duration = Duration::from_secs(30);
struct Fixture {
    child: Child,
    input: ChildStdin,
    output: mpsc::Receiver<Value>,
    info: Value,
    dir: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let mut child = Command::new("node")
            .arg(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../packages/daemon/src/fixtures/day-map-sources.ts"),
            )
            .env_remove("NODE_TEST_CONTEXT")
            .env_remove("PILOT_HOME")
            .env_remove("PILOT_PORT")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Ok(v) = serde_json::from_str(&line) {
                    if tx.send(v).is_err() {
                        break;
                    }
                }
            }
        });
        let info = output.recv_timeout(WAIT).unwrap();
        let dir = std::env::temp_dir().join(format!("day-sources-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let app = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        for file in std::fs::read_dir(app).unwrap() {
            let path = file.unwrap().path();
            let name = path.file_name().unwrap().to_str().unwrap();
            if (name.ends_with(".ts") || name.ends_with(".tsx") || name == "theme.json")
                && !name.ends_with(".test.tsx")
            {
                std::fs::copy(&path, dir.join(name)).unwrap();
            }
        }
        std::fs::write(dir.join("nsh.json"),json!({"name":"Pilot","id":"test.day.sources","theme":"theme.json","capabilities":{"host":METHODS}}).to_string()).unwrap();
        Self {
            child,
            input,
            output,
            info,
            dir,
        }
    }
    fn command(&mut self, action: &str, value: &str) -> Value {
        writeln!(self.input, "{}", json!({"action":action,"value":value})).unwrap();
        self.input.flush().unwrap();
        self.output.recv_timeout(WAIT).unwrap()
    }
    fn bridge(&self) -> Bridge {
        let source: Source = serde_json::from_value(self.info["source"].clone()).unwrap();
        let host = NativeHost::open(source, self.info["ledger"].as_str().unwrap().into()).unwrap();
        let changes = host.changes();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                tokio::time::timeout(WAIT, async {
                    while host.snapshot().freshness.state != pilot_day_native::FreshnessState::Live
                    {
                        changes.recv().await.unwrap();
                    }
                })
                .await
                .unwrap();
            });
        Bridge::new(DayRoot::new(host))
    }
    fn request(&self, kind: &str) -> Value {
        json!({"missionId":self.info["mission"],"planRevision":3,"area":"item",
            "recordId":if kind=="decision" {"choice"} else {"fact"},"kind":kind,"id":self.info[kind]})
    }
    fn read(&self, bridge: &Bridge, request: Value) -> Value {
        let source = format!(
            r#"import {{mount,signal,Text,host}} from "nsh";
const result=signal("waiting"); mount(()=> <Text>{{result()}}</Text>);
setTimeout(()=>{{host.call("day.plan.source",{{version:1,window:host.params.day.window,args:{request}}},{{timeout:0}}).then(r=>result.set("source-result:"+JSON.stringify(r)),e=>result.set("source-result:"+JSON.stringify({{error:String(e)}})));}},0);"#
        );
        let entry = self.dir.join("ReadSource.tsx");
        std::fs::write(&entry, source).unwrap();
        let mut app = open(&entry, bridge);
        app.wait_until("source reply", WAIT, |s| {
            s.texts().iter().any(|s| s.starts_with("source-result:"))
        })
        .unwrap();
        let screen = app.screen();
        let text = screen
            .texts()
            .into_iter()
            .find(|s| s.starts_with("source-result:"))
            .unwrap();
        serde_json::from_str(text.strip_prefix("source-result:").unwrap()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = writeln!(self.input, "{}", json!({"action":"quit"}));
        let _ = self.input.flush();
        // Even a failed test joins its owned fixture process.
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
        if let Some(home) = self.info["source"]["profile"].as_str() {
            let _ = std::fs::remove_dir_all(home);
        }
    }
}
fn open(entry: &Path, bridge: &Bridge) -> Headless {
    let ui_sets = vec![nsh_base::registry(), pilot_day_native::registry()];
    let bundle = restrict(compile_tsx(entry, &ui_sets).unwrap()).unwrap();
    Headless::start(EngineConfig {
        ui_sets,
        viewport: Size::new(Points(1100.0), Points(1800.0)),
        host: bridge.channel(),
        ..EngineConfig::new(bundle)
    })
    .unwrap()
}
fn close(bridge: Bridge) {
    let rx = bridge.close();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            assert_eq!(
                tokio::time::timeout(WAIT, rx.recv()).await.unwrap(),
                Ok(Ok::<_, Error>(()))
            );
        });
}
fn wait(app: &mut Headless, selector: &str) {
    app.wait_for_within(selector, WAIT)
        .unwrap_or_else(|e| panic!("{selector}: {e}\n{:?}", app.screen().texts()));
}

fn flush(app: &mut Headless, bridge: &Bridge) {
    let generation = bridge.request_flush().unwrap();
    let deadline = std::time::Instant::now() + WAIT;
    while !bridge.flush_ready(generation) {
        bridge.native_capture_finished(generation).unwrap();
        assert!(
            std::time::Instant::now() < deadline,
            "forms did not acknowledge their exact close generation"
        );
        app.wait(Duration::from_millis(50)).unwrap();
    }
}

#[test]
fn original_records_and_history_are_exact_passive_and_survive_cold_reopen() {
    let mut f = Fixture::new();
    let bridge = f.bridge();
    let decision = f.read(&bridge, f.request("decision"));
    assert_eq!(
        decision["value"]["snapshot"]["body"], "Use native storage.\nKeep exact 💬 context.",
        "{decision}"
    );
    assert_eq!(decision["value"]["snapshot"]["currentness"], "current");
    let knowledge = f.read(&bridge, f.request("knowledge"));
    assert!(
        knowledge["value"]["snapshot"]["body"]
            .as_str()
            .unwrap()
            .contains("\r\nObserved: exact 💬 bytes.\r\n")
    );
    assert!(
        knowledge["value"]["snapshot"]["check"]
            .as_str()
            .unwrap()
            .starts_with("Not checked")
    );
    f.command("fill-summary", "");
    let outside_summary = f.read(&bridge, f.request("knowledge"));
    assert_eq!(
        outside_summary["value"]["snapshot"]["body"], knowledge["value"]["snapshot"]["body"],
        "exact linked source remains readable beyond the map's 40-entry summary: {outside_summary}"
    );
    f.command("replace", "");
    f.command("append", "");
    let retired = f.read(&bridge, f.request("decision"));
    assert_eq!(
        retired["value"]["snapshot"]["body"],
        decision["value"]["snapshot"]["body"]
    );
    assert_eq!(retired["value"]["snapshot"]["currentness"], "stale");
    assert!(
        retired["value"]["snapshot"]["history"][0]
            .as_str()
            .unwrap()
            .contains("Replaced by Decision")
    );
    let older = f.read(&bridge, f.request("knowledge"));
    assert_eq!(
        older["value"]["snapshot"]["body"],
        knowledge["value"]["snapshot"]["body"]
    );
    assert_eq!(older["value"]["snapshot"]["currentness"], "stale");
    assert!(
        older["value"]["snapshot"]["provenance"]
            .to_string()
            .contains("latest revision 2")
    );
    let mut fog = f.request("knowledge");
    fog["area"] = json!("fog");
    fog["recordId"] = json!("later");
    assert_eq!(
        f.read(&bridge, fog)["value"]["snapshot"]["body"],
        knowledge["value"]["snapshot"]["body"]
    );
    close(bridge);
    f.command("restart", "");
    let bridge = f.bridge();
    assert_eq!(
        f.read(&bridge, f.request("knowledge"))["value"]["snapshot"]["body"],
        knowledge["value"]["snapshot"]["body"]
    );
    let mut wrong = f.request("decision");
    wrong["planRevision"] = json!(2);
    assert_eq!(f.read(&bridge, wrong)["error"], "stale");
    let mut wrong = f.request("decision");
    wrong["id"] = f.info["knowledge"].clone();
    assert_eq!(f.read(&bridge, wrong)["error"], "stale");
    assert_eq!(
        f.command("stats", "")["posts"],
        0,
        "reads create no operation or answer"
    );
    close(bridge);
}

#[test]
fn changed_access_during_canonical_io_refuses_without_leaking_the_body() {
    for (race, kind) in [
        ("leave", "decision"),
        ("project", "decision"),
        ("unlink", "knowledge"),
    ] {
        let mut f = Fixture::new();
        let bridge = f.bridge();
        f.command("race", race);
        let result = f.read(&bridge, f.request(kind));
        assert!(result.get("error").is_some(), "{race}: {result}");
        assert!(
            result.get("value").is_none(),
            "a refused source must redact its body"
        );
        close(bridge);
    }
}

#[test]
fn removed_sources_and_changed_scope_are_unavailable_never_empty_or_accepted() {
    for (action, kind) in [
        ("delete", "decision"),
        ("unlink", "knowledge"),
        ("access", "decision"),
        ("archive", "decision"),
    ] {
        let mut f = Fixture::new();
        let bridge = f.bridge();
        f.command(action, "");
        let result = f.read(&bridge, f.request(kind));
        assert!(result.get("error").is_some(), "{action}: {result}");
        assert!(result.get("value").is_none());
        close(bridge);
    }
}

#[test]
fn the_connected_map_opens_sources_in_place_and_returns_without_losing_its_saved_answer() {
    let mut f = Fixture::new();
    let bridge = f.bridge();
    let mut app = open(&f.dir.join("Connected.tsx"), &bridge);
    let mission = f.info["mission"].as_str().unwrap().to_owned();
    wait(&mut app, &format!("id:plan-{mission}"));
    app.press(&format!("id:plan-{mission}")).unwrap();
    wait(&mut app, "id:map");
    app.press("id:own-outcome").unwrap();
    app.type_text("id:answer-outcome", "Keep exact 💬 draft")
        .unwrap();
    app.press("id:settled-toggle").unwrap();
    app.press("id:explore-choice").unwrap();
    let source = format!(
        "id:source-choice-{} >> role:button",
        f.info["decision"].as_str().unwrap()
    );
    app.press(&source).unwrap();
    wait(&mut app, "Use native storage.\nKeep exact 💬 context.");
    assert!(app.screen().matches("id:interview").unwrap());
    app.press("Back to map").unwrap();
    assert!(app.screen().matches("id:map").unwrap());
    assert!(!app.shows("Use native storage.\nKeep exact 💬 context."));
    assert_eq!(
        app.screen().input_text("id:answer-outcome").unwrap(),
        Some("Keep exact 💬 draft")
    );
    // Ordinary close saves still-debounced text through the real native close
    // handshake. Dropping a test engine alone is not a safe application close.
    flush(&mut app, &bridge);
    drop(app);
    close(bridge);
    f.command("restart", "");
    let bridge = f.bridge();
    let mut app = open(&f.dir.join("Connected.tsx"), &bridge);
    wait(&mut app, &format!("id:plan-{mission}"));
    app.press(&format!("id:plan-{mission}")).unwrap();
    wait(&mut app, "id:interview");
    // The answer is the daemon's saved draft, not a duplicated source tracker.
    assert!(
        app.screen()
            .texts()
            .iter()
            .any(|s| s.contains("Keep exact 💬 draft"))
            || app.screen().input_text("id:answer-outcome").unwrap() == Some("Keep exact 💬 draft")
    );
    drop(app);
    close(bridge);
    assert_eq!(
        f.command("stats", "")["posts"],
        1,
        "only the user's answer save wrote"
    );
}
