//! Mounted production Browser + task pane, owned GET-only server. No live client/writer.
use crate::{
    LocalOptions,
    mission_browser_fixture::{self as f, Reply, Server},
    mission_browser_view::{Browser, Event, Input},
    mission_reader::Route,
};
use gpui_kit::{
    AnyWindowHandle, App, AppContext, Bounds, Context, Entity, HeadlessAppContext, IntoElement,
    ParentElement, Render, ScrollDelta, Styled, Subscription, Window, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    div, point, px, size,
    test::TestWindowExt,
};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
struct Host {
    browser: Entity<Browser>,
    _events: Subscription,
}
fn input(route: Option<Route>) -> Input {
    Input {
        route,
        filter: None,
        projects: Arc::new(Vec::new()),
        chats: Arc::new(Vec::new()),
        online: true,
        loaded: true,
    }
}
impl Host {
    fn new(options: LocalOptions, w: &mut Window, cx: &mut Context<Self>) -> Self {
        let browser = cx.new(Browser::new);
        browser.update(cx, |b, cx| {
            b.options(options);
            b.sync(input(Some(Route::Catalog)), w, cx);
        });
        let events = cx.subscribe_in(&browser, w, |v, _, event, w, cx| {
            v.browser.update(cx, |b, cx| match event {
                Event::Open { key, generation } if b.can_open(key, *generation) => {
                    b.sync(input(Some(Route::Detail(key.clone()))), w, cx)
                }
                Event::List { generation } if b.generation == *generation => {
                    b.sync(input(Some(Route::Catalog)), w, cx)
                }
                _ => {}
            });
        });
        Self {
            browser,
            _events: events,
        }
    }
}
impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.browser.clone())
    }
}
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
    host: &Entity<Host>,
    f: impl Fn(&Browser, &App) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(6);
    while !cx.update(|cx| f(host.read(cx).browser.read(cx), cx)) {
        assert!(
            Instant::now() < end,
            "bounded task publication at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn reveal(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &str) {
    cx.update_window(h, |_, w, cx| {
        let viewport = w.find("missions-page").bounds();
        let target = w.find(gpui_kit::SharedString::from(id.to_owned())).bounds();
        let delta = viewport.top() + px(24.) - target.top();
        w.scroll(
            "missions-page",
            ScrollDelta::Pixels(point(px(0.), delta)),
            cx,
        );
    })
    .unwrap();
    settle(cx, h);
}
pub fn run_mission_tasks_probe(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_TASKS_DIR").map(std::path::PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    let case = std::env::var("PILOT_NEXT_TASKS_CASE").ok();
    assert!(
        case.as_deref()
            .is_none_or(|s| ["680-light", "680-dark", "1100-light", "1100-dark"].contains(&s))
    );
    let mut cases = 0;
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let name = format!(
                "{}-{}",
                width as u32,
                if mode == ThemeMode::Light {
                    "light"
                } else {
                    "dark"
                }
            );
            if case.as_ref().is_some_and(|c| c != &name) {
                continue;
            }
            cases += 1;
            let server = Server::start();
            let mut detail = f::detail("mission-A");
            detail["tasks"]=json!((0..40).map(|n|json!({"id":format!("exact-{n}"),"number":n+1,"title":"Same title 日本語 👩‍💻","status":if n%2==0 {"todo"} else {"blocked"},"body":format!("Exact description {n}\n\nUnicode 👩‍💻 é 日本語\nLiteral ![image](https://invalid.example) <script>no execution</script>"),"order":n})).collect::<Vec<_>>());
            server.reply("/api/missions/mission-A", Reply::json(200, detail.clone()));
            cx.update(|cx| Theme::change(mode, None, cx));
            let (h, host) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(1000.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| cx.new(|cx| Host::new(server.options.clone(), w, cx)),
                    )
                })
                .unwrap();
            until(cx, h, &host, |b, _| b.catalog.is_some() && !b.busy);
            cx.update(|cx| assert_eq!(Theme::global(cx).mode, mode));
            let row = format!("mission-row-{}", f::key("mission-A").tag());
            cx.update_window(h, |_, w, cx| {
                w.click(gpui_kit::SharedString::from(row.clone()), cx)
            })
            .unwrap();
            until(cx, h, &host, |b, _| b.detail.is_some() && !b.busy);
            let pane = cx.update(|cx| host.read(cx).browser.read(cx).tasks_browser.clone());
            let before = server.state.lock().unwrap().seen.len();
            settle(cx, h);
            assert_eq!(
                before,
                server.state.lock().unwrap().seen.len(),
                "collapsed pane never fetches"
            );
            reveal(cx, h, "mission-tasks-toggle");
            cx.update_window(h, |_, w, cx| w.click("mission-tasks-toggle", cx))
                .unwrap();
            until(cx, h, &host, |_, cx| {
                pane.read(cx).state.snapshot.is_some() && !pane.read(cx).state.busy
            });
            cx.update(|cx| {
                assert_eq!(
                    pane.read(cx).state.snapshot.as_ref().unwrap().tasks.len(),
                    40
                )
            });
            reveal(cx, h, "mission-tasks-list");
            cx.update_window(h, |_, w, cx| {
                let b = w.find("mission-tasks-list").bounds();
                assert!(b.left() >= px(0.) && b.right() <= px(width) && b.size.height > px(200.));
                w.click("mission-tasks-item-exact-0", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(pane.read(cx).state.selected.as_deref(), Some("exact-0")));
            reveal(cx, h, "mission-tasks-copy");
            cx.update_window(h, |_, w, cx| w.click("mission-tasks-copy", cx))
                .unwrap();
            cx.update(|cx| {
                let s = cx.read_from_clipboard().unwrap().text().unwrap();
                assert!(
                    s.contains("Exact description 0")
                        && s.contains("👩‍💻 é")
                        && s.contains("Task ID: exact-0")
                );
            });
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!("{name}-details.png")))
                    .unwrap();
            }
            // Escape from actual detail returns to mounted list; arrows/Enter select the other same-title ID.
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            reveal(cx, h, "mission-tasks-list");
            cx.update_window(h, |_, w, cx| {
                w.press("down", cx);
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(pane.read(cx).state.selected.as_deref(), Some("exact-1")));
            reveal(cx, h, "mission-tasks-copy");
            cx.update_window(h, |_, w, cx| w.click("mission-tasks-copy", cx))
                .unwrap();
            cx.update(|cx| {
                assert!(
                    cx.read_from_clipboard()
                        .unwrap()
                        .text()
                        .unwrap()
                        .contains("Exact description 1")
                )
            });
            // The received list is not the old 24-row preview: actual wheel reaches exact task 40.
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            reveal(cx, h, "mission-tasks-list");
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "mission-tasks-list",
                    ScrollDelta::Pixels(point(px(0.), px(-100_000.))),
                    cx,
                )
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("mission-tasks-item-exact-39", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(pane.read(cx).state.selected.as_deref(), Some("exact-39")));
            reveal(cx, h, "mission-tasks-copy");
            cx.update_window(h, |_, w, cx| w.click("mission-tasks-copy", cx))
                .unwrap();
            cx.update(|cx| {
                assert!(
                    cx.read_from_clipboard()
                        .unwrap()
                        .text()
                        .unwrap()
                        .contains("Exact description 39")
                )
            });
            // Refresh errors retain exact selected description, with explicit stale/error presentation.
            server.reply("/api/missions/mission-A", Reply::json(503, json!({})));
            reveal(cx, h, "mission-tasks-refresh");
            cx.update_window(h, |_, w, cx| w.click("mission-tasks-refresh", cx))
                .unwrap();
            until(cx, h, &host, |_, cx| {
                pane.read(cx).state.error.is_some() && !pane.read(cx).state.busy
            });
            cx.update(|cx| {
                let p = pane.read(cx);
                assert_eq!(p.state.selected.as_deref(), Some("exact-39"));
                assert_eq!(p.state.snapshot.as_ref().unwrap().tasks.len(), 40);
            });
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!("{name}-stale.png")))
                    .unwrap();
            }
            server.reply("/api/missions/mission-A", Reply::json(200, detail.clone()));
            reveal(cx, h, "mission-tasks-refresh");
            cx.update_window(h, |_, w, cx| w.click("mission-tasks-refresh", cx))
                .unwrap();
            until(cx, h, &host, |_, cx| {
                pane.read(cx).state.error.is_none() && !pane.read(cx).state.busy
            });
            // No automatic refresh or mutation on dismissal. Reopen and switch mission during a slow read.
            reveal(cx, h, "mission-tasks-toggle");
            let before = server.state.lock().unwrap().seen.len();
            cx.update_window(h, |_, w, cx| w.click("mission-tasks-toggle", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(before, server.state.lock().unwrap().seen.len());
            let mut slow = Reply::json(200, detail);
            slow.delay_ms = 400;
            server.reply("/api/missions/mission-A", slow);
            cx.update_window(h, |_, w, cx| w.click("mission-tasks-toggle", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                host.read(cx).browser.clone().update(cx, |b, cx| {
                    b.sync(input(Some(Route::Detail(f::key("mission-B")))), w, cx)
                })
            })
            .unwrap();
            until(cx, h, &host, |b, _| {
                b.detail.as_ref().is_some_and(|d| d.key.id == "mission-B") && !b.busy
            });
            cx.update(|cx| {
                let p = pane.read(cx);
                assert!(
                    !p.opened
                        && !p.state.busy
                        && p.state.snapshot.is_none()
                        && p.state.selected.is_none()
                );
                assert_eq!(p.state.key.as_ref().unwrap().id, "mission-B");
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
                        || p.starts_with("/api/missions/mission-")
                        || p.starts_with("/api/sessions?archived=all&missionId=mission-"))
            );
            cx.update(|cx| h.update(cx, |_, w, _| w.remove_window()).unwrap());
            cx.run_until_parked();
            println!(
                "mission_tasks {name}: exact IDs, 40-row list, keyboard, Unicode copy, stale refresh, mission cancellation PASS"
            );
        }
    }
    assert!(cases > 0, "nonzero selected task journeys");
}
