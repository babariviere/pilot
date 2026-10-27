//! Mounted production Browser/task form, only an owned synthetic daemon.
use crate::{
    mission_browser_fixture as f,
    mission_browser_view::{Browser, Input},
    mission_reader::Route,
    mission_update::Outcome,
    mission_update_fixture::{Reply, Server},
    mission_update_view::Form,
};
use gpui_kit::{
    AnyWindowHandle, App, AppContext, Bounds, Entity, EntityInputHandler, Focusable,
    HeadlessAppContext, InputEvent as _, ScrollDelta, WindowBounds, WindowOptions,
    component::{ActiveTheme, ThemeMode},
    point, px, size,
    test::TestWindowExt,
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
        assert!(
            Instant::now() < end,
            "mission-update timeout at {}",
            std::panic::Location::caller()
        );
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
fn reveal(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    cx.update_window(h, |_, w, cx| {
        let scroll_id = if w.try_find("mission-activity-page").is_some() {
            "mission-activity-page"
        } else {
            "missions-page"
        };
        let viewport = w.find(scroll_id).bounds();
        let target = w.find(id).bounds();
        w.scroll(
            scroll_id,
            ScrollDelta::Pixels(point(px(0.), viewport.top() + px(24.) - target.top())),
            cx,
        );
    })
    .unwrap();
    settle(cx, h);
}
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    reveal(cx, h, id);
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
}
fn paste(cx: &mut HeadlessAppContext, h: AnyWindowHandle, form: &Entity<Form>, text: &str) {
    cx.update_window(h, |_, w, cx| {
        let field = form.read(cx).text.clone();
        field.update(cx, |i, cx| i.focus(w, cx));
        cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(text.into()));
        w.press("secondary-a", cx);
        w.press("secondary-v", cx);
    })
    .unwrap();
    settle(cx, h);
}
fn route(cx: &mut HeadlessAppContext, h: AnyWindowHandle, b: &Entity<Browser>, id: &str) {
    cx.update_window(h, |_, w, cx| {
        b.update(cx, |b, cx| {
            if !b.brief_marked(w, cx) {
                b.sync(input(Some(Route::Detail(f::key(id)))), w, cx);
            }
        })
    })
    .unwrap();
    settle(cx, h);
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, dir: &Option<PathBuf>, name: String) {
    if let Some(d) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(d.join(name))
            .unwrap();
    }
}
pub fn run_mission_update_probe(cx: &mut HeadlessAppContext) {
    capacity(cx);
    let dir = std::env::var_os("PILOT_NEXT_UPDATE_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    let mut cases = 0;
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cases += 1;
            let server = Server::start();
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
            let (h, browser) = cx
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
                                let mut b = Browser::new(cx);
                                b.options(server.options.clone());
                                b.sync(input(Some(Route::Catalog)), w, cx);
                                b
                            })
                        },
                    )
                })
                .unwrap();
            until(cx, h, |cx| {
                browser.read(cx).catalog.is_some() && !browser.read(cx).busy
            });
            route(cx, h, &browser, "mission-A");
            until(cx, h, |cx| {
                browser.read(cx).detail.is_some() && !browser.read(cx).busy
            });
            crate::mission_browser_view::probe_menu_command(cx, h, "Activity");
            let activity = cx.update(|cx| browser.read(cx).activity_browser.clone().unwrap());
            until(cx, h, |cx| activity.read(cx).state.loaded);
            click(cx, h, "activity-post-update");
            let shelf = cx.update(|cx| activity.read(cx).update.clone());
            let form = cx.update(|cx| shelf.read(cx).current.clone().unwrap());
            assert_eq!(server.posts(), 0);
            paste(cx, h, &form, " Update 日本語 👩‍💻 é ");
            paste(cx, h, &form, &"😀".repeat(4001));
            cx.update(|cx| {
                assert_eq!(
                    form.read(cx).text.read(cx).value().as_ref(),
                    " Update 日本語 👩‍💻 é "
                )
            });
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(server.posts(), 0, "plain Enter only edits");
            cx.update_window(h, |_, w, cx| {
                form.read(cx).text.clone().update(cx, |i, cx| {
                    i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx);
                });
                w.press("secondary-enter", cx);
            })
            .unwrap();
            settle(cx, h);
            click(cx, h, "mission-update-close");
            click(cx, h, "activity-overview");
            route(cx, h, &browser, "mission-B");
            cx.update(|cx| {
                assert_eq!(
                    browser.read(cx).route,
                    Some(Route::Detail(f::key("mission-A")))
                )
            });
            assert_eq!(server.posts(), 0);
            cx.update_window(h, |_, w, cx| {
                let field = form.read(cx).text.clone();
                assert!(field.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()));
                assert!(field.read(cx).focus_handle(cx).is_focused(w));
                field.update(cx, |i, cx| i.unmark_text(w, cx));
            })
            .unwrap();
            settle(cx, h);
            let retained = cx.update(|cx| form.read(cx).text.read(cx).value());
            click(cx, h, "mission-update-close");
            cx.update_window(h, |_, w, cx| {
                assert!(activity.read(cx).focus_handle().is_focused(w))
            })
            .unwrap();
            route(cx, h, &browser, "mission-B");
            until(cx, h, |cx| !browser.read(cx).busy);
            crate::mission_browser_view::probe_menu_command(cx, h, "Activity");
            until(cx, h, |cx| activity.read(cx).state.loaded);
            click(cx, h, "activity-post-update");
            let other = cx.update(|cx| shelf.read(cx).current.clone().unwrap());
            paste(cx, h, &other, "Other mission draft");
            cx.update(|cx| form.update(cx, |_, cx| cx.emit(crate::mission_update_view::Close)));
            settle(cx, h);
            cx.update(|cx| assert_eq!(shelf.read(cx).current.as_ref(), Some(&other)));
            route(cx, h, &browser, "mission-A");
            until(cx, h, |cx| !browser.read(cx).busy);
            crate::mission_browser_view::probe_menu_command(cx, h, "Activity");
            until(cx, h, |cx| activity.read(cx).state.loaded);
            click(cx, h, "activity-post-update");
            cx.update(|cx| {
                assert_eq!(shelf.read(cx).current.as_ref(), Some(&form));
                assert_eq!(form.read(cx).text.read(cx).value(), retained);
            });
            paste(cx, h, &form, " Update 日本語 👩‍💻 ");
            reveal(cx, h, "mission-update-form");
            cx.update_window(h, |_, w, cx| {
                assert_eq!(cx.theme().mode, mode);
                let b = w.find("mission-update-text").bounds();
                assert!(b.left() >= px(0.) && b.right() <= px(width) && b.size.width > px(300.));
            })
            .unwrap();
            capture(cx, h, &dir, format!("{}-{mode:?}-draft.png", width as u32));
            let mut ack = Reply::json(
                201,
                serde_json::json!({"id":42,"kind":"update","text":"Update 日本語 👩‍💻","at":1}),
            );
            ack.delay = 350;
            server.reply("POST", "/api/missions/mission-A/events", ack);
            click(cx, h, "mission-update-submit");
            click(cx, h, "mission-update-submit");
            click(cx, h, "mission-update-close");
            route(cx, h, &browser, "mission-B");
            until(cx, h, |cx| !browser.read(cx).busy);
            until(cx, h, |cx| {
                matches!(
                    form.read(cx).state.attempt.as_ref(),
                    Some((_, Outcome::Acknowledged(42)))
                )
            });
            assert_eq!(server.posts(), 1);
            cx.update(|cx| {
                assert!(other.read(cx).state.attempt.is_none());
                assert!(!form.read(cx).visible);
            });
            route(cx, h, &browser, "mission-A");
            until(cx, h, |cx| !browser.read(cx).busy);
            crate::mission_browser_view::probe_menu_command(cx, h, "Activity");
            until(cx, h, |cx| activity.read(cx).state.loaded);
            click(cx, h, "activity-post-update");
            reveal(cx, h, "mission-update-result");
            capture(cx, h, &dir, format!("{}-{mode:?}-ack.png", width as u32));
            click(cx, h, "mission-update-another");
            cx.update(|cx| {
                assert!(form.read(cx).state.attempt.is_none());
                assert!(form.read(cx).text.read(cx).value().is_empty());
            });
            // Other mission owns an independent Unknown operation. Timeline refresh cannot settle it.
            route(cx, h, &browser, "mission-B");
            until(cx, h, |cx| !browser.read(cx).busy);
            crate::mission_browser_view::probe_menu_command(cx, h, "Activity");
            until(cx, h, |cx| activity.read(cx).state.loaded);
            click(cx, h, "activity-post-update");
            server.reply(
                "POST",
                "/api/missions/mission-B/events",
                Reply {
                    status: None,
                    bytes: vec![],
                    delay: 0,
                },
            );
            cx.update_window(h, |_, w, cx| w.press("secondary-enter", cx))
                .unwrap();
            settle(cx, h);
            until(cx, h, |cx| {
                matches!(
                    other.read(cx).state.attempt.as_ref(),
                    Some((_, Outcome::Unknown(_)))
                )
            });
            assert_eq!(server.posts(), 2);
            click(cx, h, "mission-update-close");
            click(cx, h, "activity-post-update");
            server.reply(
                "GET",
                "/api/missions/mission-B/events",
                Reply::json(
                    200,
                    serde_json::json!([
                        {"id":99,"kind":"update","text":"Other mission draft","at":1}
                    ]),
                ),
            );
            click(cx, h, "activity-refresh");
            until(cx, h, |cx| activity.read(cx).state.pending.is_none());
            click(cx, h, "mission-update-submit");
            cx.update_window(h, |_, w, cx| w.press("secondary-enter", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(server.posts(), 2);
            cx.update(|cx| {
                assert!(matches!(
                    other.read(cx).state.attempt.as_ref(),
                    Some((_, Outcome::Unknown(_)))
                ))
            });
            click(cx, h, "mission-update-copy");
            cx.update(|cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    "Other mission draft"
                )
            });
            reveal(cx, h, "mission-update-result");
            capture(
                cx,
                h,
                &dir,
                format!("{}-{mode:?}-unknown.png", width as u32),
            );
            click(cx, h, "mission-update-close");
            cx.update_window(h, |_, w, cx| {
                assert!(activity.read(cx).focus_handle().is_focused(w));
                w.remove_window();
            })
            .unwrap();
        }
    }
    assert_eq!(cases, 4);
    root(cx);
    eprintln!(
        "mission_update: 4 mounted scenes passed; bounded Unicode, explicit pointer/keyboard, IME, pinned drafts, late ACK/Close, Unknown/no retry, refresh, copy/focus"
    );
}

fn root(cx: &mut HeadlessAppContext) {
    let server = Server::start();
    let (h, view) = cx
        .update(|cx| {
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
        })
        .unwrap();
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
    crate::mission_browser_view::probe_menu_command(cx, h, "Activity");
    let activity = cx.update(|cx| browser.read(cx).activity_browser.clone().unwrap());
    until(cx, h, |cx| activity.read(cx).state.loaded);
    click(cx, h, "activity-post-update");
    let shelf = cx.update(|cx| activity.read(cx).update.clone());
    let form = cx.update(|cx| shelf.read(cx).current.clone().unwrap());
    paste(cx, h, &form, "Root draft 日本語 👩‍💻");
    // Bound native edits atomically. Clipboard avoids O(n) individual key dispatch.
    paste(cx, h, &form, &"😀".repeat(4001));
    cx.update(|cx| {
        assert_eq!(
            form.read(cx).text.read(cx).value().as_ref(),
            "Root draft 日本語 👩‍💻"
        )
    });
    cx.update_window(h, |_, w, cx| {
        form.read(cx).text.clone().update(cx, |i, cx| {
            i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx)
        })
    })
    .unwrap();
    settle(cx, h);
    reveal(cx, h, "mission-update-text");
    cx.update_window(h, |_, w, cx| {
        let input = form.read(cx).text.clone();
        let bounds = w.find("mission-update-text").bounds();
        let before = input.read(cx).selected_range();
        let mut target = None;
        for y in 1..=8 {
            for x in 1..=8 {
                let point = bounds.origin
                    + point(
                        bounds.size.width * (x as f32 / 64.),
                        bounds.size.height * (y as f32 / 32.),
                    );
                if input
                    .update(cx, |i, cx| i.character_index_for_point(point, w, cx))
                    .is_some_and(|n| n < 8)
                {
                    target = Some(point);
                    break;
                }
            }
            if target.is_some() {
                break;
            }
        }
        let position = target.expect("measured native text hit target");
        w.dispatch_event(
            gpui_kit::MouseDownEvent {
                button: gpui_kit::MouseButton::Left,
                position,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }
            .to_platform_input(),
            cx,
        );
        assert_ne!(
            input.read(cx).selected_range(),
            before,
            "inside marked editor remains interactive"
        );
        w.dispatch_event(
            gpui_kit::MouseUpEvent {
                button: gpui_kit::MouseButton::Left,
                position,
                modifiers: Default::default(),
                click_count: 1,
            }
            .to_platform_input(),
            cx,
        );
    })
    .unwrap();
    settle(cx, h);
    for key in [
        "secondary-1",
        "secondary-[",
        "secondary-k",
        "secondary-,",
        "secondary-enter",
        "escape",
    ] {
        cx.update_window(h, |_, w, cx| {
            w.press(key, cx);
            assert_eq!(
                view.read(cx).brief_fixture_bits(),
                (true, false, false, false)
            );
            assert!(
                form.read(cx)
                    .text
                    .clone()
                    .update(cx, |i, cx| i.marked_text_range(w, cx).is_some())
            );
        })
        .unwrap();
        settle(cx, h);
    }
    for id in ["nav-home", "project-scope"] {
        cx.update_window(h, |_, w, cx| {
            w.click(id, cx);
            assert_eq!(
                view.read(cx).brief_fixture_bits(),
                (true, false, false, false)
            );
            let input = form.read(cx).text.clone();
            assert!(input.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()));
            assert!(input.read(cx).focus_handle(cx).is_focused(w));
        })
        .unwrap();
        settle(cx, h);
    }
    assert_eq!(server.posts(), 0);
    cx.update_window(h, |_, w, cx| {
        form.read(cx)
            .text
            .clone()
            .update(cx, |i, cx| i.unmark_text(w, cx))
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| w.press("secondary-k", cx))
        .unwrap();
    settle(cx, h);
    cx.update(|cx| assert!(view.read(cx).brief_fixture_bits().1));
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| w.click("nav-home", cx))
        .unwrap();
    settle(cx, h);
    cx.update(|cx| assert!(!view.read(cx).brief_fixture_bits().0));
    assert_eq!(server.posts(), 0);
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    eprintln!(
        "mission update: actual Root marked-editor caret, sibling pre-blur, keyboard navigation/palette/settings/project guards and unmark recovery passed"
    );
}

fn capacity(cx: &mut HeadlessAppContext) {
    let server = Server::start();
    let (h, shelf) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                show: false,
                ..Default::default()
            },
            cx,
            |_, cx| cx.new(crate::mission_update_view::Shelf::new),
        )
        .unwrap()
    });
    cx.update_window(h, |_, w, cx| {
        shelf.update(cx, |shelf, cx| {
            let key = |n| crate::mission_browser::Key {
                home: crate::mission_browser::Home::local(&server.options.host()),
                id: format!("mission-{n}"),
            };
            let mut retained = Vec::new();
            for n in 0..12 {
                shelf.show(key(n), server.options.clone(), w, cx).unwrap();
                let f = shelf.current.clone().unwrap();
                f.update(cx, |f, cx| {
                    f.text.update(cx, |i, cx| {
                        i.set_value(format!("Unsent update 日本語 {n}"), w, cx)
                    });
                    if n < 2 {
                        let s = f.state.begin(&f.key, "Captured update").unwrap();
                        if n == 1 {
                            assert!(f.state.finish(&s, Outcome::Unknown("lost")));
                        }
                    }
                });
                retained.push(f);
            }
            for (n, f) in retained.iter().enumerate() {
                shelf.show(key(n), server.options.clone(), w, cx).unwrap();
                assert_eq!(shelf.current.as_ref(), Some(f));
                assert_eq!(
                    f.read(cx).text.read(cx).value().as_ref(),
                    format!("Unsent update 日本語 {n}")
                );
                if n < 2 {
                    f.update(cx, |f, _| assert!(f.state.begin(&f.key, "Again").is_err()));
                }
            }
        });
        w.remove_window();
    })
    .unwrap();
    cx.run_until_parked();
    assert_eq!(server.posts(), 0);
    println!(
        "mission updates: twelve targets, same-target drafts and Pending/Unknown retained PASS"
    );
}
