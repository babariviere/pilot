use super::*;
use crate::mission_browser_fixture::{self as f, Reply, Server};
use gpui_kit::{
    AnyWindowHandle, Bounds, Entity, EntityInputHandler, HeadlessAppContext, ScrollDelta,
    WindowBounds, WindowOptions,
    component::{ActiveTheme, Theme, ThemeMode},
    point, size,
    test::TestWindowExt,
};
use serde_json::json;
use std::time::{Duration, Instant};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
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
    f: impl Fn(&Browser) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(12);
    while !cx.update(|cx| f(v.read(cx))) {
        assert!(Instant::now() < deadline, "bounded reader wait");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn reveal(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &str) {
    for _ in 0..5 {
        let visible = cx
            .update_window(h, |_, w, cx| {
                let b = w.find(id.to_owned()).bounds();
                if b.top() >= px(20.) && b.bottom() <= w.viewport_size().height - px(20.) {
                    return true;
                }
                w.scroll(
                    "missions-page",
                    ScrollDelta::Pixels(point(px(0.), px(240.) - b.top())),
                    cx,
                );
                false
            })
            .unwrap();
        settle(cx, h);
        if visible {
            return;
        }
    }
    panic!("cannot reveal {id}");
}
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &str) {
    reveal(cx, h, id);
    cx.update_window(h, |_, w, cx| w.click(id.to_owned(), cx))
        .unwrap();
    settle(cx, h);
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: String) {
    if let Some(dir) = std::env::var_os("PILOT_NEXT_DECISIONS_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(name))
            .unwrap();
    }
}
pub fn run_mission_decisions_probe(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::start();
            let mut detail = f::detail("mission-A");
            detail["decisions"] = json!([
                {"id":"d1","number":1,"audience":"all","text":"Keep the current binding wording. 私 👩‍💻\nA second line stays current."},
                {"id":"d2","number":2,"audience":"coordinator","text":"Coordinator context only."},
                {"id":"d3","number":3,"audience":"reference","text":"Reference wording."}
            ]);
            detail["decisionProposals"] = json!([
                {"id":"p1","decisionId":"d1","kind":"edit","text":"UNADOPTED replacement\nNever the current decision","reason":"Suggested clarification 私","status":"pending"},
                {"id":"p2","decisionId":"removed","kind":"remove","reason":"Target is no longer present","status":"pending"}
            ]);
            server.reply("/api/missions/mission-A", Reply::json(200, detail.clone()));
            let (h, view) = cx
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
                            let view = cx.new(Browser::new);
                            view.update(cx, |v, cx| {
                                v.options(server.options.clone());
                                v.catalog = Some(Arc::new(
                                    crate::mission_browser::catalog(&f::catalog()).unwrap(),
                                ));
                                v.sync(
                                    Input {
                                        route: Some(Route::Detail(f::key("mission-A"))),
                                        filter: None,
                                        projects: Arc::new(vec![]),
                                        chats: Arc::new(vec![]),
                                        online: true,
                                        loaded: true,
                                    },
                                    w,
                                    cx,
                                );
                            });
                            view
                        },
                    )
                })
                .unwrap();
            cx.update_window(h, |_, w, cx| Theme::change(mode, Some(w), cx))
                .unwrap();
            until(cx, h, &view, |v| v.detail.is_some() && !v.busy);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(cx.theme().mode, mode);
                assert_eq!(w.viewport_size().width, px(width));
                w.click("mission-decisions-open", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.click("decisions-toggle-current-d1", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("decisions-text-d1").bounds().size.height > px(20.));
                assert!(w.find("decisions-text-d1").bounds().right() <= px(width));
                w.click("decisions-copy-d1", cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    detail["decisions"][0]["text"].as_str().unwrap()
                );
                // The page owns focus after a disclosure. Tab reaches a real native control.
                let focus = view.read(cx).focus.clone();
                focus.focus(w, cx);
                w.press("tab", cx);
                assert_eq!(w.find("missions-list").focused(), Some(true));
            })
            .unwrap();
            settle(cx, h);
            capture(cx, h, format!("current-{}-{width}.png", mode.name()));
            click(cx, h, "decisions-toggle-proposal-p1");
            click(cx, h, "proposal-copy-p1");
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    detail["decisionProposals"][0]["text"].as_str().unwrap()
                );
                let current = &view
                    .read(cx)
                    .detail
                    .as_ref()
                    .unwrap()
                    .decisions
                    .as_ref()
                    .unwrap()
                    .decisions
                    .rows
                    .as_ref()
                    .unwrap()[0]
                    .text
                    .value;
                assert_eq!(current, detail["decisions"][0]["text"].as_str().unwrap());
                assert!(w.find("proposal-text-p1").bounds().right() <= px(width));
                assert!(
                    w.find("decisions-proposals-heading").bounds().top()
                        > w.find("decisions-current-heading").bounds().top()
                );
            })
            .unwrap();
            reveal(cx, h, "decisions-proposals-heading");
            capture(cx, h, format!("proposal-{}-{width}.png", mode.name()));
            click(cx, h, "decisions-toggle-proposal-p2");
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("proposal-reason-p2").is_some());
                assert!(w.try_find("proposal-text-p2").is_none());
            })
            .unwrap();
            // Real mounted task draft/preedit on the Tasks tab. Leaving the tab
            // must neither submit nor blur it.
            click(cx, h, "mission-tab-tasks");
            click(cx, h, "mission-task-new");
            let form = cx.update(|cx| {
                view.read(cx)
                    .tasks_browser
                    .read(cx)
                    .creation
                    .clone()
                    .unwrap()
            });
            cx.update_window(h, |_, w, cx| {
                form.update(cx, |f, cx| {
                    f.focus(w, cx);
                    f.title.update(cx, |i, cx| {
                        i.replace_text_in_range(None, "Retained draft 👩‍💻", w, cx);
                        i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx);
                    });
                });
            })
            .unwrap();
            settle(cx, h);
            let before = cx.update(|cx| form.read(cx).title.read(cx).value().to_string());
            click(cx, h, "mission-tab-overview");
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    view.read(cx).tab,
                    crate::mission_browser_view::Tab::Tasks,
                    "pre-blur capture refuses leaving Tasks"
                );
                let input = form.read(cx).title.clone();
                assert!(input.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()));
                assert_eq!(input.read(cx).value().as_ref(), before);
                input.update(cx, |i, cx| i.unmark_text(w, cx));
            })
            .unwrap();
            settle(cx, h);
            click(cx, h, "task-create-close");
            assert_eq!(
                cx.update(|cx| form.read(cx).title.read(cx).value().to_string()),
                before
            );
            click(cx, h, "mission-tab-overview");
            assert!(
                cx.update(|cx| view.read(cx).decisions.opened),
                "the disclosure survives a trip to Tasks"
            );
            // Source disclosure is keyboard reachable; Return changes only its disclosure.
            reveal(cx, h, "decisions-source");
            cx.update_window(h, |_, w, cx| {
                let focus = view.read(cx).focus.clone();
                focus.focus(w, cx);
                let mut reached = false;
                for _ in 0..20 {
                    w.press("tab", cx);
                    if w.find("decisions-source").focused() == Some(true) {
                        reached = true;
                        break;
                    }
                }
                assert!(reached);
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("decisions-source-text").is_some())
            })
            .unwrap();
            // Refresh failure retains wording and marks it stale, without a new read path.
            server.reply("/api/missions/mission-A", Reply::json(503, json!({})));
            cx.update_window(h, |_, w, cx| view.update(cx, |v, cx| v.read(w, cx)))
                .unwrap();
            until(cx, h, &view, |v| v.error.is_some() && !v.busy);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("decisions-text-d1").is_some());
                assert!(w.try_find("decisions-stale").is_some());
                view.update(cx, |v, cx| {
                    v.sync(
                        Input {
                            route: Some(Route::Detail(f::key("mission-B"))),
                            filter: None,
                            projects: Arc::new(vec![]),
                            chats: Arc::new(vec![]),
                            online: true,
                            loaded: true,
                        },
                        w,
                        cx,
                    )
                });
            })
            .unwrap();
            until(cx, h, &view, |v| {
                v.detail
                    .as_ref()
                    .is_some_and(|d| d.key == f::key("mission-B"))
                    && !v.busy
            });
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("decisions-text-d1").is_none());
                assert!(w.try_find("decisions-proposal-p1").is_none());
            })
            .unwrap();
            click(cx, h, "mission-decisions-open");
            cx.update(|cx| {
                let snapshot = view
                    .read(cx)
                    .detail
                    .as_ref()
                    .unwrap()
                    .decisions
                    .as_ref()
                    .unwrap();
                assert!(snapshot.decisions.rows.as_ref().unwrap().is_empty());
                assert!(
                    snapshot.proposals.rows.is_none(),
                    "absent is not known-empty"
                );
            });
            let mut long = f::detail("mission-B");
            let mut rows:Vec<_>=(0..129).map(|i| json!({"id":format!("long-{i}"),"number":i+1,"audience":"reference","text":"Bounded decision"})).collect();
            rows[0]["text"] = json!("Multiline 私👩‍💻\n".repeat(1800));
            long["decisions"] = json!(rows);
            long["decisionProposals"] = json!([]);
            server.reply("/api/missions/mission-B", Reply::json(200, long));
            cx.update_window(h, |_, w, cx| view.update(cx, |v, cx| v.read(w, cx)))
                .unwrap();
            until(cx, h, &view, |v| !v.busy);
            click(cx, h, "decisions-toggle-current-long-0");
            click(cx, h, "decisions-copy-long-0");
            cx.update_window(h, |_, _, cx| {
                let snapshot = view
                    .read(cx)
                    .detail
                    .as_ref()
                    .unwrap()
                    .decisions
                    .as_ref()
                    .unwrap();
                let text = &snapshot.decisions.rows.as_ref().unwrap()[0].text;
                assert!(snapshot.decisions.capped && text.clipped);
                assert_eq!(snapshot.decisions.rows.as_ref().unwrap().len(), 128);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    text.value
                );
            })
            .unwrap();
            // Malformed section is an explicit failure, not a fabricated empty list.
            let mut bad = f::detail("mission-B");
            bad["decisions"] = json!(null);
            server.reply("/api/missions/mission-B", Reply::json(200, bad));
            cx.update_window(h, |_, w, cx| view.update(cx, |v, cx| v.read(w, cx)))
                .unwrap();
            until(cx, h, &view, |v| !v.busy);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("decisions-error").is_some())
            })
            .unwrap();
            println!(
                "PASS decisions {width} {}: exact GET-only reader, current/proposal copy, native keyboard, draft/preedit, stale/selection, bounded long/empty/absent/error",
                mode.name()
            );
            assert!(server.all_gets());
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        }
    }
    crate::local_view::mission_decisions_root_probe::run(cx);
}
