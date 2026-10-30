//! Mounted production tray + composer with synthetic public snapshots only.
use super::*;
use crate::session_todos::{Feed, Source};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds,
    WindowOptions, point, size, test::TestWindowExt,
};
use serde_json::{Value, json};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..6 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
            .unwrap();
    }
}
fn todo(id: &str, status: &str, assigned: Option<&str>) -> Value {
    let mut value = json!({"id":id,"title":format!("Verify {id} safely"),"status":status,"createdAt":"2026-10-26"});
    if let Some(id) = assigned {
        value["assignedToSession"] = json!(id);
    }
    value
}
fn rows() -> Vec<Message> {
    (1..=30)
        .map(|id| {
            Message::live(
                id,
                "assistant".into(),
                format!("Reader {id}\n\n{}", "Retained conversation. ".repeat(30)),
            )
            .anchored(crate::model::ReaderKey::model(id, 0, Some(0)))
        })
        .collect()
}
fn publish(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    items: Value,
) {
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| {
            let mut state = v.state.clone();
            // The UI drains rows out of each full publication. A faux transport
            // must supply them again, just as LocalClient does on every update.
            state.rows = rows();
            state
                .todos
                .apply(&json!({"type":"todos_update","items":items}));
            v.accept(state, w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
}
// Only the 76pt tray and existing 6pt/mb_3 margins remain. Kit spacing is rem
// based, so derive it rather than assuming a 16pt rem. No hidden-child gap.
fn assert_no_tasks(w: &mut Window) {
    for id in [
        "session-todos-strip",
        "session-todos-toggle",
        "session-todos-list",
        "session-todos-unavailable",
        "session-todos-retained",
        "session-todos-coverage",
    ] {
        assert!(w.try_find(id).is_none(), "empty feed mounted {id}");
    }
    assert_eq!(
        w.find("conversation-editor").bounds().size.height,
        px(76. + 6.) + w.rem_size() * 0.75
    );
    assert_eq!(w.find("composer-tray").bounds().size.height, px(76.));
    assert_eq!(w.find("composer-input").bounds().size.height, px(34.));
}
pub fn run_session_todos_probe(cx: &mut HeadlessAppContext) {
    // Endpoint/interaction checks; composer_controls owns motion phases.
    cx.update(|cx| cx.set_reduce_motion(true));
    let captures = std::env::var_os("PILOT_NEXT_TODOS_DIR").map(std::path::PathBuf::from);
    if let Some(p) = &captures {
        std::fs::create_dir_all(p).unwrap();
    }
    for width in [680., 1100.] {
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
            let server =
                crate::chat_models_fixture::Server::start(crate::chat_models_fixture::Mode::Accept);
            let (writer, writes) = Interaction::recording();
            let (client, commands) = LocalClient::synthetic_commands();
            let (h, view) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(840.)),
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
                                v.usage_options = Some(server.options.clone());
                                let chat = crate::local_model::chat(
                                    &server.seen.lock().unwrap().session(),
                                )
                                .unwrap();
                                let other = v.state.chats[1].clone();
                                v.state.chats = Arc::new(vec![chat.clone(), other]);
                                v.selected = Some("source".into());
                                v.editor
                                    .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                                v.connect_model_controls(server.options.clone(), w, cx);
                                v.editor.update(cx, |e, cx| {
                                    e.select("chat:source".into(), true, false, w, cx);
                                    e.model_context(
                                        "source",
                                        "/synthetic/project",
                                        chat.model_configuration.clone().unwrap(),
                                        w,
                                        cx,
                                    );
                                });
                                v.state.todos = Feed::new(Source::new(
                                    v.usage_options.clone().unwrap(),
                                    "source".into(),
                                    v.generation,
                                ));
                                v.state.rows = rows();
                                v.transcript.update(cx, |t, cx| {
                                    t.replace_readonly(v.state.rows.clone(), true, cx)
                                });
                                v
                            })
                        },
                    )
                })
                .unwrap();
            settle(cx, h);
            let (editor, transcript) = cx.update(|cx| {
                (
                    view.read(cx).editor.clone(),
                    view.read(cx).transcript.clone(),
                )
            });
            let input = cx.update(|cx| editor.read(cx).shell_probe().0);
            cx.update_window(h, |_, w, cx| {
                assert_no_tasks(w);
                input.update(cx, |i, cx| i.focus(w, cx));
                w.input("Unsent 私 👩‍💻 draft", cx);
                w.scroll(
                    "viewport",
                    gpui_kit::ScrollDelta::Pixels(point(px(0.), px(100000.))),
                    cx,
                );
            })
            .unwrap();
            settle(cx, h);
            let deadline = std::time::Instant::now() + Duration::from_secs(8);
            while !cx.update(|cx| editor.read(cx).model_probe_state().0) {
                assert!(
                    std::time::Instant::now() < deadline,
                    "bounded synthetic model read"
                );
                settle(cx, h);
                std::thread::yield_now();
            }
            let controls = cx
                .update_window(h, |_, w, _| {
                    [
                        "composer-input",
                        "chat-model",
                        "chat-thinking",
                        "context-usage",
                        "local-send",
                    ]
                    .map(|id| w.find(id).bounds())
                })
                .unwrap();
            let original_anchor = cx.update(|cx| transcript.read(cx).history_probe_anchor(cx));
            assert!(!original_anchor.2, "fixture must really be reading history");
            let draft = cx.update(|cx| input.read(cx).value().to_string());
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let mut state = v.state.clone();
                    state.rows = rows();
                    state.todos.stale();
                    v.accept(state, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_no_tasks(w);
                assert!(input.focus_handle(cx).is_focused(w));
                assert_eq!(w.find("composer-tray").bounds().size.height, px(76.));
            })
            .unwrap();
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!("todos-unavailable-{width}-{dark}.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let mut state = v.state.clone();
                    state.rows = rows();
                    state.todos.stream();
                    state.todos.apply(&json!({"type":"snapshot","entries":[]}));
                    v.accept(state, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| assert_no_tasks(w)).unwrap();
            let variants = vec![
                ("zero", json!([])),
                (
                    "unknown",
                    json!([
                        todo("unknown", "mystery", None),
                        todo("cancelled", "cancelled", None),
                        todo("completed", "completed", None),
                        todo("in-progress", "in_progress", None)
                    ]),
                ),
                (
                    "closed",
                    json!([todo("closed", "closed", None), todo("done", "done", None)]),
                ),
                (
                    "active",
                    json!([
                        todo("queued", "open", None),
                        todo("active", "open", Some("source")),
                        todo("foreign", "open", Some("other-chat"))
                    ]),
                ),
                (
                    "capped",
                    json!(
                        (0..270)
                            .map(|id| {
                                let mut t = todo(
                                    &format!("task-{id}"),
                                    "open",
                                    if id == 250 { Some("source") } else { None },
                                );
                                t["title"] = json!("Long 日本 👩‍💻 task title ".repeat(20));
                                t
                            })
                            .collect::<Vec<_>>()
                    ),
                ),
            ];
            for (name, items) in variants {
                publish(cx, h, &view, items);
                cx.update_window(h, |_, w, cx| {
                    if name == "zero" {
                        assert_no_tasks(w);
                        assert!(input.focus_handle(cx).is_focused(w));
                        return;
                    }
                    assert!(w.find("session-todos-toggle").visible());
                    let current = [
                        "composer-input",
                        "chat-model",
                        "chat-thinking",
                        "context-usage",
                        "local-send",
                    ]
                    .map(|id| w.find(id).bounds());
                    // Only vertical position follows an explicit disclosure. Widths,
                    // relative input/control slots and control heights remain fixed.
                    for (before, now) in controls.iter().zip(current) {
                        assert_eq!(
                            now.size, before.size,
                            "todo updates must not resize composer/model/context/Send"
                        );
                        assert_eq!(now.left(), before.left());
                        assert_eq!(now.bottom(), before.bottom());
                    }
                    let anchor = transcript.read(cx).history_probe_anchor(cx);
                    assert_eq!(
                        anchor.0, original_anchor.0,
                        "public tasks preserve actual reader rows"
                    );
                    assert!((anchor.1 - original_anchor.1).abs() < 1.);
                    assert!(
                        transcript.read(cx).reading_mark(cx).is_some(),
                        "retained reader must not become empty"
                    );
                    assert!(
                        w.try_find("session-todos-list").is_none(),
                        "stream must not auto-open"
                    );
                    assert_eq!(w.find("composer-tray").bounds().size.height, px(76.));
                    assert_eq!(w.find("composer-input").bounds().size.height, px(34.));
                    assert!(
                        w.find("session-todos-strip").bounds().bottom()
                            <= w.find("composer-tray").bounds().top()
                    );
                    assert_eq!(input.read(cx).value().as_ref(), draft);
                    assert!(
                        input.focus_handle(cx).is_focused(w),
                        "updates never steal focus"
                    );
                    w.click("session-todos-toggle", cx);
                })
                .unwrap();
                settle(cx, h);
                if name == "zero" {
                    // Malformed data after a known empty report remains hidden,
                    // without changing that report into current data.
                    publish(cx, h, &view, json!([{}]));
                    cx.update_window(h, |_, w, _| assert_no_tasks(w)).unwrap();
                    if let Some(p) = &captures {
                        cx.capture_screenshot(h)
                            .unwrap()
                            .save(p.join(format!("todos-zero-{width}-{dark}.png")))
                            .unwrap();
                    }
                    continue;
                }
                cx.update_window(h, |_, w, _| {
                    if name != "zero" {
                        assert!(w.find("session-todos-list").bounds().size.height <= px(112.));
                    }
                    if name == "active" {
                        assert!(
                            w.find("session-todo:active").bounds().top()
                                < w.find("session-todo:foreign").bounds().top()
                        );
                    }
                    if name == "capped" {
                        assert!(w.find("session-todos-coverage").visible());
                        assert_eq!(w.find_all("session-todos-list").len(), 1);
                    }
                    let tray = w.find("composer-tray").bounds();
                    let context = w.find("context-usage").bounds();
                    assert!(w.find("chat-model").bounds().right() <= context.left());
                    let send = w.find("local-send").bounds();
                    assert_eq!(tray.size.height, px(76.));
                    assert!(context.right() <= send.left());
                    assert!(context.top() >= w.find("composer-input").bounds().bottom());
                    assert!(w.find("session-todos-strip").bounds().right() <= tray.right());
                })
                .unwrap();
                if captures.is_some() {
                    for _ in 0..2 {
                        settle(cx, h);
                    }
                }
                if let Some(p) = &captures {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(p.join(format!("todos-{name}-{width}-{dark}.png")))
                        .unwrap();
                }
                if name == "capped" {
                    let before = cx.update(|cx| transcript.read(cx).history_probe_anchor(cx));
                    let last = cx.update(|cx| {
                        SharedString::from(format!(
                            "session-todo:{}",
                            view.read(cx)
                                .state
                                .todos
                                .snapshot
                                .as_ref()
                                .unwrap()
                                .rows
                                .last()
                                .unwrap()
                                .id
                        ))
                    });
                    cx.update_window(h, |_, w, cx| {
                        w.scroll(
                            "session-todos-list",
                            gpui_kit::ScrollDelta::Pixels(point(px(0.), px(-10000.))),
                            cx,
                        )
                    })
                    .unwrap();
                    settle(cx, h);
                    cx.update_window(h, |_, w, cx| {
                        assert!(
                            w.find(last.clone()).visible(),
                            "capped list scrolls independently"
                        );
                        let after = transcript.read(cx).history_probe_anchor(cx);
                        assert_eq!(after.0, before.0);
                        assert!((after.1 - before.1).abs() < 1.);
                    })
                    .unwrap();
                }
                // Pointer activation deliberately preserves composer focus. Tab backwards
                // from that editor to the preceding disclosure, then use its native key path.
                cx.update_window(h, |_, w, cx| w.press("shift-tab", cx))
                    .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(w.find("session-todos-strip").focused(), Some(true));
                    assert!(
                        w.find("session-todos-toggle")
                            .label()
                            .unwrap()
                            .starts_with("Hide")
                    );
                    w.press("space", cx);
                })
                .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    assert!(
                        w.try_find("session-todos-list").is_none(),
                        "Space collapses disclosure"
                    );
                    assert!(
                        w.find("session-todos-toggle")
                            .label()
                            .unwrap()
                            .starts_with("Show")
                    );
                    input.update(cx, |i, cx| i.focus(w, cx));
                })
                .unwrap();
                settle(cx, h);
            }
            // Pointer siblings cannot end marked text, nor can Escape fold the strip.
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("session-todos-toggle", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("session-todos-list").is_none());
                assert!(input.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()));
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("session-todos-list").is_none());
                let marked = input.update(cx, |i, cx| i.marked_text_range(w, cx));
                if let Some(marked) = marked {
                    input.update(cx, |i, cx| i.replace_text_in_range(Some(marked), "", w, cx));
                }
                let end = input.read(cx).value().encode_utf16().count();
                input.update(cx, |i, cx| {
                    i.replace_text_in_range(Some(0..end), &draft, w, cx)
                });
            })
            .unwrap();
            settle(cx, h);
            // Malformed replacement retains rows with visible provenance, including collapsed.
            publish(cx, h, &view, json!({}));
            cx.update_window(h, |_, w, _| {
                assert!(w.find("session-todos-retained").visible())
            })
            .unwrap();
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!("todos-stale-{width}-{dark}.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let mut state = v.state.clone();
                    state.rows = rows();
                    state.todos.stream();
                    v.accept(state, w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.find("session-todos-retained").visible());
                assert!(
                    w.try_find("session-todos-list").is_none(),
                    "reconnect keeps collapsed intent"
                );
            })
            .unwrap();
            // Equal row count, status-only stream: stable draft/entity/focus/reader position.
            publish(
                cx,
                h,
                &view,
                json!([todo("active", "open", Some("source"))]),
            );
            let anchor = cx.update(|cx| transcript.read(cx).history_probe_anchor(cx));
            publish(cx, h, &view, json!([todo("active", "done", None)]));
            cx.update_window(h, |_, w, cx| {
                assert_eq!(view.read(cx).editor, editor);
                assert_eq!(input.read(cx).value().as_ref(), draft);
                assert!(input.focus_handle(cx).is_focused(w));
                let now = transcript.read(cx).history_probe_anchor(cx);
                assert_eq!(now.0, anchor.0);
                assert!((now.1 - anchor.1).abs() < 1.);
                w.click("session-todos-toggle", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_,w,cx| view.update(cx, |v,cx| {
                let mut state=v.state.clone();
                state.rows = rows();
                state.rows.push(Message::live(31,"assistant".into(),"Streaming tail remains offscreen".into()));
                state.todos.apply(&json!({"type":"todos_update","items":[todo("active","open",Some("source"))]}));
                v.accept(state,w,cx);
            })).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.find("session-todos-list").visible(),
                    "stream preserves expanded intent"
                );
                let now = transcript.read(cx).history_probe_anchor(cx);
                assert_eq!(now.0, anchor.0);
                assert!((now.1 - anchor.1).abs() < 1.);
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.press("shift-tab", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("session-todos-list").is_none())
            })
            .unwrap();
            // Authoritative empty replacement retires a keyboard-focused disclosure.
            // Keep its expanded intent for this exact source when tasks reappear.
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("session-todos-strip").focused(), Some(true));
                w.press("space", cx);
            })
            .unwrap();
            settle(cx, h);
            publish(cx, h, &view, json!([]));
            cx.update_window(h, |_, w, cx| {
                assert_no_tasks(w);
                assert!(
                    input.focus_handle(cx).is_focused(w),
                    "empty replacement restores editor focus"
                );
                assert_eq!(input.read(cx).value().as_ref(), draft);
            })
            .unwrap();
            publish(cx, h, &view, json!([todo("return", "done", None)]));
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.find("session-todos-list").visible(),
                    "empty replacement preserves disclosure intent"
                );
                assert!(
                    input.focus_handle(cx).is_focused(w),
                    "reappearing tasks do not steal focus"
                );
                w.press("shift-tab", cx);
            })
            .unwrap();
            settle(cx, h);
            // Same chat, new generation cannot display old content. Late replies are fenced.
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let late = v.state.clone();
                    v.generation += 1;
                    v.accept(late, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("session-todos-strip").is_none());
                assert!(
                    input.focus_handle(cx).is_focused(w),
                    "source loss restores mounted editor focus"
                );
                w.click("chat-row-synthetic-two", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(matches!(commands.try_recv(),Ok(Command::Open{id,..}) if id=="synthetic-two"));
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("session-todos-strip").is_none());
                assert_eq!(input.read(cx).value().as_ref(), "");
            })
            .unwrap();
            // Same-sized tasks in another source must not inherit expanded intent.
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let mut state = v.state.clone();
                    state.rows = rows();
                    // Faux transport must publish the newly admitted generation,
                    // not clone the prior chat's deliberately rejected publication.
                    state.generation = v.generation;
                    state.todos = Feed::new(Source::new(
                        v.usage_options.clone().unwrap(),
                        "synthetic-two".into(),
                        v.generation,
                    ));
                    state.todos.apply(
                        &json!({"type":"todos_update","items":[todo("other", "done", None)]}),
                    );
                    v.accept(state, w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("session-todos-toggle").visible());
                assert!(
                    w.try_find("session-todos-list").is_none(),
                    "other source starts collapsed"
                );
                w.click("chat-row-source", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(matches!(commands.try_recv(),Ok(Command::Open{id,..}) if id=="source"));
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let mut state = v.state.clone();
                    state.rows = rows();
                    // Faux transport must publish the newly admitted generation,
                    // not clone the prior chat's deliberately rejected publication.
                    state.generation = v.generation;
                    state.todos = Feed::new(Source::new(
                        v.usage_options.clone().unwrap(),
                        "source".into(),
                        v.generation,
                    ));
                    state.todos.apply(
                        &json!({"type":"todos_update","items":[todo("return", "done", None)]}),
                    );
                    v.accept(state, w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.find("session-todos-list").visible(),
                    "return restores only this source intent"
                );
                assert_eq!(input.read(cx).value().as_ref(), draft);
            })
            .unwrap();
            assert!(
                server
                    .seen
                    .lock()
                    .unwrap()
                    .requests
                    .iter()
                    .all(|(method, _, _)| method == "GET")
            );
            assert!(commands.try_recv().is_err());
            assert!(
                writes.try_recv().is_err(),
                "Disclosure never mutates or sends"
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            println!(
                "session todos {width} dark={dark}: public states, bounds, keyboard/IME, retained source, draft and reader guards passed"
            );
        }
    }
}
