//! Mounted production Browser + task pane, owned GET-only server. No live client/writer.
use crate::{
    LocalOptions,
    mission_browser_fixture::{self as f, Reply, Server},
    mission_browser_view::{Browser, Event, Input, Tab},
    mission_reader::Route,
};
use gpui_kit::{
    AnyWindowHandle, App, AppContext, Bounds, Context, Entity, HeadlessAppContext, IntoElement,
    ParentElement, Render, ScrollDelta, Styled, Subscription, Window, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    div, point, px, size,
    test::TestWindowExt,
};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
const TASKS: usize = 300;
/// Every status, a phase-gated Blocked (stored To do) and dropped, in fill-unsorted order.
const STATUSES: [&str; 8] = [
    "todo",
    "dropped",
    "blocked",
    "done",
    "delegated",
    "in_review",
    "in_progress",
    "gated",
];
struct Host {
    browser: Entity<Browser>,
    _events: Subscription,
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
impl Host {
    fn new(options: LocalOptions, w: &mut Window, cx: &mut Context<Self>) -> Self {
        let browser = cx.new(Browser::new);
        browser.update(cx, |b, cx| {
            b.options(options);
            b.sync(input(Some(Route::Catalog)), w, cx);
        });
        let events = cx.subscribe_in(&browser, w, |v, _, event, w, cx| {
            v.browser.update(cx, |b, cx| match event {
                Event::Open { key, generation } if b.can_open(key, *generation) => {
                    b.sync(input(Some(Route::Detail(key.clone()))), w, cx)
                }
                Event::List { generation } if b.generation == *generation => {
                    b.sync(input(Some(Route::Catalog)), w, cx)
                }
                _ => {}
            });
        });
        Self {
            browser,
            _events: events,
        }
    }
}
impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.browser.clone())
    }
}
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
#[track_caller]
fn until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    host: &Entity<Host>,
    f: impl Fn(&Browser, &App) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(6);
    while !cx.update(|cx| f(host.read(cx).browser.read(cx), cx)) {
        assert!(
            Instant::now() < end,
            "bounded task publication at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
pub fn run_mission_tasks_probe(cx: &mut HeadlessAppContext) {
    crate::mission_tasks_view::capacity_probe::run(cx);
    let dir = std::env::var_os("PILOT_NEXT_TASKS_DIR").map(std::path::PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    let case = std::env::var("PILOT_NEXT_TASKS_CASE").ok();
    assert!(
        case.as_deref()
            .is_none_or(|s| ["680-light", "680-dark", "1100-light", "1100-dark"].contains(&s))
    );
    let mut cases = 0;
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let name = format!(
                "{}-{}",
                width as u32,
                if mode == ThemeMode::Light {
                    "light"
                } else {
                    "dark"
                }
            );
            if case.as_ref().is_some_and(|c| c != &name) {
                continue;
            }
            cases += 1;
            let server = Server::start();
            let mut detail = f::detail("mission-A");
            detail["tasks"]=json!((0..TASKS).map(|n|{let s=STATUSES[n%STATUSES.len()];let mut t=json!({"id":format!("exact-{n}"),"number":n+1,"title":"Same title 日本語 👩‍💻","status":s,"body":format!("Exact description {n}\n\nUnicode 👩‍💻 é 日本語\nLiteral ![image](https://invalid.example) <script>no execution</script>"),"order":n,"completion":{"checks":"x".repeat(7500)}});if s=="gated"{t["status"]=json!("blocked");t["storedStatus"]=json!("todo");}t}).collect::<Vec<_>>());
            // Beyond 256 rows and 2 MiB: every received task stays reachable.
            assert!(serde_json::to_vec(&detail).unwrap().len() > 2 * 1024 * 1024);
            server.reply("/api/missions/mission-A", Reply::json(200, detail.clone()));
            cx.update(|cx| Theme::change(mode, None, cx));
            let (h, host) = cx
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
                        |w, cx| cx.new(|cx| Host::new(server.options.clone(), w, cx)),
                    )
                })
                .unwrap();
            until(cx, h, &host, |b, _| b.catalog.is_some() && !b.busy);
            cx.update(|cx| assert_eq!(Theme::global(cx).mode, mode));
            let row = format!("mission-row-{}", f::key("mission-A").tag());
            cx.update_window(h, |_, w, cx| {
                w.click(gpui_kit::SharedString::from(row.clone()), cx)
            })
            .unwrap();
            until(cx, h, &host, |b, _| b.detail.is_some() && !b.busy);
            let pane = cx.update(|cx| host.read(cx).browser.read(cx).tasks_browser.clone());
            let before = server.state.lock().unwrap().seen.len();
            settle(cx, h);
            assert_eq!(
                before,
                server.state.lock().unwrap().seen.len(),
                "Overview never fetches the task list"
            );
            cx.update_window(h, |_, w, _| {
                assert!(
                    w.try_find("mission-tasks-browser").is_none(),
                    "no list on Overview"
                );
                // Open work only: 300 received, 38 dropped, 38 done.
                assert_eq!(w.find("mission-tab-tasks").label(), Some("Tasks 224"));
            })
            .unwrap();
            click(cx, h, "mission-tab-tasks");
            until(cx, h, &host, |_, cx| {
                pane.read(cx).state.snapshot.is_some() && !pane.read(cx).state.busy
            });
            cx.update(|cx| {
                assert_eq!(host.read(cx).browser.read(cx).tab, Tab::Tasks);
                assert_eq!(
                    pane.read(cx).state.snapshot.as_ref().unwrap().tasks.len(),
                    TASKS
                )
            });
            // The pane legend matches the overview: bar order, work status, dropped excluded.
            let progress = cx.update(|cx| {
                let s = pane.read(cx).state.snapshot.clone().unwrap();
                let b = host.read(cx).browser.read(cx);
                assert_eq!(s.progress, b.detail.as_ref().unwrap().summary.counts);
                s.progress.clone()
            });
            assert_eq!(
                progress.iter().map(|c| c.0).collect::<Vec<_>>(),
                [
                    "done",
                    "in_review",
                    "in_progress",
                    "blocked",
                    "todo",
                    "delegated"
                ]
            );
            assert_eq!(progress[4].1, 75, "phase-gated tasks count as stored To do");
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("mission-tasks-legend-dropped").is_none());
                let mut last = None;
                for (status, _) in &progress {
                    let id = gpui_kit::SharedString::from(format!("mission-tasks-legend-{status}"));
                    let b = w.find(id).bounds();
                    if let Some((top, left)) = last {
                        assert!(
                            b.top() > top || (b.top() == top && b.left() > left),
                            "{status} legend follows reading order"
                        );
                    }
                    last = Some((b.top(), b.left()));
                }
                // A mission without phases is one flat list without headers.
                assert!(w.try_find("mission-tasks-phase-0").is_none());
            })
            .unwrap();
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!("{name}-legend.png")))
                    .unwrap();
            }
            // The tab spans the page, not the Overview's reading column.
            cx.update_window(h, |_, w, cx| {
                let b = w.find("mission-tasks-list").bounds();
                let inset = px(crate::ui::Space::HOME);
                assert!(
                    b.left() <= inset + px(1.) && b.right() >= px(width) - inset - px(1.),
                    "full-width list {b:?}"
                );
                assert!(b.size.height > px(500.), "list fills the tab {b:?}");
                assert!(b.bottom() <= px(1000.));
                w.scroll(
                    "mission-tasks-list",
                    ScrollDelta::Pixels(point(px(0.), px(100_000.))),
                    cx,
                );
            })
            .unwrap();
            settle(cx, h);
            click(cx, h, "mission-tasks-item-exact-0");
            cx.update(|cx| assert_eq!(pane.read(cx).state.selected.as_deref(), Some("exact-0")));
            // Selecting a task opens nothing below the list; its "…" menu acts on it.
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("mission-tasks-details").is_none());
                assert!(w.find("mission-tasks-list").bounds().size.height > px(500.));
                assert!(pane.read(cx).owns_focus(w, cx));
            })
            .unwrap();
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!("{name}-selected.png")))
                    .unwrap();
            }
            task_action(cx, h, "exact-0", "Copy task");
            cx.update(|cx| {
                let s = cx.read_from_clipboard().unwrap().text().unwrap();
                assert!(
                    s.contains("Exact description 0")
                        && s.contains("👩‍💻 e\u{301}")
                        && s.contains("Task ID: exact-0")
                );
            });
            // Escape clears the selection and highlight; arrows/Enter then start
            // from the top and select the other same-title ID.
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| assert!(pane.read(cx).state.selected.is_none()));
            cx.update_window(h, |_, w, cx| {
                w.press("down", cx);
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(pane.read(cx).state.selected.as_deref(), Some("exact-0")));
            cx.update_window(h, |_, w, cx| {
                w.press("down", cx);
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(pane.read(cx).state.selected.as_deref(), Some("exact-1")));
            task_action(cx, h, "exact-1", "Copy task");
            cx.update(|cx| {
                assert!(
                    cx.read_from_clipboard()
                        .unwrap()
                        .text()
                        .unwrap()
                        .contains("Exact description 1")
                )
            });
            // Overview and back keeps the list and its selection; no read.
            let before = server.state.lock().unwrap().seen.len();
            click(cx, h, "mission-tab-overview");
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("mission-tasks-browser").is_none());
                assert!(w.find("mission-goal").visible());
            })
            .unwrap();
            click(cx, h, "mission-tab-tasks");
            assert_eq!(before, server.state.lock().unwrap().seen.len());
            cx.update(|cx| assert_eq!(pane.read(cx).state.selected.as_deref(), Some("exact-1")));
            // The received list is not the old 24-row preview: actual wheel reaches the last task.
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "mission-tasks-list",
                    ScrollDelta::Pixels(point(px(0.), px(-100_000.))),
                    cx,
                )
            })
            .unwrap();
            settle(cx, h);
            click(cx, h, "mission-tasks-item-exact-299");
            cx.update(|cx| assert_eq!(pane.read(cx).state.selected.as_deref(), Some("exact-299")));
            task_action(cx, h, "exact-299", "Copy task");
            cx.update(|cx| {
                assert!(
                    cx.read_from_clipboard()
                        .unwrap()
                        .text()
                        .unwrap()
                        .contains("Exact description 299")
                )
            });
            // The overview's exact reveal bridge reaches row 257 from the top of the
            // list and scrolls it into view; Up/Down then cross the 256 boundary.
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "mission-tasks-list",
                    ScrollDelta::Pixels(point(px(0.), px(100_000.))),
                    cx,
                )
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("mission-tasks-item-exact-256").is_none());
                pane.update(cx, |p, cx| p.reveal(Some("exact-256".into()), w, cx));
            })
            .unwrap();
            settle(cx, h);
            let row_in_list = |cx: &mut HeadlessAppContext, id: &str| {
                let id = gpui_kit::SharedString::from(format!("mission-tasks-item-{id}"));
                cx.update_window(h, |_, w, _| {
                    let list = w.find("mission-tasks-list").bounds();
                    let row = w.find(id).bounds();
                    assert!(
                        row.top() >= list.top() - px(1.) && row.bottom() <= list.bottom() + px(1.),
                        "{row:?} in {list:?}"
                    );
                })
                .unwrap();
            };
            cx.update(|cx| assert_eq!(pane.read(cx).state.selected.as_deref(), Some("exact-256")));
            row_in_list(cx, "exact-256");
            cx.update_window(h, |_, w, cx| {
                assert!(pane.read(cx).owns_focus(w, cx));
                w.press("up", cx);
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(pane.read(cx).state.selected.as_deref(), Some("exact-255")));
            row_in_list(cx, "exact-255");
            cx.update_window(h, |_, w, cx| {
                w.press("down", cx);
                w.press("down", cx);
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(pane.read(cx).state.selected.as_deref(), Some("exact-257")));
            row_in_list(cx, "exact-257");
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!("{name}-reveal-257.png")))
                    .unwrap();
            }
            // Refresh errors retain the exact selected row, with explicit stale/error presentation.
            server.reply("/api/missions/mission-A", Reply::json(503, json!({})));
            click(cx, h, "mission-tasks-refresh");
            until(cx, h, &host, |_, cx| {
                pane.read(cx).state.error.is_some() && !pane.read(cx).state.busy
            });
            cx.update(|cx| {
                let p = pane.read(cx);
                assert_eq!(p.state.selected.as_deref(), Some("exact-257"));
                assert_eq!(p.state.snapshot.as_ref().unwrap().tasks.len(), TASKS);
            });
            cx.update_window(h, |_, w, _| {
                assert!(w.find("mission-tasks-error").visible());
                assert!(w.find("mission-tasks-item-exact-257").visible());
            })
            .unwrap();
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!("{name}-stale.png")))
                    .unwrap();
            }
            server.reply("/api/missions/mission-A", Reply::json(200, detail.clone()));
            click(cx, h, "mission-tasks-refresh");
            until(cx, h, &host, |_, cx| {
                pane.read(cx).state.error.is_none() && !pane.read(cx).state.busy
            });
            // Switch mission during a slow read: the late result is fenced and the
            // other mission opens on its Overview.
            let mut slow = Reply::json(200, detail);
            slow.delay_ms = 400;
            server.reply("/api/missions/mission-A", slow);
            click(cx, h, "mission-tasks-refresh");
            cx.update(|cx| assert!(pane.read(cx).state.busy));
            server.reply("/api/missions/mission-B", Reply::json(200, phased()));
            cx.update_window(h, |_, w, cx| {
                host.read(cx).browser.clone().update(cx, |b, cx| {
                    b.sync(input(Some(Route::Detail(f::key("mission-B")))), w, cx)
                })
            })
            .unwrap();
            until(cx, h, &host, |b, _| {
                b.detail.as_ref().is_some_and(|d| d.key.id == "mission-B") && !b.busy
            });
            cx.update(|cx| {
                let p = pane.read(cx);
                assert!(
                    !p.opened
                        && !p.state.busy
                        && p.state.snapshot.is_none()
                        && p.state.selected.is_none()
                );
                assert_eq!(p.state.key.as_ref().unwrap().id, "mission-B");
                assert_eq!(host.read(cx).browser.read(cx).tab, Tab::Overview);
            });
            phases_journey(cx, h, &host, &pane, &server, &dir, &name);
            assert!(server.all_gets());
            assert!(
                server
                    .state
                    .lock()
                    .unwrap()
                    .seen
                    .iter()
                    .all(|(_, p)| p == "/api/hello"
                        || p == "/api/mission-catalog"
                        || p.starts_with("/api/missions/mission-")
                        || p.starts_with("/api/sessions?archived=all&missionId=mission-"))
            );
            cx.update(|cx| h.update(cx, |_, w, _| w.remove_window()).unwrap());
            cx.run_until_parked();
            println!(
                "mission_tasks {name}: exact IDs, {TASKS}-row 2 MiB+ list, reveal past 256, keyboard, Unicode copy, stale refresh, mission cancellation PASS"
            );
        }
    }
    assert!(cases > 0, "nonzero selected task journeys");
}

fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
}
/// Choose a command from a task row's "…" menu, waiting out any dialog
/// entrance. False when the menu did not open.
pub(crate) fn task_action(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    task: &str,
    label: &str,
) -> bool {
    let button = gpui_kit::SharedString::from(format!("mission-task-menu-{task}"));
    cx.update_window(h, |_, w, cx| w.click(button, cx)).unwrap();
    settle(cx, h);
    let chosen = cx
        .update_window(h, |_, w, cx| {
            if w.try_find("popup-menu").is_none() {
                return false;
            }
            let item = (0..8usize)
                .find(|i| {
                    w.within("popup-menu")
                        .try_find(*i)
                        .is_some_and(|e| e.label() == Some(label))
                })
                .unwrap_or_else(|| panic!("task menu has no {label:?}"));
            w.within("popup-menu").click(item, cx);
            true
        })
        .unwrap();
    settle(cx, h);
    cx.advance_clock(Duration::from_millis(300));
    settle(cx, h);
    chosen
}
/// Mission B: Build (current), Ship and an empty Later phase, plus unphased work.
fn phased() -> serde_json::Value {
    let mut v = f::detail("mission-B");
    v["phases"] = json!([
        {"id":"p-ship","missionId":"mission-B","name":"Ship it 日本語 👩‍💻","order":2},
        {"id":"p-build","missionId":"mission-B","name":"Build","order":1},
        {"id":"p-later","missionId":"mission-B","name":"Later","order":3}
    ]);
    let rows = [
        ("p-build", "done"),
        ("p-build", "done"),
        ("p-build", "done"),
        ("p-build", "in_review"),
        ("p-ship", "todo"),
        ("p-ship", "in_progress"),
        ("p-ship", "dropped"),
        ("", "todo"),
    ];
    v["tasks"] = json!(rows.iter().enumerate().map(|(n, (phase, status))| {
        let mut t = json!({"id":format!("b-{n}"),"number":n+1,"title":format!("Phase task {n}"),"status":status,"order":n,"body":format!("Body {n}")});
        if !phase.is_empty() { t["phaseId"] = json!(phase); }
        t
    }).collect::<Vec<_>>());
    v
}
/// Filter/fold controls are local presentation. The owned server admits GET only.
fn visibility_journey(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    host: &Entity<Host>,
    pane: &Entity<crate::mission_tasks_view::Pane>,
    server: &Server,
    dir: &Option<std::path::PathBuf>,
    name: &str,
) {
    let snapshot = cx.update(|cx| pane.read(cx).state.snapshot.clone().unwrap());
    click(cx, h, "mission-tasks-item-b-0");
    click(cx, h, "mission-tasks-hide-finished");
    cx.update(|cx| {
        let p = pane.read(cx);
        assert!(
            p.state.selected.is_none(),
            "filtered task loses its action target"
        );
        assert!(Arc::ptr_eq(p.state.snapshot.as_ref().unwrap(), &snapshot));
    });
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("mission-tasks-item-b-0").is_none());
        assert!(w.try_find("mission-tasks-item-b-6").is_none());
        assert!(
            w.find("mission-tasks-item-b-7").visible(),
            "unphased access"
        );
        assert!(
            w.try_find("missions-refresh").is_none(),
            "only one refresh control"
        );
    })
    .unwrap();
    click(cx, h, "mission-tasks-item-b-4");
    click(cx, h, "mission-tasks-hide-finished");
    click(cx, h, "mission-tasks-hide-finished");
    cx.update(|cx| assert_eq!(pane.read(cx).state.selected.as_deref(), Some("b-4")));
    click(cx, h, "mission-tasks-phase-1");
    cx.update(|cx| assert!(pane.read(cx).state.selected.is_none()));
    cx.update_window(h, |_, w, cx| {
        assert!(w.try_find("mission-tasks-item-b-4").is_none());
        assert_eq!(
            w.find("mission-tasks-phase-1").label(),
            Some("Expand Ship it 日本語 👩‍💻")
        );
        w.press("enter", cx); // Reopen the same focused disclosure.
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(w.find("mission-tasks-item-b-4").visible())
    })
    .unwrap();
    click(cx, h, "mission-tasks-phase-0");
    // Refresh retains rows, folds, filter and focus without moving the toolbar/list.
    let (bounds, focus) = cx
        .update_window(h, |_, w, cx| {
            for _ in 0..60 {
                w.press("tab", cx);
                if w.find("mission-tasks-refresh").focused() == Some(true) {
                    break;
                }
            }
            assert_eq!(w.find("mission-tasks-refresh").focused(), Some(true));
            (
                [
                    w.find("mission-tasks-refresh").bounds(),
                    w.find("mission-tasks-list").bounds(),
                ],
                w.focused(cx),
            )
        })
        .unwrap();
    let mut slow = Reply::json(200, phased());
    slow.delay_ms = 700;
    server.reply("/api/missions/mission-B", slow);
    cx.update_window(h, |_, w, cx| w.press("enter", cx))
        .unwrap();
    settle(cx, h);
    cx.update(|cx| assert!(pane.read(cx).state.busy));
    cx.update_window(h, |_, w, cx| {
        assert!(w.try_find("missions-refresh").is_none());
        assert_eq!(
            w.find("mission-tasks-refresh").label(),
            Some("Refreshing tasks")
        );
        // Disabled controls leave the tab tree while busy, but retain the
        // focused handle, which becomes active again on completion.
        assert_eq!(w.focused(cx), focus);
        assert_eq!(w.find("mission-tasks-refresh").disabled(), Some(true));
        assert_eq!(
            [
                w.find("mission-tasks-refresh").bounds(),
                w.find("mission-tasks-list").bounds()
            ],
            bounds
        );
        assert!(
            w.find("mission-tasks-item-b-4").visible(),
            "rows retained during refresh"
        );
    })
    .unwrap();
    until(cx, h, host, |_, cx| !pane.read(cx).state.busy);
    cx.update(|cx| {
        let p = pane.read(cx);
        assert!(p.state.visibility.hide_finished);
        assert!(p.state.visibility.collapsed.contains("phase:p-build"));
        assert_eq!(
            p.state.snapshot.as_ref().unwrap().progress,
            snapshot.progress
        );
    });
    cx.update_window(h, |_, w, _| {
        assert_eq!(
            [
                w.find("mission-tasks-refresh").bounds(),
                w.find("mission-tasks-list").bounds()
            ],
            bounds
        );
        assert_eq!(w.find("mission-tasks-refresh").focused(), Some(true));
    })
    .unwrap();
    click(cx, h, "mission-tab-overview");
    click(cx, h, "mission-tab-tasks");
    cx.update(|cx| {
        assert!(
            pane.read(cx)
                .state
                .visibility
                .collapsed
                .contains("phase:p-build")
        )
    });
    // All hidden is not "No tasks". Headers and a one-click recovery remain.
    click(cx, h, "mission-tasks-phase-1");
    click(cx, h, "mission-tasks-phase-2");
    cx.update_window(h, |_, w, _| {
        assert!(w.find("mission-tasks-show-all").visible());
        for i in 0..3 {
            assert!(
                w.find(gpui_kit::SharedString::from(format!(
                    "mission-tasks-phase-{i}"
                )))
                .visible()
            );
        }
    })
    .unwrap();
    if let Some(dir) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(format!("{name}-folded-tasks.png")))
            .unwrap();
    }
    click(cx, h, "mission-tasks-show-all");
    cx.update(|cx| {
        let p = pane.read(cx);
        assert!(!p.state.visibility.hide_finished && p.state.visibility.collapsed.is_empty());
        assert!(p.state.selected.is_none());
    });
    cx.update_window(h, |_, w, _| {
        assert!(w.find("mission-tasks-item-b-0").visible())
    })
    .unwrap();
    let mut finished = phased();
    for task in finished["tasks"].as_array_mut().unwrap() {
        if task["status"] != "dropped" {
            task["status"] = json!("done");
        }
    }
    server.reply("/api/missions/mission-B", Reply::json(200, finished));
    click(cx, h, "mission-tasks-refresh");
    until(cx, h, host, |_, cx| !pane.read(cx).state.busy);
    click(cx, h, "mission-tasks-hide-finished");
    cx.update_window(h, |_, w, _| {
        assert!(w.find("mission-tasks-show-all").visible());
        assert_eq!(
            w.find("mission-tasks-phase-0").label(),
            Some("Collapse Build")
        );
        assert!(w.try_find("mission-tasks-item-b-0").is_none());
        assert!(w.try_find("mission-tasks-item-b-7").is_none());
    })
    .unwrap();
    click(cx, h, "mission-tasks-phase-0");
    cx.update_window(h, |_, w, cx| w.press("enter", cx))
        .unwrap();
    settle(cx, h);
    click(cx, h, "mission-tasks-show-all");
    server.reply("/api/missions/mission-B", Reply::json(200, phased()));
    click(cx, h, "mission-tasks-refresh");
    until(cx, h, host, |_, cx| !pane.read(cx).state.busy);
    assert!(server.all_gets());
}
/// Overview phases in order with exact counts, keyboard into Tasks, phase
/// sections, Up/Down across a section boundary, and drafts kept across tabs.
fn phases_journey(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    host: &Entity<Host>,
    pane: &Entity<crate::mission_tasks_view::Pane>,
    server: &Server,
    dir: &Option<std::path::PathBuf>,
    name: &str,
) {
    cx.update(|cx| {
        let b = host.read(cx).browser.read(cx);
        let rows: Vec<_> = b
            .detail
            .as_ref()
            .unwrap()
            .phases
            .iter()
            .map(|g| (g.name.clone(), g.done, g.total, g.current))
            .collect();
        assert_eq!(
            rows,
            [
                ("Build".to_owned(), 3, 4, true),
                ("Ship it 日本語 👩‍💻".to_owned(), 0, 2, false),
                ("No phase".to_owned(), 0, 1, false),
            ]
        );
    });
    cx.update_window(h, |_, w, _| {
        assert!(
            w.try_find("mission-progress").is_none(),
            "phases replace the overall bar"
        );
        assert!(
            w.try_find("mission-phase-3").is_none(),
            "an empty phase has no row"
        );
        let page = w.find("missions-page").bounds();
        let mut top = None;
        for id in ["mission-phase-0", "mission-phase-1", "mission-phase-2"] {
            let b = w.find(id).bounds();
            assert!(
                b.left() >= page.left() && b.right() <= page.right(),
                "{id} {b:?}"
            );
            assert!(top.is_none_or(|t| b.top() > t), "{id} follows phase order");
            top = Some(b.top());
        }
        assert_eq!(
            w.find("mission-phase-0").label(),
            Some("Build, current phase: 3 of 4 done. Open Tasks")
        );
        assert_eq!(w.find("mission-tab-tasks").label(), Some("Tasks 4"));
    })
    .unwrap();
    if let Some(d) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(d.join(format!("{name}-phases-overview.png")))
            .unwrap();
    }
    // Keyboard: Tab to the Ship row and open Tasks with Return.
    cx.update_window(h, |_, w, cx| {
        let row = "mission-phase-1";
        for _ in 0..60 {
            w.press("tab", cx);
            if w.find(row).focused() == Some(true) {
                break;
            }
        }
        assert_eq!(w.find(row).focused(), Some(true));
        w.press("enter", cx);
    })
    .unwrap();
    until(cx, h, host, |b, cx| {
        b.tab == Tab::Tasks && pane.read(cx).state.snapshot.is_some() && !pane.read(cx).state.busy
    });
    cx.update(|cx| {
        let s = pane.read(cx).state.snapshot.clone().unwrap();
        assert_eq!(s.key.id, "mission-B");
        let titles: Vec<_> = s
            .sections
            .iter()
            .map(|s| s.title.clone().unwrap())
            .collect();
        assert_eq!(titles, ["Build", "Ship it 日本語 👩‍💻", "No phase"]);
    });
    cx.update_window(h, |_, w, _| {
        let mut top = None;
        for (header, first) in [
            ("mission-tasks-phase-0", "mission-tasks-item-b-0"),
            ("mission-tasks-phase-1", "mission-tasks-item-b-4"),
            ("mission-tasks-phase-2", "mission-tasks-item-b-7"),
        ] {
            let hb = w.find(header).bounds();
            let rb = w.find(first).bounds();
            assert!(rb.top() >= hb.bottom() - px(1.), "{header} heads its rows");
            assert!(top.is_none_or(|t| hb.top() > t), "{header} in phase order");
            top = Some(hb.top());
        }
        for (section, first) in [
            (0, "mission-tasks-item-b-0"),
            (1, "mission-tasks-item-b-4"),
            (2, "mission-tasks-item-b-7"),
        ] {
            let content = w
                .find(gpui_kit::SharedString::from(format!(
                    "mission-tasks-phase-content-{section}"
                )))
                .bounds();
            let title = w
                .find(gpui_kit::SharedString::from(format!(
                    "mission-tasks-phase-title-{section}"
                )))
                .bounds();
            assert_eq!(
                content.left(),
                w.find(first).bounds().left(),
                "phase and task glyph lanes align"
            );
            assert_eq!(
                title.left(),
                w.within(first).find("resource-title").bounds().left(),
                "phase and task titles align"
            );
        }
        // Dropped tasks stay listed in their phase.
        assert!(w.find("mission-tasks-item-b-6").visible());
    })
    .unwrap();
    visibility_journey(cx, h, host, pane, server, dir, name);
    // Up/Down cross the Build/Ship disclosure by exact ID.
    click(cx, h, "mission-tasks-item-b-3");
    cx.update_window(h, |_, w, cx| {
        w.press("down", cx); // phase disclosure
        w.press("down", cx);
        w.press("enter", cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update(|cx| assert_eq!(pane.read(cx).state.selected.as_deref(), Some("b-4")));
    cx.update(|cx| {
        assert!(
            pane.read(cx)
                .state
                .snapshot
                .as_ref()
                .unwrap()
                .task("b-4")
                .unwrap()
                .context
                .contains("Phase: Ship it")
        )
    });
    // An open New task form and the selection survive Overview and back.
    click(cx, h, "mission-task-new");
    let form = cx.update(|cx| pane.read(cx).creation.clone().unwrap());
    if let Some(d) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(d.join(format!("{name}-phases-tasks.png")))
            .unwrap();
    }
    click(cx, h, "mission-tab-overview");
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("mission-tasks-browser").is_none())
    })
    .unwrap();
    click(cx, h, "mission-tab-tasks");
    cx.update(|cx| {
        let p = pane.read(cx);
        assert_eq!(p.creation.as_ref(), Some(&form));
        assert!(form.read(cx).visible);
        assert_eq!(p.state.selected.as_deref(), Some("b-4"));
    });
    // Right-click runs a row's commands on that exact task, not the selection.
    let menu = |cx: &mut HeadlessAppContext, row: &'static str, label: &str| {
        cx.update_window(h, |_, w, cx| w.right_click(row, cx))
            .unwrap();
        settle(cx, h);
        cx.update_window(h, |_, w, cx| {
            let item = (0..8usize)
                .find(|i| {
                    w.within("popup-menu")
                        .try_find(*i)
                        .is_some_and(|e| e.label() == Some(label))
                })
                .unwrap_or_else(|| panic!("task menu has no {label:?}"));
            w.within("popup-menu").click(item, cx);
        })
        .unwrap();
        settle(cx, h);
    };
    menu(cx, "mission-tasks-item-b-1", "Copy task");
    cx.update(|cx| {
        assert_eq!(pane.read(cx).state.selected.as_deref(), Some("b-1"));
        let s = cx.read_from_clipboard().unwrap().text().unwrap();
        assert!(
            s.starts_with("#2 Phase task 1") && s.contains("Body 1"),
            "{s}"
        );
    });
    menu(cx, "mission-tasks-item-b-5", "Change status…");
    cx.update(|cx| {
        let p = pane.read(cx);
        assert_eq!(p.state.selected.as_deref(), Some("b-5"));
        let form = p.status_form.as_ref().expect("status form opens");
        assert_eq!(form.read(cx).target.task, "b-5");
    });
    // Status opens as a dialog over the list, not below it.
    cx.advance_clock(Duration::from_millis(300));
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        let form = w.find("task-status-form").bounds();
        assert!(form.size.width <= px(520.) && form.left() > px(0.));
    })
    .unwrap();
    if let Some(d) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(d.join(format!("{name}-status-dialog.png")))
            .unwrap();
    }
    click(cx, h, "task-status-close");
    cx.update(|cx| assert!(pane.read(cx).status_form.is_none()));
    // The highlighted row's "…" button offers the same commands.
    task_action(cx, h, "b-5", "Copy task");
    cx.update(|cx| {
        let s = cx.read_from_clipboard().unwrap().text().unwrap();
        assert!(s.starts_with("#6 Phase task 5"), "{s}");
    });
    if let Some(d) = dir {
        cx.update_window(h, |_, w, cx| w.right_click("mission-tasks-item-b-2", cx))
            .unwrap();
        settle(cx, h);
        cx.capture_screenshot(h)
            .unwrap()
            .save(d.join(format!("{name}-row-menu.png")))
            .unwrap();
        cx.update_window(h, |_, w, cx| w.press("escape", cx))
            .unwrap();
        settle(cx, h);
    }
}
