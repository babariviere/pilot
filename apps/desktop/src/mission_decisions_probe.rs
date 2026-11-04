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
    // Wait out the task dialog's entrance/exit, as the task probes do; its overlay
    // otherwise still covers the tabs on the next click.
    if matches!(id, "mission-task-new" | "task-create-close") {
        cx.advance_clock(Duration::from_millis(300));
    }
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
                assert!(snapshot.decisions.capped && !text.clipped);
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
    run_withdrawal(cx);
    crate::local_view::mission_decisions_root_probe::run(cx);
}

/// Retired decisions and withdrawal review: narrow/wide, keyboard, long reasons,
/// one exact POST per response, lost ACK and stale fences. Hidden synthetic window.
fn run_withdrawal(cx: &mut HeadlessAppContext) {
    let reason = "Practice changed; this no longer applies. 私 👩‍💻 ".repeat(24);
    for width in [520., 1100.] {
        let server = Server::start();
        let mut detail = f::detail("mission-A");
        detail["decisions"] = json!([
            {"id":"d1","number":1,"audience":"all","text":"Current successor wording."},
            {"id":"d2","number":2,"audience":"all","text":"Original withdrawn wording stays readable.","withdrawn":{"at":5,"reason":reason,"proposalId":"p0"}},
            {"id":"d3","number":3,"audience":"reference","text":"Replaced wording.","replacement":{"id":"d1","number":1,"at":6}},
            {"id":"d4","number":4,"audience":"reference","text":"Replaced by a decision outside this view.","replacement":{"id":"hidden","number":40,"at":7}},
            {"id":"d5","number":5,"audience":"all","text":"Active target of a withdrawal."},
            {"id":"d6","number":6,"audience":"all","text":"Second target."},
            {"id":"d7","number":7,"audience":"all","text":"Third target."}
        ]);
        detail["decisionProposals"] = json!([
            {"id":"p3","decisionId":"d5","kind":"withdraw","operationId":"op-3","reason":reason,"status":"pending"},
            {"id":"p4","decisionId":"d6","kind":"withdraw","reason":"Legacy proposal without an operation ID","status":"pending"},
            {"id":"p5","decisionId":"d7","kind":"withdraw","reason":"Stays pending","status":"pending"},
            {"id":"p6","decisionId":"d7","kind":"withdraw","reason":"Rejected","status":"rejected"}
        ]);
        server.reply("/api/missions/mission-A", Reply::json(200, detail.clone()));
        server.reply(
            "POST /api/missions/mission-A/decision-proposals/p3/accept",
            Reply::json(200, json!({"id":"p3","decisionId":"d5","kind":"withdraw","status":"accepted","reason":reason})),
        );
        // p4's response is lost after the daemon receives it.
        server.reply(
            "POST /api/missions/mission-A/decision-proposals/p4/reject",
            Reply::json(0, json!({})),
        );
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
                            v.catalog_current = true;
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
        until(cx, h, &view, |v| v.detail.is_some() && !v.busy);
        click(cx, h, "mission-decisions-open");
        cx.update_window(h, |_, w, _| {
            // Retired rows leave current guidance; their labels wait behind a disclosure.
            for id in ["d1", "d5", "d6", "d7"] {
                assert!(w.try_find(format!("decisions-row-{id}")).is_some());
            }
            for id in ["d2", "d3", "d4"] {
                assert!(w.try_find(format!("decisions-row-{id}")).is_none());
            }
        })
        .unwrap();
        click(cx, h, "decisions-retired");
        cx.update_window(h, |_, w, _| {
            for id in ["d2", "d3", "d4"] {
                assert!(w.find(format!("decisions-status-{id}")).bounds().right() <= px(width));
            }
            assert!(
                w.find("decisions-row-d2").bounds().top()
                    > w.find("decisions-row-d7").bounds().top()
            );
            assert!(
                w.try_find("decisions-reason-d2").is_none(),
                "reason on demand"
            );
            assert!(w.try_find("decisions-successor-d3").is_some());
            assert!(
                w.try_find("decisions-successor-d4").is_none(),
                "a missing successor has no link or invented body"
            );
        })
        .unwrap();
        click(cx, h, "decisions-toggle-current-d2");
        cx.update_window(h, |_, w, _| {
            let b = w.find("decisions-reason-d2").bounds();
            assert!(
                b.right() <= px(width) && b.size.height > px(40.),
                "long reason wraps"
            );
            assert!(w.try_find("decisions-text-d2").is_some());
        })
        .unwrap();
        capture(cx, h, format!("retired-{width}.png"));
        click(cx, h, "decisions-successor-d3");
        cx.update_window(h, |_, w, _| {
            assert!(w.try_find("decisions-text-d1").is_some(), "successor opens");
        })
        .unwrap();
        // Accept p3 by keyboard only.
        click(cx, h, "decisions-toggle-proposal-p3");
        reveal(cx, h, "proposal-withdraw-p3");
        cx.update_window(h, |_, w, cx| {
            assert!(w.find("proposal-reason-p3").bounds().right() <= px(width));
            assert!(w.find("proposal-keep-p3").bounds().right() <= px(width));
            let focus = view.read(cx).focus.clone();
            focus.focus(w, cx);
            let mut reached = false;
            for _ in 0..80 {
                w.press("tab", cx);
                if w.find("proposal-withdraw-p3").focused() == Some(true) {
                    reached = true;
                    break;
                }
            }
            assert!(reached, "keyboard reaches Withdraw");
            w.press("enter", cx);
        })
        .unwrap();
        capture(cx, h, format!("withdraw-{width}.png"));
        until(cx, h, &view, |v| {
            v.decisions.attempts.sending().is_none()
                && v.decisions
                    .attempts
                    .get(&v.brief_source().unwrap(), "p3")
                    .is_some()
        });
        cx.update(|cx| {
            let v = view.read(cx);
            let (_, outcome) = v
                .decisions
                .attempts
                .get(&v.brief_source().unwrap(), "p3")
                .unwrap();
            assert_eq!(*outcome, Outcome::Ack);
            // Only the confirmed POST reports; the retained snapshot is unchanged until Refresh.
            let s = v.detail.as_ref().unwrap().decisions.as_ref().unwrap();
            assert!(s.decisions.rows.as_ref().unwrap()[4].active());
        });
        let writes = server.writes();
        assert_eq!(writes.len(), 1);
        assert_eq!(
            writes[0].1,
            "/api/missions/mission-A/decision-proposals/p3/accept"
        );
        assert_eq!(writes[0].3, json!({}));
        cx.update_window(h, |_, w, _| {
            assert!(w.try_find("proposal-result-p3").is_some());
            assert!(
                w.try_find("proposal-withdraw-p3").is_none(),
                "no repeat after Ack"
            );
        })
        .unwrap();
        // Lost ACK: Unknown, retained, and never resent.
        click(cx, h, "decisions-toggle-proposal-p4");
        click(cx, h, "proposal-keep-p4");
        until(cx, h, &view, |v| v.decisions.attempts.sending().is_none());
        cx.update(|cx| {
            let v = view.read(cx);
            let (_, outcome) = v
                .decisions
                .attempts
                .get(&v.brief_source().unwrap(), "p4")
                .unwrap();
            assert!(matches!(outcome, Outcome::Unknown(_)));
        });
        cx.update_window(h, |_, w, _| {
            assert!(w.try_find("proposal-result-p4").is_some());
            assert!(w.try_find("proposal-keep-p4").is_none());
            assert!(w.try_find("proposal-withdraw-p4").is_none());
        })
        .unwrap();
        assert_eq!(server.writes().len(), 1, "one POST for the lost ACK");
        capture(cx, h, format!("unknown-{width}.png"));
        // Stale and offline snapshots refuse responses without any request.
        click(cx, h, "decisions-toggle-proposal-p5");
        server.reply("/api/missions/mission-A", Reply::json(503, json!({})));
        cx.update_window(h, |_, w, cx| view.update(cx, |v, cx| v.read(w, cx)))
            .unwrap();
        until(cx, h, &view, |v| v.error.is_some() && !v.busy);
        reveal(cx, h, "proposal-keep-p5");
        cx.update_window(h, |_, w, cx| {
            assert!(w.try_find("decisions-stale").is_some());
            w.click("proposal-keep-p5", cx);
            view.update(cx, |v, cx| {
                v.sync(
                    Input {
                        route: Some(Route::Detail(f::key("mission-A"))),
                        filter: None,
                        projects: Arc::new(vec![]),
                        chats: Arc::new(vec![]),
                        online: false,
                        loaded: true,
                    },
                    w,
                    cx,
                )
            });
        })
        .unwrap();
        settle(cx, h);
        if w_has(cx, h, "proposal-keep-p5") {
            cx.update_window(h, |_, w, cx| w.click("proposal-keep-p5", cx))
                .unwrap();
        }
        settle(cx, h);
        assert!(server.writes().is_empty(), "stale/offline: nothing sent");
        assert!(cx.update(|cx| {
            view.read(cx)
                .decisions
                .attempts
                .get(&source(), "p5")
                .is_none()
        }));
        println!(
            "PASS decision lifecycle {width}: retired labels/on-demand reason/successor, keyboard Withdraw one POST, lost ACK Unknown no replay, stale/offline refused"
        );
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    }
}
fn w_has(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &str) -> bool {
    cx.update_window(h, |_, w, _| w.try_find(id.to_owned()).is_some())
        .unwrap()
}
fn source() -> crate::mission_brief::Source {
    crate::mission_brief::Source {
        key: f::key("mission-A"),
        project: "project-A".into(),
    }
}
