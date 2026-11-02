//! Actual LocalViewer sidebar navigation to the Automations page, against an owned faux daemon.
use super::*;
use crate::{
    mission_browser_fixture::{Reply, Server},
    scheduled_messages_tests as f,
};
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    base::TextSelection,
    component::{ActiveTheme, Theme, ThemeMode},
    point, size,
    test::TestWindowExt,
};
use serde_json::json;
use std::time::Instant;
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
#[track_caller]
fn until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    v: &Entity<LocalViewer>,
    done: impl Fn(&crate::automations_view::Automations) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update(|cx| done(v.read(cx).automations.read(cx))) {
        assert!(Instant::now() < end, "bounded faux automations read");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn idle(a: &crate::automations_view::Automations) -> bool {
    !a.state.busy && a.pending.is_none()
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: String) {
    if let Some(dir) = std::env::var_os("PILOT_NEXT_AUTOMATIONS_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(format!("{name}.png")))
            .unwrap();
    }
}
fn exists(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &str) -> bool {
    cx.update_window(h, |_, w, _| w.try_find(id.to_owned()).is_some())
        .unwrap()
}
fn deletes(s: &Server) -> usize {
    s.state
        .lock()
        .unwrap()
        .seen
        .iter()
        .filter(|(m, _)| m != "GET")
        .count()
}
pub fn run_automations_probe(cx: &mut HeadlessAppContext) {
    cx.update(|cx| cx.set_reduce_motion(true));
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let now = crate::usage_overview::now();
            let s = Server::start();
            let mut r = Reply::json(200, f::roster_at(now));
            r.delay_ms = 180;
            s.reply("/api/schedules", r);
            let (h, v) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(900.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| {
                            cx.new(|cx| {
                                w.activate_window();
                                let mut v = LocalViewer::build(None, None, w, cx);
                                v.automations
                                    .update(cx, |a, _| a.connect(s.options.clone()));
                                v.state.projects = Arc::new(crate::local_model::projects(&json!([{"id":"project-a","name":"Pilot","path":"/synthetic/a"},{"id":"project-b","name":"Docs 日本語","path":"/synthetic/b"}])).unwrap());
                                v.state.chats = Arc::new(vec![crate::local_model::chat(&json!({"id":"chat-a","title":"Design review 👩‍💻","projectId":"project-a","state":"idle"})).unwrap()]);
                                v.state.projects_loaded = true;
                                v.state.list_loaded = true;
                                v.state.loaded = true;
                                v.state.status = "Synthetic Local fixture".into();
                                v.rebuild_nav(w, cx);
                                v
                            })
                        },
                    )
                })
                .unwrap();
            // Production window-open appearance follows the system. Pin only afterwards.
            cx.update(|cx| Theme::change(mode, None, cx));
            settle(cx, h);
            cx.update(|cx| assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark));
            assert!(
                s.state.lock().unwrap().seen.is_empty(),
                "no schedule read before navigation"
            );
            assert!(!exists(cx, h, "settings-schedules"));
            cx.update_window(h, |_, w, cx| w.click("nav-automations", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(cx.update(|cx| v.read(cx).page.clone()), Page::Automations);
            assert!(exists(cx, h, "automations-loading"));
            assert!(!exists(cx, h, "automations-empty"));
            until(cx, h, &v, idle);
            assert!(cx.update(|cx| v.read(cx).automations.read(cx).state.error.is_none()));
            // Upcoming and failed rows only; sent and cancelled history stays off the page.
            for id in ["one", "two", "four", "six"] {
                assert!(exists(cx, h, &format!("automation-row-{id}")), "{id}");
            }
            for id in ["three", "five"] {
                assert!(!exists(cx, h, &format!("automation-row-{id}")), "{id}");
            }
            assert!(exists(cx, h, "automations-attention"));
            assert!(exists(cx, h, "automations-one-time"));
            assert!(
                !exists(cx, h, "automation-action-six"),
                "sending rows can't be cancelled"
            );
            assert!(
                !exists(cx, h, "automation-message-one"),
                "details start collapsed"
            );
            cx.update_window(h, |_, w, _| {
                let right = w.find("automations").bounds().right();
                for id in [
                    "automations-page",
                    "automations-title",
                    "automations-refresh",
                    "automation-text-one",
                    "automation-action-one",
                    "automation-details-one",
                ] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.size.width > px(0.) && b.right() <= right,
                        "{id}: {b:?} within {right:?}"
                    );
                }
            })
            .unwrap();
            capture(cx, h, format!("{width}-{mode:?}-list"));
            // The row opens its message; technical fields stay under Details.
            cx.update_window(h, |_, w, cx| w.click("automation-text-one", cx))
                .unwrap();
            settle(cx, h);
            assert!(exists(cx, h, "automation-message-one"));
            assert!(!exists(cx, h, "automation-technical-text-one"));
            cx.update_window(h, |_, w, cx| w.click("automation-technical-one", cx))
                .unwrap();
            settle(cx, h);
            assert!(exists(cx, h, "automation-technical-text-one"));
            capture(cx, h, format!("{width}-{mode:?}-details"));
            cx.update_window(h, |_, w, cx| {
                let b = w.find("automation-message-one").bounds();
                let a = point(b.left() + px(1.), b.top() + px(7.));
                w.drag(a, a + point(px(90.), px(0.)), cx);
                let text = TextSelection::selected_text(w, cx);
                assert!(!text.trim().is_empty());
                assert!(
                    f::MESSAGE.contains(text.trim()),
                    "Unicode selection: {text:?}"
                );
                w.press("secondary-c", cx);
                // Kit copy trims selection edges.
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap().trim(),
                    text.trim()
                );
            })
            .unwrap();
            // The chevron is a keyboard control too.
            for _ in 0..40 {
                if cx
                    .update_window(h, |_, w, _| {
                        w.find("automation-details-four").focused() == Some(true)
                    })
                    .unwrap()
                {
                    break;
                }
                cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
                settle(cx, h);
            }
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("automation-details-four").focused(), Some(true));
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(exists(cx, h, "automation-message-four"));
            assert!(!exists(cx, h, "automation-message-one"));
            // Cancel: a fresh record check, one DELETE, then a passive re-read.
            let mut after = f::roster_at(now);
            after[0]["state"] = json!("cancelled");
            after[0]["revision"] = json!(2);
            s.reply(
                "GET /api/schedules/one",
                Reply::json(200, f::roster_at(now)[0].clone()),
            );
            s.reply(
                "DELETE /api/schedules/one",
                Reply::json(200, json!({"ok": true})),
            );
            s.reply("GET /api/schedules", Reply::json(200, after.clone()));
            cx.update_window(h, |_, w, cx| w.click("automation-action-one", cx))
                .unwrap();
            settle(cx, h);
            until(cx, h, &v, idle);
            assert_eq!(deletes(&s), 1);
            assert!(exists(cx, h, "automations-note"));
            assert!(!exists(cx, h, "automation-row-one"));
            capture(cx, h, format!("{width}-{mode:?}-cancelled"));
            // A refused cancel says so on its row and sends nothing.
            let mut changed = after[3].clone();
            changed["revision"] = json!(9);
            s.reply("GET /api/schedules/four", Reply::json(200, changed));
            cx.update_window(h, |_, w, cx| w.click("automation-action-four", cx))
                .unwrap();
            settle(cx, h);
            until(cx, h, &v, idle);
            assert_eq!(deletes(&s), 1);
            assert!(exists(cx, h, "automation-note-four"));
            // A failed refresh keeps the last report and says so.
            let at = cx.update(|cx| v.read(cx).automations.read(cx).state.read_at);
            s.reply("GET /api/schedules", Reply::json(503, json!({})));
            cx.update_window(h, |_, w, cx| w.click("automations-refresh", cx))
                .unwrap();
            until(cx, h, &v, idle);
            assert_eq!(
                cx.update(|cx| v.read(cx).automations.read(cx).state.read_at),
                at
            );
            assert!(exists(cx, h, "automations-error"));
            assert!(exists(cx, h, "automations-stale"));
            assert!(exists(cx, h, "automation-row-four"));
            capture(cx, h, format!("{width}-{mode:?}-stale"));
            s.reply(
                "GET /api/schedules",
                Reply::json(200, json!([after[2].clone()])),
            );
            cx.update_window(h, |_, w, cx| w.click("automations-refresh", cx))
                .unwrap();
            until(cx, h, &v, idle);
            assert!(exists(cx, h, "automations-empty"));
            assert!(!exists(cx, h, "automations-one-time"));
            assert!(!exists(cx, h, "automations-attention"));
            capture(cx, h, format!("{width}-{mode:?}-empty"));
            // Leaving cancels an in-flight read; coming back reads again.
            let mut slow = Reply::json(200, f::roster_at(now));
            slow.delay_ms = 400;
            s.reply("GET /api/schedules", slow);
            cx.update_window(h, |_, w, cx| {
                w.click("automations-refresh", cx);
                w.click("nav-home", cx);
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(cx.update(|cx| v.read(cx).page.clone()), Page::Home);
            assert!(!cx.update(|cx| v.read(cx).automations.read(cx).state.busy));
            cx.update_window(h, |_, w, cx| w.press("secondary-4", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(cx.update(|cx| v.read(cx).page.clone()), Page::Automations);
            until(cx, h, &v, idle);
            assert!(exists(cx, h, "automation-row-one"));
            assert_eq!(deletes(&s), 1);
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        }
    }
}
