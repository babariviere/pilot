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
    web_links(cx);
    println!(
        "chat_links: native Markdown click, URL dispatch, exact/unloaded identities, errors, drafts, IME, history, stale-result fencing, web opening and service badges passed"
    );
}

/// Ordinary and service web links open only through the captured opener; unsafe and
/// app/file schemes are refused. Nothing reaches a real browser or the network.
fn web_links(cx: &mut HeadlessAppContext) {
    let opened = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    cx.update(|cx| {
        let opened = opened.clone();
        cx.set_global(crate::external_links::Opener(Arc::new(move |url, _| {
            opened.lock().unwrap().push(url.into())
        })))
    });
    let rows = [
        (920, "[docs](https://example.com/docs?q=1#a)"),
        (921, "https://github.com/acme/api/pull/412"),
        (922, "[the ticket](https://linear.app/acme/issue/ENG-3)"),
        (923, "https://acme.slack.com/archives/C1/p1111111111111111"),
        (
            924,
            "[lookalike](https://github.com.evil.io/acme/api/pull/1)",
        ),
        (925, "[script](javascript:alert(1))"),
        (926, "[file](file:///etc/hosts)"),
        (927, "[chat](pilot://chat/exact-ID)"),
        (
            928,
            "Fixed in https://github.com/acme/api/pull/412, tracked by [ENG-3](https://linear.app/acme/issue/ENG-3) and discussed in https://acme.slack.com/archives/C1/p1111111111111111 with [docs](https://example.com/docs).",
        ),
    ];
    let (client, commands) = LocalClient::synthetic_commands();
    let (h, v) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(960.), px(900.)),
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
                        v.state.chats = Arc::new(
                            ["synthetic", "exact-ID"]
                                .map(|id| {
                                    crate::local_model::chat(
                                        &json!({"id":id,"title":"Links","state":"idle"}),
                                    )
                                    .unwrap()
                                })
                                .to_vec(),
                        );
                        v.transcript.update(cx, |t, cx| {
                            t.history_scope(v.generation);
                            t.replace_readonly(
                                rows.iter()
                                    .map(|(id, text)| {
                                        Message::live(*id, "assistant".into(), (*text).into())
                                    })
                                    .collect(),
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
    if let Some(dir) = std::env::var_os("PILOT_NEXT_CHAT_LINKS_DIR").map(std::path::PathBuf::from) {
        std::fs::create_dir_all(&dir).unwrap();
        for dark in [false, true] {
            cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            settle(cx, h);
            cx.capture_screenshot(h)
                .unwrap()
                .save(dir.join(format!(
                    "service-links-{}.png",
                    if dark { "dark" } else { "light" }
                )))
                .unwrap();
        }
    }
    let click_row = |cx: &mut HeadlessAppContext, id: u64| {
        cx.update_window(h, |_, w, cx| {
            let row = v.read(cx).transcript.read(cx).history_probe_row(id);
            let p = row.read(cx).bounds().origin + gpui_kit::point(px(12.), px(10.));
            w.pointer_down(p, MouseButton::Left, cx);
            w.pointer_up(p, MouseButton::Left, cx);
        })
        .unwrap();
        settle(cx, h);
    };
    let take = || std::mem::take(&mut *opened.lock().unwrap());
    // An ordinary Markdown link used to fall into the chat route and only show an error.
    click_row(cx, 920);
    assert_eq!(take(), ["https://example.com/docs?q=1#a"]);
    cx.update(|cx| assert_eq!(v.read(cx).nav_error, None));
    // Service links render the mark and Swift's title (unit-tested), copy the written
    // text and open the exact URL.
    for (id, url, written) in [
        (
            921,
            "https://github.com/acme/api/pull/412",
            "https://github.com/acme/api/pull/412",
        ),
        (922, "https://linear.app/acme/issue/ENG-3", "the ticket"),
        (
            923,
            "https://acme.slack.com/archives/C1/p1111111111111111",
            "https://acme.slack.com/archives/C1/p1111111111111111",
        ),
    ] {
        let badge = SharedString::from(format!("service-link-{id}-0"));
        cx.update_window(h, |_, w, cx| {
            let b = w.find(badge.clone()).bounds();
            assert!(
                b.size.width > px(40.) && b.size.height > px(10.),
                "{id}: {b:?}"
            );
            let row = v.read(cx).transcript.read(cx).history_probe_row(id);
            row.update(cx, |s, cx| s.select_all(cx));
            assert_eq!(
                row.read(cx).selected_text().trim_end(),
                written,
                "{id}: copy text"
            );
            row.update(cx, |s, cx| s.clear_selection(cx));
        })
        .unwrap();
        settle(cx, h);
        cx.update_window(h, |_, w, cx| w.click(badge.clone(), cx))
            .unwrap();
        settle(cx, h);
        assert_eq!(take(), [url], "{id}");
    }
    // A lookalike host is an ordinary link: no badge, but it still opens as written.
    cx.update_window(h, |_, w, _| {
        assert!(
            w.try_find(SharedString::from("service-link-924-0"))
                .is_none()
        )
    })
    .unwrap();
    click_row(cx, 924);
    assert_eq!(take(), ["https://github.com.evil.io/acme/api/pull/1"]);
    for id in [925, 926] {
        click_row(cx, id);
        assert!(take().is_empty(), "{id} must not open");
        cx.update(|cx| assert_eq!(v.read(cx).nav_error, Some(crate::external_links::REFUSED)));
    }
    // Internal chat links still navigate in the app, never through the opener.
    while commands.try_recv().is_ok() {}
    click_row(cx, 927);
    assert!(take().is_empty());
    cx.update(|cx| assert_eq!(v.read(cx).selected.as_deref(), Some("exact-ID")));
    assert!(matches!(commands.try_recv(), Ok(Command::Open { id, .. }) if id == "exact-ID"));
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    cx.update(|cx| cx.remove_global::<crate::external_links::Opener>());
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
