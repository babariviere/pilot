//! Hidden real Settings and Kit list against an isolated faux daemon.
use crate::{
    mission_browser_fixture::{Reply, Server},
    scheduled_messages_tests as f,
    scheduled_messages_view::ScheduledMessages,
    settings_view::{SettingsPreferences, SettingsView},
};
use gpui_kit::{
    AnyWindowHandle, AppContext, Bounds, Entity, HeadlessAppContext, WindowBounds, WindowOptions,
    base::TextSelection,
    component::{ActiveTheme, Theme, ThemeMode},
    point, px, size,
    test::TestWindowExt,
};
use std::time::{Duration, Instant};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| {
            w.draw(cx).clear(cx);
        })
        .unwrap();
    }
}
fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, v: &Entity<ScheduledMessages>) {
    let end = Instant::now() + Duration::from_secs(8);
    while cx.update(|cx| v.read(cx).state.busy) {
        assert!(Instant::now() < end, "bounded faux schedule read");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: String) {
    if let Some(dir) = std::env::var_os("PILOT_NEXT_SCHEDULES_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(format!("{name}.png")))
            .unwrap();
    }
}
pub fn run_scheduled_messages_probe(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let s = Server::start();
            f::install(&s);
            let mut r = Reply::json(200, f::roster());
            r.delay_ms = 180;
            s.reply("/api/schedules", r);
            let mut view = None;
            let (h, settings) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(1100.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        let schedules =
                            cx.new(|cx| ScheduledMessages::new(s.options.clone(), w, cx));
                        view = Some(schedules.clone());
                        let owner = cx.new(|_| {
                            let mut p = SettingsPreferences::new(None);
                            p.schedules = Some(schedules);
                            p
                        });
                        owner.update(cx, |p, cx| p.load(cx));
                        cx.new(|cx| SettingsView::new(owner, w, cx))
                    },
                )
                .unwrap()
            });
            let v = view.unwrap();
            // Production window-open appearance follows the system. Pin only afterwards.
            cx.update_window(h, |_, w, cx| Theme::change(mode, Some(w), cx))
                .unwrap();
            cx.update(|cx| assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark));
            settle(cx, h);
            assert!(
                s.state.lock().unwrap().seen.is_empty(),
                "no schedule read before navigation"
            );
            cx.update_window(h, |_, w, cx| {
                w.activate_window();
                w.click("settings-schedules", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("schedules-loading").is_some());
                assert!(w.try_find("schedules-empty").is_none());
            })
            .unwrap();
            capture(cx, h, format!("{width}-{mode:?}-loading"));
            until(cx, h, &v);
            assert!(cx.update(|cx| v.read(cx).state.error.is_none()));
            cx.update_window(h, |_, w, cx| w.click("schedules-refresh", cx))
                .unwrap();
            until(cx, h, &v);
            // macOS pointer activation need not transfer keyboard focus to a Button.
            for _ in 0..16 {
                if cx
                    .update_window(h, |_, w, _| {
                        w.find("schedules-refresh").focused() == Some(true)
                    })
                    .unwrap()
                {
                    break;
                }
                cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
                settle(cx, h);
            }
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("schedules-refresh").focused(), Some(true));
                w.press("tab", cx);
                w.press("down", cx);
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("schedules-detail-text").is_some())
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| {
                for id in [
                    "schedules-page",
                    "schedules-title",
                    "schedules-list",
                    "schedules-refresh",
                ] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.size.width > px(0.) && b.left() >= px(0.) && b.right() <= px(width),
                        "{id}: {b:?}"
                    );
                }
                w.click("schedule-row-one", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("schedules-detail-text").is_some())
            })
            .unwrap();
            // Real focused List keyboard changes record without sending or navigating chats.
            cx.update_window(h, |_, w, cx| {
                w.press("down", cx);
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("schedules-record-error").is_some())
            })
            .unwrap();
            capture(cx, h, format!("{width}-{mode:?}-failed-details"));
            cx.update_window(h, |_, w, cx| {
                w.click("schedule-row-one", cx);
            })
            .unwrap();
            settle(cx, h);
            capture(cx, h, format!("{width}-{mode:?}-time-details"));
            cx.update_window(h, |_, w, cx| {
                let b = w.find("schedules-detail-text").bounds();
                assert!(b.right() <= px(width), "literal details fit column");
                let a = point(b.left() + px(1.), b.top() + px(7.));
                w.drag(a, a + point(px(170.), px(0.)), cx);
                let text = TextSelection::selected_text(w, cx);
                assert!(!text.trim().is_empty());
                assert!(f::NAME.contains(text.trim()), "Unicode selection: {text:?}");
                w.press("secondary-c", cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), text);
            })
            .unwrap();
            let at = cx.update(|cx| v.read(cx).state.read_at);
            s.reply("/api/schedules", Reply::json(503, serde_json::json!({})));
            cx.update_window(h, |_, w, cx| w.click("schedules-refresh", cx))
                .unwrap();
            until(cx, h, &v);
            assert_eq!(cx.update(|cx| v.read(cx).state.read_at), at);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("schedules-error").is_some());
                assert!(w.try_find("schedules-stale").is_some());
                assert!(w.try_find("schedules-list").is_some());
            })
            .unwrap();
            capture(cx, h, format!("{width}-{mode:?}-stale"));
            s.reply("/api/schedules", Reply::json(200, serde_json::json!([])));
            cx.update_window(h, |_, w, cx| w.click("schedules-refresh", cx))
                .unwrap();
            until(cx, h, &v);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("schedules-empty").is_some());
                assert!(w.try_find("schedules-detail-text").is_none());
            })
            .unwrap();
            capture(cx, h, format!("{width}-{mode:?}-empty"));
            let mut r = Reply::json(200, f::roster());
            r.delay_ms = 180;
            s.reply("/api/schedules", r);
            cx.update_window(h, |_, w, cx| {
                w.click("schedules-refresh", cx);
                w.click("settings-appearance", cx);
            })
            .unwrap();
            assert!(!cx.update(|cx| v.read(cx).state.busy));
            assert!(cx.update(|cx| v.read(cx).state.snapshot.as_ref().unwrap().items.is_empty()));
            assert!(s.all_gets());
            assert!(
                s.state
                    .lock()
                    .unwrap()
                    .seen
                    .iter()
                    .all(|(_, p)| p == "/api/hello" || p == "/api/schedules")
            );
            cx.update_window(h, |_, w, cx| {
                assert!(settings.update(cx, |s, cx| s.request_close(w, cx)));
                w.remove_window();
            })
            .unwrap();
        }
    }
}
