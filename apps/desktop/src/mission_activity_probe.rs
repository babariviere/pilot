//! Real mounted Browser and Activity; only the outer navigation host is synthetic.
use super::*;
use crate::mission_browser_fixture::{self as f, Reply, Server};
use gpui_kit::{
    AnyWindowHandle, AppContext, Bounds, Entity, HeadlessAppContext, ScrollDelta, WindowBounds,
    WindowOptions,
    component::{ActiveTheme, Theme, ThemeMode},
    point, size,
    test::TestWindowExt,
};
use serde_json::json;
use std::time::{Duration, Instant};
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
    view: &Entity<Browser>,
    p: impl Fn(&Browser, &App) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update(|cx| p(view.read(cx), cx)) {
        assert!(
            Instant::now() < end,
            "bounded activity journey at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn activity(v: &Browser) -> &Entity<crate::mission_activity_view::Activity> {
    v.activity_browser.as_ref().unwrap()
}
fn event(id: u64) -> serde_json::Value {
    // A confirmed push and a failed PR attempt, as the daemon records them.
    if id == 59 {
        return json!({"id":id,"kind":"github","text":"Same chat title pushed branch feat/inline-日本 · jj git push","sessionId":"chat-A","at":1700000000000u64+id});
    }
    if id == 57 {
        return json!({"id":id,"kind":"github","text":"Same chat title attempted: created PR #42 (failed, exit 1) · gh pr create","sessionId":"not-loaded","at":1700000000000u64+id});
    }
    json!({"id":id,"kind":if id==60{"handoff"}else{"task"},"text":if id==60 {format!("Same summary 私 👩‍💻\n{}", "A bounded handoff detail. ".repeat(8))}else{"Same summary 私 👩‍💻".into()},"sessionId":if id.is_multiple_of(2){Some("chat-A")}else{None},"at":1700000000000u64+id})
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: String) {
    if let Some(dir) = std::env::var_os("PILOT_NEXT_ACTIVITY_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(name))
            .unwrap();
    }
}
pub fn run_mission_activity_probe(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let opened = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
            let chat = crate::local_model::chat(&json!({"id":"chat-A","title":"Same chat title","missionId":"mission-A","projectId":"project-A","state":"idle"})).unwrap();
            let server = Server::start();
            server.reply(
                "/api/missions/mission-A/events",
                Reply::json(200, json!((11..=60).map(event).collect::<Vec<_>>())),
            );
            server.reply(
                "/api/missions/mission-A/events?before=11",
                Reply::json(200, json!((1..=10).map(event).collect::<Vec<_>>())),
            );
            server.reply(
                "/api/missions/mission-A/events?before=1",
                Reply::json(200, json!([])),
            );
            server.reply(
                "/api/missions/mission-B/events",
                Reply::json(200, json!([])),
            );
            let (h, view) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(840.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| {
                            let view = cx.new(Browser::new);
                            let opened = opened.clone();
                            view.update(cx, |v, cx| {
                                // Same emitted route identities as the LocalViewer host; no data injection.
                                cx.subscribe_in(&view, w, move |v, _, e: &Event, w, cx| match e {
                                    Event::Open { key, generation }
                                        if v.can_open(key, *generation) =>
                                    {
                                        v.route = Some(Route::Detail(key.clone()));
                                        v.read(w, cx);
                                    }
                                    Event::List { generation } if v.current(*generation) => {
                                        v.route = Some(Route::Catalog);
                                        v.read(w, cx);
                                    }
                                    Event::Chat { id, .. } => opened.borrow_mut().push(id.clone()),
                                    _ => {}
                                })
                                .detach();
                                v.options(server.options.clone());
                                v.sync(
                                    Input {
                                        route: Some(Route::Catalog),
                                        filter: None,
                                        projects: Arc::new(vec![]),
                                        chats: Arc::new(vec![chat.clone()]),
                                        online: true,
                                        loaded: true,
                                    },
                                    w,
                                    cx,
                                );
                            });
                            view
                        },
                    )
                })
                .unwrap();
            // Pin appearance AFTER window creation, then verify the actual mounted theme.
            cx.update_window(h, |_, w, cx| Theme::change(mode, Some(w), cx))
                .unwrap();
            until(cx, h, &view, |v, _| v.catalog.is_some() && !v.busy);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(cx.theme().mode, mode);
                assert_eq!(w.viewport_size().width, px(width));
                w.click(format!("mission-row-{}", f::key("mission-A").tag()), cx);
            })
            .unwrap();
            until(cx, h, &view, |v, _| {
                v.detail
                    .as_ref()
                    .is_some_and(|d| d.key == f::key("mission-A"))
                    && !v.busy
            });
            crate::mission_browser_view::probe_menu_command(cx, h, "Activity");
            until(cx, h, &view, |v, cx| {
                v.activity_open && activity(v).read(cx).state.loaded
            });
            cx.update_window(h, |_, w, cx| {
                let a = activity(view.read(cx)).read(cx);
                assert_eq!(a.state.rows.len(), 50);
                assert!(
                    view.read(cx).tasks_browser.read(cx).state.key.is_none(),
                    "hidden task source is suspended"
                );
                assert_eq!(a.state.rows[0].id, 60);
                assert!(w.find("mission-activity-page").bounds().size.width <= px(width));
                assert_eq!(w.find("mission-activity-page").focused(), Some(true));
                // Follow the mounted controls, including the user-update entry point.
                for id in [
                    "activity-overview",
                    "activity-refresh",
                    "activity-scope",
                    "activity-post-update",
                    "activity-copy-60",
                    "activity-expand-60",
                ] {
                    w.press("tab", cx);
                    assert_eq!(w.find(id).focused(), Some(true), "Tab reaches {id}");
                }
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("activity-detail-60").is_some(),
                    "keyboard opens canonical event"
                );
                let first = w.find("activity-event-60").bounds();
                let second = w.find("activity-event-59").bounds();
                let detail = w.find("activity-detail-60").bounds();
                assert!(second.top() >= first.bottom() + px(Space::SIDEBAR));
                assert!(detail.left() >= first.left() + px(Space::SIDEBAR));
                assert!(detail.right() <= first.right() - px(Space::SIDEBAR));
                assert!(w.find("activity-scope").bounds().bottom() < first.top());
                w.press("shift-tab", cx);
                assert_eq!(w.find("activity-copy-60").focused(), Some(true));
                w.press("enter", cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    event(60)["text"].as_str().unwrap()
                );
            })
            .unwrap();
            // The copy control paints only on card hover or keyboard focus,
            // with a fixed slot and no layout shift. Compare actual native pixels.
            cx.update_window(h, |_, w, cx| {
                w.click("activity-detail-60", cx);
                w.hover("activity-heading", cx);
            })
            .unwrap();
            settle(cx, h);
            let hidden = cx.capture_screenshot(h).unwrap();
            let (copy_bounds, card_bounds) = cx
                .update_window(h, |_, w, cx| {
                    let copy = w.find("activity-copy-60");
                    assert_eq!(copy.role(), Some(gpui_kit::Role::Button));
                    assert_eq!(copy.label(), Some("Copy event text"));
                    let bounds = copy.bounds();
                    let card = w.find("activity-event-60").bounds();
                    w.hover("activity-event-60", cx);
                    (bounds, card)
                })
                .unwrap();
            settle(cx, h);
            let hovered = cx.capture_screenshot(h).unwrap();
            let scale = hovered.width() as f32 / width;
            let mut changed = 0;
            for y in (f32::from(copy_bounds.top()) * scale) as u32
                ..(f32::from(copy_bounds.bottom()) * scale) as u32
            {
                for x in (f32::from(copy_bounds.left()) * scale) as u32
                    ..(f32::from(copy_bounds.right()) * scale) as u32
                {
                    changed += usize::from(hidden.get_pixel(x, y) != hovered.get_pixel(x, y));
                }
            }
            assert!(changed > 0, "hover must actually paint the clipboard icon");
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("activity-event-60").bounds(), card_bounds);
                w.click("activity-copy-60", cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    event(60)["text"].as_str().unwrap()
                );
            })
            .unwrap();
            // GitHub audit events are inline timeline lines like Swift, not cards.
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("activity-expand-59").is_none(),
                    "no card disclosure"
                );
                assert!(w.try_find("activity-github-icon-59").is_some());
                let line = w.find("activity-event-59").bounds();
                assert!(line.right() <= px(width));
                assert!(
                    line.size.height < w.find("activity-event-58").bounds().size.height,
                    "compact line, not a card"
                );
                let link = w.find("activity-chat-59");
                assert_eq!(link.role(), Some(gpui_kit::Role::Button));
                assert_eq!(link.label(), Some("Open chat Same chat title"));
                // A chat this client hasn't loaded is named, never linked.
                assert!(w.try_find("activity-chat-57").is_none());
                assert!(w.try_find("activity-github-icon-57").is_some());
                w.click("activity-chat-59", cx);
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(*opened.borrow(), ["chat-A"], "exact chat link");
            capture(
                cx,
                h,
                format!("{}-{}-timeline.png", width as u32, mode.name()),
            );
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "mission-activity-page",
                    ScrollDelta::Pixels(point(px(0.), px(-20000.))),
                    cx,
                )
            })
            .unwrap();
            settle(cx, h);
            let anchor = cx.update(|cx| activity(view.read(cx)).read(cx).scroll.offset());
            assert!(anchor.y < px(-100.));
            cx.update_window(h, |_, w, cx| w.click("activity-earlier", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| {
                activity(v).read(cx).state.rows.len() == 60
            });
            cx.update(|cx| assert_eq!(activity(view.read(cx)).read(cx).scroll.offset(), anchor));
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "mission-activity-page",
                    ScrollDelta::Pixels(point(px(0.), px(-20000.))),
                    cx,
                )
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("activity-earlier", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| activity(v).read(cx).state.exhausted);
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "mission-activity-page",
                    ScrollDelta::Pixels(point(px(0.), px(20000.))),
                    cx,
                )
            })
            .unwrap();
            settle(cx, h);
            // Explicit failing refresh retains exact events, never a false empty state.
            server.reply(
                "/api/missions/mission-A/events",
                Reply::json(503, json!({})),
            );
            cx.update_window(h, |_, w, cx| w.click("activity-refresh", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| {
                activity(v).read(cx).state.error.is_some()
            });
            cx.update(|cx| {
                let a = activity(view.read(cx)).read(cx);
                assert_eq!(a.state.rows.len(), 60);
                assert!(a.state.stale);
            });
            capture(
                cx,
                h,
                format!("{}-{}-retained-error.png", width as u32, mode.name()),
            );
            // Pending A reply is cancelled by real Back and mission navigation to B.
            let mut slow = Reply::json(200, json!([event(61)]));
            slow.delay_ms = 300;
            server.reply("/api/missions/mission-A/events", slow);
            let prior_reads = server
                .state
                .lock()
                .unwrap()
                .seen
                .iter()
                .filter(|(_, p)| p == "/api/missions/mission-A/events")
                .count();
            cx.update_window(h, |_, w, cx| {
                w.click("activity-retry", cx);
            })
            .unwrap();
            until(cx, h, &view, |v, cx| {
                activity(v).read(cx).state.pending.is_some()
                    && server
                        .state
                        .lock()
                        .unwrap()
                        .seen
                        .iter()
                        .filter(|(_, p)| p == "/api/missions/mission-A/events")
                        .count()
                        > prior_reads
            });
            cx.update_window(h, |_, w, cx| w.click("activity-overview", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(!view.read(cx).activity_open);
                assert_eq!(
                    view.read(cx).tasks_browser.read(cx).state.key,
                    Some(f::key("mission-A")),
                    "overview task source rearms without a read"
                );
                assert_eq!(w.find("missions-page").focused(), Some(true));
                w.click("missions-list", cx);
            })
            .unwrap();
            until(cx, h, &view, |v, _| {
                v.route == Some(Route::Catalog) && !v.busy
            });
            cx.update_window(h, |_, w, cx| {
                w.click(format!("mission-row-{}", f::key("mission-B").tag()), cx)
            })
            .unwrap();
            until(cx, h, &view, |v, _| {
                v.detail
                    .as_ref()
                    .is_some_and(|d| d.key == f::key("mission-B"))
                    && !v.busy
            });
            crate::mission_browser_view::probe_menu_command(cx, h, "Activity");
            until(cx, h, &view, |v, cx| activity(v).read(cx).state.loaded);
            cx.update(|cx| {
                let a = activity(view.read(cx)).read(cx);
                assert_eq!(a.state.key, Some(f::key("mission-B")));
                assert!(a.state.rows.is_empty());
                assert!(a.state.error.is_none());
            });
            assert!(server.all_gets());
            assert!(
                server
                    .state
                    .lock()
                    .unwrap()
                    .seen
                    .iter()
                    .all(|(_, p)| p == "/api/hello"
                        || p == "/api/mission-catalog"
                        || p.starts_with("/api/missions/")
                        || p.starts_with("/api/sessions?archived=all&missionId="))
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            drop(view);
            cx.run_until_parked();
            println!(
                "PASS activity mounted {width} {}: navigation, keyboard disclosure/copy, scroll anchor, earlier/end, retained error, focus return, source cancellation; GET-only",
                mode.name()
            );
        }
    }
}
