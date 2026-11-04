//! Hidden production root: a pasted Slack link in the Command Palette, against the faux
//! pilotd. A tracked link opens its exact message (dismissed included) without writing; an
//! untracked one offers explicit adds per Slack-tracking project. No real Slack or accounts.
use super::*;
use crate::slack_triage_fixture::message;
use crate::slack_triage_view::AddState;

const TRACKED: u64 = 1_791_892_800;
const UNTRACKED: u64 = 1_791_893_000;
const REFUSED: u64 = 1_791_893_100;
const LANDED: u64 = 1_791_893_200;
const LOST: u64 = 1_791_893_300;

fn link(seconds: u64) -> String {
    format!("https://acme.slack.com/archives/C1/p{seconds}000100?team=T1")
}
fn palette_rows(v: &Entity<LocalViewer>, cx: &App) -> Option<Vec<String>> {
    v.read(cx).jump.as_ref().map(|p| p.read(cx).probe_slack(cx))
}
fn palette_selected(v: &Entity<LocalViewer>, cx: &App) -> Option<String> {
    v.read(cx).jump.as_ref()?.read(cx).probe(cx).3
}
fn draft(v: &Entity<LocalViewer>, cx: &App) -> String {
    v.read(cx)
        .editor
        .read(cx)
        .shell_probe()
        .0
        .read(cx)
        .value()
        .to_string()
}
fn searches(s: &Server) -> usize {
    s.state
        .lock()
        .unwrap()
        .seen
        .iter()
        .filter(|(_, p, _)| p.starts_with("/api/tracking/slack/search"))
        .count()
}
fn adds(s: &Server) -> Vec<Value> {
    writes(s)
        .into_iter()
        .filter(|(m, p, _)| m == "POST" && p == "/api/tracking/slack/messages")
        .map(|(_, _, b)| b)
        .collect()
}
/// Opens the palette and types (as a paste lands) one query into its search field.
fn paste(cx: &mut HeadlessAppContext, h: AnyWindowHandle, v: &Entity<LocalViewer>, text: &str) {
    cx.update_window(h, |_, w, cx| {
        if v.read(cx).jump.is_none() {
            w.press("secondary-k", cx);
        }
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(v.read(cx).jump.is_some(), "Cmd-K opens the palette");
        w.press("secondary-a", cx);
        w.input(text, cx);
    })
    .unwrap();
    settle(cx, h);
}

pub(super) fn run(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_SLACK_DIR").map(std::path::PathBuf::from);
    for width in [680., 1100.] {
        let wide = width >= 960.;
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let s = Server::start(
                vec![
                    project("p1", "Atlas", &["C1"]),
                    project("p2", "Boreal", &["C9"]),
                    project("p3", "Cirrus", &[]),
                ],
                vec![source("p1", "ok"), source("p2", "ok")],
                vec![
                    message(
                        "tracked",
                        "p1",
                        "Refund export fails 日本語 👩‍💻",
                        "dismissed",
                        TRACKED,
                    ),
                    message("open", "p1", "Open report", "open", TRACKED - 100),
                ],
            );
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
                            v.writer = Some(writer.clone());
                            v.editor.update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                            v.generation = 10;
                            v.state.generation = 10;
                            v.state.loaded = true;
                            v.state.list_loaded = true;
                            v.state.projects = Arc::new(
                                crate::local_model::projects(&json!([
                                    {"id":"p1","name":"Atlas","path":"/synthetic/a"},
                                    {"id":"p2","name":"Boreal","path":"/synthetic/b"},
                                    {"id":"p3","name":"Cirrus","path":"/synthetic/c"}
                                ]))
                                .unwrap(),
                            );
                            v.state.projects_loaded = true;
                            v.state.chats = Arc::new(vec![
                                crate::local_model::chat(&json!({"id":"synthetic","title":"Current","state":"idle","projectId":"p1"})).unwrap(),
                            ]);
                            v.inbox.update(cx, |i, cx| i.options(options, cx));
                            v.rebuild_nav(w, cx);
                            v
                        })
                    },
                )
                .unwrap()
            });
            cx.update_window(h, |_, w, cx| {
                Theme::change(mode, Some(w), cx);
                w.activate_window();
            })
            .unwrap();
            settle(cx, h);
            // A draft with a grapheme cluster stays exactly as typed across every journey.
            cx.update_window(h, |_, w, cx| {
                let text = v.read(cx).editor.read(cx).shell_probe().0;
                text.update(cx, |t, cx| t.set_value("Keep 👩‍💻 e\u{301}", w, cx));
                let editor = v.read(cx).editor.clone();
                editor.update(cx, |e, cx| e.focus(w, cx));
            })
            .unwrap();
            settle(cx, h);

            // Lookalikes and ordinary words never reach pilotd's Slack search.
            for text in [
                "https://acme.slack.com.evil.example/archives/C1/p1791892800000100",
                "http://acme.slack.com/archives/C1/p1791892800000100",
                "refund export",
            ] {
                paste(cx, h, &v, text);
                cx.update(|cx| {
                    assert_eq!(
                        palette_rows(&v, cx).unwrap(),
                        Vec::<String>::new(),
                        "{text}"
                    )
                });
            }
            assert_eq!(searches(&s), 0, "only a message link is looked up");

            // A tracked link: its exact, dismissed message leads and is selected. Nothing is written.
            paste(cx, h, &v, &link(TRACKED));
            until(cx, h, "tracked lookup", |cx| {
                palette_rows(&v, cx).is_some_and(|r| !r.is_empty())
            });
            cx.update(|cx| {
                assert_eq!(
                    palette_rows(&v, cx).unwrap(),
                    ["slack:open:tracked", "slack:add:p2"],
                    "Atlas holds it; Boreal may add it; Cirrus tracks no Slack"
                );
                assert_eq!(
                    palette_selected(&v, cx).as_deref(),
                    Some("slack:open:tracked")
                );
            });
            assert!(
                present(cx, h, "jump-row-slack:open:tracked")
                    && present(cx, h, "jump-row-slack:add:p2")
            );
            capture(cx, h, captures.as_deref(), width, mode, "palette-tracked");
            assert_eq!(searches(&s), 1, "one passive lookup per link");
            assert!(writes(&s).is_empty(), "paste and search never write");
            // A stale query cannot activate: an edited link has no rows. Nine backspaces drop
            // "?team=T1" and one timestamp digit.
            cx.update_window(h, |_, w, cx| {
                for _ in 0..9 {
                    w.press("backspace", cx);
                }
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(palette_rows(&v, cx).unwrap().is_empty());
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(writes(&s).is_empty());
            paste(cx, h, &v, &link(TRACKED));
            until(cx, h, "tracked again", |cx| {
                palette_rows(&v, cx).is_some_and(|r| !r.is_empty())
            });
            press(cx, h, "enter");
            until(cx, h, "opened exactly", |cx| {
                let b = slack(&v, cx);
                let b = b.read(cx);
                !b.busy && b.board.is_some() && b.selected.as_deref() == Some("tracked") && b.open
            });
            cx.update(|cx| {
                let view = v.read(cx);
                assert!(view.jump.is_none());
                assert!(
                    matches!(view.page, Page::Inbox(None)),
                    "All projects stays All"
                );
                assert_eq!(view.inbox.read(cx).tab, crate::inbox::Tab::Slack);
                let b = slack(&v, cx);
                let b = b.read(cx);
                assert_eq!(
                    b.probe_filter(),
                    (false, true),
                    "Show dismissed turns on to show it"
                );
                assert_eq!(
                    b.board
                        .as_ref()
                        .unwrap()
                        .item("tracked")
                        .unwrap()
                        .triage
                        .status,
                    Status::Dismissed,
                    "never restored"
                );
                assert_eq!(draft(&v, cx), "Keep 👩‍💻 e\u{301}");
            });
            assert!(present(
                cx,
                h,
                if wide {
                    "slack-inspector"
                } else {
                    "slack-detail"
                }
            ));
            if wide {
                assert!(
                    present(cx, h, "slack-column-dismissed")
                        && present(cx, h, "slack-card-tracked")
                );
            }
            capture(cx, h, captures.as_deref(), width, mode, "opened-dismissed");
            assert!(
                writes(&s).is_empty(),
                "opening an existing message writes nothing"
            );
            if !wide {
                click(cx, h, "slack-back");
            }

            // An untracked link: explicit adds, the channel's project first. Return adds once.
            s.reply(
                "POST",
                "/api/tracking/slack/messages",
                Reply {
                    delay_ms: 400,
                    ..Reply::status(
                        Some(200),
                        message("added", "p1", "Added from a link", "open", UNTRACKED),
                    )
                },
            );
            paste(cx, h, &v, &format!("  {}  ", link(UNTRACKED)));
            until(cx, h, "untracked lookup", |cx| {
                palette_rows(&v, cx).is_some_and(|r| !r.is_empty())
            });
            cx.update(|cx| {
                assert_eq!(
                    palette_rows(&v, cx).unwrap(),
                    ["slack:add:p1", "slack:add:p2"]
                );
                assert_eq!(palette_selected(&v, cx).as_deref(), Some("slack:add:p1"));
            });
            capture(cx, h, captures.as_deref(), width, mode, "palette-add");
            assert!(writes(&s).is_empty());
            press(cx, h, "enter");
            cx.update(|cx| {
                let b = slack(&v, cx);
                assert_eq!(
                    b.read(cx).adding.as_ref().map(|a| a.state.clone()),
                    Some(AddState::Pending)
                );
            });
            assert!(present(cx, h, "slack-add"));
            capture(cx, h, captures.as_deref(), width, mode, "adding");
            // A second activation while it runs sends nothing.
            cx.update_window(h, |_, w, cx| {
                let b = slack(&v, cx);
                let link = crate::slack_triage::MessageLink::parse(&link(UNTRACKED)).unwrap();
                b.update(cx, |b, cx| b.add("p1".into(), link, w, cx));
            })
            .unwrap();
            until(cx, h, "added", |cx| {
                let b = slack(&v, cx);
                let b = b.read(cx);
                b.adding.is_none() && b.selected.as_deref() == Some("added") && b.open
            });
            assert_eq!(
                adds(&s),
                [json!({"projectId":"p1","url":link(UNTRACKED)})],
                "one explicit add, the link exactly as pasted (trimmed)"
            );
            s.clear("POST", "/api/tracking/slack/messages");
            if !wide {
                click(cx, h, "slack-back");
            }

            // A refusal keeps pilotd's reason; Try again (by pointer) is a new explicit add.
            s.reply(
                "POST",
                "/api/tracking/slack/messages",
                Reply::status(
                    Some(503),
                    json!({"error":"Slack is limiting requests. Try again in a minute."}),
                ),
            );
            paste(cx, h, &v, &link(REFUSED));
            until(cx, h, "refused lookup", |cx| {
                palette_rows(&v, cx).is_some_and(|r| !r.is_empty())
            });
            click(cx, h, "jump-row-slack:add:p2");
            until(cx, h, "refused", |cx| {
                matches!(
                    slack(&v, cx).read(cx).adding.as_ref().map(|a| &a.state),
                    Some(AddState::Refused(r)) if r == "Slack is limiting requests. Try again in a minute."
                )
            });
            cx.update(|cx| assert!(matches!(v.read(cx).page, Page::Inbox(None))));
            assert!(present(cx, h, "slack-add-retry"));
            capture(cx, h, captures.as_deref(), width, mode, "add-refused");
            assert_eq!(adds(&s).len(), 2);
            s.clear("POST", "/api/tracking/slack/messages");
            click(cx, h, "slack-add-retry");
            until(cx, h, "retried", |cx| {
                slack(&v, cx).read(cx).adding.is_none()
            });
            assert_eq!(adds(&s).len(), 3);
            assert_eq!(adds(&s)[2], json!({"projectId":"p2","url":link(REFUSED)}));
            if !wide {
                click(cx, h, "slack-back");
            }

            // A lost reply is Unknown and never resent; the next read settles it when it landed.
            s.state.lock().unwrap().items.push(message(
                "landed",
                "p1",
                "Landed before the reply was lost",
                "open",
                LANDED,
            ));
            s.reply(
                "POST",
                "/api/tracking/slack/messages",
                Reply::status(None, Value::Null),
            );
            cx.update_window(h, |_, w, cx| {
                let b = slack(&v, cx);
                let link = crate::slack_triage::MessageLink::parse(&link(LANDED)).unwrap();
                b.update(cx, |b, cx| b.add("p1".into(), link, w, cx));
            })
            .unwrap();
            until(cx, h, "reconciled", |cx| {
                let b = slack(&v, cx);
                let b = b.read(cx);
                b.adding.is_none() && b.selected.as_deref() == Some("landed")
            });
            assert_eq!(adds(&s).len(), 4);
            if !wide {
                click(cx, h, "slack-back");
            }
            cx.update_window(h, |_, w, cx| {
                let b = slack(&v, cx);
                let link = crate::slack_triage::MessageLink::parse(&link(LOST)).unwrap();
                b.update(cx, |b, cx| b.add("p1".into(), link, w, cx));
            })
            .unwrap();
            until(cx, h, "unknown", |cx| {
                let b = slack(&v, cx);
                let b = b.read(cx);
                !b.busy
                    && matches!(
                        b.adding.as_ref().map(|a| &a.state),
                        Some(AddState::Unknown(_))
                    )
            });
            assert!(present(cx, h, "slack-add-dismiss") && !present(cx, h, "slack-add-retry"));
            capture(cx, h, captures.as_deref(), width, mode, "add-unknown");
            assert_eq!(adds(&s).len(), 5, "Unknown is never resent");
            click(cx, h, "slack-add-dismiss");
            assert!(!present(cx, h, "slack-add"));
            s.clear("POST", "/api/tracking/slack/messages");

            // Another daemon's reply is refused: no rows, so nothing to activate.
            s.state.lock().unwrap().daemon = "other".into();
            paste(cx, h, &v, &link(UNTRACKED + 7));
            until(cx, h, "identity refusal", |cx| {
                v.read(cx)
                    .jump
                    .as_ref()
                    .is_some_and(|p| p.read(cx).probe(cx).2)
                    && palette_rows(&v, cx).is_some_and(|r| r.is_empty())
            });
            press(cx, h, "enter");
            press(cx, h, "escape");
            cx.update(|cx| {
                assert!(v.read(cx).jump.is_none());
                assert_eq!(draft(&v, cx), "Keep 👩‍💻 e\u{301}");
            });
            assert_eq!(adds(&s).len(), 5);
            let patches = writes(&s).iter().filter(|(m, _, _)| m == "PATCH").count();
            assert_eq!(patches, 0, "no status was changed");
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"slack_links":true,"lookalikes_unsearched":true,
                    "tracked_opens_exact_dismissed":true,"open_writes":0,"untracked_add_ranked":true,
                    "pending_double_activation":true,"refused_retry":true,"unknown_not_resent":true,
                    "unknown_reconciled":true,"identity_refused":true,"draft_kept":true,"adds":5,
                    "native_offscreen":true})
            );
        }
    }
}
