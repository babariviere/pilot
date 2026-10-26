//! Real mounted Local header/inspector, synthetic read-only text, no live actions.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds,
    WindowOptions, size, test::TestWindowExt,
};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..6 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
pub fn run_conversation_links_probe(cx: &mut HeadlessAppContext) {
    let captures =
        std::env::var_os("PILOT_NEXT_CONVERSATION_LINKS_DIR").map(std::path::PathBuf::from);
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
            let (client, commands) = LocalClient::synthetic_commands();
            let (h, view) = cx.update(|cx| gpui_kit::open_window(WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(Default::default(), size(px(width), px(840.))))), show: false, focus: false, ..Default::default()
        }, cx, |w, cx| cx.new(|cx| {
            let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
            v.client = Some(client);
            v.editor.update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
            let rows = (1..=20).map(|id| Message::live(id, "Assistant".into(), if id == 2 || id == 19 {
                "See [the guide](https://example.org/guide?q=日本語#section).".into()
            } else { format!("Synthetic loaded message {id}. No actions or live data.") }).anchored(crate::model::ReaderKey::model(id, 0, Some(0)))).collect();
            v.transcript.update(cx, |t, cx| t.replace_readonly(rows, true, cx));
            v
        }))).unwrap();
            settle(cx, h);
            let input = cx.update(|cx| view.read(cx).editor.read(cx).shell_probe().0);
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, "Retained draft 日本語", w, cx);
                    i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("conversation-links-toggle", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("conversation-links-pane").is_none());
                let marked = input
                    .update(cx, |i, cx| i.marked_text_range(w, cx))
                    .unwrap();
                input.update(cx, |i, cx| i.replace_text_in_range(Some(marked), "", w, cx));
            })
            .unwrap();
            settle(cx, h);
            let draft = cx.update(|cx| input.read(cx).value().to_string());
            let transcript = cx.update(|cx| view.read(cx).transcript.clone());
            cx.update(|cx| {
                transcript.update(cx, |t, cx| {
                    assert!(t.restore_reading(
                        crate::navigation::ReadingMark {
                            message: Some(crate::model::ReaderKey::model(6, 0, Some(0))),
                            offset: 0.,
                            following: false,
                        },
                        cx
                    ));
                })
            });
            settle(cx, h);
            let (selected, range) = cx
                .update_window(h, |_, w, cx| {
                    let selected = transcript.read(cx).history_probe_row(6);
                    let b = selected.read(cx).bounds();
                    let viewport = w.find("viewport").bounds();
                    let from =
                        gpui_kit::point(b.left() + px(2.), b.top().max(viewport.top()) + px(8.));
                    let to = gpui_kit::point(from.x + px(150.), from.y);
                    assert!(viewport.contains(&from) && viewport.contains(&to));
                    w.drag(from, to, cx);
                    let range = selected
                        .read(cx)
                        .selected_source_range()
                        .expect("fresh real reader selection");
                    (selected, range)
                })
                .unwrap();
            settle(cx, h);
            let before = cx.update(|cx| transcript.read(cx).reading_mark(cx).unwrap());
            cx.update_window(h, |_, w, cx| w.press("secondary-alt-l", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("conversation-links-pane").visible());
                let pane = w.find("conversation-links-region").bounds();
                assert!(pane.size.width >= px(300.) && pane.size.height >= px(270.));
                assert_eq!(
                    transcript.read(cx).reading_mark(cx).unwrap().message,
                    before.message
                );
                assert!(!transcript.read(cx).reading_mark(cx).unwrap().following);
                assert_eq!(
                    selected.read(cx).selected_source_range(),
                    Some(range.clone())
                );
                // Pane root -> Refresh -> Close -> explicit Copy link.
                for _ in 0..3 {
                    w.press("tab", cx);
                }
                assert_eq!(
                    w.find(("conversation-link-copy", 0usize)).focused(),
                    Some(true)
                );
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    "https://example.org/guide?q=日本語#section"
                )
            });
            // A current-generation publication must not rescan or disturb reading/selection.
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let mut next = v.state.clone();
                    next.rows = transcript.read(cx).link_snapshot_rows();
                    next.rows.push(
                        Message::live(
                            21,
                            "Assistant".into(),
                            "https://new.example.org/committed".into(),
                        )
                        .anchored(crate::model::ReaderKey::model(
                            21,
                            0,
                            Some(0),
                        )),
                    );
                    next.page_revision += 1;
                    v.accept(next, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(
                    transcript.read(cx).history_probe_row(6).entity_id(),
                    selected.entity_id()
                );
                assert_eq!(
                    selected.read(cx).selected_source_range(),
                    Some(range.clone())
                );
                assert_eq!(
                    transcript.read(cx).reading_mark(cx).unwrap().message,
                    before.message
                );
            });
            cx.update_window(h, |_, w, _| {
                assert!(
                    w.try_find(("conversation-link", 1usize)).is_none(),
                    "no automatic stream scan"
                )
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| {
                w.click(("conversation-link-sources", 0usize), cx)
            })
            .unwrap();
            settle(cx, h);
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!(
                        "links-{width}-{}.png",
                        if dark { "dark" } else { "light" }
                    )))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.click("conversation-link-source-0-1", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                let v = view.read(cx);
                assert_eq!(
                    v.transcript.read(cx).reading_mark(cx).unwrap().message,
                    Some(crate::model::ReaderKey::model(2, 0, Some(0)))
                );
                assert_eq!(input.read(cx).value().to_string(), draft);
            });
            // A reused presentation number is not the original canonical source.
            cx.update(|cx| {
                transcript.update(cx, |t, cx| {
                    let mut rows = t.link_snapshot_rows();
                    rows.retain(|r| r.id() != 2);
                    rows.push(
                        Message::live(2, "Assistant".into(), "Different canonical source".into())
                            .anchored(crate::model::ReaderKey::model(300, 0, Some(0))),
                    );
                    t.replace_readonly(rows, false, cx);
                })
            });
            settle(cx, h);
            let mark = cx.update(|cx| transcript.read(cx).reading_mark(cx).unwrap().message);
            cx.update_window(h, |_, w, cx| w.click("conversation-link-source-0-1", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(transcript.read(cx).reading_mark(cx).unwrap().message, mark));
            cx.update_window(h, |_, w, cx| w.click("conversation-links-refresh", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find(("conversation-link", 1usize)).visible());
                w.click(("conversation-link-copy", 0usize), cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    "https://new.example.org/committed"
                );
            })
            .unwrap();
            // Escape returns to a mounted composer. Reopening is an explicit new capture.
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("conversation-links-pane").is_none());
                assert!(input.focus_handle(cx).is_focused(w));
                w.click("conversation-links-toggle", cx);
            })
            .unwrap();
            settle(cx, h);
            let old = cx.update(|cx| view.read(cx).conversation_links.clone().unwrap());
            // A new loaded-window generation keeps focus mounted, but hides stale links.
            cx.update(|cx| {
                view.update(cx, |v, cx| {
                    v.generation += 1;
                    cx.notify();
                })
            });
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.find("conversation-links-pane").visible());
                assert!(w.try_find(("conversation-link-copy", 0usize)).is_none());
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.click("chat-row-synthetic-two", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("conversation-links-pane").is_none());
                // An already queued callback cannot copy after a conversation switch.
                cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("fenced".into()));
                old.update(cx, |p, cx| p.copy(0, w, cx));
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), "fenced");
                assert!(before.message.is_some());
                assert!(
                    writes.try_recv().is_err(),
                    "Inspector must never send/write"
                );
                assert!(matches!(commands.try_recv(), Ok(Command::Open { .. })));
                assert!(
                    commands.try_recv().is_err(),
                    "No link fetch/opener commands"
                );
                w.remove_window();
            })
            .unwrap();
            cx.run_until_parked();
        }
    }
    println!(
        "conversation_links: mounted copy, sources, keyboard, IME, drafts, switch fencing and light/dark layouts passed"
    );
}
