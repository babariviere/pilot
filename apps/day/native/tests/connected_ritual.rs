//! The start and end of day on their saved progress, headless, with no
//! visible window, daemon, provider or real app restart.
//!
//! The first tests send the exact ritual calls through one real `Bridge` over
//! a `NativeHost` the test opened with a native clock it controls: reads write
//! nothing, saves and visits need the exact context and revision, a new day,
//! time zone or user fences old intents, a lost write is Unknown and is never
//! resent, and progress survives a cold reopen of the same journal after a
//! joined close.
//!
//! The others run `Connected.tsx` on a root the test plays with the same
//! exact names: one visit only after Today shows, Next and Back saved as the
//! step to resume at, Done and Skip saved, Escape saving nothing, a lost save
//! never resent, a day that changed under an open ritual, and progress that
//! cannot be read said as such.
//! `support/ritual_joined.rs` joins those two sides over a readable synthetic
//! HTTP/WS service: real Connected.tsx, Bridge, host clock and durable journal.
use nsh_core::{platform::Lifecycle, prelude::*};
use nsh_engine::{EngineConfig, HostCall, HostChannel};
use nsh_testing::{Headless, compile_tsx};
use pilot_day_native::{
    bridge::{Bridge, METHODS, restrict},
    contract::Home,
    desk::Desk,
    host::{
        Error, NativeHost, Options, Source,
        ritual::{DaySource, LocalDay},
    },
    model::Scenario,
    root::DayRoot,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

const WAIT: Duration = Duration::from_secs(60);

#[path = "support/ritual_joined.rs"]
mod joined;

// The real root: exact JSON calls on a NativeHost with a test clock.

type Clock = Arc<Mutex<Result<LocalDay, Error>>>;

struct Root {
    path: PathBuf,
    clock: Clock,
    bridge: Option<Bridge>,
}

fn morning() -> LocalDay {
    LocalDay {
        date: "2026-11-10".into(),
        time_zone: "Europe/Paris".into(),
        hour: 9,
        unix_ms: 1_000,
    }
}

fn me() -> u32 {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() }
}

impl Root {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("day-ritual-root-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let mut root = Self {
            path,
            clock: Arc::new(Mutex::new(Ok(morning()))),
            bridge: None,
        };
        root.reopen(Some(me())).unwrap();
        root
    }
    fn source(&self) -> Source {
        Source {
            profile: self.path.join("profile"),
            port: 1,
            home: Home {
                daemon_id: "synthetic-daemon".into(),
                lineage_id: "synthetic-lineage".into(),
            },
            project_id: "synthetic-project".into(),
            project_path: self.path.display().to_string(),
        }
    }
    fn ledger(&self) -> PathBuf {
        self.path.join("journal")
    }
    fn ledger_len(&self) -> u64 {
        std::fs::metadata(self.ledger()).map_or(0, |m| m.len())
    }
    /// Closes the open root (joined), then opens a new one on the same
    /// journal: a cold reopen. `user` None opens it with no clock at all.
    /// Returns the old root's close result.
    fn reopen(&mut self, user: Option<u32>) -> Result<(), Error> {
        let closed = self.close();
        let clock = self.clock.clone();
        let host = NativeHost::open_with_options(
            self.source(),
            self.ledger(),
            Options {
                day: user.map(|user_id| DaySource {
                    user_id,
                    clock: Arc::new(move || clock.lock().unwrap().clone()),
                }),
                ..Options::default()
            },
        )
        .unwrap();
        self.bridge = Some(Bridge::new(DayRoot::new(host)));
        closed
    }
    /// The engine is gone; close fences new calls and joins entered work.
    fn close(&mut self) -> Result<(), Error> {
        match self.bridge.take() {
            Some(bridge) => bridge.close().recv_blocking().unwrap(),
            None => Ok(()),
        }
    }
    fn bridge(&self) -> &Bridge {
        self.bridge.as_ref().unwrap()
    }
    /// Runs `body` in a tiny app on this root's channel and returns its value.
    fn run(&self, body: &str) -> Value {
        let dir = self.path.join(format!("app-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(
            dir.join("nsh.json"),
            json!({"name":"Ritual fixture","id":"test.day.ritual","capabilities":{"host":METHODS}})
                .to_string(),
        )
        .unwrap();
        let source = format!(
            r#"import {{ mount, signal, Text, host }} from "nsh";
const shown = signal("waiting");
const window = host.params.day.window;
const call = (name, args={{}}) => host.call(name, {{version:1,window,args}}, {{timeout:0}});
const view = async () => (await call("day.ritual.snapshot")).value.snapshot;
mount(() => <Text>{{shown()}}</Text>);
setTimeout(() => {{ (async () => {{ {body} }})().then(value => shown.set("done:"+JSON.stringify(value)), error => shown.set("failed:"+error.code+":"+error.message)); }},0);
"#
        );
        let file = dir.join("App.tsx");
        std::fs::write(&file, source).unwrap();
        let bundle = restrict(compile_tsx(file, &[]).unwrap()).unwrap();
        let mut config = EngineConfig::new(bundle);
        config.clock = nsh_engine::Clock::manual(std::time::UNIX_EPOCH);
        config.host = self.bridge().channel();
        let mut app = Headless::start(config).unwrap();
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
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = self.close();
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// One explicit save of the current view's context and revision, in JS.
fn save(ritual: &str, mark: &str, step: u32) -> String {
    format!(
        "const v = await view(); return await call('day.ritual.save', {{context:v.context,revision:v.revision,ritual:'{ritual}',mark:'{mark}',step:{step}}});"
    )
}

#[test]
fn ritual_calls_save_only_explicit_progress_and_it_survives_a_cold_reopen() {
    let mut root = Root::new();
    // Reads sample the clock and write nothing; the cache answers the same.
    let read =
        root.run("return [await call('day.ritual.read'), await call('day.ritual.snapshot')];");
    let first = read[0]["value"]["snapshot"].clone();
    assert_eq!(first["availability"], "available");
    assert_eq!(first["part"], "morning");
    assert_eq!(
        first["visit"], "unknown",
        "no saved visit is not a first visit"
    );
    assert_eq!(first["start"], json!({"mark":"unmarked","step":0}));
    assert_eq!(read[0]["value"]["outcome"]["status"], "accepted");
    assert_eq!(read[1]["value"]["snapshot"], first);
    assert_eq!(read[1]["value"]["outcome"], Value::Null);
    assert_eq!(root.ledger_len(), 0, "a read (or Escape) writes nothing");

    // A resume step and a visit, each against the exact view.
    let step = root.run(&save("start", "unmarked", 1));
    assert_eq!(step["value"]["outcome"]["status"], "accepted");
    assert_eq!(
        step["value"]["snapshot"]["start"],
        json!({"mark":"unmarked","step":1})
    );
    let visit = root.run(
        "const v = await view(); return await call('day.ritual.visit', {context:v.context,revision:v.revision});",
    );
    assert_eq!(visit["value"]["outcome"]["status"], "accepted");
    let written = root.ledger_len();
    assert!(written > 0);

    // An older revision, another context, bad fields or steps: refused, nothing written.
    let refused = root.run(&format!(
        "const v = await view(); return [
            await call('day.ritual.save', {{context:v.context,revision:v.revision-1,ritual:'start',mark:'done',step:2}}),
            await call('day.ritual.save', {{context:'{}',revision:v.revision,ritual:'start',mark:'done',step:2}}),
            await call('day.ritual.save', {{context:v.context,revision:v.revision,ritual:'start',mark:'done',step:33}}),
            await call('day.ritual.save', {{context:v.context,revision:v.revision,ritual:'start',mark:'done',step:2,extra:1}}),
            await call('day.ritual.visit', {{context:'',revision:v.revision}}),
            await call('day.ritual.read', {{context:v.context}}),
        ];",
        uuid::Uuid::new_v4()
    ));
    let codes: Vec<_> = refused
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["error"].clone())
        .collect();
    assert_eq!(
        codes,
        ["stale", "stale", "invalid", "invalid", "invalid", "invalid"].map(Value::from)
    );
    assert_eq!(root.ledger_len(), written);

    // Cold reopen of the same journal after a joined close.
    assert_eq!(root.reopen(Some(me())), Ok(()));
    let again = root.run("return await call('day.ritual.read');")["value"]["snapshot"].clone();
    assert_eq!(
        again["start"],
        json!({"mark":"unmarked","step":1}),
        "a saved step is not Done"
    );
    assert_eq!(again["visit"], "returning");
    assert_eq!(again["lastLookedAt"], "1000");
    assert_ne!(
        again["context"], first["context"],
        "intents of the closed window cannot apply"
    );
    let done = root.run(&save("start", "done", 2));
    assert_eq!(done["value"]["outcome"]["status"], "accepted");
    let skip = root.run(&save("end", "skipped", 0));
    assert_eq!(skip["value"]["outcome"]["status"], "accepted");
    // A final mark stays: a late resume step cannot erase it.
    assert_eq!(root.run(&save("start", "unmarked", 0))["error"], "stale");

    assert_eq!(root.reopen(Some(me())), Ok(()));
    let kept = root.run("return await call('day.ritual.read');")["value"]["snapshot"].clone();
    assert_eq!(kept["start"], json!({"mark":"done","step":2}));
    assert_eq!(kept["end"], json!({"mark":"skipped","step":0}));
    assert_eq!(
        root.close(),
        Ok(()),
        "close joins the worker and the journal"
    );
}

#[test]
fn a_new_day_zone_or_user_fences_old_intents_and_no_clock_is_unavailable() {
    let mut root = Root::new();
    let first = root.run("return await call('day.ritual.read');")["value"]["snapshot"].clone();
    // Another time zone is another day key: the old context is refused.
    root.clock.lock().unwrap().as_mut().unwrap().time_zone = "America/New_York".into();
    let zone = root.run(&format!(
        "await call('day.ritual.read'); const v = await view(); return [v, await call('day.ritual.save', {{context:'{}',revision:v.revision,ritual:'start',mark:'skipped',step:0}})];",
        first["context"].as_str().unwrap()
    ));
    assert_ne!(zone[0]["context"], first["context"]);
    assert_eq!(zone[0]["timeZone"], "America/New_York");
    assert_eq!(zone[1]["error"], "stale");
    // A new date in the evening offers the end of day, unmarked.
    *root.clock.lock().unwrap() = Ok(LocalDay {
        date: "2026-11-11".into(),
        time_zone: "Europe/Paris".into(),
        hour: 19,
        unix_ms: 90_000_000,
    });
    let evening = root.run("return await call('day.ritual.read');")["value"]["snapshot"].clone();
    assert_eq!(evening["part"], "evening");
    assert_eq!(evening["date"], "2026-11-11");
    assert_eq!(evening["end"], json!({"mark":"unmarked","step":0}));
    assert_eq!(root.ledger_len(), 0);

    // The clock cannot be read: unavailable, never a guessed day.
    *root.clock.lock().unwrap() = Err(Error::Unavailable);
    let off = root.run("return [await call('day.ritual.read'), await view()];");
    assert_eq!(off[0]["error"], "unavailable");
    assert_eq!(off[1]["availability"], "unavailable");
    assert_eq!(off[1]["part"], "unknown");

    // Another OS user: refused as identity; Today's read is not failed by it.
    *root.clock.lock().unwrap() = Ok(morning());
    root.reopen(Some(me().wrapping_add(1))).unwrap();
    let other = root
        .run("return [await call('day.ritual.read'), await view(), await call('day.today.read')];");
    assert_eq!(other[0]["error"], "identity");
    assert_eq!(other[1]["availability"], "unavailable");
    assert!(
        other[2]["value"].is_object(),
        "a ritual refusal stays with the ritual: {other}"
    );

    // A root opened without a clock says unavailable.
    root.reopen(None).unwrap();
    let none = root.run("return [await call('day.ritual.read'), await view()];");
    assert_eq!(none[0]["error"], "unavailable");
    assert_eq!(none[1]["availability"], "unavailable");
    assert_eq!(root.ledger_len(), 0);
}

#[test]
fn a_lost_write_is_unknown_never_resent_and_cold_reopen_shows_what_was_saved() {
    let mut root = Root::new();
    root.run("return await call('day.ritual.read');");
    let step = root.run(&save("start", "unmarked", 1));
    assert_eq!(step["value"]["outcome"]["status"], "accepted");
    // Change the file behind the single writer: the next write's result is uncertain.
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(root.ledger())
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    let lost = root.run(&format!(
        "const r = await (async () => {{ {} }})(); return [r, await view(), await call('day.ritual.read')];",
        save("start", "done", 2)
    ));
    assert_eq!(lost[0]["error"], "unknown");
    assert_eq!(lost[1]["availability"], "unknown");
    assert_eq!(lost[1]["start"]["mark"], "unmarked", "no fabricated Done");
    assert_eq!(
        lost[2]["error"], "unknown",
        "a read cannot bless unconfirmed memory"
    );
    assert_eq!(
        root.reopen(Some(me())),
        Err(Error::Storage),
        "the joined close reports the storage failure"
    );
    let cold = root.run("return await call('day.ritual.read');")["value"]["snapshot"].clone();
    assert_eq!(
        cold["start"],
        json!({"mark":"unmarked","step":1}),
        "the lost Done was not replayed"
    );
}

#[test]
fn while_forms_are_saved_for_a_close_reads_run_but_saves_and_visits_wait() {
    let root = Root::new();
    root.run("return await call('day.ritual.read');");
    let generation = root.bridge().begin_capture().unwrap();
    let during = root.run(&format!(
        "const v = await view(); return [
            await call('day.ritual.read'),
            await call('day.ritual.snapshot'),
            await call('day.ritual.visit', {{context:v.context,revision:v.revision}}),
            await (async () => {{ {} }})(),
        ];",
        save("start", "done", 2)
    ));
    assert_eq!(during[0]["value"]["outcome"]["status"], "accepted");
    assert!(during[1]["value"]["snapshot"].is_object());
    assert_eq!(during[2]["error"], "busy");
    assert_eq!(during[3]["error"], "busy");
    assert_eq!(root.ledger_len(), 0);
    root.bridge().cancel_flush(generation).unwrap();
    let done = root.run(&save("start", "done", 2));
    assert_eq!(done["value"]["outcome"]["status"], "accepted");
}

// Connected.tsx on a root the test plays.

const FAKE_WINDOW: &str = "00000000-0000-4000-8000-0000000000aa";

/// A copy of the app's sources whose nsh.json declares the bridge's exact names.
fn entry() -> PathBuf {
    let app = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let dir = std::env::temp_dir().join(format!("day-ritual-ui-{}", uuid::Uuid::new_v4()));
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

fn set_lifecycle(app: &mut Headless, state: Lifecycle) {
    app.set_environment("lifecycle", |e| e.lifecycle = state)
        .unwrap();
}

/// A ritual view as the root projects it.
fn progress(context: &str, part: &str) -> Value {
    json!({
        "availability":"available","context":context,"revision":0,"date":"2026-11-10",
        "timeZone":"Europe/Paris","part":part,"visit":"unknown","lastLookedAt":"",
        "start":{"mark":"unmarked","step":0},"end":{"mark":"unmarked","step":0},
        "resultsAvailability":"unavailable","results":[],"resultsLimited":false
    })
}

/// The root, played: exact names, every call kept, ritual saves and visits
/// checked against the exact context and revision like the real host.
#[derive(Clone)]
struct FakeRoot {
    channel: HostChannel,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    replies: Arc<Mutex<BTreeMap<String, Value>>>,
    ritual: Arc<Mutex<Value>>,
    /// The next answer to a name, once: an error code the root sends instead.
    refuse: Arc<Mutex<BTreeMap<String, String>>>,
}
fn answer(snapshot: Value, outcome: Value) -> Value {
    json!({"version":1,"value":{"snapshot":snapshot,"outcome":outcome}})
}
fn accepted(revision: u64) -> Value {
    json!({"status":"accepted","revision":revision,"message":""})
}
impl FakeRoot {
    fn new(ritual: Value) -> Self {
        let channel = HostChannel::new();
        channel.set_params(
            serde_json::from_value(json!({"day":{"version":1,"window":FAKE_WINDOW}})).unwrap(),
        );
        let root = Self {
            channel: channel.clone(),
            calls: Arc::default(),
            replies: Arc::default(),
            ritual: Arc::new(Mutex::new(ritual)),
            refuse: Arc::default(),
        };
        for &name in METHODS {
            let played = root.clone();
            channel.handle(name, move |call: HostCall| {
                let data = call.data().clone();
                call.resolve(played.answer(name, &data));
            });
        }
        let today = serde_json::to_value(Desk::new(Scenario::Quiet).today()).unwrap();
        root.reply("day.today.read", today.clone());
        root.reply("day.attention.read", today);
        root.reply("day.plan.prepare", Value::Null);
        root
    }
    fn answer(&self, name: &str, data: &Value) -> Value {
        self.calls
            .lock()
            .unwrap()
            .push((name.to_owned(), data.clone()));
        if let Some(code) = self.refuse.lock().unwrap().remove(name) {
            return json!({"version":1,"error":code});
        }
        let args = &data["args"];
        let mut ritual = self.ritual.lock().unwrap();
        match name {
            "day.ritual.read" | "day.ritual.results" => {
                let revision = ritual["revision"].as_u64().unwrap();
                answer(ritual.clone(), accepted(revision))
            }
            "day.ritual.snapshot" => answer(ritual.clone(), Value::Null),
            "day.ritual.visit" | "day.ritual.save" => {
                let revision = ritual["revision"].as_u64().unwrap();
                if args["context"] != ritual["context"] || args["revision"] != ritual["revision"] {
                    return json!({"version":1,"error":"stale"});
                }
                if name == "day.ritual.save" {
                    let which = args["ritual"].as_str().unwrap().to_owned();
                    if ritual[&which]["mark"] != "unmarked" {
                        return json!({"version":1,"error":"stale"});
                    }
                    ritual[&which] = json!({"mark":args["mark"],"step":args["step"]});
                }
                ritual["revision"] = json!(revision + 1);
                answer(ritual.clone(), accepted(revision + 1))
            }
            _ => self
                .replies
                .lock()
                .unwrap()
                .get(name)
                .cloned()
                .unwrap_or(json!({"version":1,"error":"unavailable"})),
        }
    }
    fn reply(&self, name: &str, snapshot: Value) {
        self.replies
            .lock()
            .unwrap()
            .insert(name.into(), answer(snapshot, Value::Null));
    }
    fn refuse_next(&self, name: &str, code: &str) {
        self.refuse.lock().unwrap().insert(name.into(), code.into());
    }
    fn set(&self, field: &str, value: Value) {
        self.ritual.lock().unwrap()[field] = value;
    }
    fn view(&self) -> Value {
        self.ritual.lock().unwrap().clone()
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
    fn changed(&self) {
        self.channel
            .send("day.changed", json!({"version":1,"window":FAKE_WINDOW}))
            .unwrap();
    }
}

/// Waits, moving the engine's time, until `done`: a host call that lands
/// after the last screen change is still seen.
fn until(app: &mut Headless, root: &FakeRoot, what: &str, done: impl Fn(&FakeRoot) -> bool) {
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

/// Lets queued calls settle, so a call that should not happen would have.
fn settle(app: &mut Headless) {
    for _ in 0..6 {
        app.wait(Duration::from_millis(50)).unwrap();
    }
}

#[test]
fn today_records_one_visit_after_it_shows_and_coming_back_reads_again() {
    let entry = entry();
    let root = FakeRoot::new(progress("day-1", "morning"));
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "id:start-day");
    // The first ritual read comes before Today's, and it writes nothing.
    let names: Vec<String> = root
        .calls
        .lock()
        .unwrap()
        .iter()
        .map(|(n, _)| n.clone())
        .collect();
    let read = names.iter().position(|n| n == "day.ritual.read").unwrap();
    let today = names.iter().position(|n| n == "day.today.read").unwrap();
    assert!(read < today, "{names:?}");
    until(&mut app, &root, "one visit", |r| {
        r.count("day.ritual.visit") == 1
    });
    assert_eq!(
        root.args("day.ritual.visit"),
        vec![json!({"context":"day-1","revision":0})]
    );

    // An invalidation reads only the cached view: no clock sample, no new visit.
    let cached = root.count("day.ritual.snapshot");
    root.changed();
    until(&mut app, &root, "cached read", |r| {
        r.count("day.ritual.snapshot") > cached
    });
    settle(&mut app);
    assert_eq!(root.count("day.ritual.read"), 1);
    assert_eq!(root.count("day.ritual.visit"), 1);

    // Leaving and coming back reads again; the same day is not visited twice.
    set_lifecycle(&mut app, Lifecycle::Background);
    set_lifecycle(&mut app, Lifecycle::Active);
    until(&mut app, &root, "focus read", |r| {
        r.count("day.ritual.read") == 2
    });
    settle(&mut app);
    assert_eq!(root.count("day.ritual.visit"), 1);

    // A new day while away: coming back reads it, and Today shows it once more.
    root.set("context", json!("day-2"));
    root.set("revision", json!(0));
    set_lifecycle(&mut app, Lifecycle::Inactive);
    settle(&mut app);
    assert_eq!(
        root.count("day.ritual.visit"),
        1,
        "a window without the focus is not a visit"
    );
    set_lifecycle(&mut app, Lifecycle::Active);
    until(&mut app, &root, "visit of the new day", |r| {
        r.count("day.ritual.visit") == 2
    });
    assert_eq!(
        root.args("day.ritual.visit")[1],
        json!({"context":"day-2","revision":0})
    );
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn steps_resume_after_a_cold_reopen_skip_is_saved_and_escape_saves_nothing() {
    let entry = entry();
    let root = FakeRoot::new(progress("day-1", "morning"));
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "id:start-day");
    until(&mut app, &root, "visit", |r| {
        r.count("day.ritual.visit") == 1
    });
    app.press("id:start-day").unwrap();
    wait(&mut app, "Step 1 of 3 · Since you looked");
    app.press("role:button[Next]").unwrap();
    wait(&mut app, "Step 2 of 3 · Needs you");
    until(&mut app, &root, "step saved", |r| {
        r.count("day.ritual.save") == 1
    });
    assert_eq!(
        root.args("day.ritual.save"),
        vec![json!({"context":"day-1","revision":1,"ritual":"start","mark":"unmarked","step":1})]
    );
    // Escape leaves without saving; Today still offers the start of day.
    app.press_key("escape").unwrap();
    wait(&mut app, "id:start-day");
    settle(&mut app);
    assert_eq!(root.count("day.ritual.save"), 1);
    assert_eq!(root.view()["start"], json!({"mark":"unmarked","step":1}));
    drop(app);

    // A cold reopen: a new window over the same saved progress resumes there.
    root.set("context", json!("day-1-reopened"));
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "id:start-day");
    app.press("id:start-day").unwrap();
    wait(&mut app, "Step 2 of 3 · Needs you");
    app.press("role:button[Skip for today]").unwrap();
    until(&mut app, &root, "skip saved", |r| {
        r.view()["start"]["mark"] == "skipped"
    });
    wait(&mut app, "id:standup");
    assert!(
        !has(&app, "id:start-day"),
        "a saved Skip is not offered again"
    );
    let saves = root.args("day.ritual.save");
    assert_eq!(saves.len(), 2);
    assert_eq!(saves[1]["context"], "day-1-reopened");
    assert_eq!(saves[1]["mark"], "skipped");
    assert_eq!(saves[1]["step"], 1);
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn the_day_closes_only_once_saved_and_a_lost_save_is_never_resent() {
    let entry = entry();
    let root = FakeRoot::new(progress("day-1", "evening"));
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "id:end-day");
    until(&mut app, &root, "visit", |r| {
        r.count("day.ritual.visit") == 1
    });
    app.press("id:end-day").unwrap();
    wait(&mut app, "Wrapping up.");
    // Results the root could not read are never "none".
    assert!(app.shows("Pilot could not read results here. This is not the same as none."));

    // A refusal saves nothing and leaves the day open.
    root.refuse_next("day.ritual.save", "busy");
    app.press("role:button[Close the day]").unwrap();
    wait(&mut app, "id:ritual-note");
    assert!(!has(&app, "Done for today."));

    // The root never answers for sure: Unknown, never sent again.
    root.refuse_next("day.ritual.save", "unknown");
    app.press("role:button[Close the day]").unwrap();
    wait(
        &mut app,
        "Pilot could not confirm this was saved. It will not save it again; Read again checks.",
    );
    assert!(!has(&app, "Done for today."));
    assert_eq!(root.count("day.ritual.save"), 2);
    app.press("role:button[Close the day]").unwrap();
    app.press("role:button[Skip for today]").unwrap();
    root.changed();
    settle(&mut app);
    assert_eq!(root.count("day.ritual.save"), 2, "nothing is resent");

    // Today says so and offers no ritual until a confirmed read.
    app.press_key("escape").unwrap();
    wait(&mut app, "id:ritual-progress");
    assert!(!has(&app, "id:end-day"));
    // The Done did land: Read again only reads, and shows it.
    root.set("end", json!({"mark":"done","step":0}));
    root.set("revision", json!(5));
    let reads = root.count("day.ritual.read");
    app.press("id:ritual-read").unwrap();
    until(&mut app, &root, "read again", |r| {
        r.count("day.ritual.read") == reads + 1
    });
    settle(&mut app);
    assert!(!has(&app, "id:ritual-progress"));
    assert!(!has(&app, "id:end-day"));
    assert_eq!(root.count("day.ritual.save"), 2);
    drop(app);

    // Another evening: Close the day shows the closed day once it is saved.
    let root = FakeRoot::new(progress("day-2", "evening"));
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "id:end-day");
    app.press("id:end-day").unwrap();
    app.press("role:button[Close the day]").unwrap();
    wait(&mut app, "Done for today.");
    assert_eq!(root.view()["end"]["mark"], "done");
    app.press("id:closed-today").unwrap();
    wait(&mut app, "id:standup");
    assert!(!has(&app, "id:end-day"));
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn a_day_that_changed_under_a_ritual_saves_nothing_and_unreadable_progress_is_said() {
    let entry = entry();
    let root = FakeRoot::new(progress("day-1", "morning"));
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "id:start-day");
    until(&mut app, &root, "visit", |r| {
        r.count("day.ritual.visit") == 1
    });
    app.press("id:start-day").unwrap();
    wait(&mut app, "Step 1 of 3 · Since you looked");
    // Midnight passed: the root's view is another day.
    root.set("context", json!("day-2"));
    root.changed();
    wait(
        &mut app,
        "The day changed since you opened this, so Pilot saves nothing here. Back to Today shows the new day.",
    );
    app.press("role:button[Skip for today]").unwrap();
    until(&mut app, &root, "refused save", |r| {
        r.count("day.ritual.save") == 1
    });
    assert_eq!(
        root.args("day.ritual.save")[0]["context"],
        "day-1",
        "the ritual's own day"
    );
    settle(&mut app);
    assert_eq!(root.view()["start"]["mark"], "unmarked");
    assert!(
        has(&app, "id:start-of-day"),
        "nothing was saved, so the ritual stays"
    );
    drop(app);

    // No clock on the root: no ritual, no visit, and Today says why.
    let root = FakeRoot::new(json!({
        "availability":"unavailable","context":"","revision":0,"date":"","timeZone":"","part":"unknown",
        "visit":"unknown","lastLookedAt":"","start":{"mark":"unmarked","step":0},"end":{"mark":"unmarked","step":0},
        "resultsAvailability":"unavailable","results":[],"resultsLimited":false
    }));
    root.refuse_next("day.ritual.read", "unavailable");
    let mut app = open_on(&entry, root.channel.clone());
    wait(
        &mut app,
        "Start and end of day are not available: Pilot cannot read the local day here.",
    );
    settle(&mut app);
    assert!(!has(&app, "id:start-day"));
    assert!(!has(&app, "id:end-day"));
    assert_eq!(root.count("day.ritual.visit"), 0);
    drop(app);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}
