//! Mounted weekly Insights enable in the real LocalViewer over an owned synthetic Local
//! only: the Automations entry, one confirmation, enabled report navigation, existing
//! report chat reuse, the exact frozen payload, late preflight replies, a missing or
//! ambiguous model, refused and lost acknowledgements, Check/status/partial progress
//! across close and restart, the host's lost schedule ACK (pending receipt, enabled
//! status) and the Automations-off block. No real grant, history, provider turn,
//! schedule or visible window.
use super::*;
use crate::{
    app_shell::Page,
    insights::State,
    insights_enable::fixture as fx,
    mission_browser_fixture::{Reply, Server},
};
use gpui_kit::{
    AnyWindowHandle, Bounds, ElementId, HeadlessAppContext, WindowBounds, WindowOptions,
    component::ThemeMode, size, test::TestWindowExt,
};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Instant};

const REPORT: &str = "report-1";
const PREFLIGHT_A: &str = "/api/insights/enable/preflight?projectId=project-A&missionId=mission-A";
/// With the existing report chat pinned, as the host contract asks.
const PREFLIGHT_A_PINNED: &str = "/api/insights/enable/preflight?projectId=project-A&missionId=mission-A&reportSessionId=report-1";
const PREFLIGHT_B: &str = "/api/insights/enable/preflight?projectId=project-B&missionId=mission-B";
const STATUS_PATH: &str = "/api/insights/enable/status";
const STATUS: &str = "POST /api/insights/enable/status";
const OPERATIONS: &str = "POST /api/operations";
const TERRA_B: &str = "b/terra-6.1";
const DRAFT: &str = "Unsent reply 私の下書き 👩‍💻";

fn hello(automations: bool) -> Value {
    let mut caps = json!({"independentExecution":true,"insights":1,"insightsEnable":1});
    if automations {
        caps["automations"] = json!(1);
    }
    json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":caps})
}
fn server() -> Server {
    let s = Server::start().with_capability();
    s.reply("/api/hello", Reply::json(200, hello(true)));
    s.reply("GET /api/schedules", Reply::json(200, json!([])));
    let models = json!({"defaultModel":"anthropic/claude-sonnet","models":[
        {"id":fx::TERRA,"provider":"terra","name":"Terra 6.1","thinkingLevels":["off"]},
        {"id":TERRA_B,"provider":"b","name":"Terra 6.1","thinkingLevels":["off"]},
        {"id":"anthropic/claude-sonnet","provider":"anthropic","name":"Claude Sonnet","thinkingLevels":["off"]}
    ]});
    for path in [
        "/api/models?cwd=%2Fsynthetic%2FA",
        "/api/models?cwd=%2Fsynthetic%2FB",
    ] {
        s.reply(path, Reply::json(200, models.clone()));
    }
    s
}
/// Non-GET requests by path, drained.
pub(super) fn posts(s: &Server) -> Vec<(String, bool, Value)> {
    s.writes()
        .into_iter()
        .map(|(_, path, cap, body)| (path, cap, body))
        .collect()
}
fn sent_operations(all: &[(String, bool, Value)]) -> Vec<Value> {
    all.iter()
        .filter(|(p, _, _)| p == "/api/operations")
        .map(|(_, cap, body)| {
            assert!(*cap, "enable carries native confirmation authority");
            body.clone()
        })
        .collect()
}

pub(super) fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
#[track_caller]
pub(super) fn until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    check: impl Fn(&mut Window, &mut App) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update_window(h, |_, w, cx| check(w, cx)).unwrap() {
        assert!(
            Instant::now() < end,
            "bounded enable probe wait at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
pub(super) fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: impl Into<ElementId>) {
    let id: ElementId = id.into();
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
}
fn pick(cx: &mut HeadlessAppContext, h: AnyWindowHandle, label: &str) {
    until(cx, h, |w, _| w.try_find("popup-menu").is_some());
    cx.update_window(h, |_, w, cx| {
        let item = (0..24usize)
            .find(|i| {
                w.within("popup-menu")
                    .try_find(*i)
                    .is_some_and(|e| e.label() == Some(label))
            })
            .unwrap_or_else(|| panic!("menu has no {label:?} item"));
        w.within("popup-menu").click(item, cx);
    })
    .unwrap();
    settle(cx, h);
}
fn shot(cx: &mut HeadlessAppContext, h: AnyWindowHandle, dir: &Option<PathBuf>, name: &str) {
    if let Some(d) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(d.join(format!("enable-{name}.png")))
            .unwrap();
    }
}
pub(super) fn open(w: &mut Window) -> bool {
    w.try_find("insights-panel").is_some()
}
fn escape(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
    assert!(!cx.update_window(h, |_, w, _| open(w)).unwrap());
}
pub(super) fn contained(w: &mut Window, width: f32) {
    let p = w.find("insights-panel").bounds();
    assert!(
        p.left() >= px(0.) && p.right() <= px(width),
        "panel {p:?} exceeds {width}"
    );
    for id in ["insights-close", "insights-panel"] {
        if let Some(e) = w.try_find(id) {
            assert!(e.bounds().right() <= p.right() + px(0.5), "{id} clipped");
        }
    }
}

pub(super) struct Mounted {
    pub(super) h: AnyWindowHandle,
    pub(super) view: Entity<LocalViewer>,
    writer: Interaction,
    drain: async_channel::Receiver<crate::interaction::WriteState>,
    root: PathBuf,
    _commands: async_channel::Receiver<Command>,
}
/// \`report\` adds a report chat bound to mission A; the draft lives on chat "plain".
fn mount(
    cx: &mut HeadlessAppContext,
    s: &Server,
    width: f32,
    mode: ThemeMode,
    report: bool,
    root: Option<PathBuf>,
) -> Mounted {
    mount_with(cx, s, width, mode, report.then_some(REPORT), root)
}
/// `report` names a report chat bound to mission A; the draft lives on chat "plain".
pub(super) fn mount_with(
    cx: &mut HeadlessAppContext,
    s: &Server,
    width: f32,
    mode: ThemeMode,
    report: Option<&str>,
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
        std::env::temp_dir().join(format!("native-insights-enable-{}", uuid::Uuid::new_v4()))
    });
    let (writer, updates) = Interaction::start(s.options.clone(), Ok(root.clone()));
    let drain = updates.clone();
    let (client, commands) = LocalClient::synthetic_commands();
    let options = s.options.clone();
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
                    v.state.status = "Synthetic Insights enable fixture".into();
                    v.state.loaded = true;
                    v.state.list_loaded = true;
                    v.state.generation = 1;
                    v.generation = 1;
                    let mut chats = vec![crate::local_model::chat(&json!({"id":"plain","title":"Ordinary chat","projectId":"project-A","cwd":"/synthetic/A","mode":"build","state":"idle"})).unwrap()];
                    if let Some(report) = report {
                        chats.push(crate::local_model::chat(&json!({"id":report,"title":"Weekly Insights 日本語","projectId":"project-A","missionId":"mission-A","cwd":"/synthetic/A","mode":"build","state":"idle","role":"insights","model":fx::TERRA})).unwrap());
                    }
                    v.state.chats = Arc::new(chats);
                    v.state.projects = Arc::new(
                        crate::local_model::projects(&json!([
                            {"id":"project-A","name":"Synthetic project A","path":"/synthetic/A"},
                            {"id":"project-B","name":"Synthetic project B 日本語","path":"/synthetic/B"}
                        ]))
                        .unwrap(),
                    );
                    v.state.projects_loaded = true;
                    v.usage_options = Some(options.clone());
                    v.missions.update(cx, |m, _| m.options(options.clone()));
                    v.automations.update(cx, |a, _| a.connect(options.clone()));
                    v.page = Page::Chat;
                    v.selected = Some("plain".into());
                    v.title = "Ordinary chat".into();
                    v.editor
                        .update(cx, |e, cx| e.select("chat:plain".into(), true, false, w, cx));
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
/// Close the window and writer; returns the private root for a restart.
pub(super) fn unmount(cx: &mut HeadlessAppContext, m: Mounted) -> PathBuf {
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
            tokio::time::timeout(Duration::from_secs(3), async {
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
pub(super) fn panel(
    cx: &mut HeadlessAppContext,
    view: &Entity<LocalViewer>,
) -> Entity<crate::insights_view::Panel> {
    cx.update(|cx| view.read(cx).insights.as_ref().unwrap().0.clone())
}
pub(super) fn ready(view: &Entity<LocalViewer>, cx: &App) -> bool {
    view.read(cx)
        .insights
        .as_ref()
        .is_some_and(|(p, _)| p.read(cx).visible && p.read(cx).probe_ready())
}
pub(super) fn attempt(
    cx: &mut HeadlessAppContext,
    view: &Entity<LocalViewer>,
    slot: &str,
) -> Option<crate::insights::Attempt> {
    cx.update(|cx| {
        view.read(cx)
            .insights_book
            .as_ref()
            .and_then(|b| b.insights.get(slot).cloned())
    })
}
fn progress(
    cx: &mut HeadlessAppContext,
    view: &Entity<LocalViewer>,
) -> (&'static str, Option<String>) {
    let p = panel(cx, view);
    cx.update(|cx| p.read(cx).probe_enable())
}
/// The next run the status field shows, if any.
fn next_at(view: &Entity<LocalViewer>, cx: &App) -> Option<u64> {
    view.read(cx)
        .insights
        .as_ref()
        .and_then(|(p, _)| p.read(cx).probe_enable_next())
}
/// The Automations page's entry point, as a pointer user reaches it.
pub(super) fn from_automations(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
) {
    if cx.update(|cx| view.read(cx).page != Page::Automations) {
        click(cx, h, "nav-automations");
        until(cx, h, |w, _| w.try_find("automations-insights").is_some());
    }
    click(cx, h, "automations-insights");
    until(cx, h, |w, cx| open(w) && ready(view, cx));
}
pub(super) fn type_draft(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
) {
    let input = cx.update(|cx| view.read(cx).editor.read(cx).shell_probe().0);
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| i.focus(w, cx));
        w.input(DRAFT, cx);
    })
    .unwrap();
    settle(cx, h);
}
pub(super) fn draft(cx: &mut HeadlessAppContext, view: &Entity<LocalViewer>) -> String {
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

pub fn run_insights_enable_probe(cx: &mut HeadlessAppContext) {
    let reduced = cx.update(|cx| {
        let previous = cx.reduce_motion();
        cx.set_reduce_motion(true);
        previous
    });
    let dir = std::env::var_os("PILOT_NEXT_INSIGHTS_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    reuse_and_recovery(cx, &dir);
    lost_schedule_ack(cx, &dir);
    choice_and_refusals(cx, &dir);
    double_confirm(cx, &dir);
    for (width, mode) in [
        (680., ThemeMode::Light),
        (680., ThemeMode::Dark),
        (1100., ThemeMode::Dark),
    ] {
        render_only(cx, &dir, width, mode);
    }
    cx.update(|cx| cx.set_reduce_motion(reduced));
    println!(
        "insights enable: reuse/recovery, lost schedule ACK, choice/refusals, double confirmation and 3 render-only layouts passed"
    );
}

/// SHA-256 of the exact UTF-8 payload bytes, computed here rather than by the writer.
fn sha256(text: &str) -> String {
    use sha2::Digest as _;
    sha2::Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
/// The host's enabled status for whatever envelope arrives.
fn enabled_status(body: &Value) -> Value {
    let op: crate::delivery_store::Operation = serde_json::from_value(body.clone()).unwrap();
    fx::status(&op, "accepted", fx::enabled(&op), "enabled", None)
}
/// A clean accepted receipt for whatever envelope arrives, so a store or host refusal
/// can't hide a second send.
fn accept_enable(body: &Value) -> Value {
    enabled_status(body)["receipt"].clone()
}

/// Enable clicked twice in one frame with clean accepted ACKs: one command reaches the
/// writer and one operation is sent, with the preflight's exact bytes.
fn double_confirm(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>) {
    let width = 1100.;
    let s = server();
    let offer = fx::offer(
        "project-A",
        "mission-A",
        fx::TERRA,
        REPORT,
        fx::chat(REPORT, fx::TERRA),
        Value::Null,
    );
    s.reply(PREFLIGHT_A_PINNED, Reply::json(200, offer.clone()));
    let m = mount(cx, &s, width, ThemeMode::Light, true, None);
    let (h, view) = (m.h, m.view.clone());
    from_automations(cx, h, &view);
    let p = panel(cx, &view);
    assert!(posts(&s).is_empty(), "opening is passive");
    s.respond(OPERATIONS, accept_enable);
    s.respond(STATUS, enabled_status);
    let before = cx.update(|cx| p.read(cx).probe_requests().0);
    cx.update_window(h, |_, w, cx| {
        w.click("insights-enable-confirm", cx);
        w.click("insights-enable-confirm", cx);
    })
    .unwrap();
    settle(cx, h);
    // Every command handed over has its own outcome before anything is counted.
    until(cx, h, |_, cx| {
        ready(&view, cx)
            && p.read(cx).probe_requests().1.is_some()
            && p.read(cx).probe_enable() == ("settled", Some("On".into()))
    });
    let (after, latest) = cx.update(|cx| p.read(cx).probe_requests());
    assert!(
        matches!(latest, Some(crate::insights::Outcome::Accepted(_))),
        "{latest:?}"
    );
    let ops = sent_operations(&posts(&s));
    assert_eq!(
        (after - before, ops.len()),
        (1, 1),
        "one Enable click reached the writer and one operation was sent"
    );
    let op: crate::delivery_store::Operation = serde_json::from_value(ops[0].clone()).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&op.payload).unwrap(),
        offer["payload"],
        "the preflight payload, verbatim"
    );
    assert_eq!(
        op.payload_hash,
        sha256(&op.payload),
        "hash of the exact bytes"
    );
    let a = attempt(cx, &view, "enable:mission-A").unwrap();
    assert_eq!(
        (a.state, serde_json::to_value(&a.operation).unwrap()),
        (State::Accepted, ops[0].clone()),
        "the stored command is the one sent"
    );
    shot(cx, h, dir, "double-confirm");
    escape(cx, h);
    drop(p);
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);
    println!(
        "insights enable 1100 Light: double confirmation with clean accepted ACKs sends one command passed"
    );
}

/// Existing report chat: Automations → confirmation → lost ACK → close/restart → Check
/// (same envelope, partial progress) → enabled → open the report chat.
fn reuse_and_recovery(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>) {
    let width = 1100.;
    let s = server();
    let offer = fx::offer(
        "project-A",
        "mission-A",
        fx::TERRA,
        REPORT,
        fx::chat(REPORT, fx::TERRA),
        Value::Null,
    );
    s.reply(PREFLIGHT_A_PINNED, Reply::json(200, offer.clone()));
    let m = mount(cx, &s, width, ThemeMode::Light, true, None);
    let (h, view) = (m.h, m.view.clone());
    type_draft(cx, h, &view);

    // Opening is passive: preflight, missions and models are reads; nothing is sent.
    from_automations(cx, h, &view);
    let p = panel(cx, &view);
    cx.update_window(h, |_, wx, cx| {
        let pf = p.read(cx).probe_preflight().expect("checked offer");
        assert_eq!(
            pf.target_id, REPORT,
            "the existing report chat is the target"
        );
        assert_eq!(p.read(cx).probe_backlog().unwrap().mission_id, "mission-A");
        assert!(
            wx.try_find("insights-enable-backlog").is_none(),
            "a trusted binding offers no selector"
        );
        assert!(wx.try_find("insights-enable-reuse").is_some());
        assert!(
            wx.try_find("insights-enable-provider").is_some(),
            "provider processing is always disclosed"
        );
        assert_ne!(wx.find("insights-enable-confirm").disabled(), Some(true));
        assert_eq!(p.read(cx).probe_model_name().as_deref(), Some("Terra 6.1"));
        contained(wx, width);
    })
    .unwrap();
    shot(cx, h, dir, "confirm-reuse");
    escape(cx, h);
    assert!(posts(&s).is_empty(), "no activation before confirmation");

    // One explicit confirmation; the ACK is lost.
    from_automations(cx, h, &view);
    s.reply(OPERATIONS, Reply::json(0, Value::Null));
    s.reply(STATUS, Reply::json(503, json!({"error":"synthetic"})));
    click(cx, h, "insights-enable-confirm");
    until(cx, h, |w, _| w.try_find("insights-unconfirmed").is_some());
    let first = sent_operations(&posts(&s));
    assert_eq!(first.len(), 1);
    let op = &first[0];
    assert_eq!(op["kind"], "insights-enable");
    assert_eq!(op["targetId"], REPORT);
    assert_eq!(
        op["destination"],
        serde_json::to_value(s.options.host()).unwrap()
    );
    let payload: Value = serde_json::from_str(op["payload"].as_str().unwrap()).unwrap();
    assert_eq!(
        payload, offer["payload"],
        "the confirmed payload is the preflight's, verbatim"
    );
    let saved = attempt(cx, &view, "enable:mission-A").unwrap();
    assert_eq!(saved.state, State::Unknown);
    assert_eq!(serde_json::to_value(&saved.operation).unwrap(), *op);
    assert_eq!(progress(cx, &view).0, "progress");
    shot(cx, h, dir, "unknown");

    // Close and reopen, then restart the writer: the attempt stays, nothing is resent.
    escape(cx, h);
    from_automations(cx, h, &view);
    assert_eq!(progress(cx, &view).0, "progress");
    assert!(
        sent_operations(&posts(&s)).is_empty(),
        "reopening never replays"
    );
    escape(cx, h);
    assert_eq!(
        draft(cx, &view),
        DRAFT,
        "the composer draft survives the flow"
    );
    drop(p);
    let root = unmount(cx, m);
    let m = mount(cx, &s, width, ThemeMode::Light, true, Some(root));
    let (h, view) = (m.h, m.view.clone());
    let op = serde_json::from_value::<crate::delivery_store::Operation>(first[0].clone()).unwrap();
    s.reply(
        STATUS,
        Reply::json(
            200,
            fx::status(&op, "unknown", Value::Null, "not_found", None),
        ),
    );
    from_automations(cx, h, &view);
    assert_eq!(
        progress(cx, &view),
        ("progress", Some("Local has no record of it yet.".into()))
    );
    let after_restart = posts(&s);
    assert!(
        sent_operations(&after_restart).is_empty(),
        "restart never replays"
    );
    assert!(
        after_restart
            .iter()
            .all(|(p, _, b)| p == STATUS_PATH && b == &first[0])
    );

    // Check: Local has no record, so the same envelope goes once; it is still applying.
    let pending = fx::status(
        &op,
        "pending",
        fx::progress(&op, "chat_ready"),
        "partial",
        Some("schedule_unresolved"),
    );
    s.reply(OPERATIONS, Reply::json(200, pending["receipt"].clone()));
    s.hold(OPERATIONS);
    click(cx, h, "insights-check");
    until(cx, h, |_, _| {
        s.state
            .lock()
            .unwrap()
            .writes
            .iter()
            .any(|w| w.1 == "/api/operations")
    });
    s.reply(STATUS, Reply::json(200, pending.clone()));
    s.release(OPERATIONS);
    until(cx, h, |_, cx| {
        view.read(cx)
            .insights_book
            .as_ref()
            .and_then(|b| b.insights.get("enable:mission-A"))
            .is_some_and(|a| a.state == State::Pending)
    });
    let checked = posts(&s);
    let resent = sent_operations(&checked);
    assert_eq!(
        resent, first,
        "Check resends exactly the saved bytes and operation ID"
    );
    let p = panel(cx, &view);
    until(cx, h, |_, cx| p.read(cx).probe_ready());
    assert_eq!(
        progress(cx, &view),
        (
            "progress",
            Some(crate::insights_enable::reason_text("schedule_unresolved").into())
        ),
        "what Local sees now outranks the entered step"
    );
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-unconfirmed").is_some())
    })
    .unwrap();
    shot(cx, h, dir, "partial");

    // Check again: the host finished; status confirms both resources, nothing is resent.
    s.reply(
        STATUS,
        Reply::json(
            200,
            fx::status(&op, "accepted", fx::enabled(&op), "enabled", None),
        ),
    );
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| {
        p.read(cx).probe_ready() && p.read(cx).probe_enable() == ("settled", Some("On".into()))
    });
    assert!(
        sent_operations(&posts(&s)).is_empty(),
        "a pending receipt is never resent"
    );
    assert_eq!(
        attempt(cx, &view, "enable:mission-A").unwrap().state,
        State::Accepted
    );
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-enable-confirm").is_none());
        assert!(w.try_find("insights-unconfirmed").is_none());
        contained(w, width);
    })
    .unwrap();
    shot(cx, h, dir, "enabled");
    click(cx, h, "insights-enable-open");
    until(cx, h, |w, cx| {
        !open(w) && view.read(cx).selected.as_deref() == Some(REPORT)
    });
    assert_eq!(cx.update(|cx| view.read(cx).page.clone()), Page::Chat);

    // The report chat's settings show the weekly state and lead back to the same status.
    s.reply("/api/insights/sessions/report-1", Reply::json(200, json!({"sessionId":REPORT,"enabled":true,"revision":3,"projectId":"project-A","missionId":"mission-A","setupPending":false,"archived":false,"available":true,"disclosure":crate::insights::DISCLOSURE})));
    cx.update_window(h, |_, w, cx| w.click("history-menu", cx))
        .unwrap();
    settle(cx, h);
    pick(cx, h, "Insights settings…");
    until(cx, h, |w, _| w.try_find("insights-weekly-state").is_some());
    click(cx, h, "insights-weekly");
    until(cx, h, |w, cx| open(w) && ready(&view, cx));
    assert_eq!(progress(cx, &view), ("settled", Some("On".into())));
    escape(cx, h);
    assert!(sent_operations(&posts(&s)).is_empty());
    drop(p);
    let root = unmount(cx, m);

    // Restart with the report chat missing from the list: the retained command's report
    // is still known, so a fresh check pins it and refuses any substitute.
    let m = mount(cx, &s, width, ThemeMode::Light, false, Some(root));
    let (h, view) = (m.h, m.view.clone());
    s.reply(
        STATUS,
        Reply::json(
            200,
            fx::status(
                &op,
                "accepted",
                fx::enabled(&op),
                "blocked",
                Some("report_identity_unavailable"),
            ),
        ),
    );
    from_automations(cx, h, &view);
    let p = panel(cx, &view);
    assert_eq!(
        progress(cx, &view),
        (
            "settled",
            Some(crate::insights_enable::reason_text("report_identity_unavailable").into())
        )
    );
    let mut missing = fx::blocked(
        "project-A",
        "mission-A",
        json!({"state":"unavailable","reason":"catalog_unavailable"}),
        "report_identity_unavailable",
    );
    missing["targetId"] = json!(REPORT);
    s.reply(PREFLIGHT_A_PINNED, Reply::json(200, missing));
    click(cx, h, "insights-enable-again");
    until(cx, h, |_, cx| {
        p.read(cx).probe_ready() && p.read(cx).probe_gate() == Some("checked")
    });
    cx.update_window(h, |_, w, cx| {
        let pf = p.read(cx).probe_preflight().unwrap();
        assert_eq!(pf.reason.as_deref(), Some("report_identity_unavailable"));
        assert!(pf.request().is_none());
        assert_eq!(p.read(cx).probe_backlog().unwrap().mission_id, "mission-A");
        assert!(w.try_find("insights-enable-blocked").is_some());
        assert_eq!(w.find("insights-enable-confirm").disabled(), Some(true));
    })
    .unwrap();
    // Local offering another target for the pinned report is refused, never confirmable.
    s.reply(
        PREFLIGHT_A_PINNED,
        Reply::json(200, fx::ready("project-A", "mission-A", fx::TERRA)),
    );
    click(cx, h, "insights-enable-retry");
    until(cx, h, |_, cx| {
        p.read(cx).probe_ready() && p.read(cx).probe_gate() == Some("failed")
    });
    cx.update_window(h, |_, w, _| {
        assert_eq!(w.find("insights-enable-confirm").disabled(), Some(true))
    })
    .unwrap();
    assert!(
        !s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(_, path)| path == PREFLIGHT_A),
        "a known report is always pinned"
    );
    assert!(
        sent_operations(&posts(&s)).is_empty(),
        "refusals send nothing"
    );
    shot(cx, h, dir, "pinned-refused");
    escape(cx, h);
    drop(p);
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);
    println!(
        "insights enable reuse 1100 Light: passive open, exact payload, lost ACK, reopen/restart without replay, Check resend of same bytes, partial, enabled, report navigation, chat settings, retained report pinning and substitute refusal passed"
    );
}

/// Status reads only, each carrying exactly the retained envelope; never an operation.
#[track_caller]
fn status_reads_only(s: &Server, envelope: &Value) {
    let all = posts(s);
    assert!(sent_operations(&all).is_empty(), "nothing is resent");
    assert!(
        all.iter()
            .all(|(p, _, b)| p == STATUS_PATH && b == envelope),
        "only passive status reads of the same envelope"
    );
}
/// The retained attempt is the same envelope and still unaccepted, with no result.
#[track_caller]
fn retained(
    cx: &mut HeadlessAppContext,
    view: &Entity<LocalViewer>,
    envelope: &Value,
    state: State,
) {
    let a = attempt(cx, view, "enable:mission-A").expect("the attempt is retained");
    assert_eq!(serde_json::to_value(&a.operation).unwrap(), *envelope);
    assert_eq!(a.state, state);
    if state != State::Accepted {
        assert!(a.result.is_none(), "no acceptance is invented");
    }
}

/// The host placed the weekly rule but its schedule ACK was lost: the receipt stays pending
/// at `schedule_pending` while present status is enabled (insights-enable.test.ts). The
/// app's own ACK is lost too. Check is a read here, the attempt stays pending across close
/// and restart, a later acceptance settles it and a later block names no cause.
fn lost_schedule_ack(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>) {
    let width = 680.;
    let s = server();
    s.reply(
        PREFLIGHT_A_PINNED,
        Reply::json(
            200,
            fx::offer(
                "project-A",
                "mission-A",
                fx::TERRA,
                REPORT,
                fx::chat(REPORT, fx::TERRA),
                Value::Null,
            ),
        ),
    );
    let m = mount(cx, &s, width, ThemeMode::Light, true, None);
    let (h, view) = (m.h, m.view.clone());
    from_automations(cx, h, &view);
    s.reply(OPERATIONS, Reply::json(0, Value::Null));
    s.reply(STATUS, Reply::json(503, json!({"error":"synthetic"})));
    click(cx, h, "insights-enable-confirm");
    until(cx, h, |w, cx| {
        w.try_find("insights-unconfirmed").is_some() && ready(&view, cx)
    });
    let first = sent_operations(&posts(&s));
    assert_eq!(first.len(), 1);
    let envelope = first[0].clone();
    let op = serde_json::from_value::<crate::delivery_store::Operation>(envelope.clone()).unwrap();
    retained(cx, &view, &envelope, State::Unknown);
    let lost = fx::status(
        &op,
        "pending",
        fx::progress(&op, "schedule_pending"),
        "enabled",
        None,
    );

    // Check: Local holds a pending receipt, so the status read is the whole Check.
    s.reply(STATUS, Reply::json(200, lost.clone()));
    click(cx, h, "insights-check");
    until(cx, h, |w, cx| {
        w.try_find("insights-unconfirmed").is_some()
            && ready(&view, cx)
            && view
                .read(cx)
                .insights_book
                .as_ref()
                .and_then(|b| b.insights.get("enable:mission-A"))
                .is_some_and(|a| a.state == State::Pending)
    });
    status_reads_only(&s, &envelope);
    retained(cx, &view, &envelope, State::Pending);
    assert_eq!(progress(cx, &view), ("progress", Some("On".into())));
    cx.update_window(h, |_, w, _| {
        assert!(
            w.try_find("insights-unconfirmed").is_some(),
            "a pending receipt keeps Check"
        );
        assert!(w.try_find("insights-enable-confirm").is_none());
        assert!(w.try_find("insights-enable-open").is_none());
        assert!(w.try_find("insights-when-note").is_some(), "next run shown");
        contained(w, width);
    })
    .unwrap();
    shot(cx, h, dir, "lost-schedule-ack");

    // Check again with the receipt still pending at the same step: the view re-reads
    // status even though the saved state is unchanged, so a moved next run shows.
    let week = 7 * 24 * 3_600_000;
    let mut moved = lost.clone();
    moved["nextAt"] = json!(fx::NEXT + week);
    s.reply(STATUS, Reply::json(200, moved));
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| {
        ready(&view, cx) && next_at(&view, cx) == Some(fx::NEXT + week)
    });
    assert_eq!(progress(cx, &view), ("progress", Some("On".into())));
    status_reads_only(&s, &envelope);
    retained(cx, &view, &envelope, State::Pending);

    // A slow read is overtaken: Local now reports the report chat unusable, same pending
    // step. The newer status wins; the older reply never brings On back.
    let slow = Reply {
        delay_ms: 2_000,
        ..Reply::json(200, lost.clone())
    };
    s.reply(STATUS, slow);
    click(cx, h, "insights-check");
    // Check's own read, then the view's re-read, both slow; Check has replied.
    until(cx, h, |w, _| {
        s.write_count() >= 2 && w.try_find("insights-unconfirmed").is_some()
    });
    let stale_sent = Instant::now();
    let mut blocked = fx::status(
        &op,
        "pending",
        fx::progress(&op, "schedule_pending"),
        "blocked",
        Some("report_chat_unavailable"),
    );
    assert_eq!(
        blocked["receipt"], lost["receipt"],
        "same receipt, same step"
    );
    blocked["nextAt"] = Value::Null;
    s.reply(STATUS, Reply::json(200, blocked.clone()));
    click(cx, h, "insights-check");
    let words = crate::insights_enable::reason_text("report_chat_unavailable");
    until(cx, h, |_, cx| {
        ready(&view, cx)
            && view
                .read(cx)
                .insights
                .as_ref()
                .is_some_and(|(p, _)| p.read(cx).probe_enable() == ("progress", Some(words.into())))
    });
    std::thread::sleep(Duration::from_millis(2_300).saturating_sub(stale_sent.elapsed()));
    settle(cx, h);
    assert_eq!(
        progress(cx, &view),
        ("progress", Some(words.into())),
        "the overtaken reply is fenced"
    );
    assert_eq!(cx.update(|cx| next_at(&view, cx)), None);
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-unconfirmed").is_some());
        assert!(w.try_find("insights-when-note").is_none(), "no next run");
        assert!(
            w.try_find("insights-enable-again").is_none(),
            "a pending command can't be set up again"
        );
    })
    .unwrap();
    status_reads_only(&s, &envelope);
    retained(cx, &view, &envelope, State::Pending);
    shot(cx, h, dir, "pending-blocked");

    // Close and reopen, then restart: the pending attempt stays, nothing is resent.
    escape(cx, h);
    from_automations(cx, h, &view);
    assert_eq!(progress(cx, &view), ("progress", Some(words.into())));
    escape(cx, h);
    let root = unmount(cx, m);
    let m = mount(cx, &s, width, ThemeMode::Light, true, Some(root));
    let (h, view) = (m.h, m.view.clone());
    from_automations(cx, h, &view);
    assert_eq!(progress(cx, &view), ("progress", Some(words.into())));
    retained(cx, &view, &envelope, State::Pending);
    status_reads_only(&s, &envelope);

    // Later: host recovery accepted it. Check adopts that receipt; nothing is resent.
    s.reply(
        STATUS,
        Reply::json(
            200,
            fx::status(&op, "accepted", fx::enabled(&op), "enabled", None),
        ),
    );
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| {
        ready(&view, cx)
            && view
                .read(cx)
                .insights
                .as_ref()
                .is_some_and(|(p, _)| p.read(cx).probe_enable() == ("settled", Some("On".into())))
    });
    retained(cx, &view, &envelope, State::Accepted);
    status_reads_only(&s, &envelope);
    escape(cx, h);
    let root = unmount(cx, m);

    // Later still: the report chat became unusable. The words name no cause.
    let m = mount(cx, &s, width, ThemeMode::Light, true, Some(root));
    let (h, view) = (m.h, m.view.clone());
    s.reply(
        STATUS,
        Reply::json(
            200,
            fx::status(
                &op,
                "accepted",
                fx::enabled(&op),
                "blocked",
                Some("report_chat_unavailable"),
            ),
        ),
    );
    from_automations(cx, h, &view);
    assert_eq!(progress(cx, &view), ("settled", Some(words.into())));
    assert!(!words.contains("archived") && !words.contains("revoked"));
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-enable-again").is_some());
        contained(w, width);
    })
    .unwrap();
    retained(cx, &view, &envelope, State::Accepted);
    status_reads_only(&s, &envelope);
    shot(cx, h, dir, "lost-schedule-blocked");
    escape(cx, h);
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);
    println!(
        "insights enable lost schedule ACK 680 Light: pending+enabled On with Check kept, same-step re-read of moved next run, pending+blocked overtaking a fenced slow read, reopen/restart without replay, later accepted, later blocked with cause-neutral words passed"
    );
}

/// No binding: choose a backlog in the confirmation; late replies, missing and ambiguous
/// models, Automations off and a refused confirmation.
fn choice_and_refusals(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>) {
    let width = 680.;
    let s = server();
    let m = mount(cx, &s, width, ThemeMode::Dark, false, None);
    let (h, view) = (m.h, m.view.clone());
    type_draft(cx, h, &view);
    from_automations(cx, h, &view);
    let p = panel(cx, &view);
    cx.update_window(h, |_, w, cx| {
        assert!(p.read(cx).probe_backlog().is_none());
        assert!(
            p.read(cx).probe_gate().is_none(),
            "no preflight before a backlog is chosen"
        );
        assert_eq!(w.find("insights-enable-confirm").disabled(), Some(true));
        assert!(w.try_find("insights-enable-backlog").is_some());
        contained(w, width);
    })
    .unwrap();
    shot(cx, h, dir, "choose");

    // A slow reply for the first choice never replaces the second.
    s.reply(
        PREFLIGHT_A,
        Reply::json(
            200,
            fx::blocked(
                "project-A",
                "mission-A",
                json!({"state":"unavailable","reason":"not_found"}),
                "model_unavailable",
            ),
        ),
    );
    s.hold(&format!("GET {PREFLIGHT_A}"));
    s.reply(
        PREFLIGHT_B,
        Reply::json(200, fx::ready("project-B", "mission-B", fx::TERRA)),
    );
    click(cx, h, "insights-enable-backlog");
    pick(cx, h, "Same mission 日本語 · Synthetic project A");
    click(cx, h, "insights-enable-backlog");
    pick(cx, h, "Same mission 日本語 · Synthetic project B 日本語");
    until(cx, h, |_, cx| {
        p.read(cx)
            .probe_preflight()
            .is_some_and(|pf| pf.mission_id == "mission-B")
    });
    s.release(&format!("GET {PREFLIGHT_A}"));
    std::thread::sleep(Duration::from_millis(50));
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        let pf = p.read(cx).probe_preflight().unwrap();
        assert_eq!(
            (pf.mission_id.as_str(), pf.request().is_some()),
            ("mission-B", true)
        );
        assert_ne!(w.find("insights-enable-confirm").disabled(), Some(true));
    })
    .unwrap();

    // Missing model, on reopening: blocked, no fallback, nothing to confirm.
    s.reply(
        PREFLIGHT_B,
        Reply::json(
            200,
            fx::blocked(
                "project-B",
                "mission-B",
                json!({"state":"unavailable","reason":"not_found"}),
                "model_unavailable",
            ),
        ),
    );
    escape(cx, h);
    from_automations(cx, h, &view);
    assert_eq!(
        cx.update(|cx| p.read(cx).probe_backlog().unwrap().mission_id),
        "mission-B",
        "the choice survives reopening"
    );
    cx.update_window(h, |_, w, cx| {
        assert!(p.read(cx).probe_preflight().unwrap().request().is_none());
        assert!(w.try_find("insights-enable-blocked").is_some());
        assert_eq!(w.find("insights-enable-confirm").disabled(), Some(true));
    })
    .unwrap();
    shot(cx, h, dir, "missing-model");

    // Ambiguous: the user picks an exact ID; the explicit read honors it.
    s.reply(
        PREFLIGHT_B,
        Reply::json(
            200,
            fx::blocked(
                "project-B",
                "mission-B",
                json!({"state":"ambiguous","ids":[fx::TERRA, TERRA_B]}),
                "model_ambiguous",
            ),
        ),
    );
    click(cx, h, "insights-enable-retry");
    until(cx, h, |w, cx| {
        p.read(cx).probe_ready() && w.try_find("insights-enable-model").is_some()
    });
    s.reply(
        &format!("{PREFLIGHT_B}&model=b%2Fterra-6.1"),
        Reply::json(200, fx::ready("project-B", "mission-B", TERRA_B)),
    );
    click(cx, h, "insights-enable-model");
    pick(cx, h, TERRA_B);
    until(cx, h, |_, cx| {
        p.read(cx)
            .probe_preflight()
            .is_some_and(|pf| pf.request().is_some())
    });
    assert!(posts(&s).is_empty(), "choices and checks are reads");

    // Refused: a durable rejection is final and shown; a fresh confirmation stays possible.
    let offered = cx.update(|cx| p.read(cx).probe_preflight().unwrap().frozen.unwrap().model);
    assert_eq!(offered, TERRA_B);
    s.reply(OPERATIONS, Reply::json(500, json!({"error":"synthetic"})));
    click(cx, h, "insights-enable-confirm");
    until(cx, h, |w, _| w.try_find("insights-unconfirmed").is_some());
    let sent = sent_operations(&posts(&s));
    let op: crate::delivery_store::Operation = serde_json::from_value(sent[0].clone()).unwrap();
    let payload: Value = serde_json::from_str(&op.payload).unwrap();
    assert_eq!(payload["model"], TERRA_B, "the explicit choice is frozen");
    s.reply(
        STATUS,
        Reply::json(
            200,
            fx::status(
                &op,
                "rejected",
                Value::Null,
                "blocked",
                Some("Insights confirmation changed; refresh preflight"),
            ),
        ),
    );
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| {
        view.read(cx)
            .insights_book
            .as_ref()
            .and_then(|b| b.insights.get("enable:mission-B"))
            .is_some_and(|a| a.state == State::Rejected)
    });
    cx.update_window(h, |_, w, cx| {
        assert_eq!(p.read(cx).probe_enable().0, "confirm");
        assert!(w.try_find("insights-outcome").is_some());
    })
    .unwrap();
    assert!(
        sent_operations(&posts(&s)).is_empty(),
        "a rejected receipt is never resent"
    );
    shot(cx, h, dir, "refused");
    escape(cx, h);

    // Automations off: a clear block that leads to the existing switch; nothing switches.
    s.reply("/api/hello", Reply::json(200, hello(false)));
    from_automations(cx, h, &view);
    let p = panel(cx, &view);
    click(cx, h, "insights-enable-backlog");
    pick(cx, h, "Same mission 日本語 · Synthetic project B 日本語");
    until(cx, h, |_, cx| {
        p.read(cx).probe_gate() == Some("automations-off")
    });
    cx.update_window(h, |_, w, _| {
        assert_eq!(w.find("insights-enable-confirm").disabled(), Some(true));
        assert!(w.find("insights-enable-settings").visible());
    })
    .unwrap();
    shot(cx, h, dir, "automations-off");
    click(cx, h, "insights-enable-settings");
    until(cx, h, |w, cx| {
        !open(w) && view.read(cx).settings_window.is_some()
    });
    cx.update(|cx| {
        assert_eq!(
            view.read(cx).settings.read(cx).category,
            crate::settings_view::Category::Chats
        );
    });
    assert!(posts(&s).is_empty(), "showing the switch changes nothing");
    if let Some(handle) = cx.update(|cx| view.read(cx).settings_window) {
        cx.update_window(handle, |_, w, _| w.remove_window())
            .unwrap();
        cx.run_until_parked();
    }
    assert_eq!(
        draft(cx, &view),
        DRAFT,
        "the composer draft survives the flow"
    );
    drop(p);
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);
    println!(
        "insights enable choice 680 Dark: chooser, late reply, missing/ambiguous model, refusal, automations off passed"
    );
}

fn render_only(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>, width: f32, mode: ThemeMode) {
    let s = server();
    s.reply(
        PREFLIGHT_A_PINNED,
        Reply::json(
            200,
            fx::offer(
                "project-A",
                "mission-A",
                fx::TERRA,
                REPORT,
                fx::chat(REPORT, fx::TERRA),
                Value::Null,
            ),
        ),
    );
    let m = mount(cx, &s, width, mode, true, None);
    let (h, view) = (m.h, m.view.clone());
    let tag = format!("{}-{mode:?}", width as u32);
    from_automations(cx, h, &view);
    click(cx, h, "insights-enable-details");
    cx.update_window(h, |_, w, _| {
        contained(w, width);
        for id in [
            "insights-enable-sample",
            "insights-enable-readonly",
            "insights-enable-model-id",
            "insights-field-budget",
            "insights-field-when",
        ] {
            assert!(w.try_find(id).is_some(), "{id}");
        }
        assert!(
            w.find("insights-enable-confirm").visible(),
            "actions stay pinned"
        );
    })
    .unwrap();
    shot(cx, h, dir, &format!("confirm-{tag}"));
    escape(cx, h);
    assert!(posts(&s).is_empty(), "rendering never writes");
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);
    println!("insights enable render-only {tag} passed");
}
