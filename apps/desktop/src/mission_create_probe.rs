//! Mounted production Browser/standalone mission form, only an owned synthetic daemon.
use crate::{
    mission_browser_view::{Browser, Input},
    mission_create::Outcome,
    mission_create_fixture::{Reply, Server},
    mission_create_view::Form,
    mission_reader::Route,
};
use gpui_kit::{
    AnyWindowHandle, App, AppContext, Bounds, Entity, EntityInputHandler, Focusable,
    HeadlessAppContext, ScrollDelta, WindowBounds, WindowOptions,
    component::{ActiveTheme, ThemeMode},
    point, px, size,
    test::TestWindowExt,
};
use std::{
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
        projects: Arc::new(vec![
            crate::local_model::Project {
                id: "project-A".into(),
                name: "Example 日本語".into(),
                path: "/synthetic/a".into(),
            },
            crate::local_model::Project {
                id: "project-B".into(),
                name: "Other".into(),
                path: "/synthetic/b".into(),
            },
        ]),
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

pub fn run_mission_create_probe(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
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
            click(cx, h, "missions-new");
            let form = cx.update(|cx| browser.read(cx).creation.clone().unwrap());
            assert_eq!(server.posts(), 0);
            paste(cx, h, &form, false, " Title 日本語 👩‍💻 ");
            paste(cx, h, &form, true, " Goal é ");
            click(cx, h, "mission-create-submit");
            assert_eq!(server.posts(), 0, "project selection is explicit");
            click(cx, h, "mission-create-project");
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                if mode == ThemeMode::Light {
                    w.click("mission-project-project-A", cx);
                } else {
                    w.press("down", cx);
                }
            })
            .unwrap();
            settle(cx, h);
            if mode == ThemeMode::Dark {
                cx.update_window(h, |_, w, cx| w.press("enter", cx))
                    .unwrap();
                settle(cx, h);
            }
            cx.update(|cx| assert_eq!(form.read(cx).project.as_deref(), Some("project-A")));
            cx.update_window(h, |_, w, cx| {
                form.read(cx).body.read(cx).focus_handle(cx).focus(w, cx);
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(server.posts(), 0, "ordinary Return never creates a mission");
            paste(cx, h, &form, true, " Goal é ");
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
            click(cx, h, "mission-create-close");
            cx.update(|cx| {
                assert!(
                    form.read(cx).visible,
                    "IME blocks sibling close before blur"
                )
            });
            assert_eq!(server.posts(), 0);
            cx.update_window(h, |_, w, cx| {
                form.read(cx)
                    .title
                    .clone()
                    .update(cx, |i, cx| i.unmark_text(w, cx))
            })
            .unwrap();
            paste(cx, h, &form, false, " Title 日本語 👩‍💻 ");
            // Retain oversized edit rejection through the native clipboard path.
            paste(cx, h, &form, true, &"😀".repeat(2001));
            cx.update(|cx| assert_eq!(form.read(cx).body.read(cx).value().as_ref(), " Goal é "));
            paste(cx, h, &form, true, " Goal é ");
            cx.update_window(h, |_, w, cx| {
                assert_eq!(cx.theme().mode, mode);
                for id in [
                    "mission-create-title",
                    "mission-create-body",
                    "mission-create-project",
                    "mission-create-submit",
                ] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.left() >= px(0.) && b.right() <= px(width),
                        "field/button fits viewport"
                    );
                    assert!(b.size.height > px(15.));
                }
            })
            .unwrap();
            if let Some(dir) = std::env::var_os("PILOT_NEXT_MISSION_CREATE_DIR") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{:?}.png", width as u32, mode)))
                    .unwrap();
            }
            let mut delayed = Reply::json(
                201,
                crate::mission_create_fixture::ack(
                    &serde_json::json!({"projectId":"project-A","title":"Title 日本語 👩‍💻","goal":"Goal é"}),
                ),
            );
            delayed.delay = 300;
            server.reply("POST", "/api/missions", delayed);
            cx.update_window(h, |_, w, cx| {
                form.read(cx).body.read(cx).focus_handle(cx).focus(w, cx);
                w.press("secondary-enter", cx);
            })
            .unwrap();
            settle(cx, h);
            click(cx, h, "mission-create-submit");
            click(cx, h, "mission-create-close");
            cx.update_window(h, |_, w, cx| {
                assert!(!form.read(cx).visible);
                assert!(
                    w.focused(cx).is_some(),
                    "close restores mounted browser focus"
                );
                browser.update(cx, |b, cx| b.sync(input(None), w, cx));
            })
            .unwrap();
            until(cx, h, |cx| {
                matches!(
                    form.read(cx).state.attempt.as_ref(),
                    Some((_, Outcome::Created(_)))
                )
            });
            assert_eq!(server.posts(), 1);
            cx.update_window(h, |_, w, cx| {
                browser.update(cx, |b, cx| b.sync(input(Some(Route::Catalog)), w, cx))
            })
            .unwrap();
            until(cx, h, |cx| !browser.read(cx).busy);
            click(cx, h, "missions-new");
            cx.update(|cx| {
                assert_eq!(browser.read(cx).creation.as_ref(), Some(&form));
                assert_eq!(form.read(cx).project.as_deref(), Some("project-A"));
            });
            click(cx, h, "mission-create-submit");
            assert_eq!(server.posts(), 1);
            // A separate, explicit operation only follows a known creation ACK.
            click(cx, h, "mission-create-another");
            paste(cx, h, &form, false, "Second");
            paste(cx, h, &form, true, "Retained goal");
            server.reply(
                "POST",
                "/api/missions",
                Reply::json(400, serde_json::json!({"error":"post-commit"})),
            );
            click(cx, h, "mission-create-submit");
            until(cx, h, |cx| {
                matches!(
                    form.read(cx).state.attempt.as_ref(),
                    Some((_, Outcome::Unknown(_)))
                )
            });
            click(cx, h, "mission-create-close");
            click(cx, h, "missions-new");
            click(cx, h, "mission-create-submit");
            assert_eq!(server.posts(), 2, "Unknown cannot be resent after reopen");
            cx.update(|cx| {
                assert_eq!(
                    form.read(cx).body.read(cx).value().as_ref(),
                    "Retained goal"
                )
            });
            println!("mission_create {width} {mode:?}: passed");
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        }
    }
}
