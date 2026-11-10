//! The connected entry (`Connected.tsx`) as its native root runs it: the
//! released host channel with exactly the bridge's method names, one
//! `Bridge` over the canonical `DayRoot`, and the joined close after the
//! engine stops. The entry is copied with an `nsh.json` that declares those
//! names, as a packaged connected window would; the default mock app's
//! deny-all `nsh.json` is not changed. Headless, no visible window.
//!
//! The first test needs no daemon: a selection that cannot be read shows its
//! honest state, never mock data, and a flush generation is answered only
//! after the forms saved. The second runs the whole New → questions →
//! saved progress → Submit path against the isolated production daemon with
//! a forked faux kernel (`day-planning-enrollment.ts`, needs the repository's
//! Node dependencies).
use nsh_core::prelude::*;
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, compile_tsx};
use pilot_day_native::{
    bridge::{Bridge, METHODS, restrict},
    contract::Home,
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

const WAIT: Duration = Duration::from_secs(60);

/// A copy of the app's sources whose `nsh.json` declares the bridge's exact
/// method names, and nothing else.
fn entry() -> PathBuf {
    let app = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let dir = std::env::temp_dir().join(format!("day-connected-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    for file in std::fs::read_dir(&app).unwrap() {
        let path = file.unwrap().path();
        let name = path.file_name().unwrap().to_str().unwrap().to_owned();
        if (name.ends_with(".ts") || name.ends_with(".tsx") || name == "theme.json")
            && !name.ends_with(".test.tsx")
        {
            std::fs::copy(&path, dir.join(&name)).unwrap();
        }
    }
    std::fs::write(
        dir.join("nsh.json"),
        json!({"name":"Pilot Day","id":"dev.pilot.day","theme":"theme.json","capabilities":{"host":METHODS}})
            .to_string(),
    )
    .unwrap();
    dir.join("Connected.tsx")
}

fn ui_sets() -> Vec<Registry> {
    vec![nsh_base::registry(), pilot_day_native::registry()]
}

/// One window on `bridge`'s channel, desktop-sized.
fn open(entry: &Path, bridge: &Bridge) -> Headless {
    let bundle = restrict(compile_tsx(entry, &ui_sets()).expect("Connected.tsx builds")).unwrap();
    let config = EngineConfig {
        ui_sets: ui_sets(),
        viewport: Size::new(Points(1100.0), Points(1400.0)),
        host: bridge.channel(),
        ..EngineConfig::new(bundle)
    };
    Headless::start(config).expect("the engine starts")
}

fn block<T>(rx: async_channel::Receiver<Result<T, Error>>) -> Result<T, Error> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async { tokio::time::timeout(WAIT, rx.recv()).await })
        .expect("answered in time")
        .map_err(|_| Error::Unavailable)
        .and_then(|r| r)
}

/// Stops the engine first, then joins the root, as the native owner must.
fn close(app: Headless, bridge: Bridge) {
    drop(app);
    assert_eq!(
        block(bridge.close()),
        Ok(()),
        "close joins entered work and the worker"
    );
}

fn wait(app: &mut Headless, what: &str) {
    app.wait_for_within(what, WAIT)
        .unwrap_or_else(|e| panic!("{what}: {e}\n{:?}", app.screen().texts()));
}

#[test]
fn an_unreadable_service_shows_its_state_and_forms_save_before_close() {
    let dir = std::env::temp_dir().join(format!("day-connected-root-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let host = NativeHost::open(
        Source {
            profile: dir.join("missing-profile"),
            port: 1,
            home: Home {
                daemon_id: "synthetic-daemon".into(),
                lineage_id: "synthetic-lineage".into(),
            },
            project_id: "synthetic-project".into(),
            project_path: dir.display().to_string(),
        },
        dir.join("journal"),
    )
    .unwrap();
    let bridge = Bridge::new(DayRoot::new(host));
    let entry = entry();
    let mut app = open(&entry, &bridge);
    // Today opens on the service's own (unreadable) state, never on examples.
    // "Opening Pilot…" shows until the first read answers.
    wait(&mut app, "role:button[New]");
    for mock in ["Mock data", "Three short things need you."] {
        assert!(!app.shows(mock), "{mock} shows on a connected window");
    }
    // The lifecycle owner asks for a flush; the UI answers only after its
    // forms saved, and readiness also needs the native capture.
    let generation = bridge.request_flush().unwrap();
    app.wait_until("forms saved", WAIT, |_| true).unwrap();
    let deadline = std::time::Instant::now() + WAIT;
    while !bridge.flush_ready(generation) {
        if bridge.native_capture_finished(generation).is_err() {
            panic!("flush generation lost");
        }
        assert!(
            std::time::Instant::now() < deadline,
            "UI never acknowledged its saved forms"
        );
        app.wait(Duration::from_millis(50)).unwrap();
    }
    close(app, bridge);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
    let _ = std::fs::remove_dir_all(dir);
}

struct Fixture {
    child: Child,
    input: ChildStdin,
    output: mpsc::Receiver<Value>,
    info: Value,
}
impl Fixture {
    fn new() -> Self {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/daemon/src/fixtures/day-planning-enrollment.ts");
        let mut child = Command::new("node")
            .arg(script)
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
                if let Ok(v) = serde_json::from_str::<Value>(&line)
                    && tx.send(v).is_err()
                {
                    break;
                }
            }
        });
        let info = output.recv_timeout(Duration::from_secs(25)).unwrap();
        Self {
            child,
            input,
            output,
            info,
        }
    }
    fn cmd(&mut self, action: &str, value: bool) -> Value {
        writeln!(self.input, "{}", json!({"action":action,"value":value})).unwrap();
        self.input.flush().unwrap();
        self.output.recv_timeout(Duration::from_secs(25)).unwrap()
    }
    /// The selection the native owner would open, with the model for new
    /// missions. Nothing here comes from TSX.
    fn bridge(&self) -> (NativeHost, Bridge) {
        let source: Source = serde_json::from_value(self.info["source"].clone()).unwrap();
        let ledger = self.info["ledger"].as_str().unwrap().into();
        let host = NativeHost::open_planning(source, ledger, "faux/faux-1".into()).unwrap();
        (host.clone(), Bridge::new(DayRoot::new(host)))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn has(app: &Headless, selector: &str) -> bool {
    app.screen().matches(selector).unwrap_or(false)
}

fn answered(app: &Headless) -> String {
    app.screen()
        .texts()
        .into_iter()
        .find(|t| t.starts_with("Question ") && t.contains(" answered"))
        .unwrap_or_default()
        .to_owned()
}

#[test]
fn new_mission_questions_saved_progress_one_submit_and_the_way_back() {
    let mut f = Fixture::new();
    let entry = entry();
    let (host, bridge) = f.bridge();
    let mut app = open(&entry, &bridge);

    wait(&mut app, "role:button[New]");
    assert!(!app.shows("Mock data"));
    app.press("role:button[New]").unwrap();
    wait(&mut app, "What do you want done?");
    app.type_text("id:goal", "Clarify this exact goal").unwrap();
    app.wait_until("setup ready", WAIT, |s| {
        s.enabled("role:button[Plan a mission]").unwrap_or(false)
    })
    .unwrap();
    assert_eq!(
        f.cmd("stats", false)["posts"],
        0,
        "reading the setup sends nothing"
    );
    app.press("role:button[Plan a mission]").unwrap();

    // The mission exists; its questions are still being written.
    wait(&mut app, "Pilot is planning");
    assert!(
        !has(&app, "id:interview"),
        "preparing is not an empty interview"
    );
    let mission = host.planning_enrollments()[0]["missionId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.cmd("generate", true);
    f.cmd("held", false);
    wait(&mut app, "id:interview");
    assert!(!has(&app, "id:submit"));

    // One answer by key, saved before the window closes.
    app.press_key("1").unwrap();
    app.wait_until("first answer saved", WAIT, |s| {
        s.texts().iter().any(|t| t.contains("· 1 answered"))
    })
    .unwrap();
    app.wait_until("save settles", WAIT, |s| !s.shows("Saving…"))
        .unwrap();
    close(app, bridge);

    // Reopened: the mission is on Today, its overview leads to its planning,
    // and the saved answer is still there. Nothing was resent.
    let posts = f.cmd("stats", false)["posts"].clone();
    let (_, bridge) = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, &format!("id:mission-{mission}"));
    app.press(&format!("id:mission-{mission}")).unwrap();
    wait(&mut app, "id:open-plan");
    app.press("id:open-plan").unwrap();
    wait(&mut app, "id:interview");
    app.wait_until("saved progress", WAIT, |s| {
        s.texts().iter().any(|t| t.contains("· 1 answered"))
    })
    .unwrap();
    assert_eq!(
        f.cmd("stats", false)["posts"],
        posts,
        "reopening sends nothing"
    );

    // Every question by key, then the answers page and the one Submit.
    for _ in 0..40 {
        if app.shows("Check your answers") {
            break;
        }
        let now = answered(&app);
        app.press_key("1").unwrap();
        app.wait_until("pick saved", WAIT, |s| {
            s.texts()
                .iter()
                .any(|t| t.starts_with("Question ") && *t != now)
                || s.shows("Check your answers")
        })
        .unwrap();
        if !app.shows("Check your answers") {
            app.press_key("enter").unwrap();
            app.wait(Duration::from_millis(100)).unwrap();
        }
    }
    wait(&mut app, "Check your answers");
    app.wait_until("every answer saved", WAIT, |s| {
        s.enabled("id:submit").unwrap_or(false)
    })
    .unwrap();
    app.press("id:submit").unwrap();
    app.wait_until("submitted", WAIT, |s| {
        s.shows("Submitted. These answers are fixed.") || s.shows("Earlier interview rounds")
    })
    .unwrap();
    assert!(
        !app.shows("Work started: Done"),
        "submission starts no work"
    );

    // The overview is one step away, and Today one more.
    wait(&mut app, "id:open-overview");
    app.press("id:open-overview").unwrap();
    wait(&mut app, "id:mission-plan");
    app.press("role:button[Back to Today]").unwrap();
    wait(&mut app, &format!("id:mission-{mission}"));
    close(app, bridge);
    f.cmd("close", false);
    assert!(f.child.wait().unwrap().success());
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}
