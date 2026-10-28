//! Mounted production Browser/task form, only an owned synthetic daemon.
use crate::{
    mission_browser_fixture as f,
    mission_browser_view::{Browser, Input},
    mission_metadata::Outcome,
    mission_metadata_fixture::{Reply, Server},
    mission_metadata_view::Form,
    mission_reader::Route,
};
use gpui_kit::{
    AnyWindowHandle, App, AppContext, Bounds, Entity, EntityInputHandler, Focusable,
    HeadlessAppContext, InputEvent as _, ScrollDelta, WindowBounds, WindowOptions,
    component::ThemeMode, point, px, size, test::TestWindowExt,
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

pub fn run_mission_metadata_probe(cx: &mut HeadlessAppContext) {
    let selected = std::env::var("PILOT_NEXT_METADATA_CASE").ok();
    assert!(
        selected.as_deref().is_none_or(|s| s == "root-ime"),
        "Unknown metadata probe case"
    );
    if selected.is_some() {
        root(cx);
        return;
    }
    let dir = std::env::var_os("PILOT_NEXT_METADATA_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    let mut records = 0;
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
                let (h, b) = gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            point(px(0.), px(0.)),
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
                .unwrap();
                (h, b)
            });
            until(cx, h, |cx| b.read(cx).catalog.is_some() && !b.read(cx).busy);
            route(cx, h, &b, "mission-A");
            until(cx, h, |cx| b.read(cx).detail.is_some() && !b.read(cx).busy);
            crate::mission_browser_view::probe_menu_command(cx, h, "Edit…");
            let form = cx.update(|cx| b.read(cx).metadata[0].clone());
            until(cx, h, |cx| form.read(cx).loaded);
            assert_eq!(
                cx.update(|cx| form.read(cx).title.read(cx).value().to_string()),
                "Same mission 日本語"
            );
            let title = "Retained 日本語 👩‍💻";
            let goal = "A clear goal\nPreserve brief, history, and chats.";
            paste(cx, h, &form, false, title);
            paste(cx, h, &form, true, goal);
            capture(cx, h, &dir, format!("metadata-{name}.png"));
            // IME fences both the real sibling pointer path and submit/close keys.
            cx.update_window(h, |_, w, cx| {
                form.read(cx).body.clone().update(cx, |i, cx| {
                    i.replace_and_mark_text_in_range(None, "未確定", None, w, cx)
                });
                w.click("metadata-submit", cx);
                w.press("secondary-enter", cx);
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(cx.update(|cx| form.read(cx).visible));
            assert!(cx.update(|cx| form.read(cx).state.attempt.is_none()));
            cx.update_window(h, |_, w, cx| {
                form.read(cx)
                    .body
                    .clone()
                    .update(cx, |i, cx| i.unmark_text(w, cx))
            })
            .unwrap();
            paste(cx, h, &form, true, goal);
            // Atomic UTF16 rejection via real clipboard, not per-char dispatch.
            paste(cx, h, &form, false, &"😀".repeat(101));
            assert_eq!(
                cx.update(|cx| form.read(cx).title.read(cx).value().to_string()),
                title
            );
            paste(cx, h, &form, false, title);
            click(cx, h, "metadata-close");
            assert!(!cx.update(|cx| form.read(cx).visible));
            crate::mission_browser_view::probe_menu_command(cx, h, "Edit…");
            assert_eq!(cx.update(|cx| b.read(cx).metadata.len()), 1);
            assert_eq!(
                cx.update(|cx| form.read(cx).body.read(cx).value().to_string()),
                goal
            );
            let ack = serde_json::json!({"id":"mission-A","projectId":"project-A","title":title,"goal":goal});
            let mut reply = Reply::json(200, ack);
            reply.delay = 150;
            server.reply("PATCH", "/api/missions/mission-A", reply);
            // Plain Return edits, secondary Enter is the actual explicit save.
            cx.update_window(h, |_, w, cx| w.press("secondary-enter", cx))
                .unwrap();
            settle(cx, h);
            until(cx, h, |cx| form.read(cx).state.attempt.is_some());
            click(cx, h, "metadata-close");
            route(cx, h, &b, "mission-B");
            until(cx, h, |cx| {
                matches!(
                    form.read(cx).state.attempt.as_ref(),
                    Some((_, Outcome::Saved(_)))
                )
            });
            assert!(!cx.update(|cx| form.read(cx).visible));
            until(cx, h, |cx| {
                b.read(cx)
                    .detail
                    .as_ref()
                    .is_some_and(|d| d.key == f::key("mission-B"))
                    && !b.read(cx).busy
            });
            crate::mission_browser_view::probe_menu_command(cx, h, "Edit…");
            let other = cx.update(|cx| b.read(cx).metadata[1].clone());
            until(cx, h, |cx| other.read(cx).loaded);
            assert_eq!(
                cx.update(|cx| other.read(cx).source.key.id.clone()),
                "mission-B"
            );
            click(cx, h, "metadata-close");
            route(cx, h, &b, "mission-A");
            until(cx, h, |cx| {
                b.read(cx)
                    .detail
                    .as_ref()
                    .is_some_and(|d| d.key == f::key("mission-A"))
                    && !b.read(cx).busy
            });
            crate::mission_browser_view::probe_menu_command(cx, h, "Edit…");
            assert!(cx.update(|cx| matches!(
                form.read(cx).state.attempt.as_ref(),
                Some((_, Outcome::Saved(_)))
            )));
            click(cx, h, "metadata-edit-again");
            until(cx, h, |cx| form.read(cx).loaded);
            paste(cx, h, &form, false, "Uncertain retained");
            server.reply(
                "PATCH",
                "/api/missions/mission-A",
                Reply {
                    status: None,
                    bytes: Vec::new(),
                    delay: 0,
                    chunked: false,
                },
            );
            click(cx, h, "metadata-submit");
            until(cx, h, |cx| {
                matches!(
                    form.read(cx).state.attempt.as_ref(),
                    Some((_, Outcome::Unknown(_)))
                )
            });
            click(cx, h, "metadata-close");
            crate::mission_browser_view::probe_menu_command(cx, h, "Edit…");
            assert!(cx.update(|cx| form.read(cx).state.blocked()));
            assert_eq!(
                cx.update(|cx| form.read(cx).title.read(cx).value().to_string()),
                "Uncertain retained"
            );
            let state = server.state.lock().unwrap();
            let writes: Vec<_> = state.seen.iter().filter(|(m, _, _)| m != "GET").collect();
            assert_eq!(writes.len(), 2);
            assert!(writes.iter().all(|(m, p, v)| m == "PATCH"
                && p == "/api/missions/mission-A"
                && v.as_object().unwrap().len() == 2));
            drop(state);
            records += 1;
            println!(
                "metadata-native {name}: retained Unicode/limits/IME/close/late ACK/exact source/Unknown passed"
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        }
    }
    assert_eq!(records, 4);
    root(cx);
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
    crate::mission_browser_view::probe_menu_command(cx, h, "Edit…");
    let form = cx.update(|cx| browser.read(cx).metadata[0].clone());
    until(cx, h, |cx| form.read(cx).loaded);
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
    reveal(cx, h, "metadata-title");
    cx.update_window(h, |_, w, cx| {
        let input = form.read(cx).title.clone();
        let bounds = w.find("metadata-title").bounds();
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
    assert!(
        server
            .state
            .lock()
            .unwrap()
            .seen
            .iter()
            .all(|(m, _, _)| m == "GET")
    );
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
    eprintln!(
        "metadata: actual Root marked-editor caret, sibling pre-blur, keyboard navigation/palette/settings/project guards and unmark recovery passed"
    );
}
