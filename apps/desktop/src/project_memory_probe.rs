//! Actual hidden native memory page, owned faux Local only.
use crate::{
    local_model::Project,
    mission_browser_fixture::{Reply, Server},
    project_memory_reader::path,
    project_memory_tests as f,
    project_memory_view::Memory,
};
use gpui_kit::{
    AppContext, Bounds, Entity, HeadlessAppContext, WindowBounds, WindowOptions,
    base::TextSelection,
    component::{Theme, ThemeMode},
    point, px, size,
    test::TestWindowExt,
};
use std::time::{Duration, Instant};
fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| {
            w.draw(cx).clear(cx);
        })
        .unwrap();
    }
}
fn until(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle, v: &Entity<Memory>) {
    let end = Instant::now() + Duration::from_secs(8);
    while cx.update(|cx| v.read(cx).state.busy) {
        assert!(Instant::now() < end, "bounded synthetic memory response");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn search(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle, query: &str) {
    cx.update_window(h, |_, w, cx| {
        w.click("memory-search", cx);
        w.press("secondary-a", cx);
        w.input(query, cx);
    })
    .unwrap();
    settle(cx, h);
}

fn clear(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    cx.update_window(h, |_, w, cx| {
        w.click("memory-search-clear", cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        assert_eq!(w.find("memory-search").focused(), Some(true));
        assert!(w.try_find("memory-search-clear").is_none());
    })
    .unwrap();
}
pub fn run_project_memory_probe(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::start();
            f::install(&server);
            let mut delayed = Reply::json(200, f::root());
            delayed.delay_ms = 500;
            server.reply(&path("project-A", None).unwrap(), delayed);
            let (h, v) = cx.update(|cx| {
                Theme::change(mode, None, cx);
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
                        let v = cx.new(|cx| {
                            Memory::new(
                                Some(server.options.clone()),
                                Project {
                                    id: "project-A".into(),
                                    name: "Project conventions 日本語 👩‍💻 and lasting engineering choices".repeat(2),
                                    path: "/synthetic/project-A".into(),
                                    ..Default::default()
                                },
                                w, cx,
                            )
                        });
                        v.update(cx, |v, cx| {
                            v.focus(w, cx);
                            v.load(None, w, cx);
                        });
                        v
                    },
                )
                .unwrap()
            });
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("memory-loading").is_some());
                assert!(w.try_find("memory-empty").is_none());
            })
            .unwrap();
            // Editing during the initial pending read neither restarts it nor claims empty results.
            search(cx, h, "unmatched [");
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("memory-loading").is_some());
                assert!(w.try_find("memory-no-matches").is_none());
            })
            .unwrap();
            assert_eq!(cx.update(|cx| v.read(cx).state.generation), 1);
            clear(cx, h);
            until(cx, h, &v);
            assert!(cx.update(|cx| v.read(cx).state.error.is_none()));
            let reads = server.state.lock().unwrap().seen.len();
            let generation = cx.update(|cx| v.read(cx).state.generation);
            search(cx, h, "<source>");
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("memory-no-matches").is_some());
                assert!(w.try_find("memory-node-0-3").is_none());
                assert!(w.try_find("memory-search-scope").is_some());
            })
            .unwrap();
            search(cx, h, "日本語");
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("memory-node-0-3").is_some())
            })
            .unwrap();
            clear(cx, h);
            assert_eq!(server.state.lock().unwrap().seen.len(), reads);
            assert_eq!(cx.update(|cx| v.read(cx).state.generation), generation);
            cx.update_window(h, |_, w, cx| {
                for id in [
                    "memory-title",
                    "memory-controls",
                    "memory-node-0-3",
                    "memory-open-0",
                ] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.size.width > px(0.) && b.left() >= px(0.) && b.right() <= px(width),
                        "{id} contained at {width}"
                    );
                }
                // Reach and activate the real Kit summary button through keyboard only.
                w.activate_window();
                v.update(cx, |v, cx| v.focus(w, cx));
                w.focus_next(cx);
                for _ in 0..12 {
                    if w.find("memory-open-0").focused() == Some(true) {
                        break;
                    }
                    w.press("tab", cx);
                }
                assert_eq!(w.find("memory-open-0").focused(), Some(true));
                w.press("enter", cx);
            })
            .unwrap();
            until(cx, h, &v);
            assert!(cx.update(|cx| v.read(cx).state.range.is_some()));
            let reads = server.state.lock().unwrap().seen.len();
            let generation = cx.update(|cx| v.read(cx).state.generation);
            search(cx, h, ".*");
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("memory-no-matches").is_some())
            })
            .unwrap();
            search(cx, h, "👩‍💻 café");
            cx.update_window(h, |_, w, _| assert!(w.try_find("memory-text-3").is_some()))
                .unwrap();
            // Keyboard clear uses the normal editor and preserves browser path and generation.
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-a", cx);
                w.press("backspace", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(cx.update(|cx| v.read(cx).state.range.is_some()));
            assert_eq!(cx.update(|cx| v.read(cx).state.generation), generation);
            assert_eq!(server.state.lock().unwrap().seen.len(), reads);
            cx.update_window(h, |_, w, cx| {
                let b = w.find("memory-text-3").bounds();
                assert!(b.right() <= px(width));
                let a = point(b.left() + px(1.), b.top() + px(7.));
                w.drag(a, a + point(px(160.), px(0.)), cx);
                let selected = TextSelection::selected_text(w, cx);
                assert!(!selected.trim().is_empty());
                assert!(
                    f::note(3)["text"]
                        .as_str()
                        .unwrap()
                        .contains(selected.trim())
                );
                w.press("secondary-c", cx);
                assert!(!cx.read_from_clipboard().unwrap().text().unwrap().is_empty());
                w.click("memory-details", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| assert!(w.try_find("memory-scope").is_some()))
                .unwrap();
            // Capture calm default, not provenance diagnostics.
            cx.update_window(h, |_, w, cx| w.click("memory-details", cx))
                .unwrap();
            settle(cx, h);
            if let Some(dir) = std::env::var_os("PILOT_NEXT_MEMORY_DIR") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("memory-{width}-{mode:?}.png")))
                    .unwrap();
            }
            // Same-scope failures retain labeled stale rows. Range changes clear them.
            server.reply(
                &path(
                    "project-A",
                    Some(crate::project_memory::Range { lo: 0, hi: 3 }),
                )
                .unwrap(),
                Reply::json(503, serde_json::json!({})),
            );
            cx.update_window(h, |_, w, cx| w.click("memory-refresh", cx))
                .unwrap();
            until(cx, h, &v);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("memory-error").is_some());
                assert!(w.try_find("memory-retained").is_some());
            })
            .unwrap();
            let reads = server.state.lock().unwrap().seen.len();
            search(cx, h, "unmatched literal [");
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("memory-retained").is_some());
                assert!(w.try_find("memory-no-matches").is_some());
            })
            .unwrap();
            clear(cx, h);
            assert_eq!(server.state.lock().unwrap().seen.len(), reads);
            cx.update_window(h, |_, w, cx| w.click("memory-back", cx))
                .unwrap();
            until(cx, h, &v);
            assert!(cx.update(|cx| v.read(cx).state.range.is_none()));
            server.reply(
                &path("project-A", None).unwrap(),
                Reply::json(
                    200,
                    serde_json::json!({"count":0,"nodes":[],"truncated":false}),
                ),
            );
            cx.update_window(h, |_, w, cx| w.click("memory-refresh", cx))
                .unwrap();
            until(cx, h, &v);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("memory-empty").is_some());
                assert!(w.try_find("memory-node-0-3").is_none());
            })
            .unwrap();
            assert!(server.all_gets());
            let reads = server.state.lock().unwrap().seen.len();
            search(cx, h, "日本語");
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("memory-empty").is_some());
                assert!(w.try_find("memory-no-matches").is_some());
            })
            .unwrap();
            clear(cx, h);
            assert_eq!(server.state.lock().unwrap().seen.len(), reads);
            // Same label/path cannot redirect or disclose another project's rows.
            let (other, other_view) = cx.update(|cx| {
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
                        let v = cx.new(|cx| {
                            Memory::new(
                                Some(server.options.clone()),
                                Project {
                                    id: "project-B".into(),
                                    name: "Project conventions 日本語 👩‍💻".into(),
                                    path: "/synthetic/project-A".into(),
                                    ..Default::default()
                                },
                                w,
                                cx,
                            )
                        });
                        v.update(cx, |v, cx| v.load(None, w, cx));
                        v
                    },
                )
                .unwrap()
            });
            until(cx, other, &other_view);
            let reads = server.state.lock().unwrap().seen.len();
            search(cx, other, "日本語");
            cx.update_window(other, |_, w, _| {
                assert!(w.try_find("memory-error").is_some());
                assert!(w.try_find("memory-no-matches").is_none());
                assert!(w.try_find("memory-node-0-3").is_none());
            })
            .unwrap();
            clear(cx, other);
            assert_eq!(server.state.lock().unwrap().seen.len(), reads);
            cx.update_window(other, |_, w, cx| {
                assert!(w.try_find("memory-error").is_some());
                assert!(w.try_find("memory-retained").is_none());
                assert!(w.try_find("memory-text-3").is_none());
                assert!(w.try_find("memory-empty").is_none());
                other_view.update(cx, |v, cx| v.close(cx));
                w.remove_window();
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.close(cx));
                w.remove_window();
            })
            .unwrap();
            cx.run_until_parked();
        }
    }
}
