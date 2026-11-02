//! Hidden production root: the Inbox Slack tab against an isolated faux pilotd. No real Slack,
//! accounts, settings, services or app actions; links go to a capturing opener.
use super::*;
use crate::{
    slack_triage::{ExcerptState, Save, Status},
    slack_triage_fixture::{Reply, Server, item, project, source},
};
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    size,
    test::TestWindowExt,
};
use serde_json::{Value, json};
use std::time::Instant;

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..12 {
        cx.advance_clock(Duration::from_millis(32));
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    what: &str,
    mut done: impl FnMut(&mut App) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        settle(cx, h);
        if cx.update(|cx| done(cx)) {
            return;
        }
        assert!(Instant::now() < end, "bounded faux Slack wait: {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn capture(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    dir: Option<&std::path::Path>,
    width: f32,
    mode: ThemeMode,
    state: &str,
) {
    if let Some(dir) = dir {
        cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
            .unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(format!("{}-{}-{state}.png", width as u32, mode.name())))
            .unwrap();
    }
}
/// Opens a dropdown through its real trigger and chooses an item by its visible label.
fn choose(cx: &mut HeadlessAppContext, h: AnyWindowHandle, trigger: &str, label: &str) {
    let trigger = SharedString::from(trigger.to_owned());
    cx.update_window(h, |_, w, cx| w.click(trigger.clone(), cx))
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        let item = (0..16usize)
            .find(|i| {
                w.within("popup-menu")
                    .try_find(*i)
                    .is_some_and(|e| e.label() == Some(label))
            })
            .unwrap_or_else(|| panic!("{trigger} menu has no {label:?}"));
        w.within("popup-menu").click(item, cx);
    })
    .unwrap();
    settle(cx, h);
}
fn fixture(now: u64) -> Server {
    let hour = 3_600_000;
    let mut linked = item(
        "m1",
        "p1",
        "Checkout fails on Safari 日本語 👩‍💻",
        "open",
        "critical",
        now - 2 * hour,
    );
    linked["sessionIds"] = json!(["chat-linked"]);
    let mut waiting = item(
        "m4",
        "p1",
        "Waiting on the reporter",
        "waiting",
        "low",
        now - 9 * hour,
    );
    waiting["slack"]["waitingReason"] = json!("CSM to confirm");
    let mut noise = item("m6", "p1", "Lunch order", "open", "low", now - hour);
    noise["slack"]["label"] = json!("Noise");
    let long = "Export keeps timing out for large workspaces when filters include archived projects and e\u{301}moji 👩‍💻 ";
    let s = Server::start(
        vec![
            project("p1", "Atlas", &["C1"]),
            project("p2", "Boreal", &["C9"]),
        ],
        vec![source("p1", "ok"), {
            let mut s = source("p2", "error");
            s["budgetLimited"] = json!(true);
            s["error"] = json!("Slack hourly budget reached. Resumes next hour.");
            s
        }],
        vec![
            linked,
            item(
                "m2",
                "p1",
                "How do I export invoices?",
                "open",
                "medium",
                now - 3 * hour,
            ),
            item(
                "m3",
                "p1",
                "Add SSO for the admin console",
                "in_progress",
                "high",
                now - 26 * hour,
            ),
            waiting,
            item("m5", "p2", &long.repeat(3), "done", "low", now - 50 * hour),
            noise,
        ],
    );
    s.state.lock().unwrap().excerpts.insert(
        "m1".into(),
        json!({"itemId":"m1","author":"Ana","text":"Safari 17 shows a blank page after Pay.\nRepro: open checkout, press Pay 日本語.","truncated":false}),
    );
    s
}
fn writes(s: &Server) -> Vec<(String, String, Value)> {
    s.state.lock().unwrap().writes()
}
fn board(v: &Entity<LocalViewer>, cx: &App) -> Entity<crate::slack_triage_view::SlackBoard> {
    v.read(cx).inbox.read(cx).slack.clone()
}
fn excerpt_reads(s: &Server) -> usize {
    s.state
        .lock()
        .unwrap()
        .seen
        .iter()
        .filter(|(_, p, _)| p.ends_with("/excerpt"))
        .count()
}

pub fn run_slack_triage_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_SLACK_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    let opened = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let sink = opened.clone();
    cx.update(|cx| {
        cx.set_global(crate::external_links::Opener(Arc::new(move |url, _| {
            sink.lock().unwrap().push(url.to_owned());
        })))
    });
    for width in [680., 1100.] {
        let wide = width >= 960.;
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            opened.lock().unwrap().clear();
            let now = crate::usage_overview::now();
            let s = fixture(now);
            let (client, _reads) = LocalClient::synthetic_commands();
            let (writer, _writes) = Interaction::recording();
            let options = s.options.clone();
            let (h, v) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(720.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        cx.new(|cx| {
                            let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                            v.client = Some(client);
                            v.writer = Some(writer);
                            v.generation = 10;
                            v.state.generation = 10;
                            v.state.loaded = true;
                            v.state.list_loaded = true;
                            v.state.projects = Arc::new(
                                crate::local_model::projects(&json!([
                                    {"id":"p1","name":"Atlas","path":"/synthetic/a"},
                                    {"id":"p2","name":"Boreal","path":"/synthetic/b"}
                                ]))
                                .unwrap(),
                            );
                            v.state.projects_loaded = true;
                            v.state.chats = Arc::new(vec![
                                crate::local_model::chat(&json!({"id":"chat-linked","title":"Fix Safari checkout","projectId":"p1","state":"idle"})).unwrap(),
                            ]);
                            v.inbox.update(cx, |i, cx| i.options(options, cx));
                            v.rebuild_nav(w, cx);
                            v
                        })
                    },
                )
                .unwrap()
            });
            // Production window-open appearance follows the system. Pin only afterwards.
            cx.update_window(h, |_, w, cx| {
                Theme::change(mode, Some(w), cx);
                w.activate_window();
            })
            .unwrap();
            cx.update(|cx| assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark));
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("nav-inbox", cx))
                .unwrap();
            settle(cx, h);
            assert!(
                s.state.lock().unwrap().seen.is_empty(),
                "the Chats tab reads nothing from Slack triage"
            );
            cx.update_window(h, |_, w, cx| w.click("inbox-tab-slack", cx))
                .unwrap();
            cx.update_window(h, |_, w, _| {
                assert!(
                    w.try_find("slack-loading").is_some(),
                    "loading is not empty"
                );
            })
            .unwrap();
            until(cx, h, "first read", |cx| {
                let b = board(&v, cx);
                let b = b.read(cx);
                b.board.is_some() && !b.busy
            });
            cx.update_window(h, |_, w, cx| {
                let b = board(&v, cx);
                assert_eq!(
                    b.read(cx).probe_rows(),
                    ["m1", "m3", "m2", "m4", "m5"],
                    "severity then age; the hiding label stays behind Show hidden"
                );
                for section in ["open", "in_progress", "waiting", "done"] {
                    let id = SharedString::from(format!("slack-section-{section}"));
                    assert!(w.try_find(id).is_some(), "{section}");
                }
                assert!(w.try_find("slack-section-dismissed").is_none());
                // Two projects in scope: no single-project Sync, project-named budget notice.
                assert!(w.try_find("slack-sync").is_none());
                assert!(w.try_find("slack-source-1").is_some());
                let page = w.find("inbox-page").bounds();
                let toolbar = w.find("slack-toolbar").bounds();
                assert!(toolbar.left() >= page.left() && toolbar.right() <= page.right());
                let count = w.find("slack-count").bounds();
                assert!(count.right() <= toolbar.right() && count.size.width > px(0.));
            })
            .unwrap();
            assert_eq!(excerpt_reads(&s), 0, "opening reads no Slack message");
            capture(cx, h, captures.as_deref(), width, mode, "list");

            // Status filter, then back to every status.
            choose(cx, h, "slack-status-filter", "Done");
            cx.update(|cx| assert_eq!(board(&v, cx).read(cx).probe_rows(), ["m5"]));
            capture(cx, h, captures.as_deref(), width, mode, "filter-done");
            choose(cx, h, "slack-status-filter", "Show hidden (1)");
            cx.update(|cx| assert_eq!(board(&v, cx).read(cx).probe_rows(), ["m5"]));
            choose(cx, h, "slack-status-filter", "All statuses");
            cx.update(|cx| {
                assert_eq!(
                    board(&v, cx).read(cx).probe_rows(),
                    ["m1", "m3", "m2", "m6", "m4", "m5"]
                )
            });
            choose(cx, h, "slack-status-filter", "Show hidden (1)");

            // Keyboard selection; the excerpt is read only once its detail shows.
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.inbox.update(cx, |i, cx| i.focus(w, cx)));
                w.press("down", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(board(&v, cx).read(cx).selected.as_deref(), Some("m1"));
            });
            if !wide {
                assert_eq!(excerpt_reads(&s), 0, "no detail, no Slack read");
                cx.update_window(h, |_, w, cx| w.press("enter", cx))
                    .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, _| {
                    assert!(w.try_find("slack-back").is_some());
                    assert!(
                        w.try_find("slack-list").is_none(),
                        "detail replaces the list"
                    );
                })
                .unwrap();
            }
            until(cx, h, "excerpt", |cx| {
                matches!(
                    board(&v, cx).read(cx).probe_excerpt("m1"),
                    Some(ExcerptState::Loaded(_))
                )
            });
            assert_eq!(excerpt_reads(&s), 1);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("slack-excerpt-text").is_some());
                let title = w.find("slack-detail-title").bounds();
                let detail = w.find("slack-detail").bounds();
                assert!(title.left() >= detail.left() && title.right() <= detail.right());
                if wide {
                    let list = w.find("slack-list").bounds();
                    assert!(list.right() <= detail.left(), "side by side");
                }
                w.click("slack-open", cx);
                w.click("slack-copy", cx);
            })
            .unwrap();
            settle(cx, h);
            let url = "https://acme.slack.com/archives/C1/p".to_owned();
            {
                let opened = opened.lock().unwrap();
                assert_eq!(opened.len(), 1);
                assert!(opened[0].starts_with(&url) && opened[0].ends_with("000100?team=T1"));
            }
            cx.update(|cx| {
                let copied = cx.read_from_clipboard().and_then(|c| c.text()).unwrap();
                assert_eq!(copied, opened.lock().unwrap()[0], "exact link, team kept");
            });
            capture(cx, h, captures.as_deref(), width, mode, "detail");

            // An explicit status change sends one narrow override and shows pilotd's copy.
            choose(cx, h, "slack-field-status", "Done");
            until(cx, h, "saved", |cx| board(&v, cx).read(cx).saves.is_empty());
            assert_eq!(
                writes(&s),
                [(
                    "PATCH".to_owned(),
                    "/api/tracked-items/m1".to_owned(),
                    json!({"slack":{"status":"done"}})
                )]
            );
            cx.update(|cx| {
                let b = board(&v, cx);
                let b = b.read(cx);
                let m1 = b.board.as_ref().unwrap().item("m1").unwrap();
                assert_eq!(m1.triage.status, Status::Done);
            });

            // The exact linked chat opens; coming back keeps the Slack tab.
            cx.update_window(h, |_, w, cx| w.click("slack-open-chat", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                let view = v.read(cx);
                assert_eq!(view.page, Page::Chat);
                assert_eq!(view.selected.as_deref(), Some("chat-linked"));
            });
            cx.update_window(h, |_, w, cx| w.click("nav-inbox", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(v.read(cx).inbox.read(cx).tab, crate::inbox::Tab::Slack));
            if !wide {
                cx.update_window(h, |_, w, cx| w.click("slack-back", cx))
                    .unwrap();
                settle(cx, h);
            }

            // An unconfirmed write is Unknown, shown beside the message and never resent.
            s.reply(
                "PATCH",
                "/api/tracked-items/m2",
                Reply::status(Some(500), json!({"error":"Synthetic store failure"})),
            );
            cx.update_window(h, |_, w, cx| w.click("slack-row-m2", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("slack-dismiss", cx))
                .unwrap();
            until(cx, h, "unknown", |cx| {
                matches!(
                    board(&v, cx).read(cx).saves.get("m2"),
                    Some(Save::Unknown(_))
                ) && !board(&v, cx).read(cx).busy
            });
            settle(cx, h);
            cx.update_window(h, |_, w, _| assert!(w.try_find("slack-save").is_some()))
                .unwrap();
            assert_eq!(writes(&s).len(), 2, "Unknown is never resent");
            capture(cx, h, captures.as_deref(), width, mode, "unknown");
            s.clear("PATCH", "/api/tracked-items/m2");

            if wide {
                // Board columns: left and right cross statuses with the selection.
                cx.update_window(h, |_, w, cx| w.click("slack-layout-board", cx))
                    .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    for column in ["open", "in_progress", "waiting", "done"] {
                        let id = SharedString::from(format!("slack-column-{column}"));
                        assert!(w.try_find(id).is_some(), "{column}");
                    }
                    w.press("right", cx);
                })
                .unwrap();
                settle(cx, h);
                cx.update(|cx| assert_eq!(board(&v, cx).read(cx).selected.as_deref(), Some("m3")));
                capture(cx, h, captures.as_deref(), width, mode, "board");
                cx.update_window(h, |_, w, cx| w.click("slack-layout-list", cx))
                    .unwrap();
                settle(cx, h);
            } else {
                cx.update_window(h, |_, w, cx| w.press("escape", cx))
                    .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, _| {
                    assert!(w.try_find("slack-detail").is_none());
                    assert!(w.try_find("slack-list").is_some());
                })
                .unwrap();
            }

            // The Inbox project filter scopes the board; one project offers an ordinary sync.
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.show_inbox(Some("p2".into()), w, cx))
            })
            .unwrap();
            until(cx, h, "scoped read", |cx| {
                let b = board(&v, cx);
                let b = b.read(cx);
                !b.busy && b.probe_rows() == ["m5"]
            });
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("slack-source-0").is_some(), "budget notice");
                w.click("slack-sync", cx);
            })
            .unwrap();
            until(cx, h, "sync", |_| {
                writes(&s).iter().any(|(m, _, _)| m == "POST")
            });
            let posts: Vec<_> = writes(&s)
                .into_iter()
                .filter(|(m, _, _)| m == "POST")
                .collect();
            assert_eq!(
                posts,
                [(
                    "POST".to_owned(),
                    "/api/sources/p2:slack/poll".to_owned(),
                    Value::Null
                )],
                "one ordinary, unforced sync"
            );

            // A reply from another daemon is refused; the last report stays, marked stale.
            s.state.lock().unwrap().daemon = "other".into();
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let mut state = v.state.clone();
                    state.tracked_revision += 1;
                    v.accept(state, w, cx);
                })
            })
            .unwrap();
            until(cx, h, "identity refusal", |cx| {
                let b = board(&v, cx);
                let b = b.read(cx);
                b.error.is_some() && !b.busy
            });
            cx.update_window(h, |_, w, _| assert!(w.try_find("slack-stale").is_some()))
                .unwrap();
            cx.update(|cx| assert_eq!(board(&v, cx).read(cx).probe_rows(), ["m5"]));
            capture(cx, h, captures.as_deref(), width, mode, "stale");
            assert_eq!(
                writes(&s).len(),
                3,
                "only the explicit change, the Unknown attempt and the sync"
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"rows_sections_filters":true,
                    "keyboard_detail_excerpt":true,"exact_link_copy":true,"narrow_override_saved":true,
                    "exact_chat":true,"unknown_not_resent":true,"board_or_escape":true,
                    "project_scope_unforced_sync":true,"identity_refused_stale":true,
                    "writes":3,"native_offscreen":true})
            );
        }
    }
}
