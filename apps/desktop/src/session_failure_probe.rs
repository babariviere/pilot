//! Actual mounted selected-chat report. Synthetic summaries only, no live writes.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds,
    WindowOptions, size, test::TestWindowExt,
};
use serde_json::json;

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..6 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn report(
    v: &mut LocalViewer,
    value: serde_json::Value,
    w: &mut Window,
    cx: &mut Context<LocalViewer>,
) {
    let mut state = v.state.clone();
    state.rows = v.transcript.read(cx).link_snapshot_rows();
    let chat = Arc::make_mut(&mut state.chats)
        .iter_mut()
        .find(|c| c.id == "synthetic")
        .unwrap();
    chat.writable = true;
    chat.failure = crate::session_failure::read(&value);
    chat.busy = value["working"] == true;
    chat.state = value["state"].as_str().unwrap_or("idle").into();
    chat.signal = if chat.busy {
        Some(Signal::Working)
    } else if chat.failure.is_some() {
        Some(Signal::Failed)
    } else {
        None
    };
    state.page_revision += 1;
    v.accept(state, w, cx);
}
pub fn run_session_failure_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_SESSION_FAILURE_DIR").map(std::path::PathBuf::from);
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
                                v.editor
                                    .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                                v
                            })
                        },
                    )
                })
                .unwrap();
            settle(cx, h);
            let input = cx.update(|cx| view.read(cx).editor.read(cx).shell_probe().0);
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    report(v, json!({"state":"working","working":true}), w, cx)
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("session-failure").is_none());
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, "Retained draft café 日本語", w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            let healthy = cx
                .update_window(h, |_, w, _| w.find("conversation-editor").bounds())
                .unwrap();
            let transcript = cx.update(|cx| view.read(cx).transcript.clone());
            cx.update(|cx| {
                transcript.update(cx, |t, cx| {
                    let rows = (1..=30)
                        .map(|id| {
                            Message::live(
                                id,
                                "Assistant".into(),
                                format!(
                                    "Synthetic loaded message {id}. Retained history and selection."
                                ),
                            )
                            .anchored(crate::model::ReaderKey::model(
                                id,
                                0,
                                Some(0),
                            ))
                        })
                        .collect();
                    t.replace_readonly(rows, true, cx);
                    assert!(t.restore_reading(
                        crate::navigation::ReadingMark {
                            message: Some(crate::model::ReaderKey::model(12, 0, Some(0))),
                            offset: 0.,
                            following: false
                        },
                        cx
                    ));
                })
            });
            settle(cx, h);
            let (selected, range) = cx
                .update_window(h, |_, w, cx| {
                    let selected = transcript.read(cx).history_probe_row(12);
                    let b = selected.read(cx).bounds();
                    let from = gpui_kit::point(b.left() + px(2.), b.top() + px(8.));
                    let to = gpui_kit::point(from.x + px(100.), from.y);
                    assert!(w.find("viewport").bounds().contains(&from));
                    w.drag(from, to, cx);
                    let range = selected
                        .read(cx)
                        .selected_source_range()
                        .expect("fresh transcript selection");
                    (selected, range)
                })
                .unwrap();
            settle(cx, h);
            let reading = cx.update(|cx| transcript.read(cx).reading_mark(cx).unwrap());
            let reason = "Tool build: connection failed → upstream unavailable\nCaused by: réseau 日本語 👩🏽‍💻\nSecond cause: public redacted detail only";
            cx.update_window(h, |_, w, cx| view.update(cx, |v,cx| report(v,json!({"state":"parked","outcome":"failed","outcomeAt":42,"outcomeReason":reason}),w,cx))).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    transcript.read(cx).reading_mark(cx).unwrap().message,
                    reading.message
                );
                assert!(!transcript.read(cx).reading_mark(cx).unwrap().following);
                assert_eq!(
                    selected.read(cx).selected_source_range(),
                    Some(range.clone())
                );
                let banner = w.find("session-failure").bounds();
                let text = w.find("session-failure-reason").bounds();
                let pane = w.find("conversation").bounds();
                assert!(banner.size.height > px(70.) && banner.size.height < px(230.));
                assert!(
                    text.size.height > px(40.),
                    "multiline reason is directly visible"
                );
                assert!(text.left() >= pane.left() && text.right() <= pane.right());
                assert_eq!(
                    input.read(cx).value().as_ref(),
                    "Retained draft café 日本語"
                );
                input.update(cx, |i, cx| i.focus(w, cx));
                // Sibling pointer cannot commit or blur composition.
                input.update(cx, |i, cx| {
                    i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                });
                assert!(
                    input.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()),
                    "probe must install actual preedit"
                );
                cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("IME fenced".into()));
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("session-failure-copy", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    "IME fenced"
                );
                let marked = input
                    .update(cx, |i, cx| i.marked_text_range(w, cx))
                    .unwrap();
                input.update(cx, |i, cx| i.replace_text_in_range(Some(marked), "", w, cx));
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("session-failure-copy", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), reason));
            // Select real rendered report text and copy with native keyboard routing.
            cx.update_window(h, |_, w, cx| {
                let b = w.find("session-failure-reason").bounds();
                w.drag(
                    gpui_kit::point(b.left() + px(2.), b.top() + px(8.)),
                    gpui_kit::point(b.left() + px(130.), b.top() + px(8.)),
                    cx,
                );
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.press("secondary-c", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                let text = cx.read_from_clipboard().unwrap().text().unwrap();
                assert!(
                    !text.is_empty() && reason.contains(&text),
                    "native selected copy: {text:?}"
                );
                assert_ne!(text, reason);
            });
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!(
                        "failure-{width}-{}.png",
                        if dark { "dark" } else { "light" }
                    )))
                    .unwrap();
            }
            // New stream run arrives before the global idle summary catches up.
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let mut s = v.state.clone();
                    s.rows = v.transcript.read(cx).link_snapshot_rows();
                    s.failure_run_serial += 1;
                    v.accept(s, w, cx);
                    assert!(
                        v.session_failure_fence
                            .historical(v.selected_failure().unwrap())
                    );
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    report(v, json!({"state":"working","working":true}), w, cx)
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("session-failure").is_none());
                assert_eq!(
                    w.find("conversation-editor").bounds(),
                    healthy,
                    "healthy geometry unchanged"
                );
                assert!(
                    input.focus_handle(cx).is_focused(w),
                    "focus restored before failed region unmount"
                );
                view.update(cx, |v, cx| {
                    report(v, json!({"state":"failed","outcomeAt":43}), w, cx)
                });
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.click("session-failure-copy", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    crate::session_failure::MISSING
                )
            });
            cx.update_window(h, |_,w,cx| view.update(cx, |v,cx| report(v,json!({"outcome":"failed","outcomeAt":44,"outcomeReason":"Long public cause 日本語\n".repeat(2000)}),w,cx))).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("session-failure").bounds().size.height < px(260.));
                w.click("session-failure-copy", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                let t = cx.read_from_clipboard().unwrap().text().unwrap();
                assert!(t.contains("Remaining reported text omitted"));
                assert!(t.len() < 8400);
            });
            let long_top = cx
                .update_window(h, |_, w, cx| {
                    let top = w.find("session-failure-reason").bounds().top();
                    w.scroll(
                        "session-failure",
                        gpui_kit::ScrollDelta::Lines(gpui_kit::point(0., -12.)),
                        cx,
                    );
                    top
                })
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(
                    w.find("session-failure-reason").bounds().top() < long_top,
                    "long details scroll independently"
                )
            })
            .unwrap();
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!(
                        "failure-long-{width}-{}.png",
                        if dark { "dark" } else { "light" }
                    )))
                    .unwrap();
            }
            for value in [
                json!({"state":"failed","canRetryStartup":true,"error":"Session startup: public extension load failed","outcome":"failed","outcomeAt":45}),
                json!({"state":"parked","archivedAt":99,"outcome":"failed","outcomeAt":46,"outcomeReason":"Historical public reason"}),
            ] {
                cx.update_window(h, |_, w, cx| {
                    view.update(cx, |v, cx| report(v, value, w, cx))
                })
                .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, _| assert!(w.find("session-failure").visible()))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let mut next = v.state.clone();
                    next.rows = v.transcript.read(cx).link_snapshot_rows();
                    next.status = "Local identity mismatch; subscription stopped".into();
                    v.accept(next, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.find("session-failure-provenance").visible())
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.click("chat-row-synthetic-two", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("session-failure").is_none());
                view.update(cx, |v, cx| {
                    let mut late = v.state.clone();
                    late.generation = v.generation.saturating_sub(1);
                    Arc::make_mut(&mut late.chats)
                        .iter_mut()
                        .find(|c| c.id == "synthetic")
                        .unwrap()
                        .failure = crate::session_failure::read(
                        &json!({"outcome":"failed","outcomeReason":"late chat A"}),
                    );
                    v.accept(late, w, cx);
                    assert!(v.selected_failure().is_none());
                });
                assert!(
                    writes.try_recv().is_err(),
                    "no write/start/stop/repair actions"
                );
                assert!(
                    matches!(commands.try_recv(),Ok(Command::Open {id,..}) if id=="synthetic-two")
                );
                assert!(commands.try_recv().is_err());
                w.remove_window();
            })
            .unwrap();
            cx.run_until_parked();
            println!(
                "session_failure mounted {width} dark={dark}: failure, multiline selection/copy, IME, draft, missing, long, working, focus and chat-switch fences passed"
            );
        }
    }
}
