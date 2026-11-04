//! Mounted Insights entry points in the real LocalViewer, over an owned synthetic Local
//! only: the report chat's backlog button and settings, finding decisions from the
//! mission's Tasks rows, revocation and setup. The standalone pixel probe is
//! `insights_probe`. No real grant, private history, provider turn, schedule or visible window.
use super::*;
use crate::{
    app_shell::Page,
    insights::{DISCLOSURE, Lifecycle, State},
    mission_browser_fixture::{self as f, Reply, Server},
    mission_browser_view::Tab,
};
use gpui_kit::{
    AnyWindowHandle, Bounds, ElementId, HeadlessAppContext, ScrollDelta, WindowBounds,
    WindowOptions, component::ThemeMode, point, size, test::TestWindowExt,
};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Instant};

const REPORT: &str = "report-1";
const STATUS: &str = "/api/insights/sessions/report-1";
const FINDINGS: &str = "/api/insights/sessions/report-1/findings";
const MORE: &str = "/api/insights/sessions/report-1/findings?cursor=20";
const MODELS: &str = "/api/models?cwd=%2Fsynthetic%2FA";
const OPERATIONS: &str = "POST /api/operations";
const RECEIPT: &str = "POST /api/operations/receipt";
const LONG_MODEL: &str =
    "A deliberately long model display name that must wrap inside the setup panel";

fn key(ix: usize) -> String {
    format!("{ix:08x}-0000-4000-8000-{ix:012x}")
}
fn title(ix: usize) -> String {
    if ix == 0 {
        "Cut repeated full-repository scans in long review chats: agents re-read apps/desktop/src/local_view_navigation_and_sidebar_reconciliation_module.rs after every compaction 日本語 👩‍💻".to_owned()
    } else {
        format!("Finding {ix}: tighten scoped-check guidance so agents choose one native target")
    }
}
fn lifecycle(ix: usize) -> &'static str {
    [
        "proposed",
        "approved",
        "in_progress",
        "shipped",
        "deferred",
        "dismissed",
        "verified",
    ][ix % 7]
}
fn finding(ix: usize, life: &str, revision: u64) -> Value {
    let targets = match ix % 3 {
        0 if ix == 0 => json!([
            {"projectId":"project-A","label":"Pilot (apps/desktop and packages/kernel)"},
            {"projectId":"project-B","label":"Personal dotfiles with a deliberately long project label"}
        ]),
        0 => json!([]),
        _ => json!([{"projectId":"project-A","label":"Pilot"}]),
    };
    let cost = if ix.is_multiple_of(2) {
        let later = if ix == 2 { "−18% input tokens" } else { "" };
        json!({"baseline":"41 tool calls per review","assumptions":"Same volume","estimate":"−30% input tokens","qualityRisks":"Stale summaries","laterResult":later})
    } else {
        Value::Null
    };
    let priority = ["high", "medium", "low"][ix % 3];
    json!({"key":key(ix),"revision":revision,"taskId":format!("task-{ix}"),"lifecycle":life,"title":title(ix),"priority":priority,"targets":targets,"cost":cost})
}
fn page(range: std::ops::Range<usize>, next: Option<u64>, first: &str) -> Value {
    let items: Vec<Value> = range
        .map(|ix| {
            if ix == 0 {
                finding(0, first, if first == "proposed" { 1 } else { 2 })
            } else {
                finding(ix, lifecycle(ix), ix as u64 + 1)
            }
        })
        .collect();
    json!({"items":items,"nextCursor":next})
}
fn status(enabled: bool, revision: u64) -> Value {
    json!({"sessionId":REPORT,"enabled":enabled,"revision":revision,"projectId":"project-A","missionId":"mission-A","setupPending":false,"archived":false,"available":true,"disclosure":DISCLOSURE})
}
fn models() -> Value {
    json!({"defaultModel":"anthropic/claude-sonnet","models":[
        {"id":"anthropic/claude-sonnet","provider":"anthropic","name":"Claude Sonnet","thinkingLevels":["off","low","high"],"thinking":"low"},
        {"id":"openai/gpt-long","provider":"openai","name":LONG_MODEL,"thinkingLevels":["off"]}
    ]})
}
/// Mission A's tasks are the findings' own tasks, in one phase.
fn detail() -> Value {
    let mut d = f::detail("mission-A");
    d["phases"] = json!([{"id":"phase-f","name":"Findings","order":1}]);
    d["tasks"] = json!((0..23).map(|ix| json!({"id":format!("task-{ix}"),"number":10 + ix,"title":title(ix),"status":"todo","order":ix,"phaseId":"phase-f"})).collect::<Vec<_>>());
    d["mission"]["tasksTotal"] = json!(23);
    d["mission"]["tasksDone"] = json!(0);
    d
}
fn server() -> Server {
    let s = Server::start().with_capability();
    s.reply(
        "/api/hello",
        Reply::json(
            200,
            json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"insights":1}}),
        ),
    );
    s.reply(STATUS, Reply::json(200, status(true, 3)));
    s.reply(
        FINDINGS,
        Reply::json(200, page(0..20, Some(20), "proposed")),
    );
    s.reply(MORE, Reply::json(200, page(20..23, None, "proposed")));
    s.reply(MODELS, Reply::json(200, models()));
    s.reply("/api/missions/mission-A", Reply::json(200, detail()));
    s
}
fn receipt(op: &crate::delivery_store::Operation, state: &str, result: Value) -> Value {
    json!({"operationId":op.operation_id,"payloadHash":op.payload_hash,"targetId":op.target_id,"destination":op.destination,"state":state,"result":result})
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
    check: impl Fn(&mut Window, &mut App) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update_window(h, |_, w, cx| check(w, cx)).unwrap() {
        assert!(
            Instant::now() < end,
            "bounded Insights probe wait at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: impl Into<ElementId>) {
    let id: ElementId = id.into();
    reveal(cx, h, id.clone());
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
}
/// Scroll the panel body so a target inside it is visible.
fn reveal(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: ElementId) {
    cx.update_window(h, |_, w, cx| {
        if w.try_find("insights-body").is_none() || w.find(id.clone()).visible() {
            return;
        }
        let body = w.find("insights-body").bounds();
        let target = w.find(id.clone()).bounds();
        w.scroll(
            "insights-body",
            ScrollDelta::Pixels(point(px(0.), body.top() + px(24.) - target.top())),
            cx,
        );
    })
    .unwrap();
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
fn menu_labels(cx: &mut HeadlessAppContext, h: AnyWindowHandle) -> Vec<String> {
    until(cx, h, |w, _| w.try_find("popup-menu").is_some());
    cx.update_window(h, |_, w, _| {
        (0..24usize)
            .filter_map(|i| {
                w.within("popup-menu")
                    .try_find(i)
                    .and_then(|e| e.label().map(str::to_owned))
            })
            .collect()
    })
    .unwrap()
}
fn shot(cx: &mut HeadlessAppContext, h: AnyWindowHandle, dir: &Option<PathBuf>, name: &str) {
    if let Some(d) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(d.join(format!("{name}.png")))
            .unwrap();
    }
}
fn panel_open(w: &mut Window) -> bool {
    w.try_find("insights-panel").is_some()
}
fn escape(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
}
fn closed(cx: &mut HeadlessAppContext, h: AnyWindowHandle) -> bool {
    !cx.update_window(h, |_, w, _| panel_open(w)).unwrap()
}
fn contained(w: &mut Window, width: f32) {
    let p = w.find("insights-panel").bounds();
    assert!(
        p.left() >= px(0.) && p.right() <= px(width),
        "panel {p:?} exceeds {width}"
    );
}

struct Mounted {
    h: AnyWindowHandle,
    view: Entity<LocalViewer>,
    writer: Interaction,
    drain: async_channel::Receiver<crate::interaction::WriteState>,
    root: PathBuf,
    _commands: async_channel::Receiver<Command>,
}
fn mount(cx: &mut HeadlessAppContext, s: &Server, width: f32, mode: ThemeMode) -> Mounted {
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
    let root = std::env::temp_dir().join(format!("native-insights-{}", uuid::Uuid::new_v4()));
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
                    v.state.status = "Synthetic Insights fixture".into();
                    v.state.loaded = true;
                    v.state.list_loaded = true;
                    v.state.generation = 1;
                    v.generation = 1;
                    v.state.chats = Arc::new(vec![
                        crate::local_model::chat(&json!({"id":REPORT,"title":"Weekly Insights 日本語","projectId":"project-A","missionId":"mission-A","cwd":"/synthetic/A","mode":"ask","state":"idle","role":"insights","model":"anthropic/claude-sonnet"})).unwrap(),
                        crate::local_model::chat(&json!({"id":"plain","title":"Ordinary chat","projectId":"project-A","cwd":"/synthetic/A","mode":"ask","state":"idle"})).unwrap(),
                    ]);
                    v.state.projects = Arc::new(
                        crate::local_model::projects(&json!([{"id":"project-A","name":"Synthetic Insights project","path":"/synthetic/A"}]))
                            .unwrap(),
                    );
                    v.state.projects_loaded = true;
                    v.usage_options = Some(options.clone());
                    v.missions.update(cx, |m, _| m.options(options.clone()));
                    v.page = Page::Chat;
                    v.selected = Some(REPORT.into());
                    v.title = "Weekly Insights 日本語".into();
                    v.editor.update(cx, |e, cx| {
                        e.select(format!("chat:{REPORT}"), true, false, w, cx)
                    });
                    v.rebuild_nav(w, cx);
                    v.listen_writes(updates, w, cx);
                    v
                })
            },
        )
        .unwrap()
    });
    until(cx, h, |_, cx| view.read(cx).editor.read(cx).ready());
    // TestPlatform's hidden window only, never an OS window.
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
fn unmount(cx: &mut HeadlessAppContext, m: Mounted, s: &Server, draft: Option<&str>) {
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
    let store = Store::open(root.clone(), s.options.host()).unwrap();
    if let Some(draft) = draft {
        assert_eq!(store.book.drafts[&format!("chat:{REPORT}")].text, draft);
    }
    drop(store);
    drop(writer);
    let _ = std::fs::remove_dir_all(root);
}
fn panel(
    cx: &mut HeadlessAppContext,
    view: &Entity<LocalViewer>,
) -> Entity<crate::insights_view::Panel> {
    cx.update(|cx| view.read(cx).insights.as_ref().unwrap().0.clone())
}
fn attempt(
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
fn settled_as(view: &Entity<LocalViewer>, slot: &str, state: State, cx: &App) -> bool {
    view.read(cx)
        .insights_book
        .as_ref()
        .and_then(|b| b.insights.get(slot))
        .is_some_and(|a| a.state == state)
}
fn lifecycle_of(view: &Entity<LocalViewer>, task: &str, cx: &App) -> Option<Lifecycle> {
    view.read(cx)
        .missions
        .read(cx)
        .tasks_browser
        .read(cx)
        .probe_lifecycle(task)
}
/// The report chat's … menu, then Insights settings….
fn open_settings(cx: &mut HeadlessAppContext, h: AnyWindowHandle, view: &Entity<LocalViewer>) {
    cx.update_window(h, |_, w, cx| w.click("history-menu", cx))
        .unwrap();
    settle(cx, h);
    pick(cx, h, "Insights settings…");
    let p = panel(cx, view);
    until(cx, h, |w, cx| {
        panel_open(w) && w.try_find("insights-state").is_some() && p.read(cx).probe_ready()
    });
}
/// The header's backlog button, onto the mission's Tasks with its findings.
fn open_backlog(cx: &mut HeadlessAppContext, h: AnyWindowHandle, view: &Entity<LocalViewer>) {
    cx.update_window(h, |_, w, cx| {
        let entry = w.find("insights-access");
        assert!(entry.visible());
        w.click("insights-access", cx);
    })
    .unwrap();
    to_tasks(cx, h, view);
}
fn to_tasks(cx: &mut HeadlessAppContext, h: AnyWindowHandle, view: &Entity<LocalViewer>) {
    until(cx, h, |w, cx| {
        let v = view.read(cx);
        v.page == Page::Mission(f::key("mission-A"))
            && v.missions.read(cx).tab == Tab::Tasks
            && lifecycle_of(view, "task-22", cx).is_some()
            && w.try_find("mission-task-insight-task-0").is_some()
    });
}
/// A row's own context menu, then one decision.
fn decide(cx: &mut HeadlessAppContext, h: AnyWindowHandle, task: &str, label: &str) {
    cx.update_window(h, |_, w, cx| {
        w.right_click(format!("mission-tasks-item-{task}"), cx)
    })
    .unwrap();
    pick(cx, h, label);
    until(cx, h, |w, _| {
        panel_open(w) && w.try_find("insights-decide-title").is_some()
    });
}
fn open_setup(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    click(cx, h, "mission-tab-overview");
    crate::mission_browser_view::probe_menu_command(cx, h, "Set up Insights chat…");
    until(cx, h, |w, _| {
        panel_open(w) && w.try_find("insights-model").is_some()
    });
}
fn back_to_chat(cx: &mut HeadlessAppContext, h: AnyWindowHandle, view: &Entity<LocalViewer>) {
    // The same open path a sidebar row uses.
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| {
            let chat = v
                .state
                .chats
                .iter()
                .find(|c| c.id == REPORT)
                .cloned()
                .unwrap();
            v.open(chat, w, cx);
        })
    })
    .unwrap();
    until(cx, h, |w, cx| {
        view.read(cx).page == Page::Chat
            && view.read(cx).selected.as_deref() == Some(REPORT)
            && w.try_find("insights-access").is_some()
    });
}

pub fn run_insights_native_probe(cx: &mut HeadlessAppContext) {
    let reduced_motion = cx.update(|cx| {
        let previous = cx.reduce_motion();
        cx.set_reduce_motion(true);
        previous
    });
    let dir = std::env::var_os("PILOT_NEXT_INSIGHTS_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    full(cx, &dir);
    for (width, mode) in [
        (680., ThemeMode::Light),
        (680., ThemeMode::Dark),
        (1100., ThemeMode::Dark),
    ] {
        render_only(cx, &dir, width, mode);
    }
    cx.update(|cx| cx.set_reduce_motion(reduced_motion));
    println!("insights: full flow and 3 render-only layouts passed");
}

/// Every entry and surface at another size/theme: render, Escape, nothing sent.
fn render_only(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>, width: f32, mode: ThemeMode) {
    let s = server();
    let m = mount(cx, &s, width, mode);
    let (h, view) = (m.h, m.view.clone());
    let tag = format!("{}-{mode:?}", width as u32);
    until(cx, h, |w, _| w.try_find("insights-access-count").is_some());
    open_settings(cx, h, &view);
    click(cx, h, "insights-scope-toggle");
    cx.update_window(h, |_, w, _| {
        contained(w, width);
        assert!(w.find("insights-close").visible());
    })
    .unwrap();
    shot(cx, h, dir, &format!("settings-{tag}"));
    escape(cx, h);
    assert!(closed(cx, h));
    open_backlog(cx, h, &view);
    shot(cx, h, dir, &format!("tasks-{tag}"));
    decide(cx, h, "task-0", "Approve…");
    cx.update_window(h, |_, w, _| contained(w, width)).unwrap();
    shot(cx, h, dir, &format!("decide-{tag}"));
    escape(cx, h);
    assert!(closed(cx, h));
    open_setup(cx, h);
    cx.update_window(h, |_, w, _| {
        contained(w, width);
        assert!(w.find("insights-setup").visible());
    })
    .unwrap();
    shot(cx, h, dir, &format!("setup-{tag}"));
    escape(cx, h);
    assert!(closed(cx, h));
    assert!(
        s.writes().is_empty(),
        "rendering and navigation must not write"
    );
    unmount(cx, m, &s, None);
    println!("insights render-only {tag}: settings, tasks, decision and setup passed");
}

fn full(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>) {
    let width = 1100.;
    let s = server();
    let m = mount(cx, &s, width, ThemeMode::Light);
    let (h, view) = (m.h, m.view.clone());

    // The header hint counts Proposed findings with passive reads only.
    until(cx, h, |w, _| w.try_find("insights-access-count").is_some());
    cx.update(|cx| assert_eq!(view.read(cx).insights_counts.get(REPORT), Some(&4)));
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| {
            v.selected = Some("plain".into());
            cx.notify();
        });
        w.render_frame(cx);
        assert!(w.try_find("insights-access").is_none());
        view.update(cx, |v, cx| {
            v.selected = Some(REPORT.into());
            cx.notify();
        });
    })
    .unwrap();
    settle(cx, h);
    assert!(s.writes().is_empty());

    // A composer draft survives every interaction below.
    let input = cx.update(|cx| view.read(cx).editor.read(cx).shell_probe().0);
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| i.focus(w, cx));
        w.input("Unsent Insights reply 私の下書き 👩‍💻", cx);
    })
    .unwrap();
    settle(cx, h);
    let draft = cx.update(|cx| input.read(cx).value());
    shot(cx, h, dir, "full-header");

    // Settings from the chat's … menu: passive, focused, model by display name.
    open_settings(cx, h, &view);
    let p = panel(cx, &view);
    cx.update_window(h, |_, w, cx| {
        assert!(p.read(cx).owns_focus(w, cx), "settings take focus");
        assert_eq!(
            p.read(cx).probe_model_name().as_deref(),
            Some("Claude Sonnet")
        );
        assert!(w.try_find("insights-scope").is_none());
        assert!(w.find("insights-revoke").visible());
        contained(w, width);
    })
    .unwrap();
    click(cx, h, "insights-scope-toggle");
    cx.update_window(h, |_, w, _| assert!(w.find("insights-scope").visible()))
        .unwrap();
    shot(cx, h, dir, "full-settings");
    assert!(s.writes().is_empty(), "opening settings must not write");
    escape(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(!panel_open(w));
        assert!(w.focused(cx).is_some(), "focus is restored, not dropped");
        assert_eq!(input.read(cx).value(), draft);
    })
    .unwrap();

    // The header button opens the backlog's Tasks with findings on their own rows.
    open_backlog(cx, h, &view);
    cx.update_window(h, |_, w, cx| {
        assert!(w.find("mission-tasks-deciding-0").visible());
        assert_eq!(lifecycle_of(&view, "task-0", cx), Some(Lifecycle::Proposed));
    })
    .unwrap();
    assert!(s.writes().is_empty(), "the backlog reads only");
    shot(cx, h, dir, "full-tasks");
    // A proposed finding offers decisions first; Verify only after Shipped.
    cx.update_window(h, |_, w, cx| w.right_click("mission-tasks-item-task-0", cx))
        .unwrap();
    let labels = menu_labels(cx, h);
    assert_eq!(labels[0], "Approve…");
    assert!(!labels.iter().any(|l| l == "Verify benefit…"));
    assert!(labels.iter().any(|l| l == "Change status…"));
    shot(cx, h, dir, "full-row-menu");
    escape(cx, h);
    cx.update_window(h, |_, w, cx| w.right_click("mission-tasks-item-task-3", cx))
        .unwrap();
    assert!(menu_labels(cx, h).iter().any(|l| l == "Verify benefit…"));
    escape(cx, h);

    // Decision: explicit dialog; Escape sends nothing.
    decide(cx, h, "task-0", "Approve…");
    cx.update_window(h, |_, w, _| {
        assert!(w.find("insights-decision-confirm").visible());
        contained(w, width);
    })
    .unwrap();
    shot(cx, h, dir, "full-decide");
    escape(cx, h);
    assert!(closed(cx, h));
    assert!(s.writes().is_empty());
    // Lost ACK: one exact POST, then a single Unknown row and no confirm button.
    s.reply(
        OPERATIONS,
        Reply::json(500, json!({"error":"synthetic lost acknowledgement"})),
    );
    decide(cx, h, "task-0", "Approve…");
    click(cx, h, "insights-decision-confirm");
    let slot = format!("lifecycle:{REPORT}:{}", key(0));
    until(cx, h, |w, _| w.try_find("insights-unconfirmed").is_some());
    let sent = s.writes();
    assert_eq!(sent.len(), 1, "one explicit decision POST: {sent:?}");
    let (method, path, capability, body) = sent[0].clone();
    assert_eq!(
        (method.as_str(), path.as_str(), capability),
        ("POST", "/api/operations", true)
    );
    assert_eq!(body["kind"], "insights-lifecycle");
    assert_eq!(body["targetId"], REPORT);
    let payload: Value = serde_json::from_str(body["payload"].as_str().unwrap()).unwrap();
    assert_eq!(
        payload,
        json!({"expectedRevision":1,"key":key(0),"lifecycle":"approved"})
    );
    let decided = attempt(cx, &view, &slot).unwrap();
    assert_eq!(decided.state, State::Unknown);
    cx.update_window(h, |_, w, _| {
        assert!(w.find("insights-check").visible());
        assert!(w.try_find("insights-outcome").is_none(), "one message only");
        assert!(w.try_find("insights-decision-confirm").is_none());
    })
    .unwrap();
    shot(cx, h, dir, "full-decide-unknown");
    // Closing and reopening the same decision never resends.
    escape(cx, h);
    decide(cx, h, "task-0", "Approve…");
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-unconfirmed").is_some());
        assert!(w.try_find("insights-decision-confirm").is_none());
    })
    .unwrap();
    assert!(s.writes().is_empty(), "an open slot is never resent");
    // Explicit Check: unauthenticated lookup, then the identical bytes once.
    let op = decided.operation.clone();
    s.reply(RECEIPT, Reply::json(200, json!({"state":"unknown"})));
    s.reply(
        OPERATIONS,
        Reply::json(
            200,
            receipt(
                &op,
                "accepted",
                json!({"sessionId":REPORT,"key":key(0),"operationId":op.operation_id,"kind":"finding","revision":2,"taskId":"task-0"}),
            ),
        ),
    );
    s.reply(
        FINDINGS,
        Reply::json(200, page(0..20, Some(20), "approved")),
    );
    s.reply(MORE, Reply::json(200, page(20..23, None, "approved")));
    click(cx, h, "insights-check");
    until(cx, h, |w, cx| {
        settled_as(&view, &slot, State::Accepted, cx) && !panel_open(w)
    });
    let sent = s.writes();
    assert_eq!(sent.len(), 2, "receipt lookup then one send: {sent:?}");
    assert_eq!(sent[0].1, "/api/operations/receipt");
    assert!(!sent[0].2, "receipt lookup carries no native authority");
    assert_eq!(sent[1].1, "/api/operations");
    assert!(sent[1].2);
    assert_eq!(sent[0].3, body);
    assert_eq!(sent[1].3, body, "Check resends the exact saved operation");
    // The rows and the header hint re-read passively.
    until(cx, h, |_, cx| {
        lifecycle_of(&view, "task-0", cx) == Some(Lifecycle::Approved)
            && view.read(cx).insights_counts.get(REPORT) == Some(&3)
    });
    shot(cx, h, dir, "full-tasks-decided");

    // Revocation from settings: confirmation, slow write survives closing.
    back_to_chat(cx, h, &view);
    open_settings(cx, h, &view);
    let p = panel(cx, &view);
    click(cx, h, "insights-revoke");
    cx.update_window(h, |_, w, _| {
        assert!(w.find("insights-confirm-revoke").visible())
    })
    .unwrap();
    escape(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(panel_open(w), "Escape cancels the confirmation only");
        assert!(w.try_find("insights-confirm-revoke").is_none());
    })
    .unwrap();
    assert!(s.writes().is_empty());
    let mut slow = Reply::json(500, json!({"error":"synthetic slow fault"}));
    slow.delay_ms = 900;
    s.reply(OPERATIONS, slow);
    click(cx, h, "insights-revoke");
    shot(cx, h, dir, "full-revoke-confirm");
    click(cx, h, "insights-revoke-confirm");
    let revoke = format!("revoke:{REPORT}");
    until(cx, h, |_, cx| p.read(cx).probe_waiting());
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-confirm-revoke").is_none());
        assert_eq!(w.find("insights-revoke").disabled(), Some(true));
        assert!(w.try_find("insights-waiting").is_some());
    })
    .unwrap();
    escape(cx, h);
    assert!(closed(cx, h));
    until(cx, h, |_, cx| {
        settled_as(&view, &revoke, State::Unknown, cx) && !p.read(cx).probe_waiting()
    });
    let sent = s.writes();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].3["kind"], "insights-revoke");
    assert_eq!(sent[0].3["targetId"], REPORT);
    assert_eq!(
        sent[0].3["payload"],
        json!({"expectedRevision":3}).to_string()
    );
    open_settings(cx, h, &view);
    cx.update_window(h, |_, w, _| {
        assert!(w.find("insights-unconfirmed").visible());
        assert!(w.try_find("insights-outcome").is_none(), "one message only");
    })
    .unwrap();
    shot(cx, h, dir, "full-revoke-unknown");
    let op = attempt(cx, &view, &revoke).unwrap().operation;
    s.reply(
        RECEIPT,
        Reply::json(200, receipt(&op, "pending", Value::Null)),
    );
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| {
        settled_as(&view, &revoke, State::Pending, cx) && !p.read(cx).probe_waiting()
    });
    let sent = s.writes();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1, "/api/operations/receipt");
    assert!(
        cx.update_window(h, |_, w, _| w.try_find("insights-unconfirmed").is_some())
            .unwrap()
    );
    s.reply(
        RECEIPT,
        Reply::json(
            200,
            receipt(&op, "accepted", json!({"sessionId":REPORT,"revision":4})),
        ),
    );
    s.reply(STATUS, Reply::json(200, status(false, 4)));
    click(cx, h, "insights-check");
    until(cx, h, |w, _| {
        w.try_find("insights-state").is_some()
            && w.try_find("insights-revoke").is_none()
            && w.try_find("insights-unconfirmed").is_none()
    });
    assert_eq!(s.writes().len(), 1);
    shot(cx, h, dir, "full-revoked");
    // Open backlog still navigates to Tasks.
    click(cx, h, "insights-backlog");
    to_tasks(cx, h, &view);
    assert!(closed(cx, h));
    assert!(s.writes().is_empty());
    // Revoked access: rows and the header hint re-read and offer nothing to decide.
    s.reply(
        FINDINGS,
        Reply::json(409, json!({"error":"insights_unavailable"})),
    );
    s.reply(
        MORE,
        Reply::json(409, json!({"error":"insights_unavailable"})),
    );
    cx.update(|cx| {
        view.update(cx, |v, cx| v.insights_decided(REPORT.into(), cx));
    });
    until(cx, h, |_, cx| {
        view.read(cx).insights_counts.get(REPORT) == Some(&0)
            && lifecycle_of(&view, "task-0", cx).is_none()
    });
    assert!(s.writes().is_empty());

    // Setup from the active mission's More menu: passive model read, explicit choice.
    open_setup(cx, h);
    let setup = panel(cx, &view);
    cx.update_window(h, |_, w, cx| {
        assert!(setup.read(cx).owns_focus(w, cx));
        assert_eq!(
            w.find("insights-model").label(),
            Some("Model: Claude Sonnet")
        );
        assert_ne!(w.find("insights-setup").disabled(), Some(true));
        assert!(w.find("insights-scope").visible(), "setup always discloses");
    })
    .unwrap();
    escape(cx, h);
    assert!(closed(cx, h));
    assert!(s.writes().is_empty(), "setup opens passively");
    open_setup(cx, h);
    click(cx, h, "insights-model");
    pick(cx, h, LONG_MODEL);
    cx.update_window(h, |_, w, _| {
        assert_eq!(
            w.find("insights-model").label().map(str::to_owned),
            Some(format!("Model: {LONG_MODEL}"))
        );
        let p = w.find("insights-panel").bounds();
        assert!(w.find("insights-model").bounds().right() <= p.right() + px(0.5));
        contained(w, width);
    })
    .unwrap();
    shot(cx, h, dir, "full-setup");
    s.reply(
        OPERATIONS,
        Reply::json(500, json!({"error":"synthetic lost acknowledgement"})),
    );
    click(cx, h, "insights-setup");
    until(cx, h, |w, _| w.try_find("insights-unconfirmed").is_some());
    cx.update_window(h, |_, w, _| {
        assert_eq!(w.find("insights-setup").disabled(), Some(true));
        assert!(w.try_find("insights-outcome").is_none());
    })
    .unwrap();
    let sent = s.writes();
    assert_eq!(sent.len(), 1);
    assert_eq!((sent[0].1.as_str(), sent[0].2), ("/api/operations", true));
    assert_eq!(sent[0].3["kind"], "insights-create");
    let payload: Value = serde_json::from_str(sent[0].3["payload"].as_str().unwrap()).unwrap();
    assert_eq!(
        payload,
        json!({"disclosure":DISCLOSURE,"missionId":"mission-A","model":"openai/gpt-long","projectId":"project-A"})
    );
    shot(cx, h, dir, "full-setup-unknown");
    let op = attempt(cx, &view, "create:mission-A").unwrap().operation;
    s.reply(
        RECEIPT,
        Reply::json(
            200,
            receipt(&op, "accepted", json!({"sessionId":op.target_id})),
        ),
    );
    click(cx, h, "insights-check");
    until(cx, h, |w, _| !panel_open(w));
    let sent = s.writes();
    assert_eq!(sent.len(), 1, "accepted receipt needs no resend: {sent:?}");
    assert_eq!(sent[0].1, "/api/operations/receipt");
    open_setup(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-setup").is_none());
        assert_eq!(w.find("insights-close").label(), Some("Close"));
    })
    .unwrap();
    escape(cx, h);
    assert!(s.writes().is_empty());
    cx.update(|cx| assert_eq!(input.read(cx).value(), draft));
    drop(input);
    drop(p);
    drop(setup);
    let draft = draft.to_string();
    unmount(cx, m, &s, Some(&draft));
    println!(
        "insights full 1100 Light: header count, settings from … menu, backlog Tasks rows, row decisions with lost-ACK Unknown/no-replay/Check, revoke with pending/accepted receipts, setup with explicit model passed"
    );
}
