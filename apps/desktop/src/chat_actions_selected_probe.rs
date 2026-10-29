//! One selected idle production chat: pending ACK and Unknown keep input gated.
use super::*;
pub(super) fn run(cx: &mut HeadlessAppContext) {
    let server = Server::start(Behavior::Slow);
    let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "native-chat-actions-selected-{}",
        uuid::Uuid::new_v4()
    ));
    let (writer, updates) = Interaction::start(server.options.clone(), Ok(root.clone()));
    let drain = updates.clone();
    let (client, commands) = LocalClient::synthetic_commands();
    let rows: Vec<_> = (100..116)
        .map(|id| {
            Message::live(
                id,
                "assistant".into(),
                format!(
                    "Reader {id} {}",
                    "Retain the selected idle reader. ".repeat(32)
                ),
            )
        })
        .collect();
    let (h,view)=cx.update(|cx|gpui_kit::open_window(WindowOptions{window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(1100.),px(840.))))),show:false,focus:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
        let mut v=LocalViewer::build(Some(client),Some(writer.clone()),w,cx);v.chat_actions.update(cx,|a,cx|a.connect(server.options.clone(),cx));
        v.state.status="Synthetic Local fixture".into();v.state.loaded=true;v.state.list_loaded=true;v.state.generation=1;v.generation=1;
        v.state.chats=Arc::new(vec![crate::local_model::chat(&f::source()).unwrap()]);v.state.projects=Arc::new(crate::local_model::projects(&json!([{"id":"project","name":"Synthetic","path":"/synthetic/project"}])).unwrap());v.state.projects_loaded=true;
        v.selected=Some("source".into());v.title="Selected idle source".into();v.transcript.update(cx,|t,cx|t.replace_readonly(rows.clone(),true,cx));v.editor.update(cx,|e,cx|e.select("chat:source".into(),true,false,w,cx));v.rebuild_nav(w,cx);v.listen_writes(updates,w,cx);v
    }))).unwrap();
    until(cx, h, |_, cx| view.read(cx).editor.read(cx).ready());
    let (editor, transcript) = cx.update(|cx| {
        (
            view.read(cx).editor.clone(),
            view.read(cx).transcript.clone(),
        )
    });
    let input = cx.update(|cx| editor.read(cx).shell_probe().0);
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| i.focus(w, cx));
        w.input("Selected unsent draft 私 👩‍💻", cx);
        w.scroll(
            "viewport",
            gpui_kit::ScrollDelta::Pixels(point(px(0.), px(100000.))),
            cx,
        );
    })
    .unwrap();
    settle(cx, h);
    until(cx, h, |_, cx| editor.read(cx).saved_probe(cx));
    let text = cx.update(|cx| input.read(cx).value().to_string());
    let anchor = cx.update(|cx| transcript.read(cx).history_probe_anchor(cx));
    // `None`: the list shows the chat archived, so its notice replaces the composer.
    let preserved = |w: &mut Window, cx: &mut App, disabled: Option<bool>| {
        let v = view.read(cx);
        assert_eq!(v.selected.as_deref(), Some("source"));
        assert_eq!(v.editor, editor);
        assert_eq!(v.transcript, transcript);
        assert_eq!(input.read(cx).value().as_ref(), text);
        match disabled {
            Some(disabled) => {
                assert_eq!(w.find("local-send").disabled() == Some(true), disabled)
            }
            None => {
                assert!(w.try_find("local-send").is_none());
                assert!(w.try_find("archived-composer").is_some());
            }
        }
        let current = transcript.read(cx).history_probe_anchor(cx);
        assert_eq!(current.0, anchor.0);
        assert!((current.1 - anchor.1).abs() < 1.);
    };
    menu(cx, h, "Archive");
    cx.update_window(h, |_, w, cx| click_label(w, "Archive", cx))
        .unwrap();
    until(cx, h, |_, cx| {
        server.posts() == 1
            && view
                .read(cx)
                .chat_actions
                .read(cx)
                .outcome("source")
                .is_none()
    });
    cx.update_window(h, |_, w, cx| preserved(w, cx, Some(true)))
        .unwrap();
    server.released.notify_one();
    until(cx, h, |_, cx| {
        view.read(cx).chat_actions.read(cx).outcome("source")
            == Some(&crate::chat_actions::Outcome::Acknowledged)
    });
    cx.update_window(h, |_, w, cx| preserved(w, cx, Some(true)))
        .unwrap(); // ACK without WS still gates a stale editable row.
    let publish = |cx: &mut HeadlessAppContext| {
        let raw = server.seen.lock().unwrap().source.clone();
        cx.update_window(h, |_, w, cx| {
            view.update(cx, |v, cx| {
                let mut state = v.state.clone();
                state.rows = rows.clone();
                state.chats = Arc::new(vec![crate::local_model::chat(&raw).unwrap()]);
                v.chats
                    .update(cx, |list, _| list.delegate_mut().archived = true);
                v.accept(state, w, cx);
            })
        })
        .unwrap();
        settle(cx, h);
    };
    publish(cx);
    cx.update_window(h, |_, w, cx| preserved(w, cx, None))
        .unwrap();
    server.seen.lock().unwrap().behavior = Behavior::Accept;
    menu(cx, h, "Restore");
    cx.update_window(h, |_, w, cx| click_label(w, "Restore", cx))
        .unwrap();
    until(cx, h, |_, cx| {
        server.posts() == 2
            && view.read(cx).chat_actions.read(cx).outcome("source")
                == Some(&crate::chat_actions::Outcome::Acknowledged)
    });
    publish(cx);
    cx.update_window(h, |_, w, cx| preserved(w, cx, Some(false)))
        .unwrap();
    server.seen.lock().unwrap().behavior = Behavior::Lost;
    menu(cx, h, "Archive");
    cx.update_window(h, |_, w, cx| click_label(w, "Archive", cx))
        .unwrap();
    until(cx, h, |_, cx| {
        view.read(cx).chat_actions.read(cx).outcome("source")
            == Some(&crate::chat_actions::Outcome::Unknown)
    });
    cx.update_window(h, |_, w, cx| preserved(w, cx, Some(true)))
        .unwrap();
    publish(cx);
    menu(cx, h, "Restore");
    cx.update_window(h, |_, w, cx| {
        click_label(w, "Restore", cx);
        w.press("down", cx);
        w.press("enter", cx);
        w.press("escape", cx);
        preserved(w, cx, None);
    })
    .unwrap();
    settle(cx, h);
    assert_eq!(server.posts(), 3);
    assert!(commands.try_recv().is_err());
    cx.update(|cx| {
        assert!(
            view.read(cx).chat_actions.read(cx).outcome("source")
                == Some(&crate::chat_actions::Outcome::Unknown)
        )
    });
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    drop(view);
    drop(input);
    drop(editor);
    drop(transcript);
    cx.run_until_parked();
    assert!(writer.command(WriteCommand::Close));
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(3), async {
                let mut flushed = false;
                while let Ok(s) = drain.recv().await {
                    flushed |= s.flushed;
                }
                assert!(flushed);
            })
            .await
            .unwrap();
        });
    let store = Store::open(root.clone(), server.options.host()).unwrap();
    assert_eq!(store.book.drafts["chat:source"].text, text);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
    println!(
        "{}",
        json!({"selected_idle_archive":true,"pending_ack_unknown_input_gating":true,"restore_reenables_received_writability":true,"same_draft_reader_editor":true,"no_implicit_send_stop_open":true,"unknown_readback_never_settles_or_retries":true,"private_flush":true})
    );
}
