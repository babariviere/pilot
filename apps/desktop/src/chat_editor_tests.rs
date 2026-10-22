use super::*;
use crate::{
    delivery_store::{Host, Store},
    interaction::WriteState,
};
use gpui_kit::{
    Bounds, TestAppContext, WindowBounds, WindowOptions, px, size,
    test::{TestQueryExt, TestWindowExt},
};

fn book() -> std::sync::Arc<crate::delivery_store::Book> {
    let root = std::env::temp_dir().join(format!("editor-test-{}", uuid::Uuid::new_v4()));
    let store = Store::open(
        root.clone(),
        Host {
            host_id: "local".into(),
            daemon_id: "test-daemon".into(),
            lineage_id: "test-lineage".into(),
        },
    )
    .unwrap();
    let book = std::sync::Arc::new(store.book.clone());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
    book
}
fn setup(
    cx: &mut TestAppContext,
) -> (
    gpui_kit::AnyWindowHandle,
    Entity<ChatEditor>,
    async_channel::Receiver<WriteCommand>,
) {
    let (client, commands) = Interaction::recording();
    let book = book();
    cx.update(gpui_kit::init);
    let (handle, view) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(960.), px(500.)),
                ))),
                show: false,
                ..Default::default()
            },
            cx,
            |window, cx| {
                cx.new(|cx| {
                    let mut editor = ChatEditor::new(Some(client), window, cx);
                    editor.accept(
                        WriteState {
                            book: Some(book),
                            ..Default::default()
                        },
                        window,
                        cx,
                    );
                    editor.select("chat:a".into(), true, true, window, cx);
                    editor.focus(window, cx);
                    editor
                })
            },
        )
        .unwrap()
    });
    cx.run_until_parked();
    (handle, view, commands)
}

#[gpui_kit::test]
fn thinking_reuses_one_indicator_and_stop_fences_late_presentations(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| view.activity(true, cx));
        window.render_frame(cx);
        assert_eq!(view.read(cx).activity_label(), Some("Thinking..."));
        assert_eq!(window.find_all("activity-indicator").len(), 1);
        window.click("local-stop", cx);
    })
    .unwrap();
    cx.run_until_parked();
    assert!(matches!(
        commands.try_recv().unwrap(),
        WriteCommand::Submit { stop: true, .. }
    ));
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| view.activity(true, cx));
        window.render_frame(cx);
        assert_eq!(view.read(cx).activity_label(), Some("Working..."));
        assert_eq!(window.find_all("activity-indicator").len(), 1);
        view.update(cx, |view, cx| {
            view.activity(false, cx);
            view.permission(true, false, cx);
        });
        window.render_frame(cx);
        assert_eq!(view.read(cx).activity_label(), None);
        assert!(window.find_all("activity-indicator").is_empty());
        view.update(cx, |view, cx| {
            view.activity(true, cx);
            view.select("chat:b".into(), true, false, window, cx);
        });
        assert_eq!(
            view.read(cx).activity_label(),
            None,
            "navigation clears activity"
        );
    })
    .unwrap();
}

#[gpui_kit::test]
fn double_enter_and_pointer_send_capture_latest_value_once(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.input("last character 日本語", cx);
        window.press("enter", cx);
        window.press("enter", cx);
        window.click("local-send", cx);
    })
    .unwrap();
    cx.run_until_parked();
    let command = commands.try_recv().unwrap();
    match command {
        WriteCommand::Submit {
            key, draft, stop, ..
        } => {
            assert_eq!(key, "chat:a");
            assert_eq!(draft.text, "last character 日本語");
            assert!(!stop);
        }
        _ => panic!("expected one submit"),
    }
    assert!(commands.try_recv().is_err());
    cx.update(|cx| assert_eq!(view.read(cx).cache["chat:a"].text, "last character 日本語"));
}

#[gpui_kit::test]
fn fast_navigation_captures_pending_changes_and_never_retargets_a_send(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.input("draft A", cx);
        view.update(cx, |view, cx| {
            view.select("chat:b".into(), true, true, window, cx)
        });
        window.input("draft B", cx);
        view.update(cx, |view, cx| view.submit(false, window, cx));
        view.update(cx, |view, cx| {
            view.select("chat:a".into(), true, true, window, cx)
        });
        assert_eq!(view.read(cx).text.read(cx).value().as_ref(), "draft A");
        assert_eq!(view.read(cx).cache["chat:b"].text, "draft B");
    })
    .unwrap();
    cx.run_until_parked();
    match commands.try_recv().unwrap() {
        WriteCommand::Submit { key, draft, .. } => {
            assert_eq!(key, "chat:b");
            assert_eq!(draft.text, "draft B");
        }
        _ => panic!("expected submit"),
    }
}

#[gpui_kit::test]
fn readonly_and_marked_text_cannot_send_from_keyboard_or_pointer(cx: &mut TestAppContext) {
    use gpui_kit::{ElementInputHandler, test::TestInput};
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.input("prefix ", cx);
        let handler = ElementInputHandler::new(
            window.find_by_label("Local chat message").bounds(),
            view.read(cx).text.clone(),
        );
        let mut input = TestInput::new(handler, window);
        input.compose_text(None, "にほん", Some(3..3), cx);
        window.press("enter", cx);
        window.press("shift-enter", cx);
        window.click("local-send", cx);
    })
    .unwrap();
    cx.run_until_parked();
    assert!(commands.try_recv().is_err());
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.select("chat:retained".into(), false, true, window, cx)
        });
        view.update(cx, |view, cx| {
            view.text
                .update(cx, |text, cx| text.set_value("cannot send", window, cx));
            view.submit(false, window, cx);
        });
    })
    .unwrap();
    assert!(commands.try_recv().is_err());
}

#[gpui_kit::test]
fn accepted_ack_cannot_clear_native_text_before_its_change_callback(cx: &mut TestAppContext) {
    let (handle, view, _) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.input("new text before ack", cx);
        let mut saved = (*book()).clone();
        saved.drafts.insert(
            "chat:a".into(),
            Draft {
                revision: 0,
                text: String::new(),
                ..Default::default()
            },
        );
        view.update(cx, |view, cx| {
            view.accept(
                WriteState {
                    book: Some(std::sync::Arc::new(saved)),
                    ..Default::default()
                },
                window,
                cx,
            )
        });
        assert_eq!(
            view.read(cx).text.read(cx).value().as_ref(),
            "new text before ack"
        );
    })
    .unwrap();
}

#[gpui_kit::test]
fn first_new_draft_keeps_its_revision_before_the_first_autosave_ack(cx: &mut TestAppContext) {
    let (handle, view, _) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| view.new_draft("/tmp".into(), window, cx));
        let key = view.read(cx).selected.clone().unwrap();
        assert_eq!(view.read(cx).cache[&key].revision, 1);
        assert_eq!(view.read(cx).cache[&key].cwd, "/tmp");
        view.update(cx, |view, cx| {
            view.text
                .update(cx, |text, cx| text.set_value("first edit", window, cx))
        });
        view.update(cx, |view, cx| view.changed(cx));
        assert_eq!(view.read(cx).cache[&key].revision, 2);
        view.update(cx, |view, cx| {
            view.select("chat:a".into(), true, false, window, cx)
        });
        assert_eq!(view.read(cx).cache[&key].text, "first edit");
    })
    .unwrap();
}

#[gpui_kit::test]
fn browsing_empty_chats_and_repeated_blank_new_chat_do_not_exhaust_drafts(cx: &mut TestAppContext) {
    let (handle, view, _) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        for n in 0..512 {
            view.update(cx, |view, cx| {
                view.select(format!("chat:synthetic-{n}"), true, false, window, cx)
            });
        }
        assert!(view.read(cx).cache.len() < 3);
        for _ in 0..256 {
            view.update(cx, |view, cx| view.new_draft(String::new(), window, cx));
        }
        assert!(view.read(cx).cache.len() < 3);
    })
    .unwrap();
}
