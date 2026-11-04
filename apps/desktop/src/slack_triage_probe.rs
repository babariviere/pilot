//! Hidden production root: the Inbox Slack tab against an isolated faux pilotd. No real Slack,
//! accounts, settings, services or app actions; links go to a capturing opener.
use super::*;
use crate::{
    slack_triage::{Save, Status, ThreadState},
    slack_triage_fixture::{Reply, Server, item, project, source},
    slack_triage_view::{Layout, SlackBoard},
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
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &str) {
    let id = SharedString::from(id.to_owned());
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
}
fn press(cx: &mut HeadlessAppContext, h: AnyWindowHandle, key: &str) {
    cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
    settle(cx, h);
}
fn present(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &str) -> bool {
    let id = SharedString::from(id.to_owned());
    cx.update_window(h, |_, w, _| w.try_find(id).is_some())
        .unwrap()
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
    linked["slack"]["label"] = json!("Product");
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
    let parent = (now - 2 * hour) / 1000;
    s.state.lock().unwrap().threads.insert(
        "m1".into(),
        json!({"itemId":"m1","more":false,"messages":[
            {"ts":format!("{parent}.000100"),"author":"Ana","truncated":false,
             "text":"Safari 17 shows a blank page after Pay.\nRepro: open checkout, press Pay 日本語."},
            {"ts":format!("{}.000200", parent + 600),"author":"Ben","truncated":false,
             "text":"Same on iOS. Started after Tuesday's release."},
            {"ts":format!("{}.000300", parent + 1200),"author":"Ana","truncated":false,
             "text":"Thanks, I'll attach a HAR."}]}),
    );
    s
}
fn writes(s: &Server) -> Vec<(String, String, Value)> {
    s.state.lock().unwrap().writes()
}
fn slack(v: &Entity<LocalViewer>, cx: &App) -> Entity<SlackBoard> {
    v.read(cx).inbox.read(cx).slack.clone()
}
fn thread_reads(s: &Server) -> usize {
    s.state
        .lock()
        .unwrap()
        .seen
        .iter()
        .filter(|(_, p, _)| p.ends_with("/thread"))
        .count()
}
#[path = "slack_links_probe.rs"]
mod links;
#[path = "slack_chat_start_probe.rs"]
mod start;

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
                            size(px(width), px(760.)),
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
            click(cx, h, "nav-inbox");
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
                )
            })
            .unwrap();
            until(cx, h, "first read", |cx| {
                let b = slack(&v, cx);
                let b = b.read(cx);
                b.board.is_some() && !b.busy
            });
            cx.update(|cx| {
                let b = slack(&v, cx);
                let b = b.read(cx);
                assert_eq!(
                    b.probe_rows(),
                    ["m1", "m3", "m2", "m4", "m5"],
                    "severity then age; the hiding label stays behind Show hidden"
                );
                assert_eq!(b.probe_column(Status::Open), ["m1", "m2"]);
                assert_eq!(b.layout, Layout::Board, "the board is the default");
            });
            if wide {
                for id in [
                    "slack-board",
                    "slack-column-open",
                    "slack-column-in_progress",
                    "slack-column-waiting",
                    "slack-column-done",
                    "slack-card-m1",
                    "slack-card-m5",
                    "slack-layout-board",
                ] {
                    assert!(present(cx, h, id), "{id}");
                }
                assert!(!present(cx, h, "slack-column-dismissed"));
            } else {
                // The board needs room: narrow windows list one status per tab.
                for id in [
                    "slack-status-tabs",
                    "slack-tab-open",
                    "slack-tab-done",
                    "slack-row-m1",
                ] {
                    assert!(present(cx, h, id), "{id}");
                }
                assert!(!present(cx, h, "slack-board") && !present(cx, h, "slack-layout-board"));
                click(cx, h, "slack-tab-in_progress");
                assert!(present(cx, h, "slack-row-m3") && !present(cx, h, "slack-row-m1"));
                capture(cx, h, captures.as_deref(), width, mode, "tab-in-progress");
                click(cx, h, "slack-tab-open");
            }
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("slack-source-1").is_some(), "Boreal's budget");
                assert!(w.try_find("slack-sync").is_none(), "two projects: no Sync");
                let page = w.find("inbox-page").bounds();
                let toolbar = w.find("slack-toolbar").bounds();
                assert!(toolbar.left() >= page.left() && toolbar.right() <= page.right());
            })
            .unwrap();
            assert_eq!(thread_reads(&s), 0, "opening reads no Slack thread");
            capture(cx, h, captures.as_deref(), width, mode, "overview");

            // Hidden labels stay behind the filter menu.
            choose(cx, h, "slack-filter", "Show hidden (1)");
            cx.update(|cx| {
                assert_eq!(
                    slack(&v, cx).read(cx).probe_column(Status::Open),
                    ["m1", "m2", "m6"]
                )
            });
            choose(cx, h, "slack-filter", "Show hidden (1)");

            // Keyboard: arrows select without reading; Return opens the inspector and its thread.
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.inbox.update(cx, |i, cx| i.focus(w, cx)))
            })
            .unwrap();
            press(cx, h, "down");
            cx.update(|cx| assert_eq!(slack(&v, cx).read(cx).selected.as_deref(), Some("m1")));
            if wide {
                press(cx, h, "right");
                cx.update(|cx| assert_eq!(slack(&v, cx).read(cx).selected.as_deref(), Some("m3")));
                press(cx, h, "left");
                cx.update(|cx| assert_eq!(slack(&v, cx).read(cx).selected.as_deref(), Some("m1")));
            }
            assert_eq!(thread_reads(&s), 0, "selection alone reads nothing");
            press(cx, h, "enter");
            until(cx, h, "thread", |cx| {
                matches!(
                    slack(&v, cx).read(cx).probe_thread("m1"),
                    Some(ThreadState::Loaded(_))
                )
            });
            assert_eq!(thread_reads(&s), 1);
            cx.update_window(h, |_, w, cx| {
                for id in [
                    "slack-detail",
                    "slack-properties",
                    "slack-message-0",
                    "slack-message-2",
                ] {
                    assert!(w.try_find(id).is_some(), "{id}");
                }
                if wide {
                    let inspector = w.find("slack-inspector").bounds();
                    let board = w.find("slack-board").bounds();
                    assert!(
                        board.right() <= inspector.left(),
                        "board beside the inspector"
                    );
                } else {
                    assert!(w.try_find("slack-back").is_some());
                    assert!(
                        w.try_find("slack-list").is_none(),
                        "inspector replaces the list"
                    );
                }
                w.click("slack-open", cx);
                w.click("slack-copy", cx);
            })
            .unwrap();
            settle(cx, h);
            {
                let opened = opened.lock().unwrap();
                assert_eq!(opened.len(), 1);
                assert!(opened[0].starts_with("https://acme.slack.com/archives/C1/p"));
                assert!(opened[0].ends_with("000100?team=T1"), "team kept");
            }
            cx.update(|cx| {
                let copied = cx.read_from_clipboard().and_then(|c| c.text()).unwrap();
                assert_eq!(copied, opened.lock().unwrap()[0], "exact link");
            });
            capture(cx, h, captures.as_deref(), width, mode, "inspector");

            // Choosing a value from a property's menu sends one narrow override and shows
            // pilotd's copy.
            choose(cx, h, "slack-field-status", "Done");
            until(cx, h, "status saved", |cx| {
                slack(&v, cx).read(cx).saves.is_empty()
            });
            assert_eq!(
                writes(&s),
                [(
                    "PATCH".to_owned(),
                    "/api/tracked-items/m1".to_owned(),
                    json!({"slack":{"status":"done"}})
                )]
            );
            cx.update(|cx| {
                let b = slack(&v, cx);
                let b = b.read(cx);
                assert_eq!(
                    b.board.as_ref().unwrap().item("m1").unwrap().triage.status,
                    Status::Done
                );
                assert!(b.open, "the inspector keeps the message it moved");
            });
            if wide {
                // Dragging a card to another column changes its status.
                cx.update_window(h, |_, w, cx| {
                    w.drag_to("slack-card-m2", "slack-column-in_progress", cx)
                })
                .unwrap();
                until(cx, h, "drop saved", |cx| {
                    slack(&v, cx).read(cx).saves.is_empty()
                });
                assert_eq!(
                    writes(&s)[1],
                    (
                        "PATCH".to_owned(),
                        "/api/tracked-items/m2".to_owned(),
                        json!({"slack":{"status":"in_progress"}})
                    )
                );
                cx.update(|cx| {
                    assert_eq!(
                        slack(&v, cx).read(cx).probe_column(Status::InProgress),
                        ["m3", "m2"]
                    )
                });
                capture(cx, h, captures.as_deref(), width, mode, "board-after-drop");
            } else {
                choose(cx, h, "slack-field-severity", "High");
                until(cx, h, "severity saved", |cx| {
                    slack(&v, cx).read(cx).saves.is_empty()
                });
                assert_eq!(writes(&s)[1].2, json!({"slack":{"severity":"high"}}));
            }

            // The exact linked chat opens; coming back keeps the Slack tab.
            click(cx, h, "slack-open-chat");
            cx.update(|cx| {
                let view = v.read(cx);
                assert_eq!(view.page, Page::Chat);
                assert_eq!(view.selected.as_deref(), Some("chat-linked"));
            });
            click(cx, h, "nav-inbox");
            cx.update(|cx| assert_eq!(v.read(cx).inbox.read(cx).tab, crate::inbox::Tab::Slack));
            if !wide {
                click(cx, h, "slack-back");
            }

            // An unconfirmed write is Unknown, shown beside the message and never resent.
            s.reply(
                "PATCH",
                "/api/tracked-items/m4",
                Reply::status(Some(500), json!({"error":"Synthetic store failure"})),
            );
            if wide {
                // The board takes the width back when the inspector closes.
                click(cx, h, "slack-close");
                click(cx, h, "slack-card-m4");
            } else {
                click(cx, h, "slack-tab-waiting");
                click(cx, h, "slack-row-m4");
            }
            choose(cx, h, "slack-field-label", "Product");
            until(cx, h, "unknown", |cx| {
                let b = slack(&v, cx);
                let b = b.read(cx);
                matches!(b.saves.get("m4"), Some(Save::Unknown(_))) && !b.busy
            });
            assert!(present(cx, h, "slack-save"));
            assert_eq!(writes(&s).len(), 3, "Unknown is never resent");
            assert_eq!(writes(&s)[2].2, json!({"slack":{"label":"Product"}}));
            capture(cx, h, captures.as_deref(), width, mode, "unknown");
            s.clear("PATCH", "/api/tracked-items/m4");

            if wide {
                // The list layout puts one status per tab beside the same inspector.
                click(cx, h, "slack-layout-list");
                assert!(present(cx, h, "slack-status-tabs") && present(cx, h, "slack-inspector"));
                capture(cx, h, captures.as_deref(), width, mode, "list");
                click(cx, h, "slack-close");
                assert!(!present(cx, h, "slack-inspector"));
                click(cx, h, "slack-layout-board");
            } else {
                press(cx, h, "escape");
                assert!(!present(cx, h, "slack-detail") && present(cx, h, "slack-list"));
            }

            // The Inbox project filter scopes the board; one project offers an ordinary sync.
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.show_inbox(Some("p2".into()), w, cx))
            })
            .unwrap();
            until(cx, h, "scoped read", |cx| {
                let b = slack(&v, cx);
                let b = b.read(cx);
                !b.busy && b.probe_rows() == ["m5"]
            });
            assert!(present(cx, h, "slack-source-0"), "budget notice");
            cx.update_window(h, |_, w, cx| w.click("slack-sync", cx))
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
                let b = slack(&v, cx);
                let b = b.read(cx);
                b.error.is_some() && !b.busy
            });
            assert!(present(cx, h, "slack-stale"));
            cx.update(|cx| assert_eq!(slack(&v, cx).read(cx).probe_rows(), ["m5"]));
            capture(cx, h, captures.as_deref(), width, mode, "stale");
            assert_eq!(writes(&s).len(), 4, "three explicit changes and one sync");
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"board_default":wide,"status_tabs":!wide,
                    "hidden_filter":true,"keyboard":true,"thread_on_open_only":true,
                    "exact_link_copy":true,"segment_change":true,"drag_to_column":wide,
                    "exact_chat":true,"unknown_not_resent":true,"project_scope_unforced_sync":true,
                    "identity_refused_stale":true,"writes":4,"native_offscreen":true})
            );
        }
    }
    // Command Palette Slack links land on this same board.
    links::run(cx);
    // Start chat from a message.
    start::run(cx);
}
