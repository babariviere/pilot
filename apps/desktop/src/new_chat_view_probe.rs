//! Production LocalViewer new-chat surface, isolated recorder, no live clients.
use super::*;
use gpui_kit::{
    Bounds, EntityInputHandler, HeadlessAppContext, WindowBounds, WindowOptions, size,
    test::TestWindowExt,
};
use serde_json::json;

fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..4 {
        cx.advance_clock(Duration::from_millis(16));
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
pub fn run_new_chat_view_probe(cx: &mut HeadlessAppContext) {
    super::draft_discard_probe::run(cx);
    let captures = std::env::var_os("PILOT_NEXT_NEW_CHAT_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for dark in [false, true] {
            let models =
                crate::chat_models_fixture::Server::start(crate::chat_models_fixture::Mode::Accept);
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
            let (writer, writes) = Interaction::recording();
            let (client, reads) = LocalClient::synthetic_commands();
            let (h, view) = cx
                .update(|cx| {
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
                                v.editor
                                    .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                                v.state.projects_loaded = true;
                                v.state.projects = Arc::new(crate::local_model::projects(&json!([
                    {"id":"atlas","name":"Atlas","path":"/synthetic/atlas"},
                    {"id":"notes","name":"Notes 日本語","path":"/synthetic/notes"}
                ])).unwrap());
                                v.rebuild_nav(w, cx);
                                v.new_chat(w, cx);
                                v.editor.update(cx, |e, cx| {
                                    e.enable_models(models.options.clone(), w, cx)
                                });
                                v
                            })
                        },
                    )
                })
                .unwrap();
            settle(cx, h);
            assert!(matches!(reads.try_recv().unwrap(), Command::Clear { .. }));
            assert!(reads.try_recv().is_err());
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!(
                        "{}-{}.png",
                        width as u32,
                        if dark { "dark" } else { "light" }
                    )))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("local-send").disabled(), Some(true));
                assert!(
                    view.read(cx)
                        .editor
                        .read(cx)
                        .shell_probe()
                        .2
                        .unwrap()
                        .project_id
                        .is_none()
                );
            })
            .unwrap();
            let editor = cx.update(|cx| view.read(cx).editor.clone());
            let key = cx.update(|cx| editor.read(cx).navigation_key().unwrap().to_owned());
            cx.update_window(h, |_, w, cx| {
                w.hover(gpui_kit::SharedString::from(format!("chat-row-{key}")), cx);
                w.render_frame(cx);
                assert_ne!(
                    w.find(gpui_kit::SharedString::from(format!("chat-menu-{key}")))
                        .disabled(),
                    Some(true),
                    "local unsent draft actions must be available"
                );
            })
            .unwrap();
            let painted = cx.capture_screenshot(h).unwrap();
            let scale = painted.width() as f32 / width;
            let (input, controls, card, tray_color) = cx
                .update_window(h, |_, w, cx| {
                    let rgba = |color: gpui_kit::Hsla| {
                        let color: gpui_kit::Rgba = color.into();
                        [color.r, color.g, color.b, color.a].map(|c| (c * 255.).round() as u8)
                    };
                    (
                        w.find("composer-input").bounds(),
                        w.find("composer-controls").bounds(),
                        rgba(crate::appearance::card(cx)),
                        rgba(crate::appearance::tray(cx)),
                    )
                })
                .unwrap();
            let sample = |b: gpui_kit::Bounds<gpui_kit::Pixels>| {
                painted
                    .get_pixel(
                        ((f32::from(b.left()) + 16.) * scale) as u32,
                        ((f32::from(b.top()) + 2.) * scale) as u32,
                    )
                    .0
            };
            assert_eq!(sample(input), card);
            assert_eq!(sample(controls), tray_color);
            assert_ne!(card, tray_color);
            cx.update_window(h, |_, w, _cx| {
                let page = w.find("new-chat-page").bounds();
                let tray = w.find("composer-tray").bounds();
                let input = w.find("composer-input").bounds();
                let setup = w.find("new-chat-setup").bounds();
                assert_eq!(tray.size.height, px(76.));
                assert_eq!(input.size.height, px(34.));
                assert_eq!(setup.left(), tray.left());
                assert_eq!(setup.right(), tray.right());
                assert!(setup.top() > page.top() && tray.bottom() < page.bottom());
                assert!(
                    (setup.top() - page.top() - (page.bottom() - tray.bottom())).abs() < px(12.)
                );
                assert!(w.try_find("view-details").is_none());
                assert!(w.try_find("make-mission").is_none());
                assert!(w.try_find("composer-recovery-region").is_none());
                assert!(
                    w.try_find("context-usage").is_none(),
                    "new drafts have no reported context"
                );
            })
            .unwrap();
            let catalog = cx.update(|cx| view.read(cx).state.projects.clone());
            for (loaded, error, empty) in [
                (false, None, false),
                (true, Some("Synthetic catalog unavailable"), false),
                (true, None, true),
            ] {
                cx.update_window(h, |_, w, cx| {
                    editor.update(cx, |e, cx| {
                        e.projects(
                            if empty {
                                Arc::default()
                            } else {
                                catalog.clone()
                            },
                            loaded,
                            error,
                            w,
                            cx,
                        )
                    })
                })
                .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(w.find("new-chat-project").disabled(), Some(true));
                    assert_eq!(w.find("local-send").disabled(), Some(true));
                    w.click("local-send", cx);
                })
                .unwrap();
                settle(cx, h);
                assert!(writes.try_recv().is_err());
            }
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.projects(catalog, true, None, w, cx))
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("new-chat-project", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.input("atlas", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let choice = w.find("new-project-atlas").bounds();
                assert!(choice.right() <= px(width) && choice.bottom() <= px(760.));
                if dark {
                    w.press("down", cx);
                    w.press("enter", cx);
                } else {
                    w.click("new-project-atlas", cx);
                }
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    editor
                        .read(cx)
                        .shell_probe()
                        .2
                        .unwrap()
                        .project_id
                        .as_deref(),
                    Some("atlas")
                );
                editor.update(cx, |e, cx| e.focus(w, cx));
                w.input("Keep 私 👩‍💻 e\u{301}", cx);
            })
            .unwrap();
            settle(cx, h);
            let text = cx.update(|cx| editor.read(cx).shell_probe().0);
            let metadata_selection = cx.update(|cx| text.read(cx).selected_range());
            let deadline = std::time::Instant::now() + Duration::from_secs(8);
            while !cx.update(|cx| editor.read(cx).model_probe_state().0) {
                assert!(std::time::Instant::now() < deadline, "bounded faux catalog");
                settle(cx, h);
                std::thread::yield_now();
            }
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("chat-model", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.input("p/b", cx)).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("model-option-p/b", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("chat-thinking", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("model-option-high", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("new-chat-build", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(editor.read(cx).shell_probe().2.unwrap().mode, "build"));
            cx.update_window(h, |_, w, cx| {
                w.press("enter", cx); // mode activation is not a submit
            })
            .unwrap();
            settle(cx, h);
            assert!(writes.try_recv().is_err());
            assert_eq!(models.posts(), 0);
            cx.update(|cx| {
                assert_eq!(
                    text.read(cx).selected_range(),
                    metadata_selection,
                    "project/model/mode presentation never replaces native selection"
                )
            });
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.focus(w, cx));
                w.render_frame(cx);
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| {
                text.update(cx, |t, cx| {
                    t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                });
            })
            .unwrap();
            settle(cx, h);
            let focused = cx.update_window(h, |_, w, cx| w.focused(cx)).unwrap();
            cx.update_window(h, |_, w, cx| {
                w.click("new-chat-ask", cx);
                assert_eq!(w.focused(cx), focused);
                assert!(editor.update(cx, |e, cx| e.marked(w, cx)));
                assert_eq!(editor.read(cx).shell_probe().2.unwrap().mode, "build");
                text.update(cx, |t, cx| t.unmark_text(w, cx));
            })
            .unwrap();
            settle(cx, h);
            // Exact retained input and entity survive real page navigation.
            let retained = cx.update(|cx| text.read(cx).value());
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let existing = v.state.chats[0].clone();
                    assert!(v.open(existing, w, cx));
                });
            })
            .unwrap();
            settle(cx, h);
            assert!(matches!(reads.try_recv().unwrap(), Command::Open { .. }));
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("new-chat-page").is_none());
                w.click("context-usage", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("context-usage-info").is_some());
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let draft = v
                        .chats
                        .read(cx)
                        .delegate()
                        .all
                        .iter()
                        .find(|c| c.id == key)
                        .unwrap()
                        .clone();
                    v.open(draft, w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(editor.read(cx).navigation_key(), Some(key.as_str()));
                assert_eq!(
                    editor.read(cx).shell_probe().0.entity_id(),
                    text.entity_id()
                );
                assert_eq!(text.read(cx).value(), retained);
                // Existing load_input/set_value navigation resets the caret. This
                // visual task deliberately does not change that editing policy.
                assert_eq!(text.read(cx).selected_range(), 0..0);
            });
            assert!(matches!(reads.try_recv().unwrap(), Command::Clear { .. }));
            assert!(reads.try_recv().is_err());
            assert!(writes.try_recv().is_err());
            // Let the existing prior-chat activity fade finish before review paint.
            for _ in 0..6 {
                settle(cx, h);
            }
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!(
                        "{}-{}-draft.png",
                        width as u32,
                        if dark { "dark" } else { "light" }
                    )))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("composer-tray").bounds().size.height, px(76.));
                assert_ne!(w.find("local-send").disabled(), Some(true));
                w.click("local-send", cx);
            })
            .unwrap();
            settle(cx, h);
            let WriteCommand::Submit {
                key: submitted_key,
                draft,
                ..
            } = writes.try_recv().unwrap()
            else {
                panic!("one explicit submit");
            };
            assert_eq!(submitted_key, key);
            assert_eq!(draft.text, retained.as_ref());
            assert_eq!(draft.project_id.as_deref(), Some("atlas"));
            assert_eq!(draft.model_choice.as_ref().unwrap().choice.model, "p/b");
            assert_eq!(
                draft
                    .model_choice
                    .as_ref()
                    .unwrap()
                    .choice
                    .thinking
                    .as_deref(),
                Some("high")
            );
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("local-send").disabled(), Some(true));
                w.click("local-send", cx);
                let mut book = crate::delivery_store::Book::shell_probe();
                let mut pending = draft.clone();
                pending.pending = Some("original-operation".into());
                book.drafts.insert(key.clone(), *pending);
                book.pending.insert(
                    "original-operation".into(),
                    crate::delivery_store::Intent {
                        id: "original-operation".into(),
                        key: key.clone(),
                        revision: draft.revision,
                        target: String::new(),
                        operation: None,
                        state: "unknown".into(),
                        diagnostic: None,
                        answer: None,
                    },
                );
                editor.update(cx, |e, cx| {
                    e.accept(
                        crate::interaction::WriteState {
                            book: Some(Arc::new(book)),
                            handled: std::collections::BTreeMap::from([(key.clone(), u64::MAX)]),
                            error: Some("Synthetic write failure. Keep unsaved text."),
                            ..Default::default()
                        },
                        w,
                        cx,
                    )
                });
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let recovery = w.find("composer-recovery-region").bounds();
                assert!(w.try_find("chat-model-restriction").is_none());
                let tray = w.find("composer-tray").bounds();
                assert!(recovery.bottom() <= tray.top());
                assert_eq!(w.find("new-chat-project").disabled(), Some(true));
                assert_eq!(w.find("new-chat-build").disabled(), Some(true));
                assert_eq!(w.find("local-send").disabled(), Some(true));
                w.click("new-chat-ask", cx);
                w.click("local-send", cx);
                assert_eq!(
                    editor.read(cx).shell_probe().2.unwrap().pending.as_deref(),
                    Some("original-operation")
                );
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!(
                        "{}-{}-unknown.png",
                        width as u32,
                        if dark { "dark" } else { "light" }
                    )))
                    .unwrap();
            }
            assert!(writes.try_recv().is_err());
            assert_eq!(models.posts(), 0);
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        }
    }
}
