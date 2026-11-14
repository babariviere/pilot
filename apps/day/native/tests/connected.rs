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
//! Node dependencies). After the restart, Today lists the saved mission in
//! Planning, and its row opens the same saved interview.
//!
//! The planning-inventory tests play the native root with a scripted channel
//! of the same exact names (no daemon, no `NativeHost`): a read and empty
//! list, refusals that are not an empty list, Read again, invalidations that
//! read only the root's cached list, and a page older than the inventory.
use nsh_core::prelude::*;
use nsh_engine::{EngineConfig, HostCall, HostChannel};
use nsh_testing::{Headless, compile_tsx};
use pilot_day_native::{
    bridge::{Bridge, METHODS, restrict},
    contract::Home,
    desk::Desk,
    host::{Error, NativeHost, Options, Source},
    model::Scenario,
    plan::{PlanAvailability, PlanIdentity, PlanRow, PlanScenario, PlanStage, Planning},
    plan_desk::PlanDesk,
    root::DayRoot,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};

#[path = "support/connection_recovery.rs"]
mod connection_recovery;
#[path = "support/today_refresh.rs"]
mod today_refresh;

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
    std::fs::create_dir(dir.join("icons")).unwrap();
    for icon in std::fs::read_dir(app.join("icons")).unwrap() {
        let icon = icon.unwrap().path();
        if icon.extension().is_some_and(|ext| ext == "svg") {
            std::fs::copy(&icon, dir.join("icons").join(icon.file_name().unwrap())).unwrap();
        }
    }
    std::fs::write(
        dir.join("nsh.json"),
        json!({"name":"Pilot","id":"dev.pilot.day","theme":"theme.json","capabilities":{"host":METHODS}})
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
    open_on(entry, bridge.channel())
}

/// One window on `channel`, under the same exact-name grant as a bridge's.
fn open_on(entry: &Path, channel: HostChannel) -> Headless {
    let bundle = restrict(compile_tsx(entry, &ui_sets()).expect("Connected.tsx builds")).unwrap();
    let config = EngineConfig {
        ui_sets: ui_sets(),
        viewport: Size::new(Points(1100.0), Points(1400.0)),
        host: channel,
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

/// New picks no project. Choose the fixture's only one, as the user does.
/// Choosing only reads its setup.
fn choose_project(app: &mut Headless, f: &Fixture) {
    const PICKER: &str = "label:Project for a new chat";
    let path = f.info["source"]["project_path"].as_str().unwrap();
    let name = Path::new(path).file_name().unwrap().to_str().unwrap();
    app.wait_until("projects listed", WAIT, |s| {
        s.enabled(PICKER).unwrap_or(false)
    })
    .unwrap();
    app.press(PICKER).unwrap();
    app.press(&format!("text:{name}")).unwrap();
}

/// Waits until a new mission's page finished its own first read. A read that
/// lands after the fixture writes the round would show that round at once.
fn first_planning_read(app: &mut Headless) {
    app.wait_until("first planning read", WAIT, |s| {
        s.enabled("label:Read this mission's planning again. This sends nothing.")
            .unwrap_or(false)
    })
    .unwrap();
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
            project: Some(pilot_day_native::host::Project {
                project_id: "synthetic-project".into(),
                project_path: dir.display().to_string(),
            }),
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
        Self::with_args(&[])
    }
    fn with_args(args: &[&str]) -> Self {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/daemon/src/fixtures/day-planning-enrollment.ts");
        let mut child = Command::new("node")
            .arg(script)
            .args(args)
            .env_remove("PILOT_HOME")
            .env_remove("PILOT_PORT")
            .env_remove("NODE_TEST_CONTEXT")
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
        // Same composed host path as the production bootstrap. In particular,
        // New must keep its explicit model when URL/day/update options coexist.
        let host = NativeHost::open_with_options(
            source,
            ledger,
            Options {
                planning_model: Some("faux/faux-1".into()),
                day: Some(pilot_day_native::host::ritual::DaySource::system()),
                ..Default::default()
            },
        )
        .unwrap();
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
    choose_project(&mut app, &f);
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
    first_planning_read(&mut app);
    let mission = host.planning_enrollments()[0]["missionId"]
        .as_str()
        .unwrap()
        .to_owned();
    // This save/reopen test reads after the fixture's durable idle barrier.
    // Keep late terminal notices from racing its first keypress. The joined
    // journey below separately exercises that real stale-event refusal.
    f.cmd("quiet", true);
    f.cmd("generate", true);
    f.cmd("held", false);
    wait(
        &mut app,
        "label:Read this mission's planning again. This sends nothing.",
    );
    app.press("label:Read this mission's planning again. This sends nothing.")
        .unwrap();
    wait(&mut app, "id:interview");
    assert!(!app.screen().enabled("id:submit").unwrap_or(false));

    // One answer by key, saved before the window closes.
    app.press_key("1").unwrap();
    app.wait_until("first answer saved", WAIT, |s| {
        s.texts().iter().any(|t| t.contains("· 1 answered"))
    })
    .unwrap();
    app.wait_until("save settles", WAIT, |s| !s.shows("Saving…"))
        .unwrap();
    let question = answered(&app);
    let generation = bridge.request_flush().unwrap();
    bridge.native_capture_finished(generation).unwrap();
    let deadline = std::time::Instant::now() + WAIT;
    while !bridge.flush_ready(generation) {
        assert!(
            std::time::Instant::now() < deadline,
            "interview capture timed out"
        );
        app.wait(Duration::from_millis(50)).unwrap();
    }
    close(app, bridge);

    // Ordinary startup opens the exact saved interview/question directly.
    // The answer comes from its own store, never from a repeated save/submit.
    let posts = f.cmd("stats", false)["posts"].clone();
    let (_, bridge) = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, "id:interview");
    assert_eq!(answered(&app), question);
    assert_eq!(f.cmd("stats", false)["posts"], posts);
    app.press("label:Pilot. Go to Today").unwrap();
    wait(&mut app, &format!("id:plan-{mission}"));
    assert!(
        !has(&app, "id:planning-off"),
        "a read list is not unavailable"
    );
    assert!(app.shows("Questions for you"));
    app.press(&format!("id:plan-{mission}")).unwrap();
    wait(&mut app, "id:interview");
    app.wait_until("saved progress from Today", WAIT, |s| {
        s.texts().iter().any(|t| t.contains("· 1 answered"))
    })
    .unwrap();
    app.press("label:Pilot. Go to Today").unwrap();
    // The overview leads to the same planning too.
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

    // The saved place is the first, already-answered question. Move forward
    // explicitly; picking its same suggestion again would clear that answer.
    app.press_key("enter").unwrap();
    wait(&mut app, "Question 2 of 2 · 1 answered");
    // Every remaining question by key, then the answers page and the one Submit.
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
    wait(&mut app, "label:Back to Mission overview");
    app.press("label:Back to Mission overview").unwrap();
    wait(&mut app, "id:mission-plan");
    app.press("label:Pilot. Go to Today").unwrap();
    wait(&mut app, &format!("id:mission-{mission}"));
    close(app, bridge);
    f.cmd("close", false);
    assert!(f.child.wait().unwrap().success());
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

/// One supported mission, from an unsent goal through both complete interviews,
/// exact-plan Start and a background report. All presses use the connected UI;
/// the fixture supplies only faux responses and explicit completion barriers.
#[test]
fn core_journey_from_new_to_agreement_start_and_report_survives_reopen() {
    let mut f = Fixture::with_args(&["--journey"]);
    let entry = entry();
    let (host, bridge) = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, "role:button[New]");
    app.press("role:button[New]").unwrap();
    wait(&mut app, "id:goal");
    app.type_text("id:goal", "Check the importer without live effects")
        .unwrap();
    app.press("label:Pilot. Go to Today").unwrap();
    app.press("role:button[New]").unwrap();
    assert_eq!(
        app.screen().input_text("id:goal"),
        Ok(Some("Check the importer without live effects"))
    );
    assert_eq!(f.cmd("stats", false)["posts"], 0);
    choose_project(&mut app, &f);
    app.wait_until("creation ready", WAIT, |s| {
        s.enabled("role:button[Plan a mission]").unwrap_or(false)
    })
    .unwrap();
    app.press("role:button[Plan a mission]").unwrap();
    wait(&mut app, "Pilot is planning");
    first_planning_read(&mut app);
    let mission = host.planning_enrollments()[0]["missionId"]
        .as_str()
        .unwrap()
        .to_owned();
    // Keep the actual terminal hold/idle events until the user has read
    // the complete held round. No sleeps or manufactured worker states.
    f.cmd("hold-events", true);
    f.cmd("generate", true);
    let held = f.cmd("held", false);
    assert!(held["heldEvents"].as_u64().unwrap() > 0);
    wait(
        &mut app,
        "label:Read this mission's planning again. This sends nothing.",
    );
    app.press("label:Read this mission's planning again. This sends nothing.")
        .unwrap();
    wait(&mut app, "Question 1 of 2 · 0 answered");
    app.wait_until("held round read", WAIT, |s| {
        s.enabled("id:choice-outcome-yes").unwrap_or(false)
    })
    .unwrap();
    let before_answer = f.cmd("stats", false)["posts"].clone();
    f.cmd("block-plan-read", true);
    f.cmd("hold-events", false);
    f.cmd("entered", false);
    wait(&mut app, OLDER);
    assert!(!app.screen().enabled("id:choice-outcome-yes").unwrap());
    app.press_key("1").unwrap();
    assert_eq!(
        f.cmd("stats", false)["posts"],
        before_answer,
        "Stale keyboard input sends nothing"
    );
    f.cmd("release", false);
    app.wait_until("fresh after terminal notices", WAIT, |s| {
        !s.shows(OLDER) && s.enabled("id:choice-outcome-yes").unwrap_or(false)
    })
    .unwrap();
    app.press("id:see-all").unwrap();
    wait(&mut app, "id:all-questions");
    app.wait_until("round accepts answers", WAIT, |s| {
        s.enabled("id:choice-outcome-yes").unwrap_or(false)
    })
    .unwrap();
    assert!(!app.screen().enabled("id:submit").unwrap());
    app.type_text("id:answer-outcome", " Exact detail\nkept byte for byte ")
        .unwrap();
    app.press("id:choice-outcome-yes").unwrap();
    wait(&mut app, "1 of 2 answered");
    assert_eq!(
        f.cmd("stats", false)["posts"].as_u64(),
        Some(before_answer.as_u64().unwrap() + 1),
        "One fresh explicit answer, never a write retry"
    );
    app.press("id:see-all").unwrap();
    app.press("label:Pilot. Go to Today").unwrap();
    close(app, bridge);

    // A cold native window reads saved progress, and admits no new work.
    let before = f.cmd("stats", false);
    let (_, bridge) = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, &format!("id:plan-{mission}"));
    app.press(&format!("id:plan-{mission}")).unwrap();
    wait(&mut app, "Question 2 of 2 · 1 answered");
    assert_eq!(f.cmd("stats", false)["posts"], before["posts"]);
    app.press("id:see-all").unwrap();
    wait(&mut app, "id:all-questions");
    assert_eq!(
        app.screen().input_text("id:answer-outcome"),
        Ok(Some(" Exact detail\nkept byte for byte "))
    );
    app.press("id:see-all").unwrap();
    app.press_key("1").unwrap();
    wait(&mut app, "Question 2 of 2 · 2 answered");
    app.press("role:button[Check answers]").unwrap();
    app.wait_until("all answers saved", WAIT, |s| {
        s.enabled("id:submit").unwrap_or(false)
    })
    .unwrap();
    app.press("id:submit").unwrap();

    // The real coordinator proposes the agreement in a NEW complete review.
    wait(&mut app, "The proposed plan");
    wait(&mut app, "Your review");
    f.cmd("held", false);
    assert_eq!(f.cmd("stats", false)["workers"], 1);
    app.press_key("1").unwrap();
    app.press("role:button[Check answers]").unwrap();
    app.wait_until("agreement saved", WAIT, |s| {
        s.enabled("id:submit").unwrap_or(false)
    })
    .unwrap();
    app.press("id:submit").unwrap();
    f.cmd("published", false);
    wait(
        &mut app,
        "Published as 1 tasks. Publication did not start work.",
    );
    assert_eq!(f.cmd("stats", false)["workers"], 1);
    wait(&mut app, "role:button[Start work]");
    app.press("role:button[Start work]").unwrap();
    wait(
        &mut app,
        "Start “Check importer” as one background Build task?",
    );
    f.cmd("lost", true);
    app.press("role:button[Start task]").unwrap();
    wait(&mut app, "role:button[Check Start]");
    assert_eq!(f.cmd("reported", false)["workers"], 2);
    close(app, bridge);

    // Lost ACK stays lookup-only across reopen, despite an existing report.
    let before = f.cmd("stats", false);
    f.cmd("restart", true);
    let (_, bridge) = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, &format!("id:mission-{mission}"));
    app.press(&format!("id:mission-{mission}")).unwrap();
    wait(&mut app, "Offline background worker reported");
    wait(&mut app, "id:open-plan");
    app.press("id:open-plan").unwrap();
    wait(&mut app, "role:button[Check Start]");
    assert!(!has(&app, "role:button[Start work]"));
    assert_eq!(f.cmd("stats", false)["posts"], before["posts"]);
    app.press("role:button[Check Start]").unwrap();
    wait(&mut app, "Work admitted: Done");
    let after = f.cmd("stats", false);
    assert_eq!(after["posts"], before["posts"], "Check never resends Start");
    assert_eq!(after["workers"], 2);
    app.press("label:Back to Mission overview").unwrap();
    wait(&mut app, "Offline background worker reported");
    wait(&mut app, "role:button[Pause mission]");
    app.press("role:button[Pause mission]").unwrap();
    app.press("role:button[Pause]").unwrap();
    wait(&mut app, "Paused. Nothing in it runs until you resume it.");
    let paused = f.cmd("stats", false);
    close(app, bridge);
    let (_, bridge) = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, &format!("id:mission-{mission}"));
    app.press(&format!("id:mission-{mission}")).unwrap();
    wait(&mut app, "Paused. Nothing in it runs until you resume it.");
    assert_eq!(
        f.cmd("stats", false)["posts"],
        paused["posts"],
        "Reopen never resumes work"
    );
    assert_eq!(f.cmd("stats", false)["workers"], 2);
    close(app, bridge);
    f.cmd("close", false);
    assert!(f.child.wait().unwrap().success());
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn a_lost_new_creation_is_checked_after_reopen_and_never_adopts_the_previous_mission() {
    let mut f = Fixture::new();
    let entry = entry();
    let (_, bridge) = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, "role:button[New]");
    app.press("role:button[New]").unwrap();
    app.type_text("id:goal", "First mission").unwrap();
    choose_project(&mut app, &f);
    app.wait_until("setup", WAIT, |s| {
        s.enabled("role:button[Plan a mission]").unwrap_or(false)
    })
    .unwrap();
    app.press("role:button[Plan a mission]").unwrap();
    wait(&mut app, "Pilot is planning");
    f.cmd("generate", true);
    f.cmd("held", false);
    wait(&mut app, "id:interview");
    let first = f.cmd("stats", false)["mission"].clone();
    app.press("label:Pilot. Go to Today").unwrap();
    app.press("role:button[New]").unwrap();
    app.type_text("id:goal", "A different exact goal").unwrap();
    choose_project(&mut app, &f);
    app.wait_until("next setup", WAIT, |s| {
        s.enabled("role:button[Plan a mission]").unwrap_or(false)
    })
    .unwrap();
    f.cmd("lost", true);
    app.press("role:button[Plan a mission]").unwrap();
    wait(&mut app, "role:button[Check creation]");
    assert!(!app.screen().enabled("role:button[Plan a mission]").unwrap());
    let before = f.cmd("held", false);
    let second = before["mission"].as_str().unwrap().to_owned();
    assert_ne!(first, second);
    assert_eq!(before["workers"], 2);
    close(app, bridge);

    let (_, bridge) = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, "role:button[New]");
    app.press("role:button[New]").unwrap();
    wait(&mut app, "role:button[Check creation]");
    assert!(!app.screen().enabled("role:button[Plan a mission]").unwrap());
    assert_eq!(f.cmd("stats", false)["posts"], before["posts"]);
    app.press("role:button[Check creation]").unwrap();
    wait(&mut app, "id:interview");
    wait(&mut app, "A different exact goal");
    let after = f.cmd("stats", false);
    assert_eq!(after["posts"], before["posts"]);
    assert_eq!(after["workers"], 2);
    close(app, bridge);
    f.cmd("close", false);
    assert!(f.child.wait().unwrap().success());
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

/// The fake root's window ID, as a native root would pass it.
const FAKE_WINDOW: &str = "inventory-window";
/// The project the fake root's window acts on.
const FAKE_PROJECT: &str = "fake-project";
/// What the connected adapter says over a planning page older than the latest reads.
const OLDER: &str = "This is an older read. Pilot checks again before it saves anything.";

/// A native root played by the test on the released channel: exact names,
/// replies the test sets, every call kept. Unset names refuse as unavailable.
/// Like the native bridge, it sends one `day.changed` and then holds further
/// notices until the next `day.today.read`, and a service read of the planning
/// list (`day.plan.inventory`) changes the root, so it sends a notice too and
/// becomes the cached list that `day.plan.inventorySnapshot` returns.
struct FakeRoot {
    channel: HostChannel,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    replies: Arc<Mutex<BTreeMap<String, Value>>>,
    by_mission: Arc<Mutex<BTreeMap<(String, String), Value>>>,
    pending: Arc<Mutex<bool>>,
    hold_snapshot: Arc<Mutex<bool>>,
    held_snapshot: Arc<Mutex<Option<(HostCall, Value)>>>,
}
fn answer(snapshot: Value) -> Value {
    json!({"version":1,"value":{"snapshot":snapshot,"outcome":null}})
}
/// Today's scope read of a window bound to one project, as the native root
/// answers it: All projects holds only the window's own project, so Today
/// shows its own sections. The handler copies the asked scope and generation.
fn own_scope() -> Value {
    json!({"version":1,"scope":"all","generation":0,"own":FAKE_PROJECT,
        "catalogComplete":true,"complete":true,"outsideNeedsYou":{"count":0,"complete":true},
        "projects":[{"id":FAKE_PROJECT,"name":"This project","selected":true,"currentness":"live",
            "observedAt":"","needsYou":{"count":0,"complete":true},"today":null,"planning":null,
            "results":null,"canAct":false,"errors":{}}]})
}
impl FakeRoot {
    fn new() -> Self {
        let channel = HostChannel::new();
        channel.set_params(
            serde_json::from_value(json!({"day":{"version":1,"window":FAKE_WINDOW}})).unwrap(),
        );
        let calls: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
        let replies: Arc<Mutex<BTreeMap<String, Value>>> = Arc::default();
        let by_mission: Arc<Mutex<BTreeMap<(String, String), Value>>> = Arc::default();
        let pending: Arc<Mutex<bool>> = Arc::default();
        let hold_snapshot: Arc<Mutex<bool>> = Arc::default();
        let held_snapshot: Arc<Mutex<Option<(HostCall, Value)>>> = Arc::default();
        for &name in METHODS {
            let (calls, replies, by_mission, pending, events) = (
                calls.clone(),
                replies.clone(),
                by_mission.clone(),
                pending.clone(),
                channel.clone(),
            );
            let (hold_snapshot, held_snapshot) = (hold_snapshot.clone(), held_snapshot.clone());
            channel.handle(name, move |call: HostCall| {
                let data = call.data().clone();
                calls.lock().unwrap().push((name.to_owned(), data.clone()));
                if name == "day.today.read" {
                    *pending.lock().unwrap() = false;
                }
                let mission = data["args"]["missionId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                let mut reply = by_mission
                    .lock()
                    .unwrap()
                    .get(&(name.to_owned(), mission))
                    .cloned()
                    .or_else(|| replies.lock().unwrap().get(name).cloned())
                    .unwrap_or(json!({"version":1,"error":"unavailable"}));
                if name == "day.today.scope"
                    && let Some(snapshot) = reply.pointer_mut("/value/snapshot")
                {
                    snapshot["generation"] = data["args"]["generation"].clone();
                    snapshot["scope"] = data["args"]["scope"].clone();
                }
                if name == "day.plan.inventory" {
                    // The root keeps what it read, or nothing current after a refusal.
                    let cached = if reply.get("value").is_some() {
                        reply.clone()
                    } else {
                        answer(not_current())
                    };
                    replies
                        .lock()
                        .unwrap()
                        .insert("day.plan.inventorySnapshot".into(), cached);
                    let mut pending = pending.lock().unwrap();
                    if !*pending {
                        *pending = true;
                        events
                            .send("day.changed", json!({"version":1,"window":FAKE_WINDOW}))
                            .unwrap();
                    }
                }
                if name == "day.plan.snapshot"
                    && std::mem::take(&mut *hold_snapshot.lock().unwrap())
                {
                    *held_snapshot.lock().unwrap() = Some((call, reply));
                } else {
                    call.resolve(reply);
                }
            });
        }
        let root = Self {
            channel,
            calls,
            replies,
            by_mission,
            pending,
            hold_snapshot,
            held_snapshot,
        };
        root.reply(
            "day.today.read",
            serde_json::to_value(Desk::new(Scenario::Quiet).today()).unwrap(),
        );
        root.reply(
            "day.attention.read",
            serde_json::to_value(Desk::new(Scenario::Quiet).today()).unwrap(),
        );
        root.reply("day.plan.prepare", Value::Null);
        root.reply("day.window.read", Value::Null);
        root.reply("day.plan.inventorySnapshot", not_current());
        root.reply("day.today.scope", own_scope());
        root
    }
    fn reply(&self, name: &str, snapshot: Value) {
        self.replies
            .lock()
            .unwrap()
            .insert(name.into(), answer(snapshot));
    }
    /// A reply to `name` for one mission only.
    fn reply_for(&self, name: &str, mission: &str, snapshot: Value) {
        self.by_mission
            .lock()
            .unwrap()
            .insert((name.into(), mission.into()), answer(snapshot));
    }
    fn refuse(&self, name: &str, error: &str) {
        self.replies
            .lock()
            .unwrap()
            .insert(name.into(), json!({"version":1,"error":error}));
    }
    fn count(&self, name: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(n, _)| n == name)
            .count()
    }
    fn args(&self, name: &str) -> Vec<Value> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(n, _)| n == name)
            .map(|(_, data)| data["args"].clone())
            .collect()
    }
    /// A service change the root saw: one invalidation, which carries no data.
    fn changed(&self) {
        *self.pending.lock().unwrap() = true;
        self.channel
            .send("day.changed", json!({"version":1,"window":FAKE_WINDOW}))
            .unwrap();
    }
    /// The lifecycle owner's request to save every form before a close or update.
    fn flush(&self, generation: u32) {
        self.channel
            .send(
                "day.flush",
                json!({"version":1,"window":FAKE_WINDOW,"generation":generation}),
            )
            .unwrap();
    }
}

/// Global startup uses the scope catalog, not the legacy root's own-project setup.
#[test]
fn global_dashboard_opens_without_project_setup_and_refreshes_from_events() {
    let root = FakeRoot::new();
    root.reply(
        "day.today.read",
        serde_json::to_value(Desk::new(Scenario::Unreadable).today()).unwrap(),
    );
    root.reply(
        "day.today.scope",
        json!({"version":1,"scope":"all","generation":0,"catalogComplete":true,"complete":false,
        "outsideNeedsYou":{"count":0,"complete":true},"projects":[{
            "id":"one","name":"One","selected":true,"currentness":"live","observedAt":"",
            "needsYou":{"count":0,"complete":true},"today":Desk::new(Scenario::Quiet).today(),
            "planning":null,"results":null,"errors":{}}]}),
    );
    let entry = entry();
    let mut app = open_on(&entry, root.channel.clone());
    wait(
        &mut app,
        "Across all your projects. Each section names its project.",
    );
    assert!(app.shows("All projects"));
    assert!(app.shows("One"));
    assert!(!app.shows("One · read only here"));
    app.wait(Duration::from_millis(300)).unwrap();
    let before = root.count("day.today.scope");
    root.replies
        .lock()
        .unwrap()
        .get_mut("day.today.scope")
        .unwrap()["value"]["snapshot"]["projects"][0]["name"] = json!("Renamed");
    root.changed();
    wait(&mut app, "Renamed");
    assert!(root.count("day.today.scope") > before);
    for name in [
        "day.plan.create",
        "day.chat.create",
        "day.attention.reply",
        "day.mission.pause",
        "day.mission.resume",
    ] {
        assert_eq!(
            root.count(name),
            0,
            "passive startup/invalidation must not send work"
        );
    }
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

/// A complete, current inventory read, as the root projects it.
fn inventory(rows: Vec<PlanRow>) -> Value {
    serde_json::to_value(Planning {
        availability: PlanAvailability::Live,
        plans: rows,
        ..Planning::default()
    })
    .unwrap()
}

/// The root's cached list after its read was lost: not a list at all.
fn not_current() -> Value {
    serde_json::to_value(Planning {
        availability: PlanAvailability::Unavailable,
        reason: "Planning missions could not be read. Read again; nothing was started.".into(),
        ..Planning::default()
    })
    .unwrap()
}

fn plan_row(id: &str, title: &str, stage: PlanStage, identity: PlanIdentity) -> PlanRow {
    PlanRow {
        mission_id: id.into(),
        title: title.into(),
        stage,
        line: "Interview answers needed".into(),
        needs_you: matches!(stage, PlanStage::Questions | PlanStage::Review),
        identity: Some(identity),
    }
}

/// The mock interview's page as a current root read, and its row's identity.
fn export_page() -> (Value, PlanIdentity) {
    let page = PlanDesk::new(PlanScenario::Interview)
        .page("export")
        .unwrap();
    let interview = page.interview.clone().unwrap();
    let mut value = serde_json::to_value(page).unwrap();
    value["fresh"] = json!(true);
    value["note"] = json!("");
    let identity = PlanIdentity {
        interview_id: interview.id,
        interview_revision: interview.revision,
        plan_revision: None,
    };
    (value, identity)
}

#[test]
fn planning_inventory_is_read_once_and_never_shown_as_empty_when_it_is_not() {
    let entry = entry();

    // A complete empty list: no Planning section at all, and no note.
    let root = FakeRoot::new();
    root.reply("day.plan.inventory", inventory(vec![]));
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "role:button[New]");
    assert!(
        has(&app, "id:planning"),
        "a connected empty list keeps its status location"
    );
    assert!(app.shows("No missions in planning."));
    assert!(!has(&app, "id:planning-off"));
    assert_eq!(
        root.count("day.plan.inventory"),
        1,
        "read once, before Today shows"
    );
    assert_eq!(root.args("day.plan.inventory"), vec![json!({})]);
    drop(app);

    // A refused read is said apart from having none, with no rows.
    let root = FakeRoot::new();
    root.refuse("day.plan.inventory", "unavailable");
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "id:planning-off");
    for text in [
        "Pilot cannot show missions in planning here.",
        "Pilot could not read them.",
        "This is not the same as having none.",
    ] {
        assert!(app.shows(text), "{text}");
    }

    // Read again only reads; overflow and a changed list are their own reasons.
    // Each Read again is one service read, and its own notice brings exactly one
    // cached read: nothing feeds back into another service read.
    app.wait(Duration::from_millis(300)).unwrap();
    for (error, reason) in [
        (
            "capacity",
            "More missions are in planning than one read holds, so Pilot shows none of them.",
        ),
        ("stale", "They changed while Pilot read them."),
        ("offline", "Pilot could not reach its service."),
    ] {
        root.refuse("day.plan.inventory", error);
        let before = root.count("day.plan.inventory");
        let cached = root.count("day.plan.inventorySnapshot");
        app.press("id:planning-off >> Read again").unwrap();
        wait(&mut app, reason);
        app.wait(Duration::from_millis(300)).unwrap();
        assert_eq!(root.count("day.plan.inventory"), before + 1);
        assert_eq!(root.count("day.plan.inventorySnapshot"), cached + 1);
        assert!(
            app.shows(reason),
            "the cached read keeps the reason: {reason}"
        );
        assert!(has(&app, "id:planning-off"));
    }

    // A complete list: those waiting for the user first, each with its stage.
    let (_, identity) = export_page();
    root.reply(
        "day.plan.inventory",
        inventory(vec![
            plan_row(
                "published",
                "Published plan",
                PlanStage::Published,
                identity.clone(),
            ),
            plan_row(
                "export",
                "Export a chat as Markdown",
                PlanStage::Questions,
                identity.clone(),
            ),
        ]),
    );
    app.press("id:planning-off >> Read again").unwrap();
    wait(&mut app, "id:plan-export");
    assert!(!has(&app, "id:planning-off"));
    let texts = app
        .screen()
        .texts()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let at = |t: &str| texts.iter().position(|x| x == t).unwrap();
    assert!(
        at("Export a chat as Markdown") < at("Published plan"),
        "needs you first"
    );
    assert!(app.shows("Questions for you"));

    // An invalidation reads only the root's cached list: never a new service read.
    app.wait(Duration::from_millis(300)).unwrap();
    let reads = root.count("day.plan.inventory");
    let cached = root.count("day.plan.inventorySnapshot");
    root.reply("day.plan.inventorySnapshot", not_current());
    root.changed();
    wait(&mut app, "id:planning-off");
    assert!(
        !has(&app, "id:plan-export"),
        "a list that is not current shows no rows"
    );
    assert!(app.shows("Pilot could not read them."));
    root.reply(
        "day.plan.inventorySnapshot",
        inventory(vec![plan_row(
            "export",
            "Export a chat as Markdown",
            PlanStage::Review,
            identity,
        )]),
    );
    root.changed();
    wait(&mut app, "Plan ready for your review");
    assert!(
        !has(&app, "id:plan-published"),
        "a mission that left the list is gone"
    );
    app.wait(Duration::from_millis(300)).unwrap();
    assert_eq!(
        root.count("day.plan.inventory"),
        reads,
        "invalidations never read the service"
    );
    assert_eq!(
        root.count("day.plan.inventorySnapshot"),
        cached + 2,
        "one cached read per invalidation, then quiet"
    );
    assert_eq!(
        root.count("day.plan.snapshot"),
        0,
        "no planning page is open"
    );
    assert!(
        root.args("day.plan.inventorySnapshot")
            .iter()
            .all(|a| *a == json!({}))
    );
    drop(app);

    // When the service changed, reading again cannot help, so it is not offered.
    let root = FakeRoot::new();
    root.refuse("day.plan.inventory", "identity");
    let mut app = open_on(&entry, root.channel.clone());
    wait(
        &mut app,
        "The Pilot service changed. Open Day again to see them.",
    );
    assert!(has(&app, "id:planning-off"));
    assert!(!has(&app, "id:planning-off >> Read again"));
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn a_planning_row_opens_its_exact_interview_and_a_page_older_than_the_list_says_so() {
    let entry = entry();
    let root = FakeRoot::new();
    let (page, identity) = export_page();
    let row = |identity: PlanIdentity| {
        inventory(vec![plan_row(
            "export",
            "Export a chat as Markdown",
            PlanStage::Questions,
            identity,
        )])
    };
    root.reply("day.plan.inventory", row(identity.clone()));
    root.reply("day.plan.inventorySnapshot", row(identity.clone()));
    root.reply("day.plan.read", page.clone());
    root.reply("day.plan.snapshot", page.clone());
    let mut app = open_on(&entry, root.channel.clone());

    // The row opens that mission's own saved interview, read by its exact ID.
    wait(&mut app, "id:plan-export");
    app.press("id:plan-export").unwrap();
    wait(&mut app, "id:interview");
    assert_eq!(
        root.args("day.plan.read"),
        vec![json!({"missionId":"export"})]
    );
    assert!(!app.shows(OLDER), "a page as new as the list is current");

    // A change while the interview is open keeps the place and the words typed.
    app.press("id:own-what").unwrap();
    app.type_text("id:answer-what", "Only the messages")
        .unwrap();
    root.changed();
    app.wait_until("cached reads after the change", WAIT, |_| {
        root.count("day.plan.snapshot") > 0
    })
    .unwrap();
    app.wait(Duration::from_millis(200)).unwrap();
    assert!(
        has(&app, "id:interview"),
        "an invalidation does not navigate"
    );
    assert_eq!(
        app.screen().input_text("id:answer-what"),
        Ok(Some("Only the messages"))
    );
    assert!(!app.shows(OLDER));

    // A failed reopen is stale even without any invalidation or newer row.
    app.press("label:Pilot. Go to Today").unwrap();
    root.refuse("day.plan.read", "unavailable");
    app.press("id:plan-export").unwrap();
    wait(&mut app, OLDER);
    wait(
        &mut app,
        "label:Read this mission's planning again. This sends nothing.",
    );
    assert!(has(&app, "id:choice-what-messages"));
    assert!(
        !app.screen()
            .enabled("id:choice-what-messages")
            .unwrap_or(false)
    );
    root.reply("day.plan.read", page.clone());
    app.press("label:Read this mission's planning again. This sends nothing.")
        .unwrap();
    app.wait_until("fresh read without navigating away", WAIT, |s| {
        !s.shows(OLDER)
    })
    .unwrap();

    // Back on Today, the list names a newer revision and the page cannot be
    // read again: the page shown is older, and says so.
    app.press("label:Pilot. Go to Today").unwrap();
    wait(&mut app, "id:plan-export");
    let newer = PlanIdentity {
        interview_revision: identity.interview_revision + 1,
        ..identity.clone()
    };
    root.reply("day.plan.inventorySnapshot", row(newer.clone()));
    root.refuse("day.plan.snapshot", "stale");
    root.refuse("day.plan.read", "unavailable");
    root.changed();
    app.wait(Duration::from_millis(200)).unwrap();
    app.press("id:plan-export").unwrap();
    wait(&mut app, OLDER);
    wait(
        &mut app,
        "Pilot could not read this mission's planning. What was read before stays on screen.",
    );

    // Read again at the newer revision: current, and the note is gone.
    let mut current = page.clone();
    current["interview"]["revision"] = json!(newer.interview_revision);
    root.reply("day.plan.read", current);
    app.press("label:Pilot. Go to Today").unwrap();
    wait(&mut app, "id:plan-export");
    app.press("id:plan-export").unwrap();
    wait(&mut app, "id:interview");
    app.wait_until("current page", WAIT, |s| !s.shows(OLDER))
        .unwrap();
    assert_eq!(
        root.count("day.plan.inventory"),
        1,
        "navigation reads no new list"
    );
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn a_cached_snapshot_from_before_a_later_notice_cannot_renew_the_interview() {
    let entry = entry();
    let root = FakeRoot::new();
    let (page, identity) = export_page();
    root.reply(
        "day.plan.inventory",
        inventory(vec![plan_row(
            "export",
            "Export",
            PlanStage::Questions,
            identity.clone(),
        )]),
    );
    root.reply(
        "day.plan.inventorySnapshot",
        inventory(vec![plan_row(
            "export",
            "Export",
            PlanStage::Questions,
            identity,
        )]),
    );
    root.reply("day.plan.read", page.clone());
    root.reply("day.plan.snapshot", page.clone());
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "id:plan-export");
    app.press("id:plan-export").unwrap();
    wait(&mut app, "id:interview");
    *root.hold_snapshot.lock().unwrap() = true;
    root.changed();
    let deadline = std::time::Instant::now() + WAIT;
    while root.held_snapshot.lock().unwrap().is_none() {
        assert!(std::time::Instant::now() < deadline);
        app.wait(Duration::from_millis(50)).unwrap();
    }
    let calls = root.count("day.plan.snapshot");
    root.refuse("day.plan.snapshot", "stale");
    let reads = root.count("day.today.read");
    root.changed();
    // The same notice refreshes Today and planning. Once Today's read is
    // asked for, planning knows of the later notice.
    while root.count("day.today.read") <= reads {
        assert!(std::time::Instant::now() < deadline);
        app.wait(Duration::from_millis(50)).unwrap();
    }
    // A notice does not mark the open page older while its read waits (no
    // flicker). The held reply is from before the later notice, so it cannot
    // renew the page; the later read is refused, so the page says it is older.
    let (call, old_reply) = root.held_snapshot.lock().unwrap().take().unwrap();
    call.resolve(old_reply);
    while root.count("day.plan.snapshot") <= calls {
        assert!(std::time::Instant::now() < deadline);
        app.wait(Duration::from_millis(50)).unwrap();
    }
    wait(&mut app, OLDER);
    assert!(app.shows(OLDER));
    assert!(!app.screen().enabled("id:choice-what-messages").unwrap());
    app.press_key("1").unwrap();
    assert_eq!(root.count("day.plan.save"), 0);
    root.reply("day.plan.snapshot", page);
    root.changed();
    app.wait_until("fresh read restores answering", WAIT, |s| {
        !s.shows(OLDER) && s.enabled("id:choice-what-messages").unwrap_or(false)
    })
    .unwrap();
    app.press_key("1").unwrap();
    while root.count("day.plan.save") == 0 {
        assert!(std::time::Instant::now() < deadline);
        app.wait(Duration::from_millis(50)).unwrap();
    }
    assert_eq!(root.count("day.plan.save"), 1);
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn an_unknown_start_without_a_new_page_stays_check_only_after_navigation() {
    let entry = entry();
    let root = FakeRoot::new();
    let (mut page, identity) = export_page();
    page["interview"] = Value::Null;
    page["work"] = json!({"canStart":true,"canCheck":false,"revision":4,"digest":"published","taskId":"task","title":"Check importer","model":"faux/faux-1","project":"Fixture","access":"build","thinking":"off","context":"context","line":""});
    root.reply(
        "day.plan.inventory",
        inventory(vec![plan_row(
            "export",
            "Export",
            PlanStage::Published,
            identity.clone(),
        )]),
    );
    root.reply(
        "day.plan.inventorySnapshot",
        inventory(vec![plan_row(
            "export",
            "Export",
            PlanStage::Published,
            identity,
        )]),
    );
    root.reply("day.plan.read", page.clone());
    root.reply("day.plan.snapshot", page);
    root.replies.lock().unwrap().insert("day.plan.startWork".into(), json!({"version":1,"value":{"snapshot":null,"outcome":{"status":"unknown","revision":1,"message":"Start receipt unavailable"}}}));
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "id:plan-export");
    app.press("id:plan-export").unwrap();
    wait(&mut app, "role:button[Start work]");
    app.press("role:button[Start work]").unwrap();
    app.press("role:button[Start task]").unwrap();
    wait(&mut app, "role:button[Check Start]");
    app.press("label:Pilot. Go to Today").unwrap();
    app.press("id:plan-export").unwrap();
    wait(&mut app, "role:button[Check Start]");
    assert!(!has(&app, "role:button[Start work]"));
    assert_eq!(root.count("day.plan.startWork"), 1);
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn an_answer_saves_to_its_own_mission_after_another_is_opened_and_the_flush_waits_for_it() {
    let entry = entry();
    let root = FakeRoot::new();
    let (first, identity) = export_page();
    let interview = identity.interview_id.clone();
    let mut second = first.clone();
    second["missionId"] = json!("other");
    second["title"] = json!("Another mission");
    second["interview"]["id"] = json!("other-enrollment-1");
    let other = PlanIdentity {
        interview_id: "other-enrollment-1".into(),
        ..identity.clone()
    };
    root.reply(
        "day.plan.inventory",
        inventory(vec![
            plan_row(
                "export",
                "Export a chat as Markdown",
                PlanStage::Questions,
                identity,
            ),
            plan_row("other", "Another mission", PlanStage::Questions, other),
        ]),
    );
    root.reply_for("day.plan.read", "export", first.clone());
    root.reply_for("day.plan.read", "other", second);
    root.refuse("day.plan.save", "unavailable");
    let mut app = open_on(&entry, root.channel.clone());

    // An answer in the first mission whose save is refused: its words wait.
    wait(&mut app, "id:plan-export");
    app.press("id:plan-export").unwrap();
    wait(&mut app, "id:interview");
    app.press("id:own-what").unwrap();
    app.type_text("id:answer-what", "Only the messages")
        .unwrap();
    app.wait_until("the first save", WAIT, |_| root.count("day.plan.save") == 1)
        .unwrap();

    // The user opens another mission from Today.
    app.press("label:Pilot. Go to Today").unwrap();
    wait(&mut app, "id:plan-other");
    app.press("id:plan-other").unwrap();
    wait(&mut app, "id:interview");
    assert!(app.shows("Another mission"));
    assert_eq!(
        root.args("day.plan.read"),
        vec![json!({"missionId":"export"}), json!({"missionId":"other"})]
    );

    // A close or an update asks for every form: the waiting answer still goes
    // to its own mission and round, and only then is the flush answered.
    root.reply("day.plan.save", first);
    root.flush(7);
    app.wait_until("the flush answer", WAIT, |_| {
        root.count("day.flush.ack") == 1
    })
    .unwrap();
    let saves = root.args("day.plan.save");
    assert_eq!(saves.len(), 2, "one refused save, one on the flush");
    for save in &saves {
        assert_eq!(save["missionId"], "export", "never the mission open now");
        assert_eq!(save["intent"]["interviewId"], json!(interview));
        assert_eq!(save["intent"]["text"], "Only the messages");
    }
    let flushes = root.args("day.flush.ack");
    assert_eq!(flushes.len(), 1);
    assert_eq!(flushes[0]["generation"], 7);
    assert_eq!(flushes[0]["view"]["place"], "plan");
    assert_eq!(flushes[0]["view"]["id"], "other");
    assert_eq!(flushes[0]["view"]["questions"], json!(["export-1/what"]));
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}
