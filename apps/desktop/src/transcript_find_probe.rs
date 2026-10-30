//! Mounted production conversation, private synthetic state, no live actions.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
    point, size,
    test::{TestEventExt, TestWindowExt},
};
#[path = "find_motion_probe.rs"]
mod motion;
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
            "Find **日本** `日本` e\u{301} 👩‍💻 literal .*".into()
        } else if id == 38 {
            "```rust\n// Another 日本 in a distant message\nlet ok = true;\n```".into()
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
    motion::run(cx);
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
            let (client, read_commands) = LocalClient::synthetic_commands();
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
                let ranges = t.read(cx).find_probe_highlights(2);
                assert_eq!(ranges.len(), 2);
                assert_ne!(ranges[0].background(), ranges[1].background());
                let text = t.read(cx).history_probe_row(2).read(cx).rendered_text();
                for range in ranges {
                    assert_eq!(&text.as_str()[range.range()], "日本");
                }
            })
            .unwrap();
            settle(cx, h);
            let first_match = cx.capture_screenshot(h).unwrap();
            let (match_bounds, match_scale) = cx
                .update_window(h, |_, w, cx| {
                    (
                        t.read(cx).history_probe_row(2).read(cx).bounds(),
                        w.scale_factor(),
                    )
                })
                .unwrap();
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find("find-status").label(), Some("2 of 3"));
                assert!(w.find(("find-target", 2u64)).visible());
            })
            .unwrap();
            let second_match = cx.capture_screenshot(h).unwrap();
            let mut changed = 0;
            for y in (f32::from(match_bounds.top()) * match_scale) as u32
                ..(f32::from(match_bounds.bottom()) * match_scale) as u32
            {
                for x in (f32::from(match_bounds.left()) * match_scale) as u32
                    ..(f32::from(match_bounds.right()) * match_scale) as u32
                {
                    changed +=
                        usize::from(first_match.get_pixel(x, y) != second_match.get_pixel(x, y));
                }
            }
            assert!(
                changed > 80,
                "Next must repaint the actual matched words, changed={changed}"
            );
            if let Some(p) = &captures {
                second_match
                    .save(p.join(format!("words-{width}-{dark}.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.click("find-next", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("find-status").label(), Some("3 of 3"));
                assert!(w.find(("find-target", 38u64)).visible());
                let ranges = t.read(cx).find_probe_highlights(38);
                assert_eq!(ranges.len(), 1);
                let text = t.read(cx).history_probe_row(38).read(cx).rendered_text();
                assert_eq!(&text.as_str()[ranges[0].range()], "日本");
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
            // A committed source append reparses Markdown. Highlight ranges
            // refresh against that parse without scrolling the held reader.
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    let mut rows = t.rows().to_vec();
                    let ix = rows.iter().position(|r| r.id() == 2).unwrap();
                    rows[ix] = Message::live(
                        2,
                        "assistant".into(),
                        format!("{}\n\nAppended **日本**", row(2).source()),
                    )
                    .anchored(crate::model::ReaderKey::model(2, 0, Some(0)));
                    t.replace_readonly(rows, false, cx);
                })
            });
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("find-status").label(), Some("4 of 4"));
                assert_eq!(t.read(cx).find_probe_highlights(2).len(), 3);
                assert_eq!(t.read(cx).reading_mark(cx).unwrap().message, before.message);
                t.update(cx, |t, cx| {
                    let mut rows = t.rows().to_vec();
                    let ix = rows.iter().position(|r| r.id() == 2).unwrap();
                    rows[ix] = row(2);
                    t.replace_readonly(rows, false, cx);
                });
            })
            .unwrap();
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
                let ranges = t.read(cx).find_probe_highlights(2);
                assert_eq!(ranges.len(), 1);
                let text = t.read(cx).history_probe_row(2).read(cx).rendered_text();
                assert_eq!(&text.as_str()[ranges[0].range()], "👩‍💻");
                w.press("secondary-a", cx);
                w.press("backspace", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("find-status").label(), Some(""));
                assert!(w.try_find(("find-target", 2u64)).is_none());
                assert!(t.read(cx).find_probe_highlights(2).is_empty());
                w.input("not-loaded", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("find-status").label(), Some("No matches"));
                assert!(t.read(cx).find_probe_highlights(2).is_empty());
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
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    w.find("find-status").label(),
                    Some("1 of 3"),
                    "Committed input-handler text refreshes Find after preedit"
                );
                assert_eq!(t.read(cx).find_probe_highlights(2).len(), 2);
            })
            .unwrap();
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
            // Literal user text uses the same range painter, not HTML mark
            // insertion. Native source mapping and exact source Copy stay intact.
            let plain = "Plain 日本 日本 <tag> **literal** e\u{301} 👩‍💻\nSecond line";
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.replace_readonly(
                        vec![
                            Message::live(201, "You".into(), plain.into())
                                .anchored(crate::model::ReaderKey::model(201, 0, None)),
                        ],
                        false,
                        cx,
                    );
                })
            });
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-f", cx);
                cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("日本".into()));
                w.press("secondary-v", cx);
            })
            .unwrap();
            settle(cx, h);
            let first_plain = cx.capture_screenshot(h).unwrap();
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("find-status").label(), Some("1 of 2"));
                let ranges = t.read(cx).find_probe_highlights(201);
                assert_eq!(ranges.len(), 2);
                let text = t.read(cx).history_probe_row(201).read(cx).rendered_text();
                assert_eq!(text.source(), plain);
                assert_eq!(text.as_str(), format!("{plain}\n"));
                for range in ranges {
                    assert_eq!(&text.as_str()[range.range()], "日本");
                }
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            let second_plain = cx.capture_screenshot(h).unwrap();
            let (b, scale) = cx
                .update_window(h, |_, w, cx| {
                    (
                        t.read(cx).history_probe_row(201).read(cx).bounds(),
                        w.scale_factor(),
                    )
                })
                .unwrap();
            let changed = ((f32::from(b.top()) * scale) as u32
                ..(f32::from(b.bottom()) * scale) as u32)
                .flat_map(|y| {
                    ((f32::from(b.left()) * scale) as u32..(f32::from(b.right()) * scale) as u32)
                        .map(move |x| (x, y))
                })
                .filter(|(x, y)| first_plain.get_pixel(*x, *y) != second_plain.get_pixel(*x, *y))
                .count();
            assert!(
                changed > 80,
                "Plain word highlight must actually paint, changed={changed}"
            );
            if let Some(p) = &captures {
                second_plain
                    .save(p.join(format!("plain-{width}-{dark}.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                let at = w.find(("copy-source", 201u64)).bounds().center();
                w.pointer_move(at, None, cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.click(("copy-source", 201u64), cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().as_deref(),
                    Some(plain)
                );
                w.click("transcript-find-query", cx);
                w.press("secondary-a", cx);
                cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("e\u{301}".into()));
                w.press("secondary-v", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("find-status").label(), Some("1 of 1"));
                let ranges = t.read(cx).find_probe_highlights(201);
                let text = t.read(cx).history_probe_row(201).read(cx).rendered_text();
                assert_eq!(&text.as_str()[ranges[0].range()], "e\u{301}");
                let b = t.read(cx).history_probe_row(201).read(cx).bounds();
                let from = b.origin + point(px(2.), px(10.));
                w.drag(from, from + point(px(90.), px(0.)), cx);
                w.press("secondary-c", cx);
            })
            .unwrap();
            settle(cx, h);
            let (plain_range, plain_copy) = cx.update(|cx| {
                (
                    t.read(cx)
                        .history_probe_row(201)
                        .read(cx)
                        .selected_source_range()
                        .unwrap(),
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                )
            });
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-f", cx);
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    t.read(cx)
                        .history_probe_row(201)
                        .read(cx)
                        .selected_source_range(),
                    Some(plain_range)
                );
                w.press("secondary-c", cx);
                // Find owns focus, so close first before copying the retained reader selection.
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(t.read(cx).find_probe_highlights(201).is_empty());
                w.press("secondary-c", cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    plain_copy
                );
            })
            .unwrap();
            while read_commands.try_recv().is_ok() {} // Previous scroll/navigation checks have their own requests.
            // Opening Find never crawls older pages. Full-history loading is explicit,
            // cancellable and retains the query entity while pages arrive.
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    v.selected = Some("paged-fixture".into());
                    v.generation = 1200;
                    v.state.generation = 1200;
                    v.state.loaded = true;
                    v.state.page_busy = false;
                    v.state.page_error = false;
                    v.earlier_attempt = None;
                    v.earlier_request = None;
                    v.state.cursor = Some(200);
                    v.state.chat_status = "Connected · Local".into();
                    v.sync_history_controls(cx);
                });
                t.update(cx, |t, cx| {
                    t.history_scope(1200);
                    t.open_find(w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            assert!(
                read_commands.try_recv().is_err(),
                "Find mount cannot fetch history"
            );
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!("partial-coverage-{width}-{dark}.png")))
                    .unwrap();
            }
            let retained_query = cx.update(|cx| t.read(cx).find_probe_input());
            cx.update_window(h, |_, w, cx| w.click("find-load-history", cx))
                .unwrap();
            settle(cx, h);
            assert!(matches!(
                read_commands.try_recv(),
                Ok(Command::Earlier {
                    before: 200,
                    generation: 1200
                })
            ));
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let mut state = v.state.clone();
                    state.rows = vec![row(2), row(38), row(201)];
                    state.cursor = None;
                    state.page_busy = false;
                    state.page_revision += 1;
                    v.accept(state, w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(
                retained_query.entity_id(),
                cx.update(|cx| t.read(cx).find_probe_input().entity_id())
            );
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("find-load-history").is_none(),
                    "full coverage removes loading action"
                );
                retained_query.update(cx, |i, cx| i.set_value("日本", w, cx));
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find("find-status").label(), Some("1 of 3"))
            })
            .unwrap();
            assert!(
                read_commands.try_recv().is_err(),
                "exhausted history never fetches again"
            );
            assert!(writes.try_recv().is_err(), "No send/submit bleed");
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
    println!(
        "transcript_find: mounted 680/1100 light/dark query, offscreen/repeated/Unicode navigation, prepend/stream, clear/no-match, close/switch/focus, selection/preedit and unchanged composer passed"
    );
}
