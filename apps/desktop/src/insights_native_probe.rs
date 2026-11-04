//! Mounted Insights entry points and panels in the real LocalViewer, over an owned
//! synthetic Local only. The standalone pixel probe is `insights_probe`.
//! No real grant, private history, provider turn, schedule or visible window.
use super::*;
use crate::{
    app_shell::Page,
    insights::{DISCLOSURE, State},
    mission_browser_fixture::{self as f, Reply, Server},
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
fn finding(ix: usize) -> Value {
    let lifecycle = [
        "proposed",
        "approved",
        "in_progress",
        "shipped",
        "deferred",
        "dismissed",
        "verified",
    ][ix % 7];
    let title = if ix == 0 {
        "Cut repeated full-repository scans in long review chats: agents re-read apps/desktop/src/local_view_navigation_and_sidebar_reconciliation_module.rs and other 2,000-line files after every compaction, which inflates context and retries 日本語 👩‍💻".to_owned()
    } else {
        format!("Finding {ix}: tighten scoped-check guidance so agents choose one native target")
    };
    let targets = match ix % 3 {
        0 if ix == 0 => json!([
            {"projectId":"project-A","label":"Pilot (apps/desktop and packages/kernel)"},
            {"projectId":"project-B","label":"Personal dotfiles with a deliberately long project label that must wrap rather than overflow the panel"}
        ]),
        0 => json!([]),
        _ => json!([{"projectId":"project-A","label":"Pilot"}]),
    };
    let cost = if ix.is_multiple_of(2) {
        let later = if ix == 2 {
            "Input tokens fell 18% over two weeks"
        } else {
            ""
        };
        json!({
            "baseline":"About 41 tool calls per review (observed in 3 chats)",
            "assumptions":"Same weekly review volume",
            "estimate":"About 30% fewer input tokens per review, roughly $4 per week at observed pricing",
            "qualityRisks":"Stale cached summaries",
            "laterResult": later,
        })
    } else {
        Value::Null
    };
    let priority = ["high", "medium", "low"][ix % 3];
    json!({"key":key(ix),"revision":ix as u64 + 1,"taskId":format!("task-{ix}"),"lifecycle":lifecycle,"title":title,"priority":priority,"targets":targets,"cost":cost})
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
        Reply::json(
            200,
            json!({"items":(0..20).map(finding).collect::<Vec<_>>(),"nextCursor":20}),
        ),
    );
    s.reply(
        MORE,
        Reply::json(
            200,
            json!({"items":(20..23).map(finding).collect::<Vec<_>>(),"nextCursor":null}),
        ),
    );
    s.reply(MODELS, Reply::json(200, models()));
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
/// Scroll the panel so the target is inside its visible region, then click it.
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: impl Into<ElementId>) {
    let id: ElementId = id.into();
    reveal(cx, h, id.clone());
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
}
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
        let item = (0..16usize)
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
            .save(d.join(format!("{name}.png")))
            .unwrap();
    }
}
fn panel_open(w: &mut Window) -> bool {
    w.try_find("insights-panel").is_some()
}
fn access_loaded(w: &mut Window) -> bool {
    w.try_find("insights-state").is_some() && w.try_find(("insights-finding", 19usize)).is_some()
}
/// No row or panel may extend past the window or the panel horizontally.
fn assert_contained(w: &mut Window, width: f32) {
    let panel = w.find("insights-panel").bounds();
    assert!(
        panel.left() >= px(0.) && panel.right() <= px(width),
        "panel {panel:?} exceeds {width}"
    );
    let mut ix = 0usize;
    while let Some(row) = w.try_find(("insights-finding", ix)) {
        let b = row.bounds();
        assert!(
            b.right() <= panel.right() + px(0.5) && b.left() >= panel.left() - px(0.5),
            "finding {ix} {b:?} overflows panel {panel:?}"
        );
        ix += 1;
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
fn open_access(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.update_window(h, |_, w, cx| {
        let entry = w.find("insights-access");
        assert!(entry.visible());
        assert_eq!(entry.label(), Some("Insights access"));
        w.click("insights-access", cx);
    })
    .unwrap();
    until(cx, h, |w, _| panel_open(w) && access_loaded(w));
}
fn open_setup(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    crate::mission_browser_view::probe_menu_command(cx, h, "Set up Insights chat…");
    until(cx, h, |w, _| {
        panel_open(w) && w.try_find("insights-model").is_some()
    });
}
fn to_mission(cx: &mut HeadlessAppContext, h: AnyWindowHandle, view: &Entity<LocalViewer>) {
    until(cx, h, |_, cx| {
        let v = view.read(cx);
        v.page == Page::Mission(f::key("mission-A"))
            && v.missions.read(cx).detail.is_some()
            && !v.missions.read(cx).busy
    });
}
fn escape(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
}
fn closed(cx: &mut HeadlessAppContext, h: AnyWindowHandle) -> bool {
    !cx.update_window(h, |_, w, _| panel_open(w)).unwrap()
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

/// Every entry and panel at another size/theme: render, scroll, Escape, nothing sent.
fn render_only(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>, width: f32, mode: ThemeMode) {
    let s = server();
    let m = mount(cx, &s, width, mode);
    let (h, view) = (m.h, m.view.clone());
    let tag = format!("{}-{mode:?}", width as u32);
    open_access(cx, h);
    cx.update_window(h, |_, w, _| assert_contained(w, width))
        .unwrap();
    shot(cx, h, dir, &format!("access-top-{tag}"));
    click(cx, h, "insights-more");
    until(cx, h, |w, _| {
        w.try_find(("insights-finding", 22usize)).is_some()
    });
    reveal(cx, h, ("insights-finding", 22usize).into());
    cx.update_window(h, |_, w, _| {
        assert!(w.find("insights-close").visible());
        assert_contained(w, width);
    })
    .unwrap();
    shot(cx, h, dir, &format!("access-bottom-{tag}"));
    click(cx, h, "insights-backlog");
    to_mission(cx, h, &view);
    open_setup(cx, h);
    cx.update_window(h, |_, w, _| {
        let p = w.find("insights-panel").bounds();
        assert!(p.right() <= px(width) && p.left() >= px(0.));
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
    println!(
        "insights render-only {tag}: access, findings paging, backlog, setup and Escape passed"
    );
}

fn full(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>) {
    let width = 1100.;
    let s = server();
    let m = mount(cx, &s, width, ThemeMode::Light);
    let (h, view) = (m.h, m.view.clone());

    // An ordinary chat has no Insights entry.
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

    // A composer draft survives every panel interaction below.
    let input = cx.update(|cx| view.read(cx).editor.read(cx).shell_probe().0);
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| i.focus(w, cx));
        w.input("Unsent Insights reply 私の下書き 👩‍💻", cx);
    })
    .unwrap();
    settle(cx, h);
    let draft = cx.update(|cx| input.read(cx).value());

    // Opening is passive: GETs only, focus moves into the panel.
    open_access(cx, h);
    let p = panel(cx, &view);
    cx.update_window(h, |_, w, cx| {
        assert!(p.read(cx).owns_focus(w, cx), "panel takes focus on open");
        assert_contained(w, width);
        let first = w.find(("insights-finding", 0usize)).bounds();
        let second = w.find(("insights-finding", 1usize)).bounds();
        assert!(first.size.height > second.size.height, "long finding wraps");
    })
    .unwrap();
    // Scope is disclosed on request in the report chat; the toggle reveals it.
    cx.update_window(h, |_, w, _| assert!(w.try_find("insights-scope").is_none()))
        .unwrap();
    click(cx, h, "insights-scope-toggle");
    cx.update_window(h, |_, w, _| assert!(w.find("insights-scope").visible()))
        .unwrap();
    assert!(s.writes().is_empty(), "opening access must not write");
    shot(cx, h, dir, "full-access-open");

    // Escape closes, restores focus outside the panel and keeps the draft.
    escape(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(!panel_open(w));
        assert!(!p.read(cx).owns_focus(w, cx));
        assert!(w.focused(cx).is_some(), "focus is restored, not dropped");
        assert_eq!(input.read(cx).value(), draft);
    })
    .unwrap();

    // Decision: menu, explicit confirmation; Escape cancels only the confirmation.
    open_access(cx, h);
    click(cx, h, ("insights-decide", 0usize));
    pick(cx, h, "Approve");
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-confirm-decision").is_some());
        // Pinned below the list: no scrolling from the clicked row is needed.
        assert!(w.find("insights-decision-confirm").visible());
        assert!(w.find("insights-close").visible());
        assert_eq!(w.find(("insights-decide", 1usize)).disabled(), Some(true));
    })
    .unwrap();
    escape(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(
            panel_open(w),
            "Escape cancels the confirmation, not the panel"
        );
        assert!(w.try_find("insights-confirm-decision").is_none());
    })
    .unwrap();
    assert!(s.writes().is_empty());
    // Lost ACK: Unknown, retained, never replayed by a repeat decision.
    s.reply(
        OPERATIONS,
        Reply::json(500, json!({"error":"synthetic lost acknowledgement"})),
    );
    click(cx, h, ("insights-decide", 0usize));
    pick(cx, h, "Approve");
    reveal(cx, h, "insights-decision-confirm".into());
    shot(cx, h, dir, "full-decision-confirm");
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
        assert!(w.try_find("insights-confirm-decision").is_none());
        assert_ne!(w.find(("insights-decide", 1usize)).disabled(), Some(true));
        assert_ne!(w.find("insights-revoke").disabled(), Some(true));
    })
    .unwrap();
    shot(cx, h, dir, "full-decision-unknown");
    // Retrying the same decision is refused locally; nothing is sent.
    click(cx, h, ("insights-decide", 0usize));
    pick(cx, h, "Approve");
    click(cx, h, "insights-decision-confirm");
    assert!(
        s.writes().is_empty(),
        "an open slot is never replaced or resent"
    );
    assert_eq!(attempt(cx, &view, &slot).unwrap(), decided);
    // Close/reopen keeps the unconfirmed row; opening sends nothing.
    escape(cx, h);
    assert!(closed(cx, h));
    open_access(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-unconfirmed").is_some())
    })
    .unwrap();
    assert!(s.writes().is_empty());
    // Explicit Check: unauthenticated receipt lookup, then the identical bytes once.
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
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| settled_as(&view, &slot, State::Accepted, cx));
    let sent = s.writes();
    assert_eq!(sent.len(), 2, "receipt lookup then one send: {sent:?}");
    assert_eq!(sent[0].1, "/api/operations/receipt");
    assert!(!sent[0].2, "receipt lookup carries no native authority");
    assert_eq!(sent[1].1, "/api/operations");
    assert!(sent[1].2);
    assert_eq!(sent[0].3, body);
    assert_eq!(sent[1].3, body, "Check resends the exact saved operation");
    until(cx, h, |w, _| {
        access_loaded(w) && w.try_find("insights-unconfirmed").is_none()
    });

    // Revocation: explicit confirmation; slow write shows progress and survives closing.
    click(cx, h, "insights-revoke");
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-confirm-revoke").is_some())
    })
    .unwrap();
    escape(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(panel_open(w));
        assert!(w.try_find("insights-confirm-revoke").is_none())
    })
    .unwrap();
    assert!(s.writes().is_empty());
    let mut slow = Reply::json(500, json!({"error":"synthetic slow fault"}));
    slow.delay_ms = 900;
    s.reply(OPERATIONS, slow);
    click(cx, h, "insights-revoke");
    reveal(cx, h, "insights-revoke-confirm".into());
    shot(cx, h, dir, "full-revoke-confirm");
    click(cx, h, "insights-revoke-confirm");
    let revoke = format!("revoke:{REPORT}");
    until(cx, h, |_, cx| p.read(cx).probe_waiting());
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-confirm-revoke").is_none());
        assert_eq!(w.find("insights-revoke").disabled(), Some(true));
    })
    .unwrap();
    // Closing doesn't cancel; reopening sends nothing new.
    escape(cx, h);
    assert!(closed(cx, h));
    until(cx, h, |_, cx| {
        settled_as(&view, &revoke, State::Unknown, cx) && !p.read(cx).probe_waiting()
    });
    let sent = s.writes();
    assert_eq!(sent.len(), 1);
    let revoke_body = sent[0].3.clone();
    assert_eq!(revoke_body["kind"], "insights-revoke");
    assert_eq!(revoke_body["targetId"], REPORT);
    assert_eq!(
        revoke_body["payload"],
        json!({"expectedRevision":3}).to_string()
    );
    open_access(cx, h);
    reveal(cx, h, "insights-unconfirmed".into());
    shot(cx, h, dir, "full-revoke-unknown");
    // Check reports still pending; nothing is resent and the row stays.
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
    // Accepted on the next Check: access re-reads as revoked; history stays.
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
            && w.try_find("insights-findings").is_none()
    });
    assert_eq!(s.writes().len(), 1);
    cx.update_window(h, |_, w, _| assert!(w.find("insights-backlog").visible()))
        .unwrap();
    shot(cx, h, dir, "full-revoked");

    // Backlog opens the linked mission through ordinary navigation.
    click(cx, h, "insights-backlog");
    to_mission(cx, h, &view);
    assert!(closed(cx, h));
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
    })
    .unwrap();
    escape(cx, h);
    assert!(closed(cx, h));
    assert!(
        s.writes().is_empty(),
        "opening and dismissing setup must not write"
    );
    assert!(
        s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(m, p)| m == "GET" && p == MODELS),
        "setup reads the mission project's scoped models"
    );
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
    })
    .unwrap();
    shot(cx, h, dir, "full-setup-chosen");
    s.reply(
        OPERATIONS,
        Reply::json(500, json!({"error":"synthetic lost acknowledgement"})),
    );
    click(cx, h, "insights-setup");
    let create = "create:mission-A".to_owned();
    until(cx, h, |w, _| w.try_find("insights-unconfirmed").is_some());
    cx.update_window(h, |_, w, _| {
        assert_eq!(w.find("insights-setup").disabled(), Some(true))
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
    let op = attempt(cx, &view, &create).unwrap().operation;
    s.reply(
        RECEIPT,
        Reply::json(
            200,
            receipt(&op, "accepted", json!({"sessionId":op.target_id})),
        ),
    );
    click(cx, h, "insights-check");
    // Accepted: the created chat isn't listed yet, so its mission stays shown.
    until(cx, h, |w, _| !panel_open(w));
    let sent = s.writes();
    assert_eq!(sent.len(), 1, "accepted receipt needs no resend: {sent:?}");
    assert_eq!(sent[0].1, "/api/operations/receipt");
    assert!(cx.update(|cx| view.read(cx).page == Page::Mission(f::key("mission-A"))));
    // Reopening setup offers no second create.
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
        "insights full 1100 Light: header entry, passive open, Escape/focus, decision confirm, lost-ACK Unknown no-replay, explicit Check, slow revoke survives close, pending/accepted receipts, backlog navigation and setup with explicit model passed"
    );
}
