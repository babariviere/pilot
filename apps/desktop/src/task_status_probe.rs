//! Production task detail and confirmation, owned synthetic HTTP only.
use crate::{
    mission_browser_fixture as f,
    mission_browser_view::{Browser, Input},
    mission_reader::Route,
    task_status::Outcome,
    task_status_fixture::{Reply, Server},
};
use gpui_kit::{
    AnyWindowHandle, App, AppContext, Bounds, Entity, EntityInputHandler, Focusable,
    HeadlessAppContext, ScrollDelta, WindowBounds, WindowOptions, point, px, size,
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
        assert!(Instant::now() < end, "task status timeout");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn input(id: &str) -> Input {
    Input {
        route: Some(Route::Detail(f::key(id))),
        filter: None,
        projects: Arc::new(vec![]),
        chats: Arc::new(vec![]),
        online: true,
        loaded: true,
    }
}
fn route(cx: &mut HeadlessAppContext, h: AnyWindowHandle, b: &Entity<Browser>, id: &str) {
    cx.update_window(h, |_, w, cx| b.update(cx, |b, cx| b.sync(input(id), w, cx)))
        .unwrap();
    settle(cx, h);
    until(cx, h, |cx| !b.read(cx).busy);
}
fn reveal(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    cx.update_window(h, |_, w, cx| {
        let p = w.find("missions-page").bounds();
        let t = w.find(id).bounds();
        w.scroll(
            "missions-page",
            ScrollDelta::Pixels(point(px(0.), p.top() + px(24.) - t.top())),
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
fn open_task(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    click(cx, h, "mission-tab-tasks");
}
pub fn run_task_status_probe(cx: &mut HeadlessAppContext) {
    let mut cases = 0;
    for (width, dark, unknown) in [(680., false, false), (1100., true, true)] {
        cases += 1;
        let server = Server::start();
        cx.update(|cx| {
            crate::appearance::commit_appearance(
                if dark {
                    crate::settings_state::AppearancePreference::Dark
                } else {
                    crate::settings_state::AppearancePreference::Light
                },
                cx,
            )
        });
        let (h, b) = cx
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
                    |w, cx| {
                        cx.new(|cx| {
                            let mut b = Browser::new(cx);
                            b.options(server.options.clone());
                            let mut initial = input("mission-A");
                            initial.route = Some(Route::Catalog);
                            b.sync(initial, w, cx);
                            b
                        })
                    },
                )
            })
            .unwrap();
        until(cx, h, |cx| !b.read(cx).busy && b.read(cx).catalog.is_some());
        route(cx, h, &b, "mission-A");
        until(cx, h, |cx| !b.read(cx).busy && b.read(cx).detail.is_some());
        let pane = cx.update(|cx| b.read(cx).tasks_browser.clone());
        open_task(cx, h);
        until(cx, h, |cx| {
            !pane.read(cx).state.busy && pane.read(cx).state.snapshot.is_some()
        });
        click(cx, h, "mission-tasks-row-task-A");
        // The existing sibling task editor's capture fence must beat status-click blur.
        if !dark {
            click(cx, h, "mission-task-new");
            let creation = cx.update(|cx| pane.read(cx).creation.clone().unwrap());
            cx.update_window(h, |_, w, cx| {
                creation.read(cx).title.clone().update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            crate::mission_tasks_probe::task_action(cx, h, "task-A", "Change status…");
            cx.update_window(h, |_, w, cx| {
                assert!(pane.read(cx).status_form.is_none());
                let field = creation.read(cx).title.clone();
                assert!(field.read(cx).focus_handle(cx).is_focused(w));
                field.update(cx, |i, cx| {
                    assert!(i.marked_text_range(w, cx).is_some());
                    i.unmark_text(w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
        }
        crate::mission_tasks_probe::task_action(cx, h, "task-A", "Change status…");
        let form = cx.update(|cx| pane.read(cx).status_form.clone().unwrap());
        assert_eq!(server.writes(), 0);
        click(cx, h, "task-status-todo");
        assert_eq!(server.writes(), 0, "selection is not submission");
        cx.update_window(h, |_, w, cx| w.press("enter", cx))
            .unwrap();
        settle(cx, h);
        assert_eq!(
            server.writes(),
            0,
            "plain Enter on form root must not submit"
        );
        click(cx, h, "task-status-close");
        cx.update_window(h, |_, w, cx| {
            assert!(
                pane.read(cx).owns_focus(w, cx),
                "close restores mounted task focus"
            )
        })
        .unwrap();
        crate::mission_tasks_probe::task_action(cx, h, "task-A", "Change status…");
        cx.update(|cx| {
            assert_eq!(pane.read(cx).status_form.as_ref(), Some(&form));
            assert_eq!(form.read(cx).chosen, "todo");
        });
        route(cx, h, &b, "mission-B");
        route(cx, h, &b, "mission-A");
        open_task(cx, h);
        until(cx, h, |cx| {
            !pane.read(cx).state.busy && pane.read(cx).state.snapshot.is_some()
        });
        click(cx, h, "mission-tasks-row-task-A");
        crate::mission_tasks_probe::task_action(cx, h, "task-A", "Change status…");
        cx.update(|cx| assert_eq!(pane.read(cx).status_form.as_ref(), Some(&form)));
        reveal(cx, h, "task-status-form");
        cx.update_window(h, |_, w, _| {
            let bounds = w.find("task-status-form").bounds();
            assert!(
                bounds.left() >= px(0.)
                    && bounds.right() <= px(width)
                    && bounds.size.width > px(300.)
            );
        })
        .unwrap();
        if let Some(dir) = std::env::var_os("PILOT_NEXT_TASK_STATUS_DIR") {
            let dir = std::path::PathBuf::from(dir);
            std::fs::create_dir_all(&dir).unwrap();
            cx.capture_screenshot(h)
                .unwrap()
                .save(dir.join(format!(
                    "{}-{}.png",
                    width as u32,
                    if dark { "dark" } else { "light" }
                )))
                .unwrap();
        }
        let mut reply = if unknown {
            Reply::json(400, serde_json::json!({"error":"after COMMIT"}))
        } else {
            Reply::json(
                200,
                serde_json::json!({"id":"task-A","number":1,"title":"Keep the draft","status":"todo","updatedAt":2}),
            )
        };
        reply.delay = 250;
        server.reply("PATCH", "/api/missions/mission-A/tasks/task-A", reply);
        click(cx, h, "task-status-submit");
        click(cx, h, "task-status-submit");
        click(cx, h, "task-status-close");
        route(cx, h, &b, "mission-B");
        until(cx, h, |cx| {
            form.read(cx)
                .state
                .attempt
                .as_ref()
                .is_some_and(|(_, o)| !matches!(o, Outcome::Pending))
        });
        assert_eq!(server.writes(), 1);
        cx.update(|cx| {
            assert!(
                matches!(
                    &form.read(cx).state.attempt.as_ref().unwrap().1,
                    Outcome::Unknown(_)
                ) == unknown
            )
        });
        let mut detail = f::detail("mission-A");
        detail["tasks"][1]["status"] = serde_json::json!("todo");
        server.reply("GET", "/api/missions/mission-A", Reply::json(200, detail));
        route(cx, h, &b, "mission-A");
        open_task(cx, h);
        until(cx, h, |cx| {
            !pane.read(cx).state.busy && pane.read(cx).state.snapshot.is_some()
        });
        click(cx, h, "mission-tasks-row-task-A");
        crate::mission_tasks_probe::task_action(cx, h, "task-A", "Change status…");
        click(cx, h, "task-status-submit");
        assert_eq!(
            server.writes(),
            1,
            "matching GET never settles Unknown or enables retry"
        );
        cx.update(|cx| assert_eq!(form.read(cx).chosen, "todo"));
        if !unknown {
            click(cx, h, "task-status-new-intent");
            cx.update(|cx| {
                assert!(form.read(cx).state.attempt.is_none());
                assert_eq!(form.read(cx).target.current, "todo");
            });
            click(cx, h, "task-status-in_review");
            assert_eq!(server.writes(), 1, "new selection is still not a write");
        }
        cx.update_window(h, |_, w, cx| w.press("escape", cx))
            .unwrap();
        settle(cx, h);
        cx.update(|cx| assert!(pane.read(cx).status_form.is_none()));
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        println!("task-status native width={width} dark={dark} unknown={unknown} PASS");
    }
    assert_eq!(cases, 2);
}
