use super::*;
use gpui_kit::{
    Bounds, EntityInputHandler, HeadlessAppContext, MouseButton, WindowBounds, WindowOptions, size,
    test::{TestEventExt, TestWindowExt},
};
use serde_json::json;

fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..8 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
pub fn run_chat_links_probe(cx: &mut HeadlessAppContext) {
    let (client, commands) = LocalClient::synthetic_commands();
    let (h, v) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(960.), px(760.)),
                    ))),
                    show: false,
                    ..Default::default()
                },
                cx,
                |w, cx| {
                    cx.new(|cx| {
                        w.activate_window();
                        let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                        v.client = Some(client);
                        v.state.projects = Arc::new(crate::local_model::projects(&json!([{"id":"scope-kept","name":"Scoped project","path":"/synthetic/scope"}])).unwrap());
                        v.state.projects_loaded = true;
                        v.state.chats = Arc::new(
                            ["synthetic", "exact-ID"]
                                .map(|id| {
                                    crate::local_model::chat(
                                        &json!({"id":id,"title":"Same title","state":"idle","projectId":"scope-kept"}),
                                    )
                                    .unwrap()
                                })
                                .to_vec(),
                        );
                        v.transcript.update(cx, |t, cx| {
                            t.history_scope(v.generation);
                            t.replace_readonly(
                                vec![Message::live(
                                    900,
                                    "assistant".into(),
                                    "[Open exact chat](pilot://chat/exact-ID)".into(),
                                )],
                                true,
                                cx,
                            )
                        });
                        v.rebuild_nav(w, cx);
                        v
                    })
                },
            )
        })
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        if std::env::var_os("PILOT_NEXT_DIRECT_LINK_ONLY").is_some() {
            v.update(cx, |v, cx| v.open_chat_url("pilot://chat/exact-ID", w, cx));
        } else {
            let row = v.read(cx).transcript.read(cx).history_probe_row(900);
            let b = row.read(cx).bounds();
            let p = b.origin + gpui_kit::point(px(30.), px(10.));
            w.pointer_down(p, MouseButton::Left, cx);
            w.pointer_up(p, MouseButton::Left, cx);
        }
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, _, cx| {
        assert_eq!(
            v.read(cx).selected.as_deref(),
            Some("exact-ID"),
            "rendered/direct chat link must select exact canonical identity"
        )
    })
    .unwrap();
    assert!(matches!(commands.try_recv(), Ok(Command::Open { id, .. }) if id == "exact-ID"));
    // Direct OS dispatch uses the same route, including already-selected targets.
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.project_scope = Some("scope-kept".into());
            let generation = v.generation;
            v.open_chat_url("pilot://chat/exact-ID", w, cx);
            assert_eq!(v.generation, generation);
            assert!(
                commands.is_empty(),
                "already-selected link must not reopen the stream"
            );
            v.open_chat_url("pilot://chat/synthetic", w, cx);
            assert_eq!(v.selected.as_deref(), Some("synthetic"));
            assert_eq!(v.project_scope.as_deref(), Some("scope-kept"));
            let (writer, _) = Interaction::recording();
            v.editor
                .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
            v.transcript.update(cx, |t, cx| {
                t.history_scope(v.generation);
                t.replace_readonly(
                    vec![Message::live(
                        901,
                        "assistant".into(),
                        "[Open exact chat](pilot://chat/exact-ID)".into(),
                    )],
                    true,
                    cx,
                );
            });
        })
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            let input = v.editor.read(cx).shell_probe().0;
            input.update(cx, |i, cx| {
                i.focus(w, cx);
                i.set_value("Draft 私 👩‍💻", w, cx);
                i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
            });
            assert!(
                input
                    .update(cx, |i, cx| i.marked_text_range(w, cx))
                    .is_some(),
                "fixture must have active composition"
            );
            v.open_chat_url("pilot://chat/exact-ID", w, cx);
            assert_eq!(v.selected.as_deref(), Some("synthetic"));
            assert!(
                input
                    .update(cx, |i, cx| i.marked_text_range(w, cx))
                    .is_some()
            );
        })
    })
    .unwrap();
    // A rendered link click must not end composition before routing admission.
    cx.update_window(h, |_, w, cx| {
        let row = v.read(cx).transcript.read(cx).history_probe_row(901);
        let p = row.read(cx).bounds().origin + gpui_kit::point(px(30.), px(10.));
        w.pointer_down(p, MouseButton::Left, cx);
        w.pointer_up(p, MouseButton::Left, cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            let input = v.editor.read(cx).shell_probe().0;
            assert_eq!(v.selected.as_deref(), Some("synthetic"));
            assert!(
                input
                    .update(cx, |i, cx| i.marked_text_range(w, cx))
                    .is_some()
            );
            input.update(cx, |i, cx| {
                i.unmark_text(w, cx);
                i.set_value("Draft 私 👩‍💻", w, cx);
            });
            v.open_chat_url("pilot://chat/exact-ID", w, cx);
            v.move_navigation(false, w, cx);
            assert_eq!(v.selected.as_deref(), Some("synthetic"));
            assert_eq!(input.read(cx).value().as_ref(), "Draft 私 👩‍💻");
            v.move_navigation(true, w, cx);
            assert_eq!(v.selected.as_deref(), Some("exact-ID"));
            v.mission_open = true;
            v.open_chat_url("pilot://chat/synthetic", w, cx);
            assert_eq!(v.selected.as_deref(), Some("exact-ID"));
            v.mission_open = false;
        })
    })
    .unwrap();
    while commands.try_recv().is_ok() {}
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            for url in [
                "pilot://chat/",
                "pilot://chat",
                "pilot://chat/id?host=x",
                "pilot://mission/id",
                "file:///tmp/test",
            ] {
                v.open_chat_url(url, w, cx);
                assert_eq!(v.selected.as_deref(), Some("exact-ID"));
                assert!(v.nav_error.is_some());
                assert!(commands.is_empty());
            }
            // An event from an unmounted/previous transcript cannot redirect this chat.
            v.transcript.update(cx, |_, cx| {
                cx.emit(crate::transcript_view::LinkOpen {
                    url: "pilot://chat/synthetic".into(),
                    generation: 0,
                })
            });
        })
    })
    .unwrap();
    settle(cx, h);
    assert!(commands.is_empty());

    cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, _, cx| {
        assert_eq!(v.read(cx).selected.as_deref(), Some("synthetic"))
    })
    .unwrap();
    cx.update_window(h, |_, w, cx| w.press("secondary-]", cx))
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, _, cx| {
        assert_eq!(v.read(cx).selected.as_deref(), Some("exact-ID"))
    })
    .unwrap();
    while commands.try_recv().is_ok() {}

    let daemon = crate::chat_links_fixture::Running::start();
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.usage_options = Some(daemon.options.clone());
            v.open_chat_url("pilot://chat/unloaded-ID", w, cx);
        })
    })
    .unwrap();
    until(cx, h, "unloaded", |cx| {
        let v = v.read(cx);
        if v.nav_error.is_some_and(|e| e != "Opening linked chat…") {
            panic!(
                "unloaded route: {:?}, requests {:?}",
                v.nav_error,
                daemon.state.lock().unwrap().requests
            );
        }
        v.selected.as_deref() == Some("unloaded-ID")
    });
    cx.update_window(h, |_, _, cx| {
        assert_eq!(v.read(cx).project_scope.as_deref(), Some("scope-kept"));
        assert_eq!(
            v.read(cx)
                .state
                .chats
                .iter()
                .find(|c| c.id == "unloaded-ID")
                .unwrap()
                .project_id
                .as_deref(),
            Some("project")
        );
    })
    .unwrap();
    assert!(matches!(commands.try_recv(), Ok(Command::Open {id, ..}) if id == "unloaded-ID"));
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.open_chat_url("pilot://chat/synthetic", w, cx);
            let mut chats = v.state.chats.as_ref().clone();
            chats.retain(|c| c.id != "unloaded-ID");
            v.state.chats = Arc::new(chats);
        })
    })
    .unwrap();
    while commands.try_recv().is_ok() {}
    daemon.state.lock().unwrap().status = 404;
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.open_chat_url("pilot://chat/unloaded-ID", w, cx)
        })
    })
    .unwrap();
    until(cx, h, "404", |cx| {
        v.read(cx)
            .nav_error
            .is_some_and(|e| e.contains("not found"))
    });
    assert!(commands.is_empty());
    {
        let mut s = daemon.state.lock().unwrap();
        s.status = 200;
        s.slow = true;
        s.requests.clear();
    }
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.open_chat_url("pilot://chat/unloaded-ID", w, cx)
        })
    })
    .unwrap();
    until(cx, h, "slow request", |_| {
        daemon
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|r| r.contains("/api/sessions/"))
    });
    cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.show_home(w, cx)))
        .unwrap();
    daemon.release.notify_one();
    until(cx, h, "late response", |_| {
        daemon.state.lock().unwrap().requests.len() == 3
    });
    settle(cx, h);
    cx.update_window(h, |_, _, cx| {
        assert_eq!(v.read(cx).page, Page::Home);
        assert_eq!(v.read(cx).selected.as_deref(), Some("synthetic"));
    })
    .unwrap();
    assert!(
        commands.is_empty(),
        "late read must not navigate after newer intent"
    );
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    println!(
        "chat_links: native Markdown click, URL dispatch, exact/unloaded identities, errors, drafts, IME, history and stale-result fencing passed"
    );
}

fn until(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    label: &str,
    predicate: impl Fn(&App) -> bool,
) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        settle(cx, h);
        if cx.update(|cx| predicate(cx)) {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "chat link probe timed out: {label}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
