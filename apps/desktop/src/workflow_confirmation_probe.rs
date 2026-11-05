//! Hidden production LocalViewer journeys for workflow confirmations.
//!
//! Live seam: packages/daemon/src/testing/workflow-host.ts runs the real daemon routes,
//! OperationJournal, native capability file and missions.sqlite in a temporary home, behind a
//! small proxy that can hold, drop or kill one confirmation request and restart the daemon on
//! the same files. Coordinator metadata is faux; no provider, reviewer, worker or real profile.
//!
//! Synthetic, labelled: the Overview entry and the reviewer consent disclosure layout use an
//! owned faux Local. No Local has a reviewer disclosure configuration, so none is shown as live.
use super::*;
use crate::{
    app_shell::Page,
    mission_browser_fixture::{self as f, Reply, Server},
    workflow_confirmation::{NO_RECORD, Outcome, Purpose, State, fixture as fx},
    workflow_confirmation_view::{Sheet, Target},
};
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions, component::ThemeMode,
    size, test::TestWindowExt,
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command as Process, Stdio},
    sync::mpsc,
    time::Instant,
};

const DRAFT: &str = "Unsent reply 下書き 👩‍💻";
const COORDINATOR: &str = "Coordinator 日本語";
const BRIEF_TAIL: &str = "END OF BRIEF: reviews stay Balanced 末尾 👩‍💻";
const DECISION_TAIL: &str = "DECISION TAIL: no merges 決定";
/// Synthetic consent values beyond the compact 120/240-character rows.
type Field = (&'static str, fn() -> String);
const LONG_DISCLOSURE: [Field; 4] = [
    ("provider", || {
        format!(
            "{}PROVIDER TAIL 提供",
            "Synthetic provider name. ".repeat(8)
        )
    }),
    ("model", || {
        format!("{}MODEL TAIL", "synthetic/reviewer-model-".repeat(8))
    }),
    ("account", || {
        format!("{}ACCOUNT TAIL", "synthetic account label ".repeat(8))
    }),
    ("terms", || {
        format!(
            "{}TERMS TAIL 規約",
            "Synthetic terms clause for layout only. ".repeat(10)
        )
    }),
];
fn row_id(key: &str) -> &'static str {
    match key {
        "provider" => "workflow-provider",
        "model" => "workflow-model",
        "account" => "workflow-account",
        _ => "workflow-terms",
    }
}

/// Text painted inside an identified element, as its text component records it.
fn painted(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) -> Vec<String> {
    let id = gpui_kit::ElementId::from(id);
    cx.update_window(h, |_, w, _| {
        gpui_kit::base::test_support::texts(w)
            .into_iter()
            .filter(|t| t.path().contains(&id))
            .map(|t| t.text().to_owned())
            .collect()
    })
    .unwrap()
}
/// Open the brief and decisions of the package on screen and return what they show.
fn disclose(cx: &mut HeadlessAppContext, h: AnyWindowHandle) -> (String, String) {
    for (toggle, shown) in [
        ("workflow-brief-toggle", "workflow-brief"),
        ("workflow-decisions-toggle", "workflow-decisions"),
    ] {
        if cx
            .update_window(h, |_, w, _| w.try_find(shown).is_none())
            .unwrap()
        {
            click(cx, h, toggle);
        }
    }
    let one = |v: Vec<String>| {
        assert_eq!(v.len(), 1, "one complete text block");
        v.into_iter().next().unwrap()
    };
    (
        one(painted(cx, h, "workflow-brief")),
        one(painted(cx, h, "workflow-decisions")),
    )
}
fn listed(p: &crate::workflow_confirmation::Prepared) -> String {
    p.decisions
        .iter()
        .map(|d| format!("D{}  {}", d.number, d.text))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// The real host fixture process and its JSON-line control channel.
struct Host {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<Value>,
    seen: Vec<Value>,
    port: u16,
    home: PathBuf,
    mission: String,
    project: String,
}
impl Host {
    fn start() -> Self {
        let mut child = Process::new("node")
            .arg(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../packages/daemon/src/testing/workflow-host.ts"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("the real workflow host fixture must run");
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    let _ = tx.send(v);
                }
            }
        });
        let first = lines
            .recv_timeout(Duration::from_secs(60))
            .expect("workflow host start line");
        let stdin = child.stdin.take().unwrap();
        Self {
            child,
            stdin,
            lines,
            seen: Vec::new(),
            port: first["port"].as_u64().unwrap() as u16,
            home: PathBuf::from(first["home"].as_str().unwrap()),
            mission: first["missionId"].as_str().unwrap().into(),
            project: first["projectId"].as_str().unwrap().into(),
        }
    }
    fn options(&self) -> LocalOptions {
        LocalOptions::synthetic(self.port).with_scope_home(self.home.clone())
    }
    fn drain(&mut self) {
        while let Ok(v) = self.lines.try_recv() {
            self.seen.push(v);
        }
    }
    #[track_caller]
    fn next(&mut self, pred: impl Fn(&Value) -> bool) -> Value {
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            self.drain();
            if let Some(i) = self.seen.iter().position(&pred) {
                return self.seen.remove(i);
            }
            assert!(
                Instant::now() < end,
                "workflow host reply timeout at {}",
                std::panic::Location::caller()
            );
            if let Ok(v) = self.lines.recv_timeout(Duration::from_millis(50)) {
                self.seen.push(v);
            }
        }
    }
    #[track_caller]
    fn send(&mut self, cmd: &str) -> Value {
        writeln!(self.stdin, "{}", json!({ "cmd": cmd })).unwrap();
        self.stdin.flush().unwrap();
        self.next(|v| v["ok"] == cmd)
    }
    fn saw(&mut self, event: &str) -> Option<Value> {
        self.drain();
        let i = self.seen.iter().position(|v| v["event"] == event)?;
        Some(self.seen.remove(i))
    }
    /// Requests through the proxy since the last call: method, path, native capability.
    fn log(&mut self) -> Vec<(String, String, bool)> {
        self.send("log")["requests"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["method"].as_str().unwrap().into(),
                    r["path"].as_str().unwrap().into(),
                    r["capability"].as_bool().unwrap(),
                )
            })
            .collect()
    }
    fn rows(&mut self) -> Value {
        self.send("rows")
    }
    fn target(&self) -> Target {
        Target {
            mission: self.mission.clone(),
            project: self.project.clone(),
            title: "Coordinator-planned mission 日本語".into(),
            coordinator: Some(("lead".into(), "lead".into())),
        }
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = writeln!(self.stdin, "{}", json!({"cmd":"close"}));
        let _ = self.stdin.flush();
        let end = Instant::now() + Duration::from_secs(10);
        while Instant::now() < end {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
    }
}
fn writes(log: &[(String, String, bool)]) -> Vec<(String, bool)> {
    log.iter()
        .filter(|(m, _, _)| m == "POST")
        .map(|(_, p, c)| (p.clone(), *c))
        .collect()
}

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
#[track_caller]
fn until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    mut check: impl FnMut(&mut Window, &mut App) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(20);
    while !cx.update_window(h, |_, w, cx| check(w, cx)).unwrap() {
        assert!(
            Instant::now() < end,
            "workflow probe wait at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::sleep(Duration::from_millis(5));
    }
    settle(cx, h);
}
fn press(cx: &mut HeadlessAppContext, h: AnyWindowHandle, key: &str) {
    cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
    settle(cx, h);
}
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
}
fn shot(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: &str) {
    if let Some(d) = std::env::var_os("PILOT_NEXT_WORKFLOW_DIR").map(PathBuf::from) {
        std::fs::create_dir_all(&d).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(d.join(format!("workflow-{name}.png")))
            .unwrap();
    }
}

struct Mounted {
    h: AnyWindowHandle,
    view: Entity<LocalViewer>,
    writer: Interaction,
    drain: async_channel::Receiver<crate::interaction::WriteState>,
    root: PathBuf,
    _commands: async_channel::Receiver<Command>,
}
fn mount(
    cx: &mut HeadlessAppContext,
    options: LocalOptions,
    width: f32,
    mode: ThemeMode,
    root: Option<PathBuf>,
) -> Mounted {
    cx.update(|cx| {
        crate::appearance::commit_appearance(
            if mode == ThemeMode::Dark {
                crate::settings_state::AppearancePreference::Dark
            } else {
                crate::settings_state::AppearancePreference::Light
            },
            cx,
        )
    });
    let root = root.unwrap_or_else(|| {
        std::env::temp_dir().join(format!("native-workflow-{}", uuid::Uuid::new_v4()))
    });
    let (writer, updates) = Interaction::start(options.clone(), Ok(root.clone()));
    let drain = updates.clone();
    let (client, commands) = LocalClient::synthetic_commands();
    let owned = writer.clone();
    let (h, view) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(width), px(820.)),
                ))),
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |w, cx| {
                cx.new(|cx| {
                    let mut v = LocalViewer::build(Some(client), Some(owned), w, cx);
                    v.state.status = "Synthetic workflow confirmation fixture".into();
                    v.state.loaded = true;
                    v.state.list_loaded = true;
                    v.state.generation = 1;
                    v.generation = 1;
                    v.state.chats = Arc::new(vec![
                        crate::local_model::chat(&json!({"id":"plain","title":"Ordinary chat","projectId":"project-A","cwd":"/synthetic/A","mode":"build","state":"idle"})).unwrap(),
                        crate::local_model::chat(&json!({"id":"lead","title":COORDINATOR,"projectId":"project-A","cwd":"/synthetic/A","mode":"build","state":"idle"})).unwrap(),
                    ]);
                    v.state.projects = Arc::new(
                        crate::local_model::projects(&json!([{"id":"project-A","name":"Synthetic project A","path":"/synthetic/A"}]))
                            .unwrap(),
                    );
                    v.state.projects_loaded = true;
                    v.usage_options = Some(options.clone());
                    v.missions.update(cx, |m, _| m.options(options.clone()));
                    v.page = Page::Chat;
                    v.selected = Some("plain".into());
                    v.title = "Ordinary chat".into();
                    v.editor.update(cx, |e, cx| e.select("chat:plain".into(), true, false, w, cx));
                    v.rebuild_nav(w, cx);
                    v.listen_writes(updates, w, cx);
                    v
                })
            },
        )
        .unwrap()
    });
    until(cx, h, |_, cx| view.read(cx).editor.read(cx).ready());
    cx.update_window(h, |_, w, _| w.activate_window()).unwrap();
    settle(cx, h);
    Mounted {
        h,
        view,
        writer,
        drain,
        root,
        _commands: commands,
    }
}
/// Close the window and flush the private writer; returns the root for a restart.
fn unmount(cx: &mut HeadlessAppContext, m: Mounted) -> PathBuf {
    let Mounted {
        h,
        view,
        writer,
        drain,
        root,
        _commands,
    } = m;
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    cx.run_until_parked();
    drop(view);
    assert!(writer.command(WriteCommand::Close));
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(5), async {
                let mut flushed = false;
                while let Ok(update) = drain.recv().await {
                    flushed |= update.flushed;
                }
                assert!(flushed, "private writer must acknowledge its final flush");
            })
            .await
            .unwrap();
        });
    drop(writer);
    root
}
fn type_draft(cx: &mut HeadlessAppContext, h: AnyWindowHandle, view: &Entity<LocalViewer>) {
    let input = cx.update(|cx| view.read(cx).editor.read(cx).shell_probe().0);
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| i.focus(w, cx));
        w.input(DRAFT, cx);
    })
    .unwrap();
    settle(cx, h);
}
fn draft(cx: &mut HeadlessAppContext, view: &Entity<LocalViewer>) -> String {
    cx.update(|cx| {
        view.read(cx)
            .editor
            .read(cx)
            .shell_probe()
            .0
            .read(cx)
            .value()
            .to_string()
    })
}
fn sheet(cx: &mut HeadlessAppContext, view: &Entity<LocalViewer>) -> Entity<Sheet> {
    cx.update(|cx| view.read(cx).workflow.as_ref().unwrap().0.clone())
}
fn visible(view: &Entity<LocalViewer>, cx: &App) -> bool {
    view.read(cx)
        .workflow
        .as_ref()
        .is_some_and(|(s, _)| s.read(cx).visible)
}
fn open(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    target: &Target,
    purpose: Purpose,
) -> Entity<Sheet> {
    // The same handler Overview's menu reaches through its ConfirmWorkflow event.
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| v.open_workflow(target.clone(), purpose, w, cx))
    })
    .unwrap();
    until(cx, h, |w, cx| {
        visible(view, cx)
            && w.try_find("workflow-sheet").is_some()
            && view
                .read(cx)
                .workflow
                .as_ref()
                .unwrap()
                .0
                .read(cx)
                .probe_ready()
    });
    sheet(cx, view)
}
fn latest(cx: &mut HeadlessAppContext, s: &Entity<Sheet>) -> Option<Outcome> {
    cx.update(|cx| s.read(cx).probe_latest())
}
#[track_caller]
fn settled(cx: &mut HeadlessAppContext, h: AnyWindowHandle, s: &Entity<Sheet>) -> Outcome {
    until(cx, h, |_, cx| s.read(cx).probe_latest().is_some());
    latest(cx, s).unwrap()
}
fn attempt(
    cx: &mut HeadlessAppContext,
    view: &Entity<LocalViewer>,
    purpose: Purpose,
    mission: &str,
) -> Option<crate::workflow_confirmation::Attempt> {
    let slot = crate::workflow_confirmation::slot(purpose, mission);
    cx.update(|cx| {
        view.read(cx)
            .insights_book
            .as_ref()
            .and_then(|b| b.workflow.get(&slot).cloned())
    })
}
fn escape(cx: &mut HeadlessAppContext, h: AnyWindowHandle, view: &Entity<LocalViewer>) {
    press(cx, h, "escape");
    assert!(
        !cx.update(|cx| visible(view, cx)),
        "Escape closes the sheet"
    );
}
/// An open attempt offers only Check: no Confirm, no Review again.
fn unconfirmed(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.update_window(h, |_, w, _| {
        assert!(
            w.try_find("workflow-check").is_some(),
            "Check stays available"
        );
        assert!(w.try_find("workflow-confirm").is_none(), "no fresh Confirm");
        assert!(w.try_find("workflow-review").is_none(), "no fresh package");
    })
    .unwrap();
}
fn contained(cx: &mut HeadlessAppContext, h: AnyWindowHandle, width: f32) {
    cx.update_window(h, |_, w, _| {
        let s = w.find("workflow-sheet").bounds();
        assert!(
            s.left() >= px(0.) && s.right() <= px(width),
            "sheet {s:?} exceeds {width}"
        );
        for id in [
            "workflow-close",
            "workflow-confirm",
            "workflow-assurance",
            "workflow-package",
        ] {
            if let Some(e) = w.try_find(id) {
                assert!(e.bounds().right() <= s.right() + px(0.5), "{id} clipped");
            }
        }
    })
    .unwrap();
}

pub fn run_workflow_confirmation_probe(cx: &mut HeadlessAppContext) {
    let reduced = cx.update(|cx| {
        let previous = cx.reduce_motion();
        cx.set_reduce_motion(true);
        previous
    });
    live(cx);
    entry(cx);
    for (width, mode) in [
        (680., ThemeMode::Light),
        (680., ThemeMode::Dark),
        (1100., ThemeMode::Light),
        (1100., ThemeMode::Dark),
    ] {
        consent_layout(cx, width, mode);
    }
    cx.update(|cx| cx.set_reduce_motion(reduced));
    println!(
        "workflow confirmations: live host passive open/keyboard/draft, stale package, held dialog, lost ACK Check, kill+restart stays Unknown, held past timeout then late original, restart Check, unavailable consent; synthetic Overview entry and 4 consent layouts passed"
    );
}

/// Every journey against the real host seam, in one mission's history.
fn live(cx: &mut HeadlessAppContext) {
    let mut host = Host::start();
    let target = host.target();
    let mission = host.mission.clone();
    let m = mount(cx, host.options(), 1100., ThemeMode::Light, None);
    let (h, view) = (m.h, m.view.clone());
    type_draft(cx, h, &view);
    host.log();

    // Opening is a passive package read. Escape closes; the draft is untouched.
    let s = open(cx, h, &view, &target, Purpose::Approve);
    let first = cx
        .update(|cx| s.read(cx).probe_shown())
        .expect("real prepared package");
    assert_eq!(
        (
            first.brief_revision,
            first.decisions.iter().map(|d| d.number).collect::<Vec<_>>(),
            first.coordinator.as_str()
        ),
        (1, vec![1], "lead")
    );
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("workflow-may").is_some() && w.try_find("workflow-excludes").is_some());
        assert!(
            w.try_find("workflow-assurance").is_some(),
            "no human-presence claim is implied"
        );
        assert_ne!(w.find("workflow-confirm").disabled(), Some(true));
    })
    .unwrap();
    contained(cx, h, 1100.);
    shot(cx, h, "live-approve");
    // The complete saved brief and decision texts of this package, beyond compact limits.
    let (brief, decided) = disclose(cx, h);
    assert!(
        brief.chars().count() > 4000 && brief.ends_with(BRIEF_TAIL),
        "complete brief"
    );
    assert_eq!(brief, first.brief);
    assert!(decided.contains(DECISION_TAIL) && decided == listed(&first));
    contained(cx, h, 1100.);
    shot(cx, h, "live-approve-disclosed");
    escape(cx, h, &view);
    assert_eq!(draft(cx, &view), DRAFT);
    let log = host.log();
    assert!(writes(&log).is_empty(), "opening never writes: {log:?}");
    assert!(
        log.iter()
            .any(|(m, p, c)| m == "GET" && p.ends_with("/approval-package?action=approve") && !c)
    );
    assert!(host.rows()["approval"].is_null());

    // Ordinary REST, as an agent tool could send it, lacks the native capability: refused.
    let payload = first.request().payload;
    let home = json!({"hostId":"local","daemonId":"test-daemon","lineageId":"test-lineage"});
    let op = json!({"schemaVersion":1,"operationId":uuid::Uuid::new_v4().to_string(),"producerId":uuid::Uuid::new_v4().to_string(),"sequence":1,"origin":home,"destination":home,"kind":"workflow-approve","targetId":mission,"payloadHash":crate::delivery_store::hash(&payload),"payload":payload});
    let url = format!("{}/api/operations", host.options().loopback());
    let status = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async move {
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .post(url)
                .header("Content-Type", "application/json")
                .body(serde_json::to_vec(&op).unwrap())
                .send()
                .await
                .unwrap()
                .status()
                .as_u16()
        });
    assert_eq!(status, 403, "no native capability, no reservation");
    assert!(host.rows()["approval"].is_null());
    host.log();

    // A held package is never retargeted: a mission change before Confirm is refused by
    // the host. Review again prepares the current package; Confirm (⌘Enter) applies it.
    let s = open(cx, h, &view, &target, Purpose::Approve);
    host.send("mutate");
    // The held package still shows its own frozen decisions, not the live change.
    let (brief, decided) = disclose(cx, h);
    assert_eq!(
        (brief.as_str(), decided.as_str()),
        (first.brief.as_str(), listed(&first).as_str())
    );
    assert!(!decided.contains("A later binding decision"));
    press(cx, h, "secondary-enter");
    assert_eq!(
        settled(cx, h, &s),
        Outcome::Rejected("The plan changed since this opened. Review again.".into())
    );
    assert!(
        host.rows()["approval"].is_null(),
        "a stale package grants nothing"
    );
    click(cx, h, "workflow-review");
    until(cx, h, |_, cx| s.read(cx).probe_ready());
    let second = cx.update(|cx| s.read(cx).probe_shown()).unwrap();
    assert_ne!(second.digest, first.digest);
    assert_eq!(
        second
            .decisions
            .iter()
            .map(|d| d.number)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    let (_, decided) = disclose(cx, h);
    assert!(decided.contains("A later binding decision") && decided == listed(&second));
    press(cx, h, "secondary-enter");
    assert_eq!(settled(cx, h, &s), Outcome::Accepted);
    let approved = attempt(cx, &view, Purpose::Approve, &mission).unwrap();
    assert_eq!(approved.state, State::Accepted);
    let rows = host.rows();
    assert_eq!(
        rows["approval"]["operationId"],
        approved.operation.operation_id.as_str()
    );
    assert_eq!(
        rows["approval"]["digest"],
        second.digest.as_str(),
        "the displayed package, not a later one"
    );
    let log = host.log();
    assert_eq!(
        writes(&log),
        vec![
            ("/api/operations".into(), true),
            ("/api/operations".into(), true)
        ]
    );
    escape(cx, h, &view);

    // Held dialog: the request waits at the host; closing and reopening never resends.
    host.send("hold");
    let s = open(cx, h, &view, &target, Purpose::Revoke);
    press(cx, h, "secondary-enter");
    let end = Instant::now() + Duration::from_secs(20);
    while host.saw("held").is_none() {
        assert!(Instant::now() < end, "request must reach the held host");
        settle(cx, h);
    }
    assert!(cx.update(|cx| s.read(cx).waiting()));
    press(cx, h, "secondary-enter");
    escape(cx, h, &view);
    assert_eq!(
        draft(cx, &view),
        DRAFT,
        "the draft survives a held confirmation"
    );
    let s2 = open(cx, h, &view, &target, Purpose::Revoke);
    assert_eq!(s, s2, "the same sheet returns with its pending request");
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("workflow-waiting").is_some());
        assert!(w.try_find("workflow-confirm").is_none());
    })
    .unwrap();
    // While held, the reopened sheet discloses the saved envelope's own package.
    let held = attempt(cx, &view, Purpose::Revoke, &mission).unwrap();
    let saved: Value = serde_json::from_str(&held.operation.payload).unwrap();
    let (brief, decided) = disclose(cx, h);
    assert_eq!(json!(brief), saved["package"]["brief"]["markdown"]);
    assert!(decided.contains(DECISION_TAIL) && decided.contains("A later binding decision"));
    assert_eq!(draft(cx, &view), DRAFT, "disclosure leaves the draft alone");
    host.send("release");
    assert_eq!(settled(cx, h, &s), Outcome::Accepted);
    assert_eq!(host.rows()["approval"]["kind"], "workflow-revoke");
    let log = host.log();
    assert_eq!(
        writes(&log),
        vec![("/api/operations".into(), true)],
        "one send despite repeated ⌘Enter and reopen"
    );
    escape(cx, h, &view);

    // Lost ACK: the host commits but the reply is lost. Check is the passive receipt only.
    host.send("drop");
    let s = open(cx, h, &view, &target, Purpose::Approve);
    press(cx, h, "secondary-enter");
    assert!(matches!(settled(cx, h, &s), Outcome::Unknown(_)));
    assert_eq!(host.next(|v| v["event"] == "dropped")["state"], "accepted");
    assert_eq!(
        attempt(cx, &view, Purpose::Approve, &mission)
            .unwrap()
            .state,
        State::Unknown
    );
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("workflow-check").is_some() && w.try_find("workflow-confirm").is_none())
    })
    .unwrap();
    host.log();
    click(cx, h, "workflow-check");
    assert_eq!(settled(cx, h, &s), Outcome::Accepted);
    assert_eq!(
        writes(&host.log()),
        vec![("/api/operations/receipt".into(), false)],
        "Check never resends or carries authority"
    );
    escape(cx, h, &view);

    // Killed before the host: Unknown survives both restarts. Check finds no record, which
    // is absence at that read only: the attempt stays Unknown and open, and nothing is resent
    // or replaced. No fresh Confirm or Review again is offered for this purpose.
    host.send("kill");
    let s = open(cx, h, &view, &target, Purpose::Revoke);
    press(cx, h, "secondary-enter");
    assert!(matches!(settled(cx, h, &s), Outcome::Unknown(_)));
    assert!(host.saw("killed").is_some());
    assert!(host.saw("held").is_some(), "kill reports its arrival too");
    let killed = attempt(cx, &view, Purpose::Revoke, &mission).unwrap();
    let root = unmount(cx, m);
    host.send("restart");
    host.log();
    let m = mount(cx, host.options(), 1100., ThemeMode::Light, Some(root));
    let (h, view) = (m.h, m.view.clone());
    until(cx, h, |_, cx| {
        view.read(cx)
            .insights_book
            .as_ref()
            .is_some_and(|b| !b.workflow.is_empty())
    });
    assert_eq!(
        attempt(cx, &view, Purpose::Revoke, &mission).as_ref(),
        Some(&killed),
        "restart keeps the exact envelope"
    );
    let s = open(cx, h, &view, &target, Purpose::Revoke);
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("workflow-check").is_some() && w.try_find("workflow-confirm").is_none())
    })
    .unwrap();
    assert!(
        !host
            .log()
            .iter()
            .any(|(_, p, _)| p.contains("approval-package")),
        "an open confirmation shows its own bytes"
    );
    // After restart, the disclosed texts are the killed envelope's saved bytes.
    let saved: Value = serde_json::from_str(&killed.operation.payload).unwrap();
    let (brief, decided) = disclose(cx, h);
    assert_eq!(json!(brief), saved["package"]["brief"]["markdown"]);
    assert!(brief.ends_with(BRIEF_TAIL) && decided.contains(DECISION_TAIL));
    click(cx, h, "workflow-check");
    assert_eq!(settled(cx, h, &s), Outcome::Unknown(NO_RECORD));
    unconfirmed(cx, h);
    press(cx, h, "secondary-enter");
    assert_eq!(
        attempt(cx, &view, Purpose::Revoke, &mission).as_ref(),
        Some(&killed)
    );
    assert_eq!(
        host.rows()["approval"]["kind"],
        "workflow-approve",
        "nothing was revoked"
    );
    assert_eq!(
        writes(&host.log()),
        vec![("/api/operations/receipt".into(), false)],
        "no record never resends or replaces"
    );
    escape(cx, h, &view);

    // Held past the client timeout: the original may still arrive. No record keeps it open;
    // ⌘Enter, close/reopen and an app restart can't send or replace it. When the original
    // arrives, an exact receipt Check settles that one operation.
    host.send("hold");
    let s = open(cx, h, &view, &target, Purpose::Approve);
    host.log();
    press(cx, h, "secondary-enter");
    let end = Instant::now() + Duration::from_secs(20);
    while host.saw("held").is_none() {
        assert!(Instant::now() < end, "request must reach the held host");
        settle(cx, h);
    }
    assert!(
        matches!(settled(cx, h, &s), Outcome::Unknown(_)),
        "the client timed out"
    );
    let original = attempt(cx, &view, Purpose::Approve, &mission).unwrap();
    assert_eq!(original.state, State::Unknown);
    click(cx, h, "workflow-check");
    assert_eq!(settled(cx, h, &s), Outcome::Unknown(NO_RECORD));
    unconfirmed(cx, h);
    press(cx, h, "secondary-enter");
    escape(cx, h, &view);
    let _ = open(cx, h, &view, &target, Purpose::Approve);
    unconfirmed(cx, h);
    press(cx, h, "secondary-enter");
    escape(cx, h, &view);
    let root = unmount(cx, m);
    let m = mount(cx, host.options(), 1100., ThemeMode::Light, Some(root));
    let (h, view) = (m.h, m.view.clone());
    until(cx, h, |_, cx| {
        view.read(cx)
            .insights_book
            .as_ref()
            .is_some_and(|b| !b.workflow.is_empty())
    });
    assert_eq!(
        attempt(cx, &view, Purpose::Approve, &mission).as_ref(),
        Some(&original)
    );
    let s = open(cx, h, &view, &target, Purpose::Approve);
    unconfirmed(cx, h);
    press(cx, h, "secondary-enter");
    click(cx, h, "workflow-check");
    assert_eq!(
        settled(cx, h, &s),
        Outcome::Unknown(NO_RECORD),
        "still no record after restart"
    );
    assert_eq!(
        attempt(cx, &view, Purpose::Approve, &mission).as_ref(),
        Some(&original)
    );
    assert_ne!(
        host.rows()["approval"]["operationId"],
        original.operation.operation_id.as_str()
    );
    // The original arrives late and is applied by the host.
    assert_eq!(host.send("release")["forwarded"], true);
    assert_eq!(
        host.rows()["approval"]["operationId"],
        original.operation.operation_id.as_str()
    );
    click(cx, h, "workflow-check");
    assert_eq!(settled(cx, h, &s), Outcome::Accepted);
    let settled_attempt = attempt(cx, &view, Purpose::Approve, &mission).unwrap();
    assert!(
        settled_attempt.state == State::Accepted && settled_attempt.operation == original.operation
    );
    let log = host.log();
    assert_eq!(
        writes(&log),
        vec![
            ("/api/operations".into(), true),
            ("/api/operations/receipt".into(), false),
            ("/api/operations/receipt".into(), false),
            ("/api/operations/receipt".into(), false),
        ],
        "one original operation; every Check is lookup-only: {log:?}"
    );
    assert!(
        !log.iter().any(|(_, p, _)| p.contains("approval-package")),
        "no fresh package"
    );
    escape(cx, h, &view);

    // Lost ACK, then both sides restart: Check settles from the host's durable journal.
    let s = open(cx, h, &view, &target, Purpose::Approve);
    host.send("drop");
    press(cx, h, "secondary-enter");
    assert!(matches!(settled(cx, h, &s), Outcome::Unknown(_)));
    host.next(|v| v["event"] == "dropped");
    let root = unmount(cx, m);
    host.send("restart");
    let m = mount(cx, host.options(), 1100., ThemeMode::Light, Some(root));
    let (h, view) = (m.h, m.view.clone());
    until(cx, h, |_, cx| view.read(cx).insights_book.is_some());
    host.log();
    let s = open(cx, h, &view, &target, Purpose::Approve);
    click(cx, h, "workflow-check");
    assert_eq!(settled(cx, h, &s), Outcome::Accepted);
    assert_eq!(
        writes(&host.log()),
        vec![("/api/operations/receipt".into(), false)]
    );
    assert_eq!(host.rows()["approval"]["kind"], "workflow-approve");
    escape(cx, h, &view);

    // No Local has a reviewer disclosure configuration: consent stays unavailable.
    let _ = open(cx, h, &view, &target, Purpose::Consent);
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("workflow-unavailable").is_some());
        assert!(
            w.try_find("workflow-confirm").is_none(),
            "nothing is invented or offered instead"
        );
        assert!(w.try_find("workflow-provider").is_none());
    })
    .unwrap();
    shot(cx, h, "live-consent-unavailable");
    escape(cx, h, &view);
    // Revoking consent that never existed has nothing to end.
    let _ = open(cx, h, &view, &target, Purpose::ConsentRevoke);
    cx.update_window(h, |_, w, _| {
        assert!(
            w.try_find("workflow-nothing").is_some() && w.try_find("workflow-confirm").is_none()
        )
    })
    .unwrap();
    escape(cx, h, &view);
    assert!(host.rows()["consent"].is_null());
    assert!(writes(&host.log()).is_empty());
    unmount(cx, m);
    drop(host);
}

fn browser_server(planning: bool) -> Server {
    let s = Server::start().with_capability();
    s.reply(
        "/api/hello",
        Reply::json(200, json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}})),
    );
    let mut d = f::detail("mission-A");
    if planning {
        d["mission"]["planningVersion"] = json!(1);
    }
    d["mission"]["coordinatorSessionId"] = json!("lead");
    s.reply("/api/missions/mission-A", Reply::json(200, d));
    s.reply(
        "/api/missions/mission-A/approval-package?action=approve",
        Reply::json(
            200,
            fx::prepared(Purpose::Approve, "mission-A", "project-A", None),
        ),
    );
    // Synthetic disclosure values longer than the compact rows, with meaningful tails.
    let mut consent = fx::prepared(
        Purpose::Consent,
        "mission-A",
        "project-A",
        Some("consent-0"),
    );
    for (key, value) in LONG_DISCLOSURE {
        consent["package"]["disclosure"][key] = json!(value());
    }
    s.reply(
        "/api/missions/mission-A/reviewer-consent-package?action=approve",
        Reply::json(200, consent),
    );
    s
}
fn to_overview(cx: &mut HeadlessAppContext, h: AnyWindowHandle, view: &Entity<LocalViewer>) {
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| v.show_chat_mission("mission-A", w, cx))
    })
    .unwrap();
    until(cx, h, |w, cx| {
        view.read(cx).page == Page::Mission(f::key("mission-A"))
            && view.read(cx).missions.read(cx).detail.is_some()
            && w.try_find("mission-more").is_some()
    });
}
fn menu_labels(cx: &mut HeadlessAppContext, h: AnyWindowHandle) -> Vec<String> {
    click(cx, h, "mission-more");
    let labels = cx
        .update_window(h, |_, w, _| {
            (0..16usize)
                .filter_map(|i| {
                    w.within("popup-menu")
                        .try_find(i)
                        .and_then(|e| e.label().map(str::to_owned))
                })
                .collect::<Vec<_>>()
        })
        .unwrap();
    press(cx, h, "escape");
    labels
}

/// Synthetic faux Local: Overview's entry exists only for coordinator-planned missions.
fn entry(cx: &mut HeadlessAppContext) {
    let legacy = browser_server(false);
    let m = mount(cx, legacy.options.clone(), 1100., ThemeMode::Light, None);
    let (h, view) = (m.h, m.view.clone());
    to_overview(cx, h, &view);
    let labels = menu_labels(cx, h);
    assert!(labels.iter().any(|l| l == "Activity"), "{labels:?}");
    assert!(
        !labels
            .iter()
            .any(|l| l.contains("plan") || l.contains("consent")),
        "legacy missions are never adopted: {labels:?}"
    );
    unmount(cx, m);

    let s = browser_server(true);
    let m = mount(cx, s.options.clone(), 1100., ThemeMode::Light, None);
    let (h, view) = (m.h, m.view.clone());
    to_overview(cx, h, &view);
    let labels = menu_labels(cx, h);
    for p in Purpose::ALL {
        assert!(labels.iter().any(|l| l == p.menu()), "{labels:?}");
    }
    crate::mission_browser_view::probe_menu_command(cx, h, "Approve plan…");
    until(cx, h, |w, cx| {
        visible(&view, cx) && w.try_find("workflow-plan").is_some()
    });
    let s_ = sheet(cx, &view);
    cx.update(|cx| {
        let sheet = s_.read(cx);
        assert_eq!(
            (sheet.target.mission.as_str(), sheet.target.project.as_str()),
            ("mission-A", "project-A")
        );
        assert_eq!(
            sheet.target.coordinator,
            Some(("lead".into(), COORDINATOR.into()))
        );
    });
    escape(cx, h, &view);
    assert!(s.writes().is_empty(), "the synthetic entry sends nothing");
    unmount(cx, m);
}

/// Synthetic faux Local only: the full D55 disclosure layout. Not live qualification.
fn consent_layout(cx: &mut HeadlessAppContext, width: f32, mode: ThemeMode) {
    let s = browser_server(true);
    let m = mount(cx, s.options.clone(), width, mode, None);
    let (h, view) = (m.h, m.view.clone());
    cx.update(|cx| gpui_kit::component::Theme::change(mode, None, cx));
    let target = Target {
        mission: "mission-A".into(),
        project: "project-A".into(),
        title: "Synthetic consent layout 日本語".into(),
        coordinator: Some(("lead".into(), "lead".into())),
    };
    let _ = open(cx, h, &view, &target, Purpose::Consent);
    cx.update_window(h, |_, w, _| {
        for id in [
            "workflow-data",
            "workflow-provider",
            "workflow-model",
            "workflow-account",
            "workflow-terms",
            "workflow-allowance",
            "workflow-retention",
            "workflow-expiry",
            "workflow-no-fallback",
            "workflow-assurance",
        ] {
            assert!(w.try_find(id).is_some(), "{id} is disclosed");
        }
    })
    .unwrap();
    // Compact rows are clipped and say so; the full disclosure is the package's own values.
    for (key, value) in LONG_DISCLOSURE {
        let row = painted(cx, h, row_id(key));
        assert_eq!(row.len(), 1);
        assert!(
            row[0].ends_with('…') && !row[0].contains("TAIL"),
            "{key} is compact"
        );
        let _ = value;
    }
    cx.update_window(h, |_, w, cx| {
        w.scroll(
            "workflow-body",
            gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(-4000.))),
            cx,
        )
    })
    .unwrap();
    settle(cx, h);
    click(cx, h, "workflow-disclosure-toggle");
    for (key, value) in LONG_DISCLOSURE {
        assert_eq!(
            painted(cx, h, row_id(key)),
            vec![value()],
            "{key} is complete"
        );
    }
    cx.update_window(h, |_, w, cx| {
        w.scroll(
            "workflow-body",
            gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(4000.))),
            cx,
        )
    })
    .unwrap();
    settle(cx, h);
    let (brief, decided) = disclose(cx, h);
    assert_eq!(brief, "# Plan\nShip the slice 日本語 👩‍💻");
    assert_eq!(decided, "D1  Design first\n\nD4  Then build");
    contained(cx, h, width);
    shot(
        cx,
        h,
        &format!(
            "synthetic-consent-{}-{}",
            width as u32,
            if mode == ThemeMode::Dark {
                "dark"
            } else {
                "light"
            }
        ),
    );
    escape(cx, h, &view);
    assert!(s.writes().is_empty(), "layout only; nothing is confirmed");
    unmount(cx, m);
}
