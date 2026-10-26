//! Actual offscreen production reader, synthetic sources only.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, ClipboardItem, EntityInputHandler, HeadlessAppContext, WindowBounds,
    WindowOptions, point, size, test::TestWindowExt,
};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..8 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn source() -> String {
    format!(
        "# Retained source\n\n{}\nHiddenNeedle exact tail\r\n",
        "Unicode e\u{301} 👩‍💻 日本 source content.\n".repeat(50)
    )
}
fn row(id: u64, text: String) -> Message {
    Message::live(id, "assistant".into(), text).anchored(crate::model::ReaderKey::model(
        id,
        0,
        Some(0),
    ))
}
pub fn run_message_fold_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_FOLD_DIR").map(std::path::PathBuf::from);
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
            let (writer, writes) = Interaction::recording();
            let (client, _commands) = LocalClient::synthetic_commands();
            let (h, v) = cx
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
                                v.editor
                                    .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                                v.transcript.update(cx, |t, cx| {
                                    t.fold_scope(Some(crate::session_todos::Source::new(
                                        LocalOptions::synthetic(9),
                                        "fold-chat".into(),
                                        1,
                                    )));
                                    t.replace_readonly(
                                        vec![
                                            row(1, source()),
                                            row(2, "Short second message".into()),
                                        ],
                                        true,
                                        cx,
                                    );
                                    t.restore_reading(
                                        crate::navigation::ReadingMark {
                                            message: Some(crate::model::ReaderKey::model(
                                                1,
                                                0,
                                                Some(0),
                                            )),
                                            offset: 0.,
                                            following: false,
                                        },
                                        cx,
                                    );
                                });
                                v
                            })
                        },
                    )
                })
                .unwrap();
            settle(cx, h);
            let (t, input) = cx.update(|cx| {
                (
                    v.read(cx).transcript.clone(),
                    v.read(cx).editor.read(cx).shell_probe().0,
                )
            });
            cx.update_window(h, |_, w, cx| {
                let state = t.read(cx).history_probe_row(1);
                let shown = state.read(cx).rendered_text().source().to_owned();
                assert!(
                    !shown.contains("HiddenNeedle"),
                    "collapsed parser cannot see full Markdown"
                );
                let b = w.find(("message-fold", 1u64)).bounds();
                assert!(b.size.width > px(40.) && b.right() <= w.find("viewport").bounds().right());
                w.click(("copy-source", 1u64), cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), source());
            })
            .unwrap();
            settle(cx, h);
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!("collapsed-{width}-{dark}.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.click(("message-fold", 1u64), cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    t.read(cx)
                        .history_probe_row(1)
                        .read(cx)
                        .rendered_text()
                        .source(),
                    source()
                );
                assert!(!t.read(cx).reading_mark(cx).unwrap().following);
                assert!(
                    w.focused(cx).is_some(),
                    "mounted focus before parser replacement"
                );
            })
            .unwrap();
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!("expanded-{width}-{dark}.png")))
                    .unwrap();
            }
            // A source extension plus prepend keeps explicit expansion and reader key.
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.replace_readonly(
                        vec![
                            row(0, "Earlier".into()),
                            row(1, source() + "stream update"),
                            row(2, "Short second message".into()),
                        ],
                        false,
                        cx,
                    )
                })
            });
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    t.read(cx)
                        .history_probe_row(1)
                        .read(cx)
                        .rendered_text()
                        .source()
                        .contains("HiddenNeedle")
                );
                assert_eq!(
                    t.read(cx).reading_mark(cx).unwrap().message,
                    Some(crate::model::ReaderKey::model(1, 0, Some(0)))
                );
                w.click(("message-fold", 1u64), cx);
            })
            .unwrap();
            settle(cx, h);
            // Each key dispatch is settled so the native mounted tree is current.
            for (key, expanded) in [
                ("space", true),
                ("escape", false),
                ("enter", true),
                ("escape", false),
            ] {
                cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
                settle(cx, h);
                cx.update(|cx| {
                    assert_eq!(
                        t.read(cx)
                            .history_probe_row(1)
                            .read(cx)
                            .rendered_text()
                            .source()
                            .contains("HiddenNeedle"),
                        expanded
                    )
                });
            }
            // Preview selection/copy never claims to include the hidden source.
            cx.update_window(h, |_, w, cx| {
                let text = t.read(cx).history_probe_row(1);
                let b = text.read(cx).bounds();
                let from = point(b.left() + px(3.), b.top() + px(9.));
                w.drag(from, from + point(px(140.), px(0.)), cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let text = t.read(cx).history_probe_row(1);
                assert!(!text.read(cx).selected_text().is_empty());
                w.press("secondary-c", cx);
                let selected = cx.read_from_clipboard().unwrap().text().unwrap();
                assert!(!selected.is_empty() && !selected.contains("HiddenNeedle"));
            })
            .unwrap();
            settle(cx, h);
            let preview_selection =
                cx.update(|cx| t.read(cx).history_probe_row(1).read(cx).selected_text());
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.replace_readonly(
                        vec![
                            row(0, "Earlier".into()),
                            row(1, source() + "stream update more"),
                            row(2, "Short second message".into()),
                        ],
                        false,
                        cx,
                    )
                })
            });
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(
                    t.read(cx).history_probe_row(1).read(cx).selected_text(),
                    preview_selection
                )
            });
            // Find deliberately reveals the exact source excerpt independently of folding.
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-f", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string("HiddenNeedle".into()));
                w.press("secondary-v", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find(("find-target", 1u64)).visible());
                assert!(
                    w.find(("find-target", 1u64))
                        .label()
                        .unwrap()
                        .contains("HiddenNeedle")
                );
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            // Marked sibling input blocks pointer disclosure before blur and keeps draft.
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, "draft", w, cx);
                    i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            let before = cx.update(|cx| t.read(cx).history_probe_row(1));
            cx.update_window(h, |_, w, cx| {
                w.click(("message-fold", 1u64), cx);
                assert!(input.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()));
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(before, t.read(cx).history_probe_row(1));
                assert!(input.read(cx).value().contains("draft"));
            });
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    let r = i.marked_text_range(w, cx).unwrap();
                    i.replace_text_in_range(Some(r), "", w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            // Same-chat reset with new allocation retains canonical expanded intent.
            cx.update_window(h, |_, w, cx| w.click(("message-fold", 1u64), cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.replace_readonly(
                        vec![
                            Message::live(99, "assistant".into(), source() + "stream update more")
                                .anchored(crate::model::ReaderKey::model(1, 0, Some(0))),
                        ],
                        true,
                        cx,
                    )
                })
            });
            settle(cx, h);
            cx.update(|cx| {
                assert!(
                    t.read(cx)
                        .history_probe_row(99)
                        .read(cx)
                        .rendered_text()
                        .source()
                        .contains("HiddenNeedle")
                )
            });
            // An unrelated replacement source resets only this message's default.
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.replace_readonly(
                        vec![
                            Message::live(
                                99,
                                "assistant".into(),
                                "Replacement source\n".repeat(60),
                            )
                            .anchored(crate::model::ReaderKey::model(
                                1,
                                0,
                                Some(0),
                            )),
                        ],
                        false,
                        cx,
                    )
                })
            });
            settle(cx, h);
            cx.update(|cx| {
                assert!(
                    !t.read(cx)
                        .history_probe_row(99)
                        .read(cx)
                        .rendered_text()
                        .source()
                        .contains(&"Replacement source\n".repeat(10))
                )
            });
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.fold_scope(Some(crate::session_todos::Source::new(
                        LocalOptions::synthetic(9),
                        "other-chat".into(),
                        2,
                    )));
                    t.replace_readonly(vec![row(1, source())], true, cx);
                })
            });
            settle(cx, h);
            cx.update(|cx| {
                assert!(
                    !t.read(cx)
                        .history_probe_row(1)
                        .read(cx)
                        .rendered_text()
                        .source()
                        .contains("HiddenNeedle")
                )
            });
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.replace_readonly(
                        vec![
                            Message::live(10, "You".into(), source())
                                .anchored(crate::model::ReaderKey::model(10, 0, Some(0))),
                        ],
                        true,
                        cx,
                    )
                })
            });
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.click(("copy-source", 10u64), cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), source());
                w.click(("message-fold", 10u64), cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert!(
                    t.read(cx)
                        .history_probe_row(10)
                        .read(cx)
                        .rendered_text()
                        .source()
                        .contains("HiddenNeedle")
                )
            });
            assert!(writes.try_recv().is_err(), "disclosure never sends");
            println!("message_fold native {width} dark={dark}: passed");
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        }
    }
}
