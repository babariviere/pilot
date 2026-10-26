//! Real mounted Browser and LocalViewer/Root, owned synthetic HTTP only.
use crate::{
    mission_browser_fixture as f,
    mission_browser_view::{Browser, Input},
    mission_lifecycle::Outcome,
    mission_lifecycle_fixture::{Reply, Server},
    mission_reader::Route,
};
use gpui_kit::{
    AnyWindowHandle, App, AppContext, Bounds, EntityInputHandler, HeadlessAppContext, ScrollDelta,
    WindowBounds, WindowOptions, component::ThemeMode, point, px, size, test::TestWindowExt,
};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
#[track_caller]
fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, f: impl Fn(&App) -> bool) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update(|cx| f(cx)) {
        assert!(Instant::now() < end, "lifecycle probe timeout");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
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
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    cx.update_window(h, |_, w, cx| {
        let page = w.find("missions-page").bounds();
        let target = w.find(id).bounds();
        w.scroll(
            "missions-page",
            ScrollDelta::Pixels(point(px(0.), page.top() + px(24.) - target.top())),
            cx,
        );
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
}
pub fn run_mission_lifecycle_probe(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_LIFECYCLE_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::start();
            let (h, b) = cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if mode == ThemeMode::Dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                );
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(850.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        cx.new(|cx| {
                            let mut b = Browser::new(cx);
                            b.options(server.options.clone());
                            b.sync(input(Some(Route::Catalog)), w, cx);
                            b
                        })
                    },
                )
                .unwrap()
            });
            until(cx, h, |cx| b.read(cx).catalog.is_some() && !b.read(cx).busy);
            cx.update_window(h, |_, w, cx| {
                b.update(cx, |b, cx| {
                    b.sync(input(Some(Route::Detail(f::key("mission-A")))), w, cx)
                })
            })
            .unwrap();
            until(cx, h, |cx| b.read(cx).detail.is_some() && !b.read(cx).busy);
            click(cx, h, "mission-archive");
            let form = cx.update(|cx| b.read(cx).lifecycle[0].clone());
            until(cx, h, |cx| form.read(cx).snapshot.is_some());
            assert!(
                server
                    .state
                    .lock()
                    .unwrap()
                    .seen
                    .iter()
                    .all(|(m, _, _)| m == "GET")
            );
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!("archive-{}-{mode:?}.png", width as u32)))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            assert!(!cx.update(|cx| form.read(cx).visible));
            click(cx, h, "mission-archive");
            cx.update_window(h, |_, w, cx| w.press("secondary-enter", cx))
                .unwrap();
            settle(cx, h);
            assert!(cx.update(|cx| form.read(cx).state.attempt.is_some()));
            click(cx, h, "lifecycle-close");
            cx.update_window(h, |_, w, cx| {
                b.update(cx, |b, cx| {
                    b.sync(input(Some(Route::Detail(f::key("mission-B")))), w, cx)
                })
            })
            .unwrap();
            until(cx, h, |cx| {
                matches!(
                    form.read(cx).state.attempt.as_ref(),
                    Some((_, Outcome::Ack))
                )
            });
            assert!(!cx.update(|cx| form.read(cx).visible));
            cx.update_window(h, |_, w, cx| {
                b.update(cx, |b, cx| {
                    b.sync(input(Some(Route::Detail(f::key("mission-A")))), w, cx)
                })
            })
            .unwrap();
            until(cx, h, |cx| {
                b.read(cx)
                    .detail
                    .as_ref()
                    .is_some_and(|d| d.key == f::key("mission-A"))
                    && !b.read(cx).busy
            });
            click(cx, h, "mission-archive");
            assert!(cx.update(|cx| matches!(
                form.read(cx).state.attempt.as_ref(),
                Some((_, Outcome::Ack))
            )));
            click(cx, h, "lifecycle-submit");
            click(cx, h, "lifecycle-close");
            assert_eq!(
                server
                    .state
                    .lock()
                    .unwrap()
                    .seen
                    .iter()
                    .filter(|(m, _, _)| m == "POST")
                    .count(),
                1
            );
            // Reopen from a fresh archived snapshot; an error is Unknown, never retried or GET-settled.
            let mut detail = f::detail("mission-A");
            detail["mission"]["status"] = serde_json::json!("archived");
            server.reply("GET", "/api/missions/mission-A", Reply::json(200, detail));
            cx.update_window(h, |_, w, cx| {
                b.update(cx, |b, cx| b.sync(input(Some(Route::Catalog)), w, cx))
            })
            .unwrap();
            until(cx, h, |cx| !b.read(cx).busy);
            cx.update_window(h, |_, w, cx| {
                b.update(cx, |b, cx| {
                    b.sync(input(Some(Route::Detail(f::key("mission-A")))), w, cx)
                })
            })
            .unwrap();
            until(cx, h, |cx| {
                b.read(cx)
                    .detail
                    .as_ref()
                    .is_some_and(|d| d.status == "archived")
                    && !b.read(cx).busy
            });
            server.reply(
                "POST",
                "/api/missions/mission-A/lifecycle",
                Reply::json(400, serde_json::json!({"error":"post-commit fault"})),
            );
            click(cx, h, "mission-reopen");
            until(cx, h, |cx| {
                form.read(cx)
                    .snapshot
                    .as_ref()
                    .is_some_and(|s| s.status == "archived")
            });
            click(cx, h, "lifecycle-submit");
            until(cx, h, |cx| {
                matches!(
                    form.read(cx).state.attempt.as_ref(),
                    Some((_, Outcome::Unknown(_)))
                )
            });
            click(cx, h, "lifecycle-close");
            click(cx, h, "mission-reopen");
            click(cx, h, "lifecycle-submit");
            assert!(cx.update(|cx| matches!(
                form.read(cx).state.attempt.as_ref(),
                Some((_, Outcome::Unknown(_)))
            )));
            assert_eq!(
                server
                    .state
                    .lock()
                    .unwrap()
                    .seen
                    .iter()
                    .filter(|(m, _, _)| m == "POST")
                    .count(),
                2
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            println!(
                "lifecycle-native {width} {mode:?}: confirmation, cancel, keyboard, hidden ACK and retained Unknown passed"
            );
        }
    }
    root(cx);
}
fn root(cx: &mut HeadlessAppContext) {
    let server = Server::start();
    let (h, view) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(1100.), px(900.)),
                ))),
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |w, cx| cx.new(|cx| crate::LocalViewer::synthetic(w, cx)),
        )
        .unwrap()
    });
    let browser = cx
        .update_window(h, |_, w, cx| {
            view.update(cx, |v, cx| {
                v.brief_fixture_setup(server.options.clone(), w, cx)
            })
        })
        .unwrap();
    until(cx, h, |cx| {
        browser.read(cx).catalog.is_some() && !browser.read(cx).busy
    });
    cx.update_window(h, |_, w, cx| {
        w.click(format!("mission-row-{}", f::key("mission-A").tag()), cx)
    })
    .unwrap();
    until(cx, h, |cx| {
        browser.read(cx).detail.is_some() && !browser.read(cx).busy
    });
    click(cx, h, "mission-edit-metadata");
    let metadata = cx.update(|cx| browser.read(cx).metadata[0].clone());
    until(cx, h, |cx| metadata.read(cx).loaded);
    cx.update_window(h, |_, w, cx| {
        metadata.read(cx).title.clone().update(cx, |i, cx| {
            i.replace_and_mark_text_in_range(None, "未確定", None, w, cx)
        })
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| w.click("nav-home", cx))
        .unwrap();
    settle(cx, h);
    assert!(cx.update(|cx| metadata.read(cx).visible));
    cx.update_window(h, |_, w, cx| {
        let i = metadata.read(cx).title.clone();
        assert!(i.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()));
        i.update(cx, |i, cx| i.unmark_text(w, cx));
    })
    .unwrap();
    settle(cx, h);
    click(cx, h, "metadata-close");
    click(cx, h, "mission-archive");
    let form = cx.update(|cx| browser.read(cx).lifecycle[0].clone());
    until(cx, h, |cx| form.read(cx).snapshot.is_some());
    click(cx, h, "lifecycle-close");
    cx.update_window(h, |_, w, cx| assert!(w.focused(cx).is_some()))
        .unwrap();
    click(cx, h, "mission-archive");
    cx.update_window(h, |_, w, cx| w.click("nav-home", cx))
        .unwrap();
    settle(cx, h);
    assert!(!cx.update(|cx| form.read(cx).visible));
    assert!(
        server
            .state
            .lock()
            .unwrap()
            .seen
            .iter()
            .all(|(m, _, _)| m == "GET")
    );
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    println!(
        "lifecycle-native actual LocalViewer/Root close/navigation preserves mounted focus and sends nothing"
    );
}
