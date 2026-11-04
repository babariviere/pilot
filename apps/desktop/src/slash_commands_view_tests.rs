use super::*;
use crate::chat_editor::tests::setup;
use gpui_kit::{AnyWindowHandle, App, EntityInputHandler, TestAppContext, test::TestWindowExt};

/// One window update, then its input events and notifications.
fn act<R>(
    cx: &mut TestAppContext,
    h: AnyWindowHandle,
    f: impl FnOnce(&mut Window, &mut App) -> R,
) -> R {
    let r = cx.update_window(h, |_, w, cx| f(w, cx)).unwrap();
    cx.run_until_parked();
    r
}
fn type_text(cx: &mut TestAppContext, h: AnyWindowHandle, view: &Entity<ChatEditor>, text: &str) {
    act(cx, h, |w, cx| {
        let input = view.read(cx).text.clone();
        input.update(cx, |i, cx| i.replace_text_in_range(None, text, w, cx));
    });
}
fn set_text(cx: &mut TestAppContext, h: AnyWindowHandle, view: &Entity<ChatEditor>, text: &str) {
    act(cx, h, |w, cx| {
        let input = view.read(cx).text.clone();
        input.update(cx, |i, cx| {
            let all = 0..i.value().encode_utf16().count();
            i.replace_text_in_range(Some(all), text, w, cx)
        });
    });
}
fn press(cx: &mut TestAppContext, h: AnyWindowHandle, key: &str) {
    act(cx, h, |w, cx| {
        w.render_frame(cx);
        w.press(key, cx)
    });
}
fn value(cx: &mut TestAppContext, view: &Entity<ChatEditor>) -> String {
    cx.read(|cx| view.read(cx).text.read(cx).value().to_string())
}
fn menu(cx: &mut TestAppContext, view: &Entity<ChatEditor>) -> Option<Vec<String>> {
    cx.read(|cx| view.read(cx).slash_probe().map(|(names, _)| names))
}
fn note(cx: &mut TestAppContext, view: &Entity<ChatEditor>) -> Option<SharedString> {
    cx.read(|cx| view.read(cx).slash_probe_note())
}
fn source(chat: &str, generation: u64) -> paths::Source {
    paths::Source {
        options: crate::LocalOptions::synthetic(9),
        target: crate::path_completion::Target {
            chat: chat.into(),
            cwd: "/synthetic".into(),
            generation,
        },
    }
}
fn no_submit(commands: &async_channel::Receiver<WriteCommand>) {
    while let Ok(command) = commands.try_recv() {
        assert!(
            !matches!(command, WriteCommand::Submit { .. }),
            "a command was sent as a message"
        );
    }
}

#[gpui_kit::test]
fn leading_slash_opens_native_commands_and_typing_refines(cx: &mut TestAppContext) {
    let (h, view, commands) = setup(cx);
    type_text(cx, h, &view, "/");
    assert_eq!(
        menu(cx, &view).unwrap(),
        ["jobs", "compact", "changes", "artifacts", "help"]
    );
    act(cx, h, |w, cx| {
        w.render_frame(cx);
        assert!(w.try_find("slash-commands").is_some());
    });
    type_text(cx, h, &view, "a");
    assert_eq!(
        menu(cx, &view).unwrap(),
        ["artifacts", "compact", "changes"]
    );
    press(cx, h, "down");
    assert_eq!(cx.read(|cx| view.read(cx).slash_probe().unwrap().1), 1);
    press(cx, h, "down");
    assert_eq!(cx.read(|cx| view.read(cx).slash_probe().unwrap().1), 2);
    press(cx, h, "down");
    assert_eq!(
        cx.read(|cx| view.read(cx).slash_probe().unwrap().1),
        0,
        "wraps"
    );
    // No match closes it; nonmatching slash prose stays as typed.
    type_text(cx, h, &view, "zz");
    assert!(menu(cx, &view).is_none());
    assert_eq!(value(cx, &view), "/azz");
    act(cx, h, |w, cx| {
        w.render_frame(cx);
        assert!(w.try_find("slash-commands").is_none());
    });
    no_submit(&commands);
}

#[gpui_kit::test]
fn escape_dismisses_until_the_text_changes_and_keeps_the_draft(cx: &mut TestAppContext) {
    let (h, view, commands) = setup(cx);
    type_text(cx, h, &view, "/he");
    assert!(menu(cx, &view).is_some());
    press(cx, h, "escape");
    assert!(menu(cx, &view).is_none());
    assert_eq!(value(cx, &view), "/he");
    type_text(cx, h, &view, "l");
    assert_eq!(menu(cx, &view).unwrap(), ["help"]);
    no_submit(&commands);
}

#[gpui_kit::test]
fn tab_completes_and_shift_enter_keeps_a_newline(cx: &mut TestAppContext) {
    let (h, view, commands) = setup(cx);
    type_text(cx, h, &view, "/he");
    press(cx, h, "tab");
    assert_eq!(value(cx, &view), "/help ");
    assert!(menu(cx, &view).is_none(), "token ended");
    set_text(cx, h, &view, "/jo");
    assert!(menu(cx, &view).is_some());
    press(cx, h, "shift-enter");
    assert_eq!(value(cx, &view), "/jo\n");
    assert!(menu(cx, &view).is_none());
    no_submit(&commands);
}

#[gpui_kit::test]
fn completing_keeps_the_rest_of_the_draft_and_is_undoable(cx: &mut TestAppContext) {
    let (h, view, commands) = setup(cx);
    set_text(cx, h, &view, "/ch then 👩‍💻 e\u{301}");
    act(cx, h, |_, cx| {
        let input = view.read(cx).text.clone();
        input.update(cx, |i, cx| i.set_selected_range(3..3, cx));
    });
    assert_eq!(menu(cx, &view).unwrap(), ["changes"]);
    press(cx, h, "tab");
    assert_eq!(value(cx, &view), "/changes then 👩‍💻 e\u{301}");
    assert_eq!(
        cx.read(|cx| view.read(cx).cache["chat:a"].text.clone()),
        value(cx, &view),
        "autosaved"
    );
    press(cx, h, "secondary-z");
    assert_eq!(value(cx, &view), "/ch then 👩‍💻 e\u{301}");
    no_submit(&commands);
}

#[gpui_kit::test]
fn native_commands_never_send_and_report_why_nothing_opened(cx: &mut TestAppContext) {
    let (h, view, commands) = setup(cx);
    // Enter on a native command runs it. Without an owning window nothing opens,
    // so the draft stays and says why.
    type_text(cx, h, &view, "/help");
    assert!(menu(cx, &view).is_some());
    press(cx, h, "enter");
    assert_eq!(value(cx, &view), "/help");
    assert_eq!(
        note(cx, &view).as_deref(),
        Some("This control isn't available here.")
    );
    // A typed whole-draft command is intercepted at send.
    press(cx, h, "enter");
    assert_eq!(value(cx, &view), "/help");
    set_text(cx, h, &view, "/jobs now");
    act(cx, h, |w, cx| {
        view.update(cx, |e, cx| e.submit_mode(false, true, w, cx))
    });
    assert_eq!(
        note(cx, &view).as_deref(),
        Some("Use /jobs without arguments.")
    );
    assert_eq!(value(cx, &view), "/jobs now");
    type_text(cx, h, &view, "!");
    assert!(note(cx, &view).is_none(), "edits clear the note");
    no_submit(&commands);
}

#[gpui_kit::test]
fn compact_arguments_are_refused_without_sending(cx: &mut TestAppContext) {
    let (h, view, commands) = setup(cx);
    set_text(cx, h, &view, "/compact keep important details");
    press(cx, h, "enter");
    assert_eq!(value(cx, &view), "/compact keep important details");
    assert_eq!(
        note(cx, &view).as_deref(),
        Some("Use /compact without arguments.")
    );
    no_submit(&commands);
}

#[gpui_kit::test]
fn compact_guard_keeps_draft_attachments_focus_and_preedit(cx: &mut TestAppContext) {
    let (h, view, commands) = setup(cx);
    set_text(cx, h, &view, "keep 👩‍💻 e\u{301}");
    act(cx, h, |w, cx| {
        view.update(cx, |e, cx| {
            e.busy = false;
            let attachment = crate::image_attachments::Attachment {
                id: "synthetic".into(),
                path: "/synthetic/image.png".into(),
                hash: "a".repeat(64),
            };
            e.cache
                .get_mut("chat:a")
                .unwrap()
                .attachments
                .push(attachment.clone());
            assert!(e.compact_ready(w, cx));
            let before = e.cache["chat:a"].clone();
            e.pending.insert("chat:a".into(), 9);
            assert!(!e.compact_ready(w, cx));
            e.pending.clear();
            e.cache.get_mut("chat:a").unwrap().pending = Some("unknown".into());
            assert!(!e.compact_ready(w, cx));
            e.cache.insert("chat:a".into(), before.clone());
            assert_eq!(e.cache["chat:a"].attachments, [attachment]);
            assert_eq!(e.cache["chat:a"].text, before.text);
            assert!(e.text.read(cx).focus_handle(cx).is_focused(w));
            e.text.update(cx, |i, cx| {
                i.replace_and_mark_text_in_range(None, "未", Some(1..1), w, cx)
            });
            let marked = e.text.read(cx).value().to_string();
            assert!(!e.compact_ready(w, cx));
            assert_eq!(e.text.read(cx).value().as_ref(), marked);
            assert!(e.marked(w, cx));
        })
    });
    no_submit(&commands);
}

#[gpui_kit::test]
fn unknown_and_session_slash_text_sends_as_typed(cx: &mut TestAppContext) {
    for text in ["/unknown thing", "/review 12", "/helpme"] {
        let (h, view, commands) = setup(cx);
        type_text(cx, h, &view, text);
        act(cx, h, |w, cx| {
            view.update(cx, |e, cx| e.submit(false, w, cx))
        });
        let Ok(WriteCommand::Submit { draft, .. }) = commands.try_recv() else {
            panic!("{text} was not sent");
        };
        assert_eq!(draft.text, text);
    }
}

#[gpui_kit::test]
fn preedit_pending_and_read_only_show_no_menu(cx: &mut TestAppContext) {
    let (h, view, commands) = setup(cx);
    act(cx, h, |w, cx| {
        let input = view.read(cx).text.clone();
        input.update(cx, |i, cx| {
            i.replace_and_mark_text_in_range(None, "/", Some(1..1), w, cx)
        });
    });
    assert!(
        menu(cx, &view).is_none(),
        "no menu during marked composition"
    );
    act(cx, h, |w, cx| {
        let input = view.read(cx).text.clone();
        input.update(cx, |i, cx| i.unmark_text(w, cx));
        view.update(cx, |e, cx| e.slash_input_changed(w, cx, true));
    });
    assert!(menu(cx, &view).is_some(), "committed text opens it");
    act(cx, h, |w, cx| {
        view.update(cx, |e, cx| {
            e.pending.insert("chat:a".into(), 1);
            e.slash_input_changed(w, cx, true);
        })
    });
    assert!(menu(cx, &view).is_none(), "pending delivery");
    act(cx, h, |w, cx| {
        view.update(cx, |e, cx| {
            e.pending.clear();
            e.permission(false, true, cx);
            e.slash_input_changed(w, cx, true);
        })
    });
    assert!(menu(cx, &view).is_none(), "read-only");
    no_submit(&commands);
}

#[gpui_kit::test]
fn new_chats_offer_only_their_controls(cx: &mut TestAppContext) {
    let (h, view, _) = setup(cx);
    act(cx, h, |w, cx| {
        view.update(cx, |e, cx| {
            e.new_draft("/synthetic".into(), w, cx);
            e.focus(w, cx);
        })
    });
    type_text(cx, h, &view, "/");
    assert_eq!(menu(cx, &view).unwrap(), ["help"]);
}

#[gpui_kit::test]
fn session_commands_apply_only_to_their_exact_source(cx: &mut TestAppContext) {
    let (_, view, _) = setup(cx);
    view.update(cx, |e, _| {
        let list = crate::slash_commands::parse_session(&serde_json::json!({"commands":[
            {"name":"review","source":"prompt","argumentHint":"<pr>"},
            {"name":"help","source":"prompt"}
        ]}))
        .unwrap();
        e.slash.catalog = Some((source("a", 3), list.into()));
        let names = |s: Option<&paths::Source>| {
            e.slash_available("chat:a", s)
                .unwrap()
                .into_iter()
                .map(|c| c.name)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(Some(&source("a", 3))),
            ["jobs", "compact", "changes", "artifacts", "review", "help"]
        );
        // Another chat, a reconnect or no source never uses this list.
        for other in [Some(source("b", 3)), Some(source("a", 4)), None] {
            assert_eq!(
                names(other.as_ref()),
                ["jobs", "compact", "changes", "artifacts", "help"]
            );
        }
        assert!(e.slash_available("subagent:a:x", None).is_none());
    });
}

#[gpui_kit::test]
fn a_stale_choice_changes_nothing(cx: &mut TestAppContext) {
    let (h, view, commands) = setup(cx);
    type_text(cx, h, &view, "/he");
    let captured = cx.read(|cx| view.read(cx).slash.menu.as_ref().unwrap().capture.clone());
    type_text(cx, h, &view, "x");
    act(cx, h, |w, cx| {
        view.update(cx, |e, cx| {
            e.slash_choose(captured.clone(), "help", false, w, cx)
        })
    });
    assert_eq!(value(cx, &view), "/hex");
    set_text(cx, h, &view, "/he");
    let mut other = captured;
    other.key = "chat:b".into();
    act(cx, h, |w, cx| {
        view.update(cx, |e, cx| e.slash_choose(other, "help", false, w, cx))
    });
    assert_eq!(value(cx, &view), "/he");
    no_submit(&commands);
}
