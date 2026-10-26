//! Mounted production conversation, private synthetic state, no live actions.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
    point, size, test::TestWindowExt,
};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..6 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn row(id: u64) -> Message {
    Message::live(
        id,
        "assistant".into(),
        if id == 2 {
            "Find 日本 日本 e\u{301} 👩‍💻 literal .*".into()
        } else if id == 38 {
            "Another 日本 in a distant message".into()
        } else {
            format!(
                "Loaded message {id}.\n\n{}",
                "Synthetic retained conversation. ".repeat(12)
            )
        },
    )
    .anchored(crate::model::ReaderKey::model(id, 0, Some(0)))
}
pub fn run_transcript_find_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_FIND_DIR").map(std::path::PathBuf::from);
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
            let (client, _read_commands) = LocalClient::synthetic_commands();
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
                                    t.replace_readonly((1..=40).map(row).collect(), true, cx)
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
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, "Retained composer draft", w, cx);
                    i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx);
                });
                w.press("secondary-f", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("transcript-find").is_none(),
                    "Composer preedit wins"
                );
                input.update(cx, |i, cx| {
                    let m = i.marked_text_range(w, cx).unwrap();
                    i.replace_text_in_range(Some(m), "", w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            let draft = cx.update(|cx| input.read(cx).value().to_string());
            // Keep a real native selection while navigating a different row.
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.restore_reading(
                        crate::navigation::ReadingMark {
                            message: Some(crate::model::ReaderKey::model(6, 0, Some(0))),
                            offset: 0.,
                            following: false,
                        },
                        cx,
                    );
                })
            });
            settle(cx, h);
            let (selected, selection) = cx
                .update_window(h, |_, w, cx| {
                    let text = t.read(cx).history_probe_row(6);
                    let b = text.read(cx).bounds();
                    let vp = w.find("viewport").bounds();
                    let from = point(b.left() + px(2.), b.top().max(vp.top()) + px(8.));
                    w.drag(from, from + point(px(140.), px(0.)), cx);
                    let range = text
                        .read(cx)
                        .selected_source_range()
                        .expect("mounted selection");
                    (text, range)
                })
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.press("secondary-f", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("transcript-find-query").focused(), Some(true));
                assert!(w.try_find(("find-target", 2u64)).is_none());
                cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("日本".into()));
                w.press("secondary-v", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("find-status").label(), Some("1 of 3"));
                let target = w.find(("find-target", 2u64));
                assert!(target.visible());
                let vp = w.find("viewport").bounds();
                assert!(vp.intersects(&target.bounds()));
                assert_eq!(
                    selected.read(cx).selected_source_range(),
                    Some(selection.clone())
                );
                assert!(!t.read(cx).reading_mark(cx).unwrap().following);
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("find-status").label(), Some("2 of 3"));
                assert!(w.find(("find-target", 2u64)).visible());
                w.click("find-next", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find("find-status").label(), Some("3 of 3"));
                assert!(w.find(("find-target", 38u64)).visible());
            })
            .unwrap();
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!(
                        "find-{width}-{}.png",
                        if dark { "dark" } else { "light" }
                    )))
                    .unwrap();
            }
            let before = cx.update(|cx| t.read(cx).reading_mark(cx).unwrap());
            // Prepend plus uncommitted streaming publication must not jump or count
            // a live-only row, nor turn following on. IDs, not row indexes, survive.
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    let mut rows = vec![row(0)];
                    rows.extend((1..=40).map(row));
                    rows.push(Message::live(
                        80,
                        "Assistant · streaming".into(),
                        "日本".into(),
                    ));
                    t.replace_readonly(rows, false, cx);
                })
            });
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("find-status").label(), Some("3 of 3"));
                assert_eq!(t.read(cx).reading_mark(cx).unwrap().message, before.message);
                assert!(!t.read(cx).reading_mark(cx).unwrap().following);
                w.click("transcript-find-query", cx);
                w.press("shift-enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("find-status").label(), Some("2 of 3"));
                w.press("secondary-a", cx);
                cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("👩‍💻".into()));
                w.press("secondary-v", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("find-status").label(), Some("1 of 1"));
                w.press("secondary-a", cx);
                w.press("backspace", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("find-status").label(), Some(""));
                assert!(w.try_find(("find-target", 2u64)).is_none());
                w.input("not-loaded", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("find-status").label(), Some("No matches"));
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("transcript-find").is_none());
                assert!(t.read(cx).find_focused(w, cx));
                assert!(!t.read(cx).reading_mark(cx).unwrap().following);
                w.press("secondary-f", cx);
            })
            .unwrap();
            settle(cx, h);
            let query = cx.update(|cx| t.read(cx).find_probe_input());
            cx.update_window(h, |_, w, cx| {
                query.update(cx, |i, cx| {
                    i.replace_and_mark_text_in_range(None, "日本", Some(2..2), w, cx)
                });
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("transcript-find").is_some(),
                    "Reopened before composition keys"
                );
                assert!(
                    query.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()),
                    "Marked before Enter"
                );
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    query.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()),
                    "Enter must preserve preedit"
                );
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("transcript-find").visible());
                assert!(query.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()));
                query.update(cx, |i, cx| i.replace_text_in_range(None, "日本", w, cx));
            })
            .unwrap();
            settle(cx, h);
            // A replacement while a scan is pending invalidates the old result and
            // unmounts the query only after mounted fallback focus is restored.
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.history_scope(999);
                    t.replace_readonly(vec![row(100)], true, cx);
                })
            });
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("transcript-find").is_none());
                assert_eq!(input.read(cx).value().to_string(), draft);
                assert!(t.read(cx).find_focused(w, cx));
            })
            .unwrap();
            // Actual chat-row navigation also retires the query. The previous
            // draft remains attached to its chat, not copied into the new chat.
            cx.update_window(h, |_, w, cx| w.press("secondary-f", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("chat-row-synthetic-two", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("transcript-find").is_none())
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.click("chat-row-synthetic", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| i.focus(w, cx));
                assert_eq!(input.read(cx).value().to_string(), draft);
                t.update(cx, |t, cx| {
                    t.replace_readonly(
                        vec![
                            Message::live(200, "You".into(), "a".repeat(1002))
                                .anchored(crate::model::ReaderKey::model(200, 0, None)),
                        ],
                        false,
                        cx,
                    )
                });
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.press("secondary-f", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.input("a", cx)).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("find-status").label(), Some("1 of 1000+ (limit)"));
                w.click("find-close", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(writes.try_recv().is_err(), "No send/submit bleed");
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
    println!(
        "transcript_find: mounted 680/1100 light/dark query, offscreen/repeated/Unicode navigation, prepend/stream, clear/no-match, close/switch/focus, selection/preedit and unchanged composer passed"
    );
}
