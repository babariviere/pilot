//! Hidden production root: Start chat from a Slack message, against the faux pilotd and a
//! recording draft writer. Start chat opens an editable draft in the message's project and
//! sends nothing; a second activation returns to the same draft; a linked message opens its
//! chat. No real Slack, accounts, daemon or app actions.
use super::*;
use crate::{
    chat_editor::Existing,
    delivery_store::{Draft, Tracked},
    interaction::WriteCommand,
};

fn editor_draft(v: &Entity<LocalViewer>, cx: &App) -> (String, Option<Draft>) {
    let e = v.read(cx).editor.read(cx);
    let (text, _, draft) = e.shell_probe();
    (text.read(cx).value().to_string(), draft)
}
fn key(v: &Entity<LocalViewer>, cx: &App) -> Option<String> {
    v.read(cx)
        .editor
        .read(cx)
        .navigation_key()
        .map(str::to_owned)
}
fn submits(writes: &async_channel::Receiver<WriteCommand>) -> Vec<Draft> {
    let mut out = Vec::new();
    while let Ok(command) = writes.try_recv() {
        if let WriteCommand::Submit { draft, .. } = command {
            out.push(*draft);
        }
    }
    out
}
fn tracked_drafts(v: &Entity<LocalViewer>, cx: &App, item: &str) -> usize {
    let e = v.read(cx).editor.read(cx);
    e.new_drafts()
        .iter()
        .filter(|(key, _)| e.tracked_draft(item) == Some(Existing::Draft(key.clone())))
        .count()
}
/// Opens one message in the inspector, as a click on its card or row.
fn inspect(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    v: &Entity<LocalViewer>,
    wide: bool,
    id: &str,
) {
    if !wide && present(cx, h, "slack-back") {
        click(cx, h, "slack-back");
    }
    let tab = cx.update(|cx| {
        slack(v, cx)
            .read(cx)
            .board
            .as_ref()
            .and_then(|b| b.item(id))
            .map(|i| i.triage.status)
    });
    if !wide && let Some(tab) = tab {
        click(cx, h, &format!("slack-tab-{}", tab.wire()));
    }
    click(
        cx,
        h,
        &format!("slack-{}-{id}", if wide { "card" } else { "row" }),
    );
    assert!(present(cx, h, "slack-detail"), "inspector for {id}");
}
fn to_slack(cx: &mut HeadlessAppContext, h: AnyWindowHandle, v: &Entity<LocalViewer>) {
    click(cx, h, "nav-inbox");
    cx.update_window(h, |_, w, cx| w.click("inbox-tab-slack", cx))
        .unwrap();
    until(cx, h, "board", |cx| {
        let b = slack(v, cx);
        let b = b.read(cx);
        b.board.is_some() && !b.busy
    });
}

pub(super) fn run(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_SLACK_DIR").map(std::path::PathBuf::from);
    for width in [680., 1100.] {
        let wide = width >= 960.;
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let now = crate::usage_overview::now();
            let hour = 3_600_000;
            let mut linked = item(
                "m1",
                "p1",
                "Checkout fails on Safari",
                "open",
                "critical",
                now - 2 * hour,
            );
            linked["sessionIds"] = json!(["chat-linked"]);
            let s = Server::start(
                vec![
                    project("p1", "Atlas", &["C1"]),
                    project("p2", "Boreal", &["C9"]),
                ],
                vec![source("p1", "ok"), source("p2", "ok")],
                vec![
                    linked,
                    item(
                        "m2",
                        "p1",
                        "How do I export invoices? 日本語 👩‍💻",
                        "open",
                        "medium",
                        now - 3 * hour,
                    ),
                    item(
                        "m5",
                        "p2",
                        "From a removed project",
                        "open",
                        "low",
                        now - 4 * hour,
                    ),
                ],
            );
            let (client, reads) = LocalClient::synthetic_commands();
            let (writer, commands) = Interaction::recording();
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
                            // Boreal is no longer a Local project.
                            v.state.projects = Arc::new(
                                crate::local_model::projects(&json!([
                                    {"id":"p1","name":"Atlas","path":"/synthetic/a"}
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
            cx.update_window(h, |_, w, cx| {
                Theme::change(mode, Some(w), cx);
                w.activate_window();
            })
            .unwrap();
            settle(cx, h);
            to_slack(cx, h, &v);

            // An unlinked message offers Start chat; opening it writes nothing.
            inspect(cx, h, &v, wide, "m2");
            assert!(present(cx, h, "slack-start-chat") && !present(cx, h, "slack-open-chat"));
            capture(cx, h, captures.as_deref(), width, mode, "start-chat");
            let prompt = cx.update(|cx| {
                slack(&v, cx)
                    .read(cx)
                    .board
                    .as_ref()
                    .unwrap()
                    .item("m2")
                    .unwrap()
                    .chat_prompt()
            });
            click(cx, h, "slack-start-chat");
            let first = cx.update(|cx| {
                let view = v.read(cx);
                assert_eq!(view.page, Page::Chat);
                let (text, draft) = editor_draft(&v, cx);
                let draft = draft.unwrap();
                assert_eq!(text, prompt, "the message as context, for the user to edit");
                assert_eq!(
                    draft.tracked,
                    Some(Tracked {
                        item_id: "m2".into(),
                        project_id: "p1".into(),
                        label: "#support".into()
                    })
                );
                assert_eq!(draft.project_id.as_deref(), Some("p1"));
                assert_eq!(draft.cwd, "/synthetic/a");
                key(&v, cx).unwrap()
            });
            assert!(first.starts_with("new:"));
            cx.update_window(h, |_, w, _| {
                assert!(
                    w.try_find("new-chat-tracked").is_some(),
                    "names its message"
                );
                assert!(
                    w.try_find("new-chat-project").is_none(),
                    "its project is fixed"
                );
                assert!(w.try_find("new-chat-add-project").is_none());
            })
            .unwrap();
            capture(cx, h, captures.as_deref(), width, mode, "draft");
            assert!(submits(&commands).is_empty(), "Start chat sends nothing");
            assert!(writes(&s).is_empty(), "nor writes to pilotd");

            // Edits stay; a second Start chat returns to the same draft, by keyboard here.
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.editor.update(cx, |e, cx| e.focus(w, cx)));
                w.input(" Edited 日本語", cx);
            })
            .unwrap();
            settle(cx, h);
            let edited = cx.update(|cx| editor_draft(&v, cx).0);
            assert_eq!(
                edited,
                format!("{prompt} Edited 日本語"),
                "typing continues after the context"
            );
            to_slack(cx, h, &v);
            if !present(cx, h, "slack-detail") {
                inspect(cx, h, &v, wide, "m2");
            }
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.inbox.update(cx, |i, cx| i.focus(w, cx)))
            })
            .unwrap();
            cx.update(|cx| assert_eq!(slack(&v, cx).read(cx).selected.as_deref(), Some("m2")));
            press(cx, h, "secondary-enter");
            cx.update(|cx| {
                assert_eq!(v.read(cx).page, Page::Chat);
                assert_eq!(
                    key(&v, cx).as_deref(),
                    Some(first.as_str()),
                    "the same draft"
                );
                assert_eq!(editor_draft(&v, cx).0, edited, "edits kept");
                assert_eq!(tracked_drafts(&v, cx, "m2"), 1, "never a duplicate");
            });

            // Send is the explicit start: one submission carrying the message and the edits.
            click(cx, h, "local-send");
            let sent = submits(&commands);
            assert_eq!(sent.len(), 1, "{}", sent.len());
            assert_eq!(sent[0].text, edited);
            assert_eq!(sent[0].tracked.as_ref().unwrap().item_id, "m2");
            // While it is sending, Start chat again returns to it and sends nothing more.
            to_slack(cx, h, &v);
            if !present(cx, h, "slack-detail") {
                inspect(cx, h, &v, wide, "m2");
            }
            click(cx, h, "slack-start-chat");
            cx.update(|cx| assert_eq!(key(&v, cx).as_deref(), Some(first.as_str())));
            if present(cx, h, "new-chat-unlink") {
                click(cx, h, "new-chat-unlink");
            }
            cx.update(|cx| {
                assert!(
                    editor_draft(&v, cx).1.unwrap().tracked.is_some(),
                    "fixed while sending"
                )
            });
            assert!(submits(&commands).is_empty());

            // A linked message opens its chat; Start another chat stays explicit.
            to_slack(cx, h, &v);
            inspect(cx, h, &v, wide, "m1");
            assert!(present(cx, h, "slack-open-chat") && !present(cx, h, "slack-start-chat"));
            capture(cx, h, captures.as_deref(), width, mode, "linked");
            choose(cx, h, "slack-more", "Start another chat");
            let another = cx.update(|cx| {
                assert_eq!(v.read(cx).page, Page::Chat);
                let (_, draft) = editor_draft(&v, cx);
                assert_eq!(draft.unwrap().tracked.unwrap().item_id, "m1");
                key(&v, cx).unwrap()
            });
            assert_ne!(another, first);
            // Unlinking keeps the draft and frees its project.
            click(cx, h, "new-chat-unlink");
            cx.update(|cx| {
                let (text, draft) = editor_draft(&v, cx);
                assert!(draft.unwrap().tracked.is_none());
                assert!(text.contains("Checkout fails on Safari"));
            });
            assert!(present(cx, h, "new-chat-project") && !present(cx, h, "new-chat-tracked"));
            to_slack(cx, h, &v);
            inspect(cx, h, &v, wide, "m1");
            // The synthetic session client's bounded command lane: drain what earlier views sent.
            while reads.try_recv().is_ok() {}
            click(cx, h, "slack-open-chat");
            cx.update(|cx| {
                assert_eq!(v.read(cx).page, Page::Chat);
                assert_eq!(v.read(cx).selected.as_deref(), Some("chat-linked"));
            });

            // A message from a project this app no longer has starts nothing.
            to_slack(cx, h, &v);
            inspect(cx, h, &v, wide, "m5");
            let before = cx.update(|cx| v.read(cx).editor.read(cx).new_drafts().len());
            click(cx, h, "slack-start-chat");
            cx.update(|cx| {
                let view = v.read(cx);
                assert!(matches!(view.page, Page::Inbox(_)));
                assert_eq!(view.nav_error, Some("That project is no longer available."));
                assert_eq!(view.editor.read(cx).new_drafts().len(), before);
            });
            assert!(submits(&commands).is_empty());
            assert!(writes(&s).is_empty(), "the board wrote nothing");
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"start_chat":true,"editable_draft":true,
                    "same_draft_on_repeat":true,"keyboard":true,"explicit_send_only":true,
                    "linked_opens_chat":true,"start_another":true,"unlink":true,
                    "stale_project_refused":true,"writes":0,"native_offscreen":true})
            );
        }
    }
}
