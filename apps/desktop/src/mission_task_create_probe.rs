//! Mounted production Browser/task form, only an owned synthetic daemon.
use crate::{
    mission_browser_fixture as f,
    mission_browser_view::{Browser, Input},
    mission_reader::Route,
    mission_task_create::Outcome,
    mission_task_create_fixture::{Reply, Server},
    mission_task_create_view::Form,
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
            "task-create timeout at {}",
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
        let viewport = w.find("missions-page").bounds();
        let target = w.find(id).bounds();
        w.scroll(
            "missions-page",
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
fn paste(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    form: &Entity<Form>,
    body: bool,
    text: &str,
) {
    cx.update_window(h, |_, w, cx| {
        let field = if body {
            form.read(cx).body.clone()
        } else {
            form.read(cx).title.clone()
        };
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
pub fn run_mission_task_create_probe(cx: &mut HeadlessAppContext) {
    let selected = std::env::var("PILOT_NEXT_TASK_CREATE_CASE").ok();
    assert!(
        selected.as_deref().is_none_or(|s| matches!(
            s,
            "680-light" | "680-dark" | "1100-light" | "1100-dark" | "root-ime"
        )),
        "unknown task creation case"
    );
    let dir = std::env::var_os("PILOT_NEXT_TASK_CREATE_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    let mut cases = 0;
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let name = format!(
                "{}-{}",
                width as u32,
                if mode == ThemeMode::Dark {
                    "dark"
                } else {
                    "light"
                }
            );
            if selected.as_deref().is_some_and(|s| s != name) {
                continue;
            }
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
            let pane = cx.update(|cx| browser.read(cx).tasks_browser.clone());
            click(cx, h, "mission-task-new");
            let form = cx.update(|cx| pane.read(cx).creation.clone().unwrap());
            assert_eq!(server.posts(), 0);
            paste(cx, h, &form, false, " Task 日本語 👩‍💻 ");
            paste(
                cx,
                h,
                &form,
                true,
                " Body é 👩‍💻\n\nLiteral <script> and ![image](https://invalid.example). ",
            );
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(server.posts(), 0, "ordinary Enter only edits text");
            // Composition refuses submission, close, and navigation before blur.
            cx.update_window(h, |_, w, cx| {
                let field = form.read(cx).title.clone();
                field.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx);
                });
                w.press("secondary-enter", cx);
            })
            .unwrap();
            settle(cx, h);
            route(cx, h, &browser, "mission-B");
            cx.update(|cx| {
                assert_eq!(
                    browser.read(cx).route,
                    Some(Route::Detail(f::key("mission-A")))
                )
            });
            assert_eq!(server.posts(), 0);
            click(cx, h, "task-create-close");
            cx.update(|cx| assert!(pane.read(cx).creation.is_some()));
            cx.update_window(h, |_, w, cx| {
                form.read(cx)
                    .title
                    .clone()
                    .update(cx, |i, cx| i.unmark_text(w, cx))
            })
            .unwrap();
            settle(cx, h);
            // Real native values are retained by source-owned entities, no queued
            // Change may be retargeted onto the other mission's draft.
            let retained = cx.update(|cx| form.read(cx).title.read(cx).value());
            route(cx, h, &browser, "mission-B");
            until(cx, h, |cx| !browser.read(cx).busy);
            click(cx, h, "mission-task-new");
            let other = cx.update(|cx| pane.read(cx).creation.clone().unwrap());
            cx.update(|cx| {
                form.update(cx, |_, cx| cx.emit(crate::mission_task_create_view::Close))
            });
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(
                    pane.read(cx).creation.as_ref(),
                    Some(&other),
                    "late hidden form Close cannot dismiss another source"
                )
            });
            paste(cx, h, &other, false, "Other mission draft");
            route(cx, h, &browser, "mission-A");
            until(cx, h, |cx| !browser.read(cx).busy);
            click(cx, h, "mission-task-new");
            cx.update(|cx| {
                assert_eq!(pane.read(cx).creation.as_ref(), Some(&form));
                assert_eq!(form.read(cx).title.read(cx).value(), retained);
            });
            paste(cx, h, &form, false, " Task 日本語 ");
            paste(cx, h, &form, true, " Body 👩‍💻 ");
            reveal(cx, h, "mission-task-create");
            cx.update_window(h, |_, w, cx| {
                assert_eq!(cx.theme().mode, mode);
                for id in ["task-create-title", "task-create-body"] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.left() >= px(0.) && b.right() <= px(width) && b.size.width > px(300.)
                    );
                }
            })
            .unwrap();
            capture(
                cx,
                h,
                &dir,
                format!("{}-{:?}-draft.png", width as u32, mode),
            );
            // Delayed ACK remains owned by A while B is selected. Closing does not cancel.
            let mut delayed = Reply::json(
                201,
                serde_json::json!({"id":"task-created","number":42,"title":"Task 日本語","body":"Body 👩‍💻","status":"todo","order":3,"createdAt":1,"updatedAt":1}),
            );
            delayed.delay = 350;
            server.reply("POST", "/api/missions/mission-A/tasks", delayed);
            click(cx, h, "task-create-submit");
            click(cx, h, "task-create-submit");
            route(cx, h, &browser, "mission-B");
            until(cx, h, |cx| {
                matches!(
                    form.read(cx).state.attempt.as_ref(),
                    Some((_, Outcome::Created(_)))
                )
            });
            assert_eq!(server.posts(), 1);
            cx.update(|cx| assert!(other.read(cx).state.attempt.is_none()));
            route(cx, h, &browser, "mission-A");
            until(cx, h, |cx| !browser.read(cx).busy);
            click(cx, h, "mission-task-new");
            reveal(cx, h, "task-create-result");
            capture(
                cx,
                h,
                &dir,
                format!("{}-{:?}-created.png", width as u32, mode),
            );
            click(cx, h, "task-create-another");
            cx.update(|cx| {
                assert!(
                    form.read(cx).state.attempt.is_none(),
                    "Another task explicitly resets only a confirmed form"
                )
            });
            paste(cx, h, &form, false, "Unconfirmed task");
            cx.update(|cx| {
                assert_eq!(
                    form.read(cx).title.read(cx).value().as_ref(),
                    "Unconfirmed task",
                    "native field accepts next task text"
                )
            });
            server.reply(
                "POST",
                "/api/missions/mission-A/tasks",
                Reply::json(
                    400,
                    serde_json::json!({"error":"synthetic post-commit publication failure"}),
                ),
            );
            cx.update_window(h, |_, w, cx| w.press("secondary-enter", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert!(
                    form.read(cx).state.attempt.is_some(),
                    "native secondary-Enter explicitly submits, without a deferred input event"
                )
            });
            until(cx, h, |cx| {
                matches!(
                    form.read(cx).state.attempt.as_ref(),
                    Some((_, Outcome::Unknown(_)))
                )
            });
            assert_eq!(server.posts(), 2);
            click(cx, h, "task-create-close");
            click(cx, h, "mission-task-new");
            click(cx, h, "mission-tasks-refresh");
            until(cx, h, |cx| !pane.read(cx).state.busy);
            click(cx, h, "task-create-submit");
            cx.update_window(h, |_, w, cx| w.press("secondary-enter", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(server.posts(), 2);
            cx.update(|cx| {
                assert!(matches!(
                    form.read(cx).state.attempt.as_ref(),
                    Some((_, Outcome::Unknown(_)))
                ))
            });
            click(cx, h, "task-create-copy");
            cx.update(|cx| {
                assert!(
                    cx.read_from_clipboard()
                        .unwrap()
                        .text()
                        .unwrap()
                        .contains("Unconfirmed task")
                )
            });
            reveal(cx, h, "task-create-result");
            capture(
                cx,
                h,
                &dir,
                format!("{}-{:?}-unknown.png", width as u32, mode),
            );
            click(cx, h, "task-create-close");
            cx.update_window(h, |_, w, cx| {
                let focus = w.focused(cx).unwrap();
                assert!(focus.is_focused(w));
                w.remove_window();
            })
            .unwrap();
        }
    }
    assert_eq!(
        cases,
        if selected.as_deref() == Some("root-ime") {
            0
        } else if selected.is_some() {
            1
        } else {
            4
        }
    );
    if selected.is_none() || selected.as_deref() == Some("root-ime") {
        root(cx);
        cases += 1;
    }
    assert!(cases > 0, "no empty native success");
    eprintln!(
        "task creation: {cases} selected native cases passed; explicit-only POST, native edits/IME, retained source drafts, late ACK/Close, Unknown/no retry, copy/focus"
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
    click(cx, h, "mission-task-new");
    let pane = cx.update(|cx| browser.read(cx).tasks_browser.clone());
    let form = cx.update(|cx| pane.read(cx).creation.clone().unwrap());
    paste(cx, h, &form, false, "Root draft 日本語 👩‍💻");
    // Bound native edits atomically. Clipboard avoids O(n) individual key dispatch.
    paste(cx, h, &form, false, &"😀".repeat(101));
    cx.update(|cx| {
        assert_eq!(
            form.read(cx).title.read(cx).value().as_ref(),
            "Root draft 日本語 👩‍💻"
        )
    });
    cx.update_window(h, |_, w, cx| {
        form.read(cx).title.clone().update(cx, |i, cx| {
            i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx)
        })
    })
    .unwrap();
    settle(cx, h);
    reveal(cx, h, "task-create-title");
    cx.update_window(h, |_, w, cx| {
        let input = form.read(cx).title.clone();
        let bounds = w.find("task-create-title").bounds();
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
                    .title
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
            let input = form.read(cx).title.clone();
            assert!(input.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()));
            assert!(input.read(cx).focus_handle(cx).is_focused(w));
        })
        .unwrap();
        settle(cx, h);
    }
    assert_eq!(server.posts(), 0);
    cx.update_window(h, |_, w, cx| {
        form.read(cx)
            .title
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
        "task creation: actual Root marked-editor caret, sibling pre-blur, keyboard navigation/palette/settings/project guards and unmark recovery passed"
    );
}
