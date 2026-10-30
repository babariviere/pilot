//! Exercise real form admission beyond the former lifetime counts, without dispatch.
use super::*;
use gpui_kit::{
    Bounds, HeadlessAppContext, WindowBounds, WindowOptions, component::ThemeMode, size,
    test::TestWindowExt,
};

pub(crate) fn run(cx: &mut HeadlessAppContext, width: f32, mode: ThemeMode) {
    let server = crate::mission_browser_fixture::Server::start();
    let options = server.options.clone();
    let (h, pane) = cx.update(|cx| {
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
            |_, cx| cx.new(Pane::new),
        )
        .unwrap()
    });
    cx.update_window(h, |_, w, cx| {
        pane.update(cx, |p, cx| {
            p.options = Some(options.clone());
            let key = |n| Key {
                home: crate::mission_browser::Home::local(&options.host()),
                id: format!("mission-{n}"),
            };
            let mut retained = Vec::new();
            for n in 0..20 {
                p.state.key = Some(key(n));
                p.new_task(w, cx);
                let f = p
                    .creation
                    .clone()
                    .expect("creation beyond sixteen missions");
                f.update(cx, |f, cx| {
                    f.title
                        .update(cx, |i, cx| i.set_value(format!("Unsent 日本語 {n}"), w, cx));
                    if n < 2 {
                        let s = f
                            .state
                            .begin(&f.key, "Captured title", "Captured body")
                            .unwrap();
                        if n == 1 {
                            assert!(
                                f.state.finish(
                                    &s,
                                    crate::mission_task_create::Outcome::Unknown("lost")
                                )
                            );
                        }
                    }
                });
                retained.push(f);
            }
            for (n, f) in retained.iter().enumerate() {
                p.state.key = Some(key(n));
                p.new_task(w, cx);
                assert_eq!(p.creation.as_ref(), Some(f));
                assert_eq!(
                    f.read(cx).title.read(cx).value().as_ref(),
                    format!("Unsent 日本語 {n}")
                );
                if n < 2 {
                    f.update(cx, |f, _| {
                        assert!(f.state.begin(&f.key, "Again", "").is_err())
                    });
                }
            }
            assert_eq!(p.creations.len(), 20);
        });
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        let form = w.within("dialog").find("mission-task-create").bounds();
        assert!(form.left() >= px(0.) && form.right() <= px(width));
        assert!(w.find("task-create-submit").visible());
        assert!(w.try_find("mission-tasks-details").is_none());
    })
    .unwrap();
    cx.update_window(h, |_, w, cx| {
        pane.update(cx, |p, cx| {
            let key = |n| Key { home: crate::mission_browser::Home::local(&options.host()), id: format!("mission-{n}") };
            let key = key(0);
            let mut detail = crate::mission_browser_fixture::detail(&key.id);
            detail["tasks"] = serde_json::json!((0..40).map(|n| serde_json::json!({
                "id": format!("task-{n}"), "number": n+1, "title": "Same title 日本語", "status": "todo", "order": n
            })).collect::<Vec<_>>());
            p.state.snapshot = Some(Arc::new(crate::mission_tasks::parse(&key, &detail).unwrap()));
            let mut retained = Vec::new();
            for n in 0..40 {
                p.state.selected = Some(format!("task-{n}"));
                p.change_status(w, cx);
                let f = p.status_form.clone().expect("status beyond thirty-two tasks");
                f.update(cx, |f, _| {
                    f.chosen = "in_progress".into();
                    if n < 2 {
                        let s = f.state.begin(&f.target, &f.chosen).unwrap();
                        if n == 1 { assert!(f.state.finish(&s, crate::task_status::Outcome::Unknown("lost"))); }
                    }
                });
                retained.push(f);
            }
            for (n, f) in retained.iter().enumerate() {
                p.state.selected = Some(format!("task-{n}"));
                p.change_status(w, cx);
                assert_eq!(p.status_form.as_ref(), Some(f));
                assert_eq!(f.read(cx).target.task, format!("task-{n}"));
                assert_eq!(f.read(cx).chosen, "in_progress");
                if n < 2 {
                    f.update(cx, |f, _| assert!(f.state.begin(&f.target, &f.chosen).is_err()));
                }
            }
            assert_eq!(p.statuses.len(), 40);
            assert!(p.create_error.is_none());
        });
    }).unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(
            pane.read(cx).creation.is_none(),
            "status replaces creation, not stacks over it"
        );
        assert!(w.within("dialog").find("task-status-form").visible());
        assert!(w.try_find("mission-task-create").is_none());
        pane.update(cx, |p, cx| p.hide_status(w, cx));
        w.remove_window();
    })
    .unwrap();
    cx.run_until_parked();
    assert!(server.all_gets());
    println!(
        "mission forms {width}/{mode:?}: 20 creation targets, 40 status targets, same-target drafts and Pending/Unknown retained PASS"
    );
}

fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(std::time::Duration::from_millis(100));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
