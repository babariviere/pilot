//! Mounted Insights review settings in the real LocalViewer over an owned synthetic Local
//! only: the report chat's settings entry, an edited draft kept across close and route
//! changes, Save versus Apply, lost/malformed ACKs with passive Check, restart retention,
//! the exact Apply preview and rule, stale CAS, model refusal, blocked-state precedence and
//! an older Local. No real grant, history, provider turn, schedule or visible window.
use super::*;
use crate::{
    insights::State,
    insights_settings::{Settings, fixture as fx},
    mission_browser_fixture::{Reply, Server},
};
use chrono::NaiveTime;
use gpui_kit::{
    AnyWindowHandle, Bounds, ElementId, EntityInputHandler as _, HeadlessAppContext, ScrollDelta,
    WindowBounds, WindowOptions, component::ThemeMode, point, size, test::TestWindowExt,
};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Instant};

const REPORT: &str = fx::REPORT;
const STATUS: &str = "/api/insights/sessions/report-1";
const SETTINGS: &str = "/api/insights/sessions/report-1/settings";
const APPLY: &str = "/api/insights/sessions/report-1/apply";
const OPERATIONS: &str = "POST /api/operations";
const RECEIPT: &str = "POST /api/operations/receipt";
const SLOT: &str = "settings:report-1";
const APPLY_SLOT: &str = "apply:report-1";
const DRAFT: &str = "Unsent reply 私の下書き 👩‍💻";

fn hello(apply: bool) -> Value {
    let mut caps = json!({"independentExecution":true,"insights":1,"insightsEnable":1,"insightsSettings":1,"automations":1});
    if apply {
        caps["insightsApply"] = json!(1);
    }
    json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":caps})
}
fn server(apply: bool) -> Server {
    let s = Server::start().with_capability();
    s.reply("/api/hello", Reply::json(200, hello(apply)));
    s.reply("GET /api/schedules", Reply::json(200, json!([])));
    s.reply(STATUS, Reply::json(200, json!({"sessionId":REPORT,"enabled":true,"revision":3,"projectId":"project-A","missionId":"mission-A","setupPending":false,"archived":false,"available":true,"disclosure":crate::insights::DISCLOSURE})));
    s.reply(
        "/api/models?cwd=%2Fsynthetic%2FA",
        Reply::json(200, json!({"defaultModel":fx::SONNET,"models":[
            {"id":fx::TERRA,"provider":"terra","name":"Terra 6.1","thinkingLevels":["off","high"]},
            {"id":fx::SONNET,"provider":"anthropic","name":"Claude Sonnet","thinkingLevels":["off","high"]}
        ]})),
    );
    s
}
fn weekly(day: u8, time: &str, zone: &str) -> Value {
    json!({"every":"week","weekday":day,"time":time,"timeZone":zone})
}
/// The settings a user makes in the main journey.
fn edited() -> Value {
    json!({
        "recurrence": weekly(1, "07:30", "Europe/Lisbon"),
        "requestedModel": {"kind":"id","value":fx::SONNET},
        "scope": {"host":"local","projects":"admitted","includeArchived":false,"excludeProjects":["project-B"],"excludeSessions":[],"sourceAccess":"read_only","coverage":"partial"},
        "bounds": {"inventoryPages":1,"historyPages":2,"entriesPerPage":4},
        "budget": {"usd":7.5,"period":"month","enforcement":"advisory","basis":"user_choice"}
    })
}
fn posts(s: &Server) -> Vec<(String, bool, Value)> {
    s.writes()
        .into_iter()
        .map(|(_, path, cap, body)| (path, cap, body))
        .collect()
}
fn sent(all: &[(String, bool, Value)], path: &str) -> Vec<Value> {
    all.iter()
        .filter(|(p, _, _)| p == path)
        .map(|(_, cap, body)| {
            assert!(
                *cap || path != "/api/operations",
                "writes carry native confirmation"
            );
            body.clone()
        })
        .collect()
}
/// Only passive receipt lookups of the same envelope; nothing executed or resent.
#[track_caller]
fn lookups_only(s: &Server, envelope: &Value) {
    let all = posts(s);
    assert!(
        all.iter()
            .all(|(p, _, b)| p == "/api/operations/receipt" && b == envelope),
        "only receipt lookups of the retained envelope: {all:?}"
    );
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
            "bounded review settings probe wait at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: impl Into<ElementId>) {
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
            .save(d.join(format!("review-{name}.png")))
            .unwrap();
    }
}
fn open(w: &mut Window) -> bool {
    w.try_find("insights-panel").is_some()
}
fn escape(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
    assert!(!cx.update_window(h, |_, w, _| open(w)).unwrap());
}
/// The panel fits the window and its fixed actions stay inside it, outside the scroller.
fn contained(w: &mut Window, width: f32, ids: &[&'static str]) {
    let p = w.find("insights-panel").bounds();
    assert!(
        p.left() >= px(0.) && p.right() <= px(width),
        "panel {p:?} exceeds {width}"
    );
    let body = w.find("insights-body").bounds();
    for id in ids {
        let e = w.find(*id).bounds();
        assert!(
            e.left() >= p.left() - px(0.5) && e.right() <= p.right() + px(0.5),
            "{id} clipped: {e:?} in {p:?}"
        );
        assert!(
            e.top() >= body.bottom() - px(0.5),
            "{id} must stay outside the scroller"
        );
        assert!(e.bottom() <= px(820.), "{id} below the window");
    }
}
fn scroll_body(cx: &mut HeadlessAppContext, h: AnyWindowHandle, dy: f32) {
    cx.update_window(h, |_, w, cx| {
        w.scroll(
            "insights-body",
            ScrollDelta::Pixels(point(px(0.), px(dy))),
            cx,
        )
    })
    .unwrap();
    settle(cx, h);
}

struct Mounted {
    h: AnyWindowHandle,
    view: Entity<LocalViewer>,
    writer: Interaction,
    drain: async_channel::Receiver<crate::interaction::WriteState>,
    root: PathBuf,
    _commands: async_channel::Receiver<Command>,
}
/// A report chat bound to mission A; the draft lives on chat "plain".
fn mount(
    cx: &mut HeadlessAppContext,
    s: &Server,
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
        std::env::temp_dir().join(format!("native-insights-review-{}", uuid::Uuid::new_v4()))
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
                    v.state.status = "Synthetic Insights review settings fixture".into();
                    v.state.loaded = true;
                    v.state.list_loaded = true;
                    v.state.generation = 1;
                    v.generation = 1;
                    v.state.chats = Arc::new(vec![
                        crate::local_model::chat(&json!({"id":"plain","title":"Ordinary chat","projectId":"project-A","cwd":"/synthetic/A","mode":"build","state":"idle"})).unwrap(),
                        crate::local_model::chat(&json!({"id":REPORT,"title":"Weekly Insights 日本語","projectId":"project-A","missionId":"mission-A","cwd":"/synthetic/A","mode":"build","state":"idle","role":"insights","model":fx::TERRA})).unwrap(),
                    ]);
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
                    v.page = crate::app_shell::Page::Chat;
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
fn panel(
    cx: &mut HeadlessAppContext,
    view: &Entity<LocalViewer>,
) -> Entity<crate::insights_view::Panel> {
    cx.update(|cx| view.read(cx).insights.as_ref().unwrap().0.clone())
}
fn ready(view: &Entity<LocalViewer>, cx: &App) -> bool {
    view.read(cx)
        .insights
        .as_ref()
        .is_some_and(|(p, _)| p.read(cx).visible && p.read(cx).probe_ready())
}
fn mode(view: &Entity<LocalViewer>, cx: &App) -> &'static str {
    view.read(cx)
        .insights
        .as_ref()
        .map_or("closed", |(p, _)| p.read(cx).probe_review_mode())
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
fn state_is(view: &Entity<LocalViewer>, slot: &str, state: State, cx: &App) -> bool {
    view.read(cx)
        .insights_book
        .as_ref()
        .and_then(|b| b.insights.get(slot))
        .is_some_and(|a| a.state == state)
}
fn values(cx: &mut HeadlessAppContext, view: &Entity<LocalViewer>) -> Settings {
    let p = panel(cx, view);
    cx.update(|cx| p.read(cx).probe_review_values(cx).expect("valid draft"))
}
fn disabled(w: &mut Window, id: &'static str) -> bool {
    w.find(id).disabled() == Some(true)
}
/// Select a chat as the sidebar does: an ordinary route change.
fn select(cx: &mut HeadlessAppContext, h: AnyWindowHandle, view: &Entity<LocalViewer>, id: &str) {
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| {
            let chat = v.state.chats.iter().find(|c| c.id == id).cloned().unwrap();
            v.open(chat, w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
}
/// Report chat → … → Insights settings… → Review Settings….
fn open_review(cx: &mut HeadlessAppContext, h: AnyWindowHandle, view: &Entity<LocalViewer>) {
    select(cx, h, view, REPORT);
    click(cx, h, "history-menu");
    pick(cx, h, "Insights settings…");
    until(cx, h, |w, cx| {
        w.try_find("insights-review-edit").is_some() && ready(view, cx)
    });
    click(cx, h, "insights-review-edit");
    until(cx, h, |w, cx| {
        open(w)
            && ready(view, cx)
            && (mode(view, cx) != "loading" || w.try_find("insights-review-blocked").is_some())
    });
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
/// Text through the input handler, as typing does, then Escape with an open composition.
fn type_into(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    which: usize,
    text: &str,
) {
    let p = panel(cx, view);
    let (_, zone, budget) = cx.update(|cx| p.read(cx).probe_review_inputs().unwrap());
    let input = if which == 0 { zone } else { budget };
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| {
            i.focus(w, cx);
            i.set_value("", w, cx);
            i.replace_text_in_range(None, text, w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
}

pub fn run_insights_settings_probe(cx: &mut HeadlessAppContext) {
    let reduced = cx.update(|cx| {
        let previous = cx.reduce_motion();
        cx.set_reduce_motion(true);
        previous
    });
    let dir = std::env::var_os("PILOT_NEXT_INSIGHTS_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    save_then_apply(cx, &dir);
    conflicts_and_refusals(cx, &dir);
    double_confirm(cx, &dir);
    older_local(cx);
    for (width, mode) in [
        (680., ThemeMode::Light),
        (680., ThemeMode::Dark),
        (1100., ThemeMode::Dark),
    ] {
        render_only(cx, &dir, width, mode);
    }
    cx.update(|cx| cx.set_reduce_motion(reduced));
    println!(
        "insights settings: save/apply journey, conflicts/refusals, double Save/Apply clicks, older Local and 3 render-only layouts passed"
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
/// A clean accepted Save receipt for whatever envelope arrives: the next revision of
/// exactly the sent settings. A store or host refusal can't hide a second send.
fn accept_save(body: &Value) -> Value {
    let op: crate::delivery_store::Operation = serde_json::from_value(body.clone()).unwrap();
    let p: Value = serde_json::from_str(&op.payload).unwrap();
    let record = json!({
        "revision": p["expectedRevision"].as_u64().unwrap() + 1,
        "settings": p["settings"],
        "model": p["settings"]["requestedModel"]["value"],
    });
    fx::receipt(&op, "accepted", record)
}
/// A clean accepted Apply receipt for whatever envelope arrives.
fn accept_apply(body: &Value) -> Value {
    let op: crate::delivery_store::Operation = serde_json::from_value(body.clone()).unwrap();
    fx::receipt(&op, "accepted", fx::progress(&op, "applied"))
}
/// Two clicks in one frame, then the outcome: (commands handed to the writer, operation POSTs).
fn double_click(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    s: &Server,
    view: &Entity<LocalViewer>,
    id: &'static str,
    slot: &str,
) -> (u64, Vec<Value>) {
    let p = panel(cx, view);
    let before = cx.update(|cx| p.read(cx).probe_requests().0);
    cx.update_window(h, |_, w, cx| {
        w.click(id, cx);
        w.click(id, cx);
    })
    .unwrap();
    settle(cx, h);
    // Every command handed over has its own outcome before anything is counted.
    until(cx, h, |_, cx| {
        state_is(view, slot, State::Accepted, cx)
            && ready(view, cx)
            && p.read(cx).probe_requests().1.is_some()
    });
    let (after, latest) = cx.update(|cx| p.read(cx).probe_requests());
    assert!(
        matches!(latest, Some(crate::insights::Outcome::Accepted(_))),
        "{latest:?}"
    );
    (after - before, sent(&posts(s), "/api/operations"))
}

/// Save, then Apply, each clicked twice in one frame. Every ACK is a clean acceptance for
/// whatever arrives, so only the confirmation itself can keep a second command from going out.
fn double_confirm(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>) {
    let width = 1100.;
    let s = server(true);
    s.reply(
        SETTINGS,
        Reply::json(200, fx::snapshot(0, fx::settings(fx::TERRA), fx::TERRA)),
    );
    let m = mount(cx, &s, width, ThemeMode::Light, None);
    let (h, view) = (m.h, m.view.clone());
    open_review(cx, h, &view);
    click(cx, h, "insights-review-day-1");
    let saved = values(cx, &view).to_value();
    assert_ne!(saved, fx::settings(fx::TERRA), "a real edit");
    posts(&s);

    // Save twice in one frame.
    s.respond(OPERATIONS, accept_save);
    s.reply(
        SETTINGS,
        Reply::json(200, fx::snapshot(1, saved.clone(), fx::TERRA)),
    );
    let (commands, ops) = double_click(cx, h, &s, &view, "insights-review-save", SLOT);
    assert_eq!(
        (commands, ops.len()),
        (1, 1),
        "one Save click reached the writer and one operation was sent"
    );
    let op: crate::delivery_store::Operation = serde_json::from_value(ops[0].clone()).unwrap();
    let payload: Value = serde_json::from_str(&op.payload).unwrap();
    assert_eq!(
        (&payload["settings"], &payload["expectedRevision"]),
        (&saved, &json!(0))
    );
    assert_eq!(
        op.payload_hash,
        sha256(&op.payload),
        "hash of the exact bytes"
    );
    let a = attempt(cx, &view, SLOT).unwrap();
    assert_eq!(
        (a.state, serde_json::to_value(&a.operation).unwrap()),
        (State::Accepted, ops[0].clone()),
        "the stored command is the one sent"
    );
    let p = panel(cx, &view);
    until(cx, h, |_, cx| {
        ready(&view, cx)
            && p.read(cx)
                .probe_review_base()
                .is_some_and(|b| b.revision == 1)
    });

    // Apply twice in one frame, from its exact preview.
    let preview = fx::ready(
        1,
        saved.clone(),
        fx::TERRA,
        fx::TERRA,
        fx::rule(None, weekly(5, "18:00", "Europe/Paris")),
    );
    s.reply(APPLY, Reply::json(200, preview.clone()));
    click(cx, h, "insights-review-apply");
    until(cx, h, |_, cx| {
        ready(&view, cx) && mode(&view, cx) == "preview"
    });
    cx.update_window(h, |_, w, _| assert!(!disabled(w, "insights-apply-confirm")))
        .unwrap();
    posts(&s);
    s.respond(OPERATIONS, accept_apply);
    let (commands, ops) = double_click(cx, h, &s, &view, "insights-apply-confirm", APPLY_SLOT);
    assert_eq!(
        (commands, ops.len()),
        (1, 1),
        "one Apply click reached the writer and one operation was sent"
    );
    let op: crate::delivery_store::Operation = serde_json::from_value(ops[0].clone()).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&op.payload).unwrap(),
        preview["payload"],
        "the preview payload, verbatim"
    );
    assert_eq!(
        op.payload_hash,
        sha256(&op.payload),
        "hash of the exact bytes"
    );
    let a = attempt(cx, &view, APPLY_SLOT).unwrap();
    assert_eq!(
        (a.state, serde_json::to_value(&a.operation).unwrap()),
        (State::Accepted, ops[0].clone())
    );
    shot(cx, h, dir, "double-apply");
    escape(cx, h);
    drop(p);
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);
    println!(
        "insights settings 1100 Light: double Save and double Apply clicks with clean accepted ACKs send one command each passed"
    );
}

/// Edit → close/route change keeps the draft → Save (lost ACK) → restart → Check resends the
/// same bytes once → saved → Apply preview → Apply pending → status-only Check → applied.
fn save_then_apply(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>) {
    let width = 1100.;
    let s = server(true);
    s.reply(
        SETTINGS,
        Reply::json(200, fx::snapshot(0, fx::settings(fx::TERRA), fx::TERRA)),
    );
    let m = mount(cx, &s, width, ThemeMode::Light, None);
    let (h, view) = (m.h, m.view.clone());
    type_draft(cx, h, &view);
    select(cx, h, &view, "plain");
    open_review(cx, h, &view);
    let p = panel(cx, &view);
    assert!(posts(&s).is_empty(), "opening is passive");
    assert_eq!(values(cx, &view).to_value(), fx::settings(fx::TERRA));
    cx.update_window(h, |_, w, cx| {
        assert!(disabled(w, "insights-review-save"), "nothing to save");
        assert!(
            disabled(w, "insights-review-apply"),
            "unsaved suggestions can't apply"
        );
        assert!(
            w.try_find("insights-review-provider").is_some(),
            "provider processing disclosed"
        );
        assert!(
            w.try_find("insights-review-save-note").is_some(),
            "Save vs Apply explained"
        );
        assert_eq!(p.read(cx).probe_review_base().unwrap().revision, 0);
        contained(w, width, &["insights-review-save", "insights-close"]);
    })
    .unwrap();
    shot(cx, h, dir, "suggested");

    // Edits through the real controls; time is set on its own state (TestPlatform limit).
    click(cx, h, "insights-review-day-1");
    let (time, ..) = cx.update(|cx| p.read(cx).probe_review_inputs().unwrap());
    cx.update_window(h, |_, w, cx| {
        time.update(cx, |t, cx| {
            t.set_time(NaiveTime::from_hms_opt(7, 30, 0).unwrap(), w, cx)
        })
    })
    .unwrap();
    type_into(cx, h, &view, 0, "Europe/Lisbon");
    // An open composition owns Escape: the panel and its text stay.
    let (_, zone, _) = cx.update(|cx| p.read(cx).probe_review_inputs().unwrap());
    cx.update_window(h, |_, w, cx| {
        zone.update(cx, |i, cx| {
            i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx)
        });
        w.press("escape", cx);
        assert!(open(w), "Escape during IME composition keeps the panel");
        zone.update(cx, |i, cx| {
            i.unmark_text(w, cx);
            i.set_value("Europe/Lisbon", w, cx);
        });
    })
    .unwrap();
    settle(cx, h);
    assert!(
        cx.update_window(h, |_, w, _| open(w)).unwrap(),
        "panel kept after IME Escape"
    );
    type_into(cx, h, &view, 1, "7.5");
    assert!(
        cx.update_window(h, |_, w, _| open(w)).unwrap(),
        "panel kept after typing"
    );
    click(cx, h, "insights-review-per-month");
    click(cx, h, "insights-review-model");
    pick(cx, h, "Claude Sonnet");
    click(cx, h, "insights-review-sources");
    scroll_body(cx, h, -400.);
    click(cx, h, "insights-review-project-1");
    click(cx, h, "insights-review-archived");
    assert_eq!(values(cx, &view).to_value(), edited());
    cx.update_window(h, |_, w, cx| {
        assert!(p.read(cx).probe_review_dirty(cx));
        assert!(!disabled(w, "insights-review-save"));
        assert!(
            disabled(w, "insights-review-apply"),
            "Apply needs a saved, unedited revision"
        );
        contained(w, width, &["insights-review-save", "insights-close"]);
    })
    .unwrap();
    assert!(posts(&s).is_empty(), "editing writes nothing");
    shot(cx, h, dir, "edited");

    // Close, change route and come back: the same editor keeps the draft.
    escape(cx, h);
    select(cx, h, &view, "plain");
    open_review(cx, h, &view);
    assert_eq!(
        values(cx, &view).to_value(),
        edited(),
        "draft survives close and route change"
    );
    assert!(cx.update(|cx| !p.read(cx).probe_review_stale()));

    // Save: the ACK is lost. Exactly one write, the desired settings only.
    s.reply(OPERATIONS, Reply::json(0, Value::Null));
    click(cx, h, "insights-review-save");
    until(cx, h, |w, cx| {
        w.try_find("insights-unconfirmed").is_some() && ready(&view, cx)
    });
    let all = posts(&s);
    let first = sent(&all, "/api/operations");
    assert_eq!(all.len(), 1, "one write");
    let op = &first[0];
    assert_eq!(
        (op["kind"].as_str(), op["targetId"].as_str()),
        (Some("insights-settings"), Some(REPORT))
    );
    let payload: Value = serde_json::from_str(op["payload"].as_str().unwrap()).unwrap();
    assert_eq!(payload["settings"], edited());
    assert_eq!(payload["expectedRevision"], 0);
    assert_eq!(payload["expectedHome"], fx::home(), "home frozen verbatim");
    assert_eq!(payload["chat"], fx::chat(fx::TERRA));
    let saved = attempt(cx, &view, SLOT).unwrap();
    assert_eq!(saved.state, State::Unknown);
    assert_eq!(serde_json::to_value(&saved.operation).unwrap(), *op);
    cx.update_window(h, |_, w, _| {
        assert!(
            disabled(w, "insights-review-save"),
            "an unconfirmed Save fences Save"
        );
        assert!(disabled(w, "insights-review-apply"), "and Apply");
    })
    .unwrap();
    shot(cx, h, dir, "unconfirmed");
    escape(cx, h);
    select(cx, h, &view, "plain");
    assert_eq!(draft(cx, &view), DRAFT, "composer draft kept");

    // Restart: the envelope is retained; opening sends nothing.
    drop(p);
    let root = unmount(cx, m);
    let m = mount(cx, &s, width, ThemeMode::Light, Some(root));
    let (h, view) = (m.h, m.view.clone());
    open_review(cx, h, &view);
    let p = panel(cx, &view);
    assert!(posts(&s).is_empty(), "restart never replays");
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-unconfirmed").is_some());
        assert!(disabled(w, "insights-review-save"));
    })
    .unwrap();

    // Check: Local has no record, so the same envelope goes once and is accepted.
    let envelope = first[0].clone();
    let retained =
        serde_json::from_value::<crate::delivery_store::Operation>(envelope.clone()).unwrap();
    let record = json!({"revision":1,"settings":edited(),"model":fx::SONNET});
    s.reply(RECEIPT, Reply::json(200, json!({"state":"unknown"})));
    s.reply(
        OPERATIONS,
        Reply::json(200, fx::receipt(&retained, "accepted", record.clone())),
    );
    s.reply(
        SETTINGS,
        Reply::json(200, fx::snapshot(1, edited(), fx::TERRA)),
    );
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| {
        state_is(&view, SLOT, State::Accepted, cx)
            && ready(&view, cx)
            && p.read(cx)
                .probe_review_base()
                .is_some_and(|b| b.revision == 1)
    });
    let all = posts(&s);
    assert_eq!(
        sent(&all, "/api/operations/receipt"),
        vec![envelope.clone()]
    );
    assert_eq!(
        sent(&all, "/api/operations"),
        vec![envelope.clone()],
        "same bytes and ID"
    );
    assert_eq!(attempt(cx, &view, SLOT).unwrap().result, Some(record));
    cx.update_window(h, |_, w, cx| {
        assert!(
            p.read(cx)
                .probe_review_done()
                .unwrap()
                .starts_with("Saved revision 1")
        );
        assert!(!p.read(cx).probe_review_dirty(cx));
        assert!(disabled(w, "insights-review-save"));
        assert!(!disabled(w, "insights-review-apply"));
        assert!(w.try_find("insights-unconfirmed").is_none());
    })
    .unwrap();
    shot(cx, h, dir, "saved");

    // Apply preview: the exact rule it replaces, the model change and provider processing.
    let preview = fx::ready(
        1,
        edited(),
        fx::SONNET,
        fx::TERRA,
        fx::rule(None, weekly(5, "18:00", "Europe/Paris")),
    );
    s.reply(APPLY, Reply::json(200, preview.clone()));
    click(cx, h, "insights-review-apply");
    until(cx, h, |_, cx| {
        ready(&view, cx) && mode(&view, cx) == "preview"
    });
    let replacement = crate::insights_settings::replacement_id(REPORT, 1);
    cx.update_window(h, |_, w, cx| {
        let pv = p.read(cx).probe_review_preview().unwrap();
        let f = pv.frozen.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&f.text).unwrap(),
            preview["payload"]
        );
        assert!(f.changes_model() && !f.keeps_rule);
        assert_eq!(f.schedule_id, replacement);
        for id in [
            "insights-apply-model-change",
            "insights-apply-provider",
            "insights-apply-excluded",
            "insights-apply-rule-id",
            "insights-apply-rule-scope",
            "insights-apply-budget-note",
        ] {
            assert!(w.try_find(id).is_some(), "{id} shown before Apply");
        }
        assert!(!disabled(w, "insights-apply-confirm"));
        contained(w, width, &["insights-apply-confirm", "insights-apply-back"]);
    })
    .unwrap();
    assert!(posts(&s).is_empty(), "the preview is a read");
    shot(cx, h, dir, "apply-preview");

    // Apply: the ACK is lost. The pending Apply outranks the editor.
    s.reply(OPERATIONS, Reply::json(0, Value::Null));
    click(cx, h, "insights-apply-confirm");
    until(cx, h, |w, cx| {
        state_is(&view, APPLY_SLOT, State::Unknown, cx)
            && mode(&view, cx) == "progress"
            && w.try_find("insights-unconfirmed").is_some()
    });
    let all = posts(&s);
    assert_eq!(all.len(), 1, "one Apply write");
    let applied_env = sent(&all, "/api/operations")[0].clone();
    let apply_op =
        serde_json::from_value::<crate::delivery_store::Operation>(applied_env.clone()).unwrap();
    assert_eq!(
        (apply_op.kind.as_str(), apply_op.target_id.as_str()),
        ("insights-apply", REPORT)
    );
    assert_eq!(
        serde_json::from_str::<Value>(&apply_op.payload).unwrap(),
        preview["payload"],
        "verbatim"
    );
    // Check: Local entered the cancellation. Pending is a lookup only, never a resend.
    s.reply(
        RECEIPT,
        Reply::json(
            200,
            fx::receipt(
                &apply_op,
                "pending",
                fx::progress(&apply_op, "cancel_pending"),
            ),
        ),
    );
    click(cx, h, "insights-check");
    until(cx, h, |w, cx| {
        state_is(&view, APPLY_SLOT, State::Pending, cx)
            && w.try_find("insights-unconfirmed").is_some()
    });
    lookups_only(&s, &applied_env);
    cx.update_window(h, |_, w, _| {
        assert!(
            w.try_find("insights-review-save").is_none(),
            "pending Apply outranks the editor"
        );
        assert!(w.try_find("insights-apply-state").is_some());
        contained(w, width, &["insights-check", "insights-close"]);
    })
    .unwrap();
    shot(cx, h, dir, "apply-pending");

    // Close and reopen: still the pending Apply. Check is a lookup only, never a resend.
    escape(cx, h);
    open_review(cx, h, &view);
    assert_eq!(cx.update(|cx| mode(&view, cx)), "progress");
    s.reply(
        RECEIPT,
        Reply::json(
            200,
            fx::receipt(
                &apply_op,
                "pending",
                fx::progress(&apply_op, "schedule_pending"),
            ),
        ),
    );
    click(cx, h, "insights-check");
    until(cx, h, |w, cx| {
        ready(&view, cx) && w.try_find("insights-waiting").is_none()
    });
    lookups_only(&s, &applied_env);
    assert!(cx.update(|cx| state_is(&view, APPLY_SLOT, State::Pending, cx)));

    // Check again: Local finished. The receipt, not a GET, settles it.
    s.reply(
        RECEIPT,
        Reply::json(
            200,
            fx::receipt(&apply_op, "accepted", fx::progress(&apply_op, "applied")),
        ),
    );
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| {
        state_is(&view, APPLY_SLOT, State::Accepted, cx)
            && ready(&view, cx)
            && mode(&view, cx) == "edit"
    });
    lookups_only(&s, &applied_env);
    cx.update_window(h, |_, w, cx| {
        let done = p.read(cx).probe_review_done().unwrap();
        assert!(
            done.contains("Applied revision 1") && done.contains(&replacement),
            "{done}"
        );
        assert!(w.try_find("insights-unconfirmed").is_none());
        contained(w, width, &["insights-review-save", "insights-close"]);
    })
    .unwrap();
    shot(cx, h, dir, "applied");
    escape(cx, h);
    select(cx, h, &view, "plain");
    assert!(
        posts(&s).is_empty(),
        "no implicit activation, rule write or review"
    );
    drop(p);
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);
    println!(
        "insights settings 1100 Light: passive open, real-control edits, IME Escape, draft across close/route, lost Save ACK, restart without replay, same-envelope Check, exact Apply preview, pending Apply precedence, status-only Check and receipt-only acceptance passed"
    );
}

/// Concurrent saves, Keep mine/Discard, a model refusal and malformed ACKs.
fn conflicts_and_refusals(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>) {
    let width = 1100.;
    let s = server(true);
    let s1 = edited();
    s.reply(
        SETTINGS,
        Reply::json(200, fx::snapshot(1, s1.clone(), fx::SONNET)),
    );
    let m = mount(cx, &s, width, ThemeMode::Light, None);
    let (h, view) = (m.h, m.view.clone());
    open_review(cx, h, &view);
    let p = panel(cx, &view);
    type_into(cx, h, &view, 1, "9");

    // Another window saved revision 2 meanwhile: the CAS refuses, the edits stay.
    let mut s2 = s1.clone();
    s2["bounds"]["historyPages"] = json!(6);
    s.reply(
        SETTINGS,
        Reply::json(200, fx::snapshot(2, s2.clone(), fx::SONNET)),
    );
    s.reply(OPERATIONS, Reply::json(0, Value::Null));
    click(cx, h, "insights-review-save");
    until(cx, h, |w, cx| {
        w.try_find("insights-unconfirmed").is_some() && state_is(&view, SLOT, State::Unknown, cx)
    });
    let env = sent(&posts(&s), "/api/operations")[0].clone();
    let op = serde_json::from_value::<crate::delivery_store::Operation>(env.clone()).unwrap();
    s.reply(
        RECEIPT,
        Reply::json(200, fx::receipt(&op, "rejected", Value::Null)),
    );
    click(cx, h, "insights-check");
    until(cx, h, |w, cx| {
        state_is(&view, SLOT, State::Rejected, cx)
            && ready(&view, cx)
            && p.read(cx).probe_review_stale()
            && w.try_find("insights-review-stale").is_some()
    });
    lookups_only(&s, &env);
    assert_eq!(values(cx, &view).budget_usd, 9., "edits kept after refusal");
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-outcome").is_some(), "refusal shown");
        assert!(
            disabled(w, "insights-review-save"),
            "stale edits need a choice first"
        );
    })
    .unwrap();
    shot(cx, h, dir, "stale");

    // Keep mine: the next Save names revision 2 explicitly. Its ACK is malformed.
    click(cx, h, "insights-review-keep");
    s.reply(
        OPERATIONS,
        Reply::json(200, json!({"state":"accepted","result":{"revision":3}})),
    );
    click(cx, h, "insights-review-save");
    until(cx, h, |w, cx| {
        w.try_find("insights-unconfirmed").is_some()
            && ready(&view, cx)
            && state_is(&view, SLOT, State::Unknown, cx)
    });
    let all = posts(&s);
    assert_eq!(all.len(), 1, "one Save");
    let env = sent(&all, "/api/operations")[0].clone();
    let op = serde_json::from_value::<crate::delivery_store::Operation>(env.clone()).unwrap();
    let payload: Value = serde_json::from_str(&op.payload).unwrap();
    assert_eq!(payload["expectedRevision"], 2);
    assert_eq!(payload["settings"]["budget"]["usd"], 9);
    assert_eq!(
        payload["settings"]["bounds"]["historyPages"], 2,
        "the user's own values, not Local's"
    );
    // A receipt for these bytes with a wrong revision is malformed too: still Unknown.
    s.reply(
        RECEIPT,
        Reply::json(
            200,
            fx::receipt(
                &op,
                "accepted",
                json!({"revision":9,"settings":payload["settings"],"model":fx::SONNET}),
            ),
        ),
    );
    click(cx, h, "insights-check");
    until(cx, h, |w, cx| {
        ready(&view, cx) && w.try_find("insights-waiting").is_none()
    });
    lookups_only(&s, &env);
    assert!(cx.update(|cx| state_is(&view, SLOT, State::Unknown, cx)));
    // Check: a pending marker for other bytes stays Unknown; nothing is resent.
    s.reply(
        RECEIPT,
        Reply::json(
            200,
            fx::receipt(&op, "pending", json!({"phase":"model_pending"})),
        ),
    );
    click(cx, h, "insights-check");
    until(cx, h, |w, cx| {
        ready(&view, cx) && w.try_find("insights-waiting").is_none()
    });
    lookups_only(&s, &env);
    assert!(cx.update(|cx| state_is(&view, SLOT, State::Unknown, cx)));
    // Check: entered, not saved. Still status-only.
    s.reply(
        RECEIPT,
        Reply::json(
            200,
            fx::receipt(&op, "pending", json!({"phase":"settings_pending"})),
        ),
    );
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| {
        ready(&view, cx) && state_is(&view, SLOT, State::Pending, cx)
    });
    lookups_only(&s, &env);
    cx.update_window(h, |_, w, _| {
        assert!(disabled(w, "insights-review-save") && disabled(w, "insights-review-apply"));
    })
    .unwrap();
    let mut s3 = payload["settings"].clone();
    s3["budget"]["basis"] = json!("user_choice");
    s.reply(
        SETTINGS,
        Reply::json(200, fx::snapshot(3, s3.clone(), fx::SONNET)),
    );
    s.reply(
        RECEIPT,
        Reply::json(
            200,
            fx::receipt(
                &op,
                "accepted",
                json!({"revision":3,"settings":payload["settings"],"model":fx::SONNET}),
            ),
        ),
    );
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| {
        state_is(&view, SLOT, State::Accepted, cx)
            && ready(&view, cx)
            && p.read(cx)
                .probe_review_base()
                .is_some_and(|b| b.revision == 3)
    });
    lookups_only(&s, &env);

    // Discard: another change while editing, and the user takes Local's values.
    type_into(cx, h, &view, 1, "11");
    let mut s4 = s3.clone();
    s4["recurrence"] = weekly(3, "12:00", "Europe/Paris");
    s.reply(
        SETTINGS,
        Reply::json(200, fx::snapshot(4, s4.clone(), fx::SONNET)),
    );
    escape(cx, h);
    open_review(cx, h, &view);
    until(cx, h, |_, cx| p.read(cx).probe_review_stale());
    click(cx, h, "insights-review-discard");
    assert_eq!(values(cx, &view).to_value(), s4);
    assert!(cx.update(|cx| !p.read(cx).probe_review_dirty(cx)));

    // Model refusal: the saved model is gone. The editor warns; Apply is blocked, no fallback.
    let mut gone = fx::snapshot(4, s4.clone(), fx::SONNET);
    gone["model"] = json!({"state":"unavailable","reason":"not_found"});
    s.reply(SETTINGS, Reply::json(200, gone));
    s.reply(
        APPLY,
        Reply::json(200, fx::blocked("Saved model is unavailable or changed")),
    );
    escape(cx, h);
    open_review(cx, h, &view);
    until(cx, h, |w, _| {
        w.try_find("insights-review-model-warning").is_some()
    });
    click(cx, h, "insights-review-apply");
    until(cx, h, |w, cx| {
        ready(&view, cx) && w.try_find("insights-apply-blocked").is_some()
    });
    cx.update_window(h, |_, w, _| {
        assert!(disabled(w, "insights-apply-confirm"));
        contained(w, width, &["insights-apply-retry", "insights-apply-back"]);
    })
    .unwrap();
    shot(cx, h, dir, "model-refused");
    click(cx, h, "insights-apply-retry");
    until(cx, h, |w, cx| {
        ready(&view, cx) && w.try_find("insights-apply-blocked").is_some()
    });
    click(cx, h, "insights-apply-back");
    assert_eq!(cx.update(|cx| mode(&view, cx)), "edit");
    assert!(posts(&s).is_empty(), "refusals send nothing");
    escape(cx, h);
    drop(p);
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);
    println!(
        "insights settings conflicts 1100 Light: stale CAS refusal, Keep mine, malformed acceptance, foreign pending marker, entered marker, Discard and model refusal passed"
    );
}

/// A Local without the Apply interface: no settings read, no editor, nothing sent.
fn older_local(cx: &mut HeadlessAppContext) {
    let s = server(false);
    let m = mount(cx, &s, 1100., ThemeMode::Light, None);
    let (h, view) = (m.h, m.view.clone());
    open_review(cx, h, &view);
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-review-blocked").is_some());
        assert!(w.try_find("insights-review-save").is_none());
    })
    .unwrap();
    assert!(
        !s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(_, p)| p == SETTINGS),
        "no settings read without both capabilities"
    );
    assert!(posts(&s).is_empty());
    escape(cx, h);
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);
}

/// Layout only: sources open with every row kind, then the replacement preview.
fn render_only(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>, width: f32, theme: ThemeMode) {
    let s = server(true);
    let mut settings = edited();
    settings["scope"]["projects"] = json!(["project-A", "project-gone"]);
    settings["scope"]["excludeProjects"] = json!(["project-old"]);
    settings["scope"]["excludeSessions"] = json!(["9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f"]);
    s.reply(
        SETTINGS,
        Reply::json(200, fx::snapshot(2, settings.clone(), fx::TERRA)),
    );
    let m = mount(cx, &s, width, theme, None);
    let (h, view) = (m.h, m.view.clone());
    open_review(cx, h, &view);
    let p = panel(cx, &view);
    cx.update(|cx| p.update(cx, |p, cx| p.probe_review_sources(true, cx)));
    settle(cx, h);
    let name = format!(
        "{}-{}",
        width as u32,
        if theme == ThemeMode::Dark {
            "dark"
        } else {
            "light"
        }
    );
    cx.update_window(h, |_, w, _| {
        for id in [
            "insights-review-unavailable",
            "insights-review-other-excluded",
            "insights-review-chats",
        ] {
            assert!(w.try_find(id).is_some(), "{id} rendered");
        }
        contained(
            w,
            width,
            &[
                "insights-review-save",
                "insights-close",
                "insights-review-apply",
            ],
        );
    })
    .unwrap();
    shot(cx, h, dir, &format!("sources-{name}"));
    let mut cleaned = settings.clone();
    cleaned["scope"]["projects"] = json!(["project-A"]);
    s.reply(
        APPLY,
        Reply::json(
            200,
            fx::ready(
                2,
                cleaned,
                fx::SONNET,
                fx::TERRA,
                fx::rule(Some(1), weekly(5, "18:00", "Europe/Paris")),
            ),
        ),
    );
    // The editor is unedited, so the preview opens; it shows the replacement only.
    click(cx, h, "insights-review-apply");
    until(cx, h, |_, cx| {
        ready(&view, cx) && mode(&view, cx) == "preview"
    });
    cx.update_window(h, |_, w, _| {
        contained(w, width, &["insights-apply-confirm", "insights-apply-back"]);
    })
    .unwrap();
    shot(cx, h, dir, &format!("preview-{name}"));
    assert!(posts(&s).is_empty(), "render-only passes write nothing");
    escape(cx, h);
    drop(p);
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);
}
