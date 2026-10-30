//! Real hidden GPUI, passive faux detail and injected external opener only.
use super::*;
use crate::mission_browser_fixture::{self as f, Reply, Server};
use gpui_kit::{
    AnyWindowHandle, Bounds, Entity, HeadlessAppContext, ScrollDelta, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    point, size,
    test::TestWindowExt,
};
use serde_json::{Value, json};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    v: &Entity<Browser>,
    ready: impl Fn(&Browser, &App) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(15);
    while !cx.update(|cx| ready(v.read(cx), cx)) {
        assert!(Instant::now() < end, "bounded mission resource wait");
        frame(cx, h);
        std::thread::yield_now();
    }
    frame(cx, h);
}
fn input(id: &str, online: bool) -> Input {
    Input {
        route: Some(Route::Detail(f::key(id))),
        filter: None,
        projects: Arc::new(vec![]),
        chats: Arc::new(vec![]),
        online,
        loaded: true,
    }
}
fn detail() -> Value {
    let mut v = f::detail("mission-A");
    v["resources"] = json!([
        {"id":"pr","url":"https://github.com/example/repository/pull/42?x=%20#discussion","title":"Reported change 日本語 👩‍💻","kind":"github.pr","externalId":"example/repository#42","taskId":"task-B","relationship":"ownership","addedBySessionId":"chat-A","createdAt":1},
        {"id":"ref","url":"https://example.test/日本語?q=%20#precise","title":"Same title","kind":"url","relationship":"reference","createdAt":2},
        {"id":"missing","url":"https://example.test/same","title":"Preserve the reader","kind":"url","taskId":"2","relationship":"reference","createdAt":3},
        {"id":"bad","url":"javascript:alert(1)","title":"Unsafe URL","kind":"url","createdAt":4},
        {"id":"long","url":format!("https://example.test/{}?literal=%20", "segment日本語".repeat(40)),"title":"Long 👩‍💻 é 日本語 ".repeat(20),"kind":"url","createdAt":5}
    ]);
    v
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: String) {
    if let Some(dir) = std::env::var_os("PILOT_NEXT_MISSION_RESOURCES_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(name))
            .unwrap();
    }
}
pub fn run_mission_resources_probe(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::start();
            server.reply("/api/missions/mission-A", Reply::json(200, detail()));
            let opened = Arc::new(Mutex::new(Vec::<String>::new()));
            let record = opened.clone();
            cx.update(|cx| {
                cx.set_global(crate::external_links::Opener(Arc::new(move |url, _| {
                    record.lock().unwrap().push(url.into())
                })))
            });
            let (h, v) = cx
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
                            let v = cx.new(Browser::new);
                            v.update(cx, |v, cx| {
                                v.options(server.options.clone());
                                v.catalog = Some(Arc::new(
                                    crate::mission_browser::catalog(&f::catalog()).unwrap(),
                                ));
                                v.sync(input("mission-A", true), w, cx);
                            });
                            v
                        },
                    )
                })
                .unwrap();
            cx.update_window(h, |_, w, cx| {
                Theme::change(mode, Some(w), cx);
                assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark);
                w.activate_window();
                v.read(cx).focus.clone().focus(w, cx);
            })
            .unwrap();
            until(cx, h, &v, |v, _| v.detail.is_some() && !v.busy);
            let reads = server.state.lock().unwrap().seen.len();
            cx.update_window(h, |_, w, cx| {
                for _ in 0..60 {
                    w.press("tab", cx);
                    if w.find("mission-links-browse").focused() == Some(true) {
                        break;
                    }
                }
                assert_eq!(w.find("mission-links-browse").focused(), Some(true));
                let top = w.find("mission-links-browse").bounds().top();
                w.scroll(
                    "missions-page",
                    ScrollDelta::Pixels(point(px(0.), px(240.) - top)),
                    cx,
                );
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(v.read(cx).resources.open);
                assert_eq!(v.read(cx).resource_rows().unwrap().len(), 5);
                let list = w.find("mission-links-list").bounds();
                let row = w.find("mission-link-pr").bounds();
                assert!(row.left() >= list.left() && row.right() <= list.right());
                assert!(row.size.height > px(36.));
                assert!(
                    w.find("mission-link-pr")
                        .label()
                        .unwrap()
                        .contains("Task #2")
                );
                w.press("enter", cx);
            })
            .unwrap();
            frame(cx, h);
            capture(
                cx,
                h,
                format!("{}-{}-detail.png", width as u32, mode.name()),
            );
            cx.update_window(h, |_, w, cx| {
                assert!(v.read(cx).resources.detail);
                // Tab reaches native actions, Return uses the injected opener exactly once.
                for _ in 0..20 {
                    w.press("tab", cx);
                    if w.find("mission-link-open").focused() == Some(true) {
                        break;
                    }
                }
                assert_eq!(w.find("mission-link-open").focused(), Some(true));
                w.press("enter", cx);
                assert_eq!(
                    &*opened.lock().unwrap(),
                    &[detail()["resources"][0]["url"].as_str().unwrap()]
                );
                w.press("tab", cx);
                assert_eq!(w.find("mission-link-copy").focused(), Some(true));
                w.press("enter", cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    detail()["resources"][0]["url"].as_str().unwrap()
                );
                w.press("tab", cx);
                assert_eq!(w.find("mission-link-task").focused(), Some(true));
                w.press("enter", cx);
            })
            .unwrap();
            until(cx, h, &v, |v, cx| {
                v.tab == Tab::Tasks
                    && v.tasks_browser.read(cx).state.selected.as_deref() == Some("task-B")
            });
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    v.read(cx).tasks_browser.read(cx).state.key,
                    Some(f::key("mission-A"))
                );
                v.update(cx, |v, cx| {
                    v.choose_tab(Tab::Overview, true, w, cx);
                    v.open_resources(v.generation, w, cx);
                });
                w.press("down", cx);
                w.press("down", cx);
                w.press("enter", cx);
                assert_eq!(w.find("mission-link-task").disabled(), Some(true));
                assert_eq!(
                    v.read(cx).resource_rows().unwrap()[2].task.as_deref(),
                    Some("2")
                );
                w.click("mission-links-back", cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.press("down", cx);
                w.press("enter", cx);
                assert_eq!(w.find("mission-link-open").disabled(), Some(true));
                w.click("mission-link-copy", cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    "javascript:alert(1)"
                );
                w.press("escape", cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.press("end", cx);
                w.press("enter", cx);
            })
            .unwrap();
            frame(cx, h);
            capture(cx, h, format!("{}-{}-long.png", width as u32, mode.name()));
            cx.update_window(h, |_, w, cx| {
                let pane = w.find("mission-link-details").bounds();
                let url = w.find("mission-link-url").bounds();
                let back = w.find("mission-links-back").bounds();
                assert!(
                    back.top() >= px(0.) && back.bottom() <= pane.top(),
                    "fixed detail header: {back:?} {pane:?}"
                );
                assert!(url.left() >= pane.left() && url.right() <= pane.right());
                // A long URL can put actions below the viewport. Scroll through its actual owner.
                w.scroll(
                    "mission-link-details",
                    ScrollDelta::Pixels(point(px(0.), px(-3000.))),
                    cx,
                );
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.click("mission-link-copy", cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    detail()["resources"][4]["url"].as_str().unwrap()
                );
                w.press("escape", cx);
                assert!(v.read(cx).focus.is_focused(w));
                w.press("escape", cx);
                assert!(!v.read(cx).resources.open);
            })
            .unwrap();
            assert!(
                server.state.lock().unwrap().seen[reads..]
                    .iter()
                    .all(|(_, p)| p == "/api/hello"),
                "task navigation may recheck hello, never reload resource detail"
            );
            // Retained links remain inspectable and exactly copyable offline, but no Open.
            let captured = cx.update(|cx| {
                (
                    v.read(cx).resource_rows().unwrap()[0].clone(),
                    v.read(cx).generation,
                )
            });
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    v.open_resources(v.generation, w, cx);
                    v.sync(input("mission-A", false), w, cx);
                })
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.press("enter", cx);
                assert_eq!(w.find("mission-link-open").disabled(), Some(true));
                w.click("mission-link-copy", cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    captured.0.url
                );
                v.update(cx, |v, cx| v.sync(input("mission-A", true), w, cx));
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    w.find("mission-link-open").disabled(),
                    Some(true),
                    "reconnect is not freshness"
                );
                w.press("escape", cx);
                w.press("escape", cx);
            })
            .unwrap();
            // Held A refresh, navigate B then A: old generation callbacks cannot retarget.
            let mut held = Reply::json(200, detail());
            held.delay_ms = 350;
            server.reply("/api/missions/mission-A", held);
            cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.read(w, cx)))
                .unwrap();
            until(cx, h, &v, |v, _| {
                v.busy
                    && server
                        .state
                        .lock()
                        .unwrap()
                        .seen
                        .iter()
                        .filter(|(_, p)| p == "/api/missions/mission-A")
                        .count()
                        >= 2
            });
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.sync(input("mission-B", true), w, cx))
            })
            .unwrap();
            until(cx, h, &v, |v, _| {
                !v.busy && v.detail.as_ref().is_some_and(|d| d.key.id == "mission-B")
            });
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    v.open_resources(v.generation, w, cx);
                    v.resource_copy(&captured.0, captured.1, cx);
                    v.resource_open(&captured.0, captured.1, cx);
                });
                assert!(w.try_find("mission-link-pr").is_none());
            })
            .unwrap();
            let late = Instant::now() + Duration::from_millis(400);
            until(cx, h, &v, |_, _| Instant::now() >= late);
            assert_eq!(opened.lock().unwrap().len(), 1);
            server.reply("/api/missions/mission-A", Reply::json(200, detail()));
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.sync(input("mission-A", true), w, cx))
            })
            .unwrap();
            until(cx, h, &v, |v, _| {
                !v.busy && v.detail.as_ref().is_some_and(|d| d.key.id == "mission-A")
            });
            // A read admitted before a disconnect remains retained, even if it
            // finishes after reconnect on the same mission and generation.
            let before = server.state.lock().unwrap().seen.len();
            let mut held = Reply::json(200, detail());
            held.delay_ms = 350;
            server.reply("/api/missions/mission-A", held);
            cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.read(w, cx)))
                .unwrap();
            until(cx, h, &v, |_, _| {
                server.state.lock().unwrap().seen[before..]
                    .iter()
                    .any(|(_, p)| p == "/api/missions/mission-A")
            });
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    v.sync(input("mission-A", false), w, cx);
                    v.sync(input("mission-A", true), w, cx);
                })
            })
            .unwrap();
            until(cx, h, &v, |v, _| !v.busy);
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.open_resources(v.generation, w, cx));
                w.press("enter", cx);
                assert_eq!(w.find("mission-link-open").disabled(), Some(true));
                w.press("escape", cx);
                w.press("escape", cx);
            })
            .unwrap();
            // Error retains old rows with explicit stale state, not fresh actions.
            server.reply("/api/missions/mission-A", Reply::json(503, json!({})));
            cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.read(w, cx)))
                .unwrap();
            until(cx, h, &v, |v, _| !v.busy && v.error.is_some());
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.open_resources(v.generation, w, cx));
                w.press("enter", cx);
                assert_eq!(w.find("mission-link-open").disabled(), Some(true));
                w.press("escape", cx);
                w.press("escape", cx);
            })
            .unwrap();
            // Empty and unsupported section are distinct, not hidden success.
            for resources in [json!([]), json!("malformed")] {
                let mut d = detail();
                d["resources"] = resources.clone();
                server.reply("/api/missions/mission-A", Reply::json(200, d));
                cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.read(w, cx)))
                    .unwrap();
                until(cx, h, &v, |v, _| !v.busy);
                cx.update_window(h, |_, w, _| {
                    assert_eq!(
                        w.find("mission-links-browse").disabled().unwrap_or(false),
                        !resources.is_array()
                    );
                })
                .unwrap();
                if resources.is_array() {
                    cx.update_window(h, |_, w, cx| {
                        w.click("mission-links-browse", cx);
                        assert!(v.read(cx).resources.open);
                        assert!(w.try_find("mission-link-open").is_none());
                        w.press("escape", cx);
                    })
                    .unwrap();
                }
            }
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    v.options(LocalOptions::synthetic(1));
                    v.resource_copy(&captured.0, captured.1, cx);
                    v.resource_open(&captured.0, captured.1, cx);
                    assert!(!v.resources.open);
                    assert_eq!(opened.lock().unwrap().len(), 1);
                    let _ = w;
                })
            })
            .unwrap();
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            assert!(server.all_gets());
            assert!(
                server
                    .state
                    .lock()
                    .unwrap()
                    .seen
                    .iter()
                    .all(|(_, p)| p == "/api/hello"
                        || p.starts_with("/api/missions/")
                        || p.starts_with("/api/sessions?archived=all&missionId="))
            );
            println!(
                "mission resources: hidden {width} {} keyboard/open/copy/task/Back/Escape/long/offline/late/error/empty passed",
                mode.name()
            );
        }
    }
}
