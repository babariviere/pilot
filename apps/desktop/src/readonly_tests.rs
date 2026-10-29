use super::*;
use gpui_kit::{
    Bounds, ScrollDelta, TestAppContext, WindowBounds, WindowOptions, base::TextSelection, point,
    px, size, test::TestWindowExt,
};
#[gpui_kit::test]
fn inline_artifact_card_skips_parser_and_emits_only_its_pinned_reference(cx: &mut TestAppContext) {
    use std::{cell::RefCell, rc::Rc};
    let reference = crate::artifact_model::Reference {
        id: "synthetic-art".into(),
        session: "owner".into(),
        revision: 3,
        title: "Synthetic publication".into(),
        kind: "unknown".into(),
    };
    let (handle, view) = setup(cx, vec![Message::artifact(42, reference.clone())]);
    assert!(view.read_with(cx, |v, _| v.text_states[0].is_none()));
    let events = Rc::new(RefCell::new(Vec::new()));
    let observed = events.clone();
    let _subscription = cx.update(|cx| {
        cx.subscribe(&view, move |_, event: &ArtifactOpen, _| {
            observed.borrow_mut().push(event.0.clone())
        })
    });
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.click(("open-artifact", 42u64), cx);
    })
    .unwrap();
    cx.run_until_parked();
    assert_eq!(&*events.borrow(), &[reference]);
}

pub(super) fn setup(
    cx: &mut TestAppContext,
    rows: Vec<Message>,
) -> (gpui_kit::AnyWindowHandle, Entity<TranscriptView>) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        TranscriptView::bind_keys(cx);
    });
    let result = cx.update(|cx| {
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
            |window, cx| {
                cx.new(|cx| {
                    let mut view = TranscriptView::readonly(window, cx);
                    view.replace_readonly(rows, true, cx);
                    view
                })
            },
        )
        .unwrap()
    });
    cx.run_until_parked();
    result
}

#[gpui_kit::test]
fn readonly_projection_keeps_selected_entity_across_prepend_delta_and_commit(
    cx: &mut TestAppContext,
) {
    let rows: Vec<_> = (20..68)
        .map(|id| Message::live(id, "assistant".into(), crate::model::REPLY.into()))
        .collect();
    let (handle, view) = setup(cx, rows.clone());
    let (selected, range, copied, query) = cx
        .update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let text = view
                .read(cx)
                .text_states
                .last()
                .unwrap()
                .as_ref()
                .unwrap()
                .clone();
            let start = text.read(cx).bounds().origin + point(px(3.), px(10.));
            window.drag(start, start + point(px(80.), px(0.)), cx);
            let range = text.read(cx).selected_source_range().unwrap();
            let query = TextSelection::selected_text(window, cx);
            window.press("secondary-c", cx);
            let copied = cx.read_from_clipboard().unwrap().text().unwrap();
            assert!(!copied.is_empty());
            window.scroll(
                "viewport",
                ScrollDelta::Pixels(point(px(0.), px(10000.))),
                cx,
            );
            (text, range, copied, query)
        })
        .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(
            selected.read(cx).selected_source_range(),
            Some(range.clone()),
            "scrolling offscreen must retain the selection before publication"
        );
        let before = view.read(cx).scroller.read(cx).logical_scroll_top();
        let anchor = view.read(cx).transcript.messages()[before.item_ix].id();
        let mut next: Vec<_> = (8..20)
            .map(|id| Message::live(id, "assistant".into(), crate::model::REPLY.into()))
            .collect();
        next.extend(rows.clone());
        if let Some(row) = next.last_mut() {
            *row = Message::live(
                row.id(),
                "assistant · committed".into(),
                format!("{}\n\nMore streamed words.", row.source()),
            )
        }
        view.update(cx, |view, cx| view.replace_readonly(next, false, cx));
        assert_eq!(
            selected.read(cx).selected_source_range(),
            Some(range.clone()),
            "publishing a prefix extension must retain the selection before layout"
        );
        window.render_frame(cx);
        assert_eq!(
            view.read(cx).text_states.last().unwrap().as_ref().unwrap(),
            &selected
        );
        assert_eq!(
            selected.read(cx).selected_source_range(),
            Some(range.clone())
        );
        assert!(!view.read(cx).scroller.read(cx).is_following_tail());
        let after = view.read(cx).scroller.read(cx).logical_scroll_top();
        assert_eq!(
            view.read(cx).transcript.messages()[after.item_ix].id(),
            anchor
        );
        window.press("secondary-c", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), copied);
        window.scroll(
            "viewport",
            ScrollDelta::Pixels(point(px(0.), px(-10000.))),
            cx,
        );
        window.render_frame(cx);
        assert_eq!(TextSelection::selected_text(window, cx), query);
        window.press("secondary-c", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), copied);
        // A different chat with reused entry numbers must never inherit selection or its entities.
        view.update(cx, |view, cx| view.replace_readonly(rows, true, cx));
        assert_ne!(
            view.read(cx).text_states.last().unwrap().as_ref().unwrap(),
            &selected
        );
        assert!(
            view.read(cx)
                .text_states
                .last()
                .unwrap()
                .as_ref()
                .unwrap()
                .read(cx)
                .selected_source_range()
                .is_none()
        );
    })
    .unwrap();
}

#[gpui_kit::test]
fn readonly_committed_label_keeps_unicode_selection_through_layout_and_parse(
    cx: &mut TestAppContext,
) {
    let key = crate::model::ReaderKey::model(20, 0, Some(0));
    let source = "日本語 e\u{301} 👨‍👩‍👧 🇫🇷 reply";
    let row = |label: &str, source: &str| {
        Message::live(20, label.into(), source.into()).anchored(key.clone())
    };
    let (handle, view) = setup(cx, vec![row("assistant", source)]);
    let (selected, range, copied) = cx
        .update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let text = view.read(cx).text_states[0].as_ref().unwrap().clone();
            let start = text.read(cx).bounds().origin + point(px(1.), px(10.));
            window.drag(start, start + point(px(210.), px(0.)), cx);
            let range = text.read(cx).selected_source_range().unwrap();
            window.press("secondary-c", cx);
            let copied = cx.read_from_clipboard().unwrap().text().unwrap();
            assert!(
                copied.contains("日本語") && copied.contains("e\u{301}"),
                "{copied:?}"
            );
            (text, range, copied)
        })
        .unwrap();
    // Label-only publication moves the same parser without changing its source.
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |v, cx| {
            v.replace_readonly(vec![row("assistant · committed", source)], false, cx)
        });
        window.render_frame(cx);
        assert_eq!(view.read(cx).text_states[0].as_ref(), Some(&selected));
        assert_eq!(
            selected.read(cx).selected_source_range(),
            Some(range.clone())
        );
        window.press("secondary-c", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), copied);
    })
    .unwrap();
    let extended = format!("{source}\n\nMore streamed words.");
    cx.update(|cx| {
        view.update(cx, |v, cx| {
            v.replace_readonly(vec![row("assistant · committed", &extended)], false, cx)
        });
    });
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(selected.read(cx).rendered_text().source(), extended);
        assert_eq!(selected.read(cx).selected_source_range(), Some(range));
        window.press("secondary-c", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), copied);
        // A new canonical reader must not inherit the old reader's selection.
        view.update(cx, |v, cx| {
            v.replace_readonly(
                vec![
                    Message::live(20, "assistant".into(), source.into())
                        .anchored(crate::model::ReaderKey::model(21, 0, Some(0))),
                ],
                false,
                cx,
            )
        });
        let fresh = view.read(cx).text_states[0].as_ref().unwrap();
        assert_ne!(fresh, &selected);
        assert!(fresh.read(cx).selected_source_range().is_none());
    })
    .unwrap();
}

/// Parser extensions must not turn an append into a full replacement when
/// their first matching syntax arrives after a selection was made.
fn streaming_extension_keeps_selection(cx: &mut TestAppContext, chunks: &[&str]) {
    let key = crate::model::ReaderKey::model(20, 0, Some(0));
    let mut source = "## 日本語 e\u{301} 👨‍👩‍👧 repeat\n\nrepeat repeat".to_string();
    let row =
        |source: &str| Message::live(20, "assistant".into(), source.into()).anchored(key.clone());
    let (handle, view) = setup(cx, vec![row(&source)]);
    let (selected, range, copied, query) = cx
        .update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let text = view.read(cx).text_states[0].as_ref().unwrap().clone();
            let start = text.read(cx).bounds().origin + point(px(1.), px(10.));
            window.drag(start, start + point(px(210.), px(0.)), cx);
            let range = text.read(cx).selected_source_range().unwrap();
            assert!(range.start >= 3, "heading marker is not selected");
            assert!(source.is_char_boundary(range.start) && source.is_char_boundary(range.end));
            let query = TextSelection::selected_text(window, cx);
            window.press("secondary-c", cx);
            let copied = cx.read_from_clipboard().unwrap().text().unwrap();
            assert!(
                copied.contains("日本語") && copied.contains("e\u{301}"),
                "{copied:?}"
            );
            (text, range, copied, query)
        })
        .unwrap();
    for chunk in chunks {
        source.push_str(chunk);
        cx.update(|cx| {
            view.update(cx, |v, cx| {
                v.replace_readonly(vec![row(&source)], false, cx)
            });
        });
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(view.read(cx).text_states[0].as_ref(), Some(&selected));
            assert_eq!(view.read(cx).rows()[0].reader_key(), Some(key.clone()));
            assert_eq!(selected.read(cx).rendered_text().source(), source);
            assert_eq!(
                selected.read(cx).selected_source_range(),
                Some(range.clone()),
                "selection survives streamed syntax: {chunk:?}"
            );
            assert_eq!(TextSelection::selected_text(window, cx), query);
            window.press("secondary-c", cx);
            assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), copied);
        })
        .unwrap();
    }
}

#[gpui_kit::test]
fn streaming_fences_keep_unicode_source_selection_and_copy(cx: &mut TestAppContext) {
    streaming_extension_keeps_selection(
        cx,
        &[
            "\n\n```rust\nlet local = 1;\n",
            "```\n",
            "\n~~~mermaid\ngraph TD\nA --> B\n",
            "~~~\n",
        ],
    );
}

#[gpui_kit::test]
fn streaming_service_links_keep_unicode_source_selection_and_copy(cx: &mut TestAppContext) {
    streaming_extension_keeps_selection(
        cx,
        &[
            "\n\n[repeat](https://github.com",
            "/acme/repo/pull/1)",
            "\n\n[repeat](https://linear.app/acme/issue/ABC-1)",
            "\n\n[repeat](https://app.slack.com/archives/C1/p123)",
        ],
    );
}

#[gpui_kit::test]
fn readonly_cannot_submit_and_images_never_reach_the_http_client(cx: &mut TestAppContext) {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    cx.update(|cx| {
        cx.set_http_client(gpui_kit::http_client::FakeHttpClient::create(move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
            async {
                Ok(gpui_kit::http_client::Response::builder()
                    .status(404)
                    .body(Default::default())
                    .unwrap())
            }
        }))
    });
    let (handle,view)=setup(cx,vec![Message::live(1,"assistant".into(),"![blocked](https://example.invalid/pixel.png)\n\n[blocked link](https://example.invalid)".into())]);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.composer.update(cx, |state, cx| {
                state.set_value("must not submit", window, cx)
            });
            view.submit(window, cx);
            view.demo(cx);
            view.prepend(cx);
            assert_eq!(view.transcript.messages().len(), 1);
            assert!(!view.transcript.is_streaming());
        });
        window.press("secondary-l", cx);
        window.press("enter", cx);
        crate::transcript_view::click_copy(window, 1, cx);
        assert!(
            cx.read_from_clipboard()
                .unwrap()
                .text()
                .unwrap()
                .starts_with("![blocked]")
        );
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| window.render_frame(cx))
        .unwrap();
    assert_eq!(requests.load(Ordering::SeqCst), 0);
}

#[gpui_kit::test]
fn message_footer_sits_below_body_with_sent_time_and_exact_copy(cx: &mut TestAppContext) {
    let sent = 1_793_178_307_250;
    let user = "Unicode e\u{301} 👩‍💻 日本 🇫🇷 exact\r\n".repeat(3);
    let rows = vec![
        Message::live(1, "You · entry 1".into(), user.clone()).with_sent(Some(sent)),
        Message::live(
            2,
            "assistant · entry 2".into(),
            "## Reply\n\nBody 👋".into(),
        )
        .with_sent(Some(sent + 1_000)),
        Message::live(3, "assistant · entry 3".into(), "No sent time".into()),
    ];
    let (handle, view) = setup(cx, rows);
    let reply = cx
        .update_window(handle, |_, w, cx| {
            w.render_frame(cx);
            let v = view.read(cx);
            let text = |ix: usize| v.text_states[ix].as_ref().unwrap().read(cx).bounds();
            let row = |id: u64| w.find(("message-actions", id)).bounds();
            let copy = |id: u64| w.find(("copy-source", id)).bounds();
            let time = |id: u64| w.find(("sent-time", id));
            assert!(row(1).bottom() <= row(2).top() && row(2).bottom() <= row(3).top());
            // User: trailing time then copy, under the hugging bubble.
            assert!(copy(1).top() >= text(0).bottom());
            assert!((copy(1).right() - row(1).right()).abs() <= px(1.));
            assert!(time(1).bounds().right() <= copy(1).left());
            assert!(time(1).bounds().top() >= text(0).bottom());
            assert_eq!(
                time(1).label(),
                Some(crate::message_time::label(sent).as_str())
            );
            // Reply: leading copy then time.
            assert!(copy(2).top() >= text(1).bottom());
            assert!((copy(2).left() - text(1).left()).abs() <= px(1.));
            assert!(time(2).bounds().left() >= copy(2).right());
            assert_eq!(
                time(2).label(),
                Some(crate::message_time::label(sent + 1_000).as_str())
            );
            // Missing metadata shows no invented time, only copy.
            assert!(w.try_find(("sent-time", 3u64)).is_none());
            assert!(copy(3).top() >= text(2).bottom());
            assert!(copy(3).bottom() <= row(3).bottom());
            let reply = (
                v.text_states[1].as_ref().unwrap().entity_id(),
                time(2).bounds().size.height,
            );
            crate::transcript_view::click_copy(w, 1, cx);
            assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), user);
            reply
        })
        .unwrap();
    // A streamed extension keeps identity, time and a footer below the longer body.
    let longer = format!(
        "## Reply\n\nBody 👋\n\n{}",
        "More streamed text. ".repeat(80)
    );
    cx.update(|cx| {
        view.update(cx, |v, cx| {
            v.replace_readonly(
                vec![
                    Message::live(1, "You · entry 1".into(), user.clone()).with_sent(Some(sent)),
                    Message::live(2, "assistant · entry 2".into(), longer.clone())
                        .with_sent(Some(sent + 1_000)),
                    Message::live(3, "assistant · entry 3".into(), "No sent time".into()),
                ],
                false,
                cx,
            )
        })
    });
    cx.run_until_parked();
    cx.update_window(handle, |_, w, cx| {
        w.render_frame(cx);
        let v = view.read(cx);
        let text = v.text_states[1].as_ref().unwrap();
        assert_eq!(text.entity_id(), reply.0);
        assert!(w.find(("copy-source", 2u64)).bounds().top() >= text.read(cx).bounds().bottom());
        let time = w.find(("sent-time", 2u64));
        assert_eq!(time.bounds().size.height, reply.1);
        assert_eq!(
            time.label(),
            Some(crate::message_time::label(sent + 1_000).as_str())
        );
        crate::transcript_view::click_copy(w, 2, cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), longer);
    })
    .unwrap();
}

#[gpui_kit::test]
fn keyboard_focus_on_copy_reveals_its_sent_time(cx: &mut TestAppContext) {
    let sent = 1_793_178_307_250;
    let reply = "Reply e\u{301} 日本 👩‍💻";
    let (handle, _view) = setup(
        cx,
        vec![
            Message::live(1, "You · entry 1".into(), "Question 👋".into()).with_sent(Some(sent)),
            Message::live(2, "assistant · entry 2".into(), reply.into())
                .with_sent(Some(sent + 1_000)),
        ],
    );
    cx.update_window(handle, |_, w, cx| {
        w.activate_window();
        w.render_frame(cx);
        for id in [1u64, 2] {
            assert!(
                !w.find(("sent-time", id)).visible(),
                "time {id} quiet at rest"
            );
            assert!(
                !w.find(("copy-source", id)).visible(),
                "copy {id} quiet at rest"
            );
        }
        w.focus_next(cx);
    })
    .unwrap();
    let mut reached = false;
    for _ in 0..20 {
        reached = cx
            .update_window(handle, |_, w, cx| {
                if w.find(("copy-source", 2u64)).focused() != Some(true) {
                    w.press("tab", cx);
                }
                w.render_frame(cx);
                w.find(("copy-source", 2u64)).focused() == Some(true)
            })
            .unwrap();
        if reached {
            break;
        }
    }
    assert!(reached, "Tab reaches the reply's copy action");
    cx.update_window(handle, |_, w, cx| {
        w.render_frame(cx);
        assert!(w.find(("copy-source", 2u64)).visible());
        assert!(
            w.find(("sent-time", 2u64)).visible(),
            "keyboard focus shows the sent time beside copy"
        );
        assert!(
            !w.find(("sent-time", 1u64)).visible(),
            "other footers stay quiet"
        );
        w.press("enter", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), reply);
    })
    .unwrap();
}
