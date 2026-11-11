//! The connected entry's update page and saved view, on the released host
//! channel with the bridge's exact method names. A scripted root answers
//! with native-shaped values (the real `ServiceView` and `Today` types), so
//! these check what the screen says about each native state, what it sends,
//! and what a flush and a cold restore carry. No daemon, updater, service or
//! visible window: the native updater's own rules are in `update_host.rs`.
use nsh_core::prelude::*;
use nsh_engine::{EngineConfig, HostCall, HostChannel};
use nsh_testing::{Headless, compile_tsx};
use pilot_day_native::{
    bridge::{METHODS, restrict},
    desk::Desk,
    model::Scenario,
    update::{
        Confirmation, PlaceKind, Restore, SavedView, ServiceState, ServiceView, UpdateKind,
        UpdateOffer, UpdatePhase, UpdateRun,
    },
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

const WAIT: Duration = Duration::from_secs(60);
const WINDOW: &str = "update-window";

/// A copy of the app's sources whose `nsh.json` declares the bridge's exact
/// method names, and nothing else.
fn entry() -> PathBuf {
    let app = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let dir = std::env::temp_dir().join(format!("day-connected-update-{}", uuid::Uuid::new_v4()));
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
        json!({"name":"Pilot","id":"dev.pilot.day","theme":"theme.json","capabilities":{"host":METHODS}})
            .to_string(),
    )
    .unwrap();
    dir.join("Connected.tsx")
}

fn ui_sets() -> Vec<Registry> {
    vec![nsh_base::registry(), pilot_day_native::registry()]
}

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

fn wait(app: &mut Headless, what: &str) {
    app.wait_for_within(what, WAIT)
        .unwrap_or_else(|e| panic!("{what}: {e}\n{:?}", app.screen().texts()));
}

fn has(app: &Headless, selector: &str) -> bool {
    app.screen().matches(selector).unwrap_or(false)
}

/// Runs the app until `done` holds. A root call can land after the last
/// screen change, so this checks between short waits, not only on changes.
fn until(app: &mut Headless, root: &Root, what: &str, done: impl Fn(&Root) -> bool) {
    let deadline = std::time::Instant::now() + WAIT;
    while !done(root) {
        if std::time::Instant::now() > deadline {
            let calls: Vec<String> = root
                .calls
                .lock()
                .unwrap()
                .iter()
                .map(|(n, d)| format!("{n} {}", d["args"]))
                .collect();
            panic!("{what} never happened; calls: {calls:#?}");
        }
        app.wait(Duration::from_millis(50)).unwrap();
    }
}

/// A native root played by the test: exact names, replies the test sets,
/// every call kept. Unset names refuse as unavailable.
struct Root {
    channel: HostChannel,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    replies: Arc<Mutex<BTreeMap<String, Value>>>,
}
fn answer(snapshot: Value) -> Value {
    json!({"version":1,"value":{"snapshot":snapshot,"outcome":null}})
}
impl Root {
    fn new(today: Scenario) -> Self {
        let channel = HostChannel::new();
        channel.set_params(
            serde_json::from_value(json!({"day":{"version":1,"window":WINDOW}})).unwrap(),
        );
        let calls: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
        let replies: Arc<Mutex<BTreeMap<String, Value>>> = Arc::default();
        for &name in METHODS {
            let (calls, replies) = (calls.clone(), replies.clone());
            channel.handle(name, move |call: HostCall| {
                let data = call.data().clone();
                calls.lock().unwrap().push((name.to_owned(), data));
                let reply = replies
                    .lock()
                    .unwrap()
                    .get(name)
                    .cloned()
                    .unwrap_or(json!({"version":1,"error":"unavailable"}));
                call.resolve(reply);
            });
        }
        let root = Self {
            channel,
            calls,
            replies,
        };
        let today = serde_json::to_value(Desk::new(today).today()).unwrap();
        root.reply("day.today.read", today.clone());
        root.reply("day.attention.read", today.clone());
        root.reply("day.attention.draft", today);
        root.reply("day.plan.prepare", Value::Null);
        root
    }
    fn reply(&self, name: &str, snapshot: Value) {
        self.replies
            .lock()
            .unwrap()
            .insert(name.into(), answer(snapshot));
    }
    fn service(&self, name: &str, view: &ServiceView) {
        self.reply(name, serde_json::to_value(view).unwrap());
    }
    fn refuse(&self, name: &str, error: &str) {
        self.replies
            .lock()
            .unwrap()
            .insert(name.into(), json!({"version":1,"error":error}));
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
    fn count(&self, name: &str) -> usize {
        self.args(name).len()
    }
    /// Calls that could change anything outside the window.
    fn effects(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|(n, _)| n.clone())
            .filter(|n| {
                !n.ends_with(".read")
                    && !n.ends_with("Snapshot")
                    && !n.ends_with(".snapshot")
                    && n != "day.ritual.results"
                    && !n.ends_with(".inventory")
                    && n != "day.plan.prepare"
                    && n != "day.update.check"
                    && n != "day.update.restored"
                    && n != "day.flush.ack"
            })
            .collect()
    }
    fn flush(&self, generation: u32) {
        self.channel
            .send(
                "day.flush",
                json!({"version":1,"window":WINDOW,"generation":generation}),
            )
            .unwrap();
    }
}

/// A registered service at 1.0 offering `kind` at 2.0.
fn offering(kind: UpdateKind) -> ServiceView {
    ServiceView {
        revision: 4,
        state: ServiceState::Registered,
        app: "1.0".into(),
        service: "1.0".into(),
        offer: Some(UpdateOffer {
            kind,
            version: "2.0".into(),
            note: "A signed service update is available.".into(),
        }),
        ..ServiceView::default()
    }
}

/// The latest native operation, in `phase`, with the root's own words.
fn ran(kind: UpdateKind, phase: UpdatePhase, message: &str) -> ServiceView {
    ServiceView {
        operation: "op-1".into(),
        revision: 9,
        state: ServiceState::Registered,
        app: "1.0".into(),
        service: "1.0".into(),
        run: Some(UpdateRun {
            kind,
            version: "2.0".into(),
            phase,
            steps: vec![],
            message: message.into(),
            next: if phase == UpdatePhase::Unknown {
                "Check only. This operation will not be sent again.".into()
            } else {
                String::new()
            },
        }),
        ..ServiceView::default()
    }
}

fn open_update(app: &mut Headless, label: &str) {
    wait(app, &format!("role:button[{label}]"));
    app.press(&format!("role:button[{label}]")).unwrap();
    wait(app, "role:button[Back]");
}

#[test]
fn uncounted_agents_say_unknown_and_a_refused_confirmation_changes_nothing() {
    let entry = entry();
    let root = Root::new(Scenario::Quiet);
    let offer = offering(UpdateKind::Service);
    root.service("day.update.read", &offer);
    let mut pending = offer.clone();
    pending.revision = 5;
    pending.pending = Some(Confirmation {
        id: "confirm-1".into(),
        kind: UpdateKind::Service,
        from: "1.0".into(),
        to: "2.0".into(),
        pauses: None,
        keeps: None,
        restarts: false,
    });
    root.service("day.update.prepare", &pending);
    root.refuse("day.update.confirm", "capacity");
    let mut app = open_on(&entry, root.channel.clone());

    open_update(&mut app, "Update ready");
    app.press("id:update-prepare").unwrap();
    wait(&mut app, "Update from 1.0 to 2.0?");
    assert!(app.shows("Pauses working agents at a safe point. Pilot cannot count them yet."));
    assert!(app.shows("Agents you paused stay as you left them."));
    for zero in ["Pauses no agents", "no agents", "Agents keep working"] {
        assert!(!app.shows(zero), "an uncounted pause shows as {zero}");
    }
    assert_eq!(
        root.args("day.update.prepare"),
        vec![json!({"kind":"service","revision":4})]
    );

    // A refusal before anything entered: said as it is, never Unknown.
    app.press("id:update-confirm").unwrap();
    wait(
        &mut app,
        "Where you are is too large to save, so nothing was paused or updated. Your drafts stay as they are.",
    );
    assert!(!app.shows("Update not confirmed"));
    assert!(!has(&app, "id:update-check"));
    assert!(!app.shows("Updated to 2.0"));
    assert_eq!(root.count("day.update.confirm"), 1);
    // The used confirmation is gone and is never sent again.
    assert!(!has(&app, "id:update-confirm"));
    assert_eq!(
        root.args("day.update.confirm")[0]["confirmation"],
        "confirm-1"
    );
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn a_prepared_app_guard_is_not_updated_and_only_check_reads_it() {
    let entry = entry();
    let root = Root::new(Scenario::Quiet);
    let prepared = ran(
        UpdateKind::App,
        UpdatePhase::Unknown,
        "The external app guard is prepared. The app has not been replaced; native handoff is still required.",
    );
    root.service("day.update.read", &prepared);
    root.service("day.update.check", &prepared);
    let mut app = open_on(&entry, root.channel.clone());

    open_update(&mut app, "Update not confirmed");
    assert!(app.shows("Update not confirmed"));
    assert!(app.shows("The external app guard is prepared. The app has not been replaced; native handoff is still required."));
    assert!(app.shows("Check only. This operation will not be sent again."));
    assert!(!app.shows("Updated to 2.0"));
    assert!(!has(&app, "id:update-prepare"));
    app.press("id:update-check").unwrap();
    until(&mut app, &root, "the check", |r| {
        r.count("day.update.check") == 1
    });
    wait(&mut app, "Update not confirmed");
    assert!(!app.shows("Updated to 2.0"));
    assert!(root.effects().is_empty(), "{:?}", root.effects());
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn a_combined_update_the_root_cannot_prepare_stays_unavailable() {
    let entry = entry();
    let root = Root::new(Scenario::Quiet);
    root.service("day.update.read", &offering(UpdateKind::Both));
    root.refuse("day.update.prepare", "unavailable");
    let mut app = open_on(&entry, root.channel.clone());

    open_update(&mut app, "Update ready");
    app.press("id:update-prepare").unwrap();
    wait(
        &mut app,
        "This update is not available here. Nothing was prepared or changed.",
    );
    assert!(!has(&app, "id:update-confirm"));
    assert_eq!(app.screen().enabled("id:update-prepare"), Ok(false));
    assert_eq!(root.count("day.update.prepare"), 1);
    assert_eq!(root.count("day.update.confirm"), 0);
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn only_a_done_run_says_updated() {
    let entry = entry();
    for (phase, message, says, never) in [
        (
            UpdatePhase::Stopped,
            "Not updated. The native identity, signature or service could not be verified.",
            "Not updated",
            "Updated to 2.0",
        ),
        (
            UpdatePhase::Done,
            "The native controller verified the service operation.",
            "Updated to 2.0",
            "Update not confirmed",
        ),
    ] {
        let root = Root::new(Scenario::Quiet);
        root.service("day.update.read", &ran(UpdateKind::Service, phase, message));
        let mut app = open_on(&entry, root.channel.clone());
        wait(&mut app, "role:button[New]");
        // A settled run needs nothing from the user: the top bar offers no page.
        assert!(!has(&app, "id:update-open"));
        drop(app);
        // Its page, opened over the window, says exactly what Rust reported.
        let root = Root::new(Scenario::Quiet);
        let mut view = ran(UpdateKind::Service, phase, message);
        view.offer = offering(UpdateKind::Service).offer;
        root.service("day.update.read", &view);
        let mut app = open_on(&entry, root.channel.clone());
        open_update(&mut app, "Update ready");
        assert!(app.shows(says), "{says}");
        assert!(app.shows(message));
        assert!(!app.shows(never), "{never}");
        drop(app);
    }
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn a_flush_saves_where_the_user_is_exactly_and_answers_only_the_newest_request() {
    let entry = entry();
    let root = Root::new(Scenario::Large);
    let today = Desk::new(Scenario::Large).today().clone();
    let decision = today.decisions[0].id.clone();
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "Say it simpler");
    app.press("Say it simpler").unwrap();
    // A question typed on Today: its draft save is in flight on the flush.
    app.press("Ask a question").unwrap();
    wait(&mut app, "id:question");
    app.type_text("id:question", "Weekends?").unwrap();
    let question = "Weekends? 👩🏽‍💻";
    app.type_text("id:question", " 👩🏽‍💻").unwrap();
    app.scroll("role:button[New]", Points(400.0)).unwrap();

    // Two requests in a row: the older one is replaced, never answered.
    root.flush(6);
    root.flush(7);
    until(&mut app, &root, "the flush answer", |r| {
        r.count("day.flush.ack") >= 1
    });
    app.wait(Duration::from_millis(300)).unwrap();
    let acks = root.args("day.flush.ack");
    assert_eq!(acks.len(), 1, "{acks:?}");
    assert_eq!(acks[0]["generation"], 7);
    let view: SavedView = nsh_core::element::from_json(&acks[0]["view"]).unwrap();
    assert_eq!(view.place, PlaceKind::Today);
    assert_eq!(view.input, format!("question:{decision}"));
    let units = question.encode_utf16().count() as u32;
    assert_eq!(
        (view.start, view.end),
        (units, units),
        "the caret in UTF-16 units"
    );
    assert!(
        view.help.contains(&format!("{decision}/simpler")),
        "{:?}",
        view.help
    );
    assert!(
        view.help.contains(&format!("{decision}/ask")),
        "{:?}",
        view.help
    );
    assert!(view.today_y > 0.0, "Today's scroll offset is kept");
    assert!(
        root.args("day.attention.draft")
            .iter()
            .any(|d| d["question"] == "Weekends?" || d.to_string().contains("Weekends?")),
        "the question was saved to its own store first"
    );
    // Only form saves: nothing answered, submitted, started or updated.
    assert!(
        root.effects().iter().all(|n| n == "day.attention.draft"),
        "{:?}",
        root.effects()
    );
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn a_refused_save_keeps_the_text_and_answers_no_flush() {
    let entry = entry();
    let root = Root::new(Scenario::Decisions);
    root.refuse("day.attention.draft", "storage");
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "Ask a question");
    app.press("Ask a question").unwrap();
    wait(&mut app, "id:question");
    app.type_text("id:question", "What about weekends?")
        .unwrap();
    root.flush(3);
    until(&mut app, &root, "the draft save", |r| {
        r.count("day.attention.draft") >= 1
    });
    app.wait(Duration::from_millis(500)).unwrap();
    assert_eq!(
        root.count("day.flush.ack"),
        0,
        "no flush answer after a refused save"
    );
    assert_eq!(
        app.screen().input_text("id:question"),
        Ok(Some("What about weekends?"))
    );
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn a_cold_restore_shows_the_saved_view_once_and_sends_nothing_else() {
    let entry = entry();
    let today = Desk::new(Scenario::Quiet).today().clone();
    for (view, shows) in [
        (
            SavedView {
                place: PlaceKind::New,
                goal: "Exact 👩🏽‍💻  goal\nkept".into(),
                input: "goal".into(),
                start: 2,
                end: 5,
                ..SavedView::default()
            },
            "id:goal",
        ),
        (
            SavedView {
                place: PlaceKind::Today,
                ritual: "standup".into(),
                date: today.date.clone(),
                today_y: 120.0,
                ..SavedView::default()
            },
            "id:standup-notes",
        ),
    ] {
        let root = Root::new(Scenario::Quiet);
        // The prepared app guard's successor: still not confirmed.
        let mut cold = ran(
            UpdateKind::App,
            UpdatePhase::Unknown,
            "The external app guard is prepared. The app has not been replaced; native handoff is still required.",
        );
        cold.restore = Some(Restore {
            id: "op-1".into(),
            view: view.clone(),
        });
        root.service("day.update.read", &cold);
        // A lost acknowledgement is not sent again and resumes nothing.
        root.refuse("day.update.restored", "unknown");
        let mut app = open_on(&entry, root.channel.clone());
        wait(&mut app, shows);
        if view.place == PlaceKind::New {
            assert_eq!(
                app.screen().input_text("id:goal"),
                Ok(Some(view.goal.as_str()))
            );
        }
        until(&mut app, &root, "the acknowledgement", |r| {
            r.count("day.update.restored") == 1
        });
        app.wait(Duration::from_millis(300)).unwrap();
        assert_eq!(root.args("day.update.restored"), vec![json!({"id":"op-1"})]);
        assert!(root.effects().is_empty(), "{:?}", root.effects());
        assert!(
            !app.shows("Updated to 2.0"),
            "an acknowledgement is not success"
        );
        drop(app);
    }

    // A ritual saved on another day comes back as Today, not as that ritual.
    let root = Root::new(Scenario::Quiet);
    let mut cold = ran(UpdateKind::App, UpdatePhase::Unknown, "Not confirmed.");
    cold.restore = Some(Restore {
        id: "op-1".into(),
        view: SavedView {
            ritual: "start".into(),
            date: "2001-01-01".into(),
            step: 2,
            ..SavedView::default()
        },
    });
    root.service("day.update.read", &cold);
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "role:button[New]");
    until(&mut app, &root, "the acknowledgement", |r| {
        r.count("day.update.restored") == 1
    });
    assert!(!has(&app, "id:standup-notes"));
    assert!(!app.shows("Since you looked"));
    assert!(root.effects().is_empty(), "{:?}", root.effects());
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}
