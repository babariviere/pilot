//! Hidden production composer geometry. No Local actions or visible windows.
//! Timings are CPU-side offscreen draws, not GPU presentation/FPS.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds,
    WindowOptions, point, size, test::TestWindowExt,
};
use serde_json::json;
use std::time::Instant;

fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle, ms: u64) -> f64 {
    cx.advance_clock(Duration::from_millis(ms));
    cx.update_window(h, |_, w, cx| w.simulate_next_frame(cx))
        .unwrap();
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| {
        let started = Instant::now();
        w.draw(cx).clear(cx);
        started.elapsed().as_secs_f64() * 1000.
    })
    .unwrap()
}
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..18 {
        frame(cx, h, 16);
    }
}
fn extent(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) -> f32 {
    cx.update_window(h, |_, w, _| {
        w.try_find(id)
            .map_or(0., |e| f32::from(e.bounds().size.height))
    })
    .unwrap()
}
fn input_state(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    input: &Entity<gpui_kit::component::input::TextareaState>,
) -> (
    String,
    std::ops::Range<usize>,
    Option<std::ops::Range<usize>>,
) {
    cx.update_window(h, |_, w, cx| {
        let marked = input.update(cx, |i, cx| i.marked_text_range(w, cx));
        let i = input.read(cx);
        assert!(
            input.focus_handle(cx).is_focused(w),
            "motion must not take focus"
        );
        (i.value().to_string(), i.selected_range(), marked)
    })
    .unwrap()
}
fn candidate(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    input: &Entity<gpui_kit::component::input::TextareaState>,
) -> Option<Bounds<gpui_kit::Pixels>> {
    cx.update_window(h, |_, w, cx| {
        let bounds = w.find("composer-input").bounds();
        input.update(cx, |i, cx| {
            i.marked_text_range(w, cx)
                .and_then(|range| i.bounds_for_range(range, bounds, w, cx))
        })
    })
    .unwrap()
}
fn tail(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    transcript: &Entity<crate::transcript_view::TranscriptView>,
) -> f32 {
    cx.update_window(h, |_, w, cx| {
        let t = transcript.read(cx);
        assert!(
            t.history_probe_anchor(cx).2,
            "wheel-to-bottom follow must survive each frame"
        );
        let bounds = t.history_probe_row(40).read(cx).bounds();
        let bottom = w.find("viewport").bounds().bottom();
        let footer = w.find(("message-actions", 40u64)).bounds();
        assert!(
            bounds.bottom() <= bottom + px(1.),
            "tail must remain physically visible: {bounds:?}, footer {footer:?}, bottom {bottom:?}"
        );
        f32::from(bottom - bounds.bottom())
    })
    .unwrap()
}
fn queue(cx: &mut HeadlessAppContext, view: &Entity<LocalViewer>, count: usize) {
    cx.update(|cx| view.update(cx, |v, cx| {
        let mut model = crate::local_model::LiveTranscript::default();
        model.apply(&json!({"type":"queue_update","items":(0..count).map(|i| json!({"id":42+i,"mode":"followUp","content":format!("Queued message {i}"),"guardToken":"a".repeat(64)})).collect::<Vec<_>>(),"automatic":[]}));
        v.state.user_queue = model.user_queue.clone();
        v.with_sending(model.rows(), &model.user_queue, cx);
        cx.notify();
    }));
}
fn todos(cx: &mut HeadlessAppContext, view: &Entity<LocalViewer>, present: bool) {
    cx.update(|cx| view.update(cx, |v, cx| {
        let items = if present { json!([{"id":"task-a","title":"Preserve input and following","status":"in_progress","createdAt":"2026-10-30"}]) } else { json!([]) };
        v.state.todos.apply(&json!({"type":"todos_update","items":items}));
        cx.notify();
    }));
}
fn sample(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    id: &'static str,
    frames: usize,
) -> Vec<f32> {
    (0..frames)
        .map(|_| {
            frame(cx, h, 16);
            extent(cx, h, id)
        })
        .collect()
}
fn intermediate(samples: &[f32], from: f32, to: f32) {
    assert!(
        samples
            .iter()
            .any(|h| *h > from.min(to) + 0.5 && *h < from.max(to) - 0.5),
        "must ease {from}->{to}: {samples:?}"
    );
    assert!(
        (samples.last().unwrap() - to).abs() < 0.1,
        "exact final extent {to}: {samples:?}"
    );
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: String) {
    if let Some(dir) = std::env::var_os("PILOT_NEXT_COMPOSER_MOTION_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.update_window(h, |_, w, _| w.render_to_image().unwrap())
            .unwrap()
            .save(dir.join(name))
            .unwrap();
    }
}
pub(crate) fn run(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for dark in [false, true] {
            cx.update(|cx| {
                cx.set_reduce_motion(false);
                crate::appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                );
            });
            let (writer, writes) = Interaction::recording();
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
                                v.editor
                                    .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                                let options = LocalOptions::synthetic(1);
                                v.state.todos = crate::session_todos::Feed::new(
                                    crate::session_todos::Source::new(
                                        options.clone(),
                                        v.selected.clone().unwrap(),
                                        v.generation,
                                    ),
                                );
                                v.usage_options = Some(options);
                                v.transcript.update(cx, |t, cx| {
                                    t.replace_readonly(
                                        (1..=40)
                                            .map(|id| {
                                                Message::live(
                                                    id,
                                                    "assistant".into(),
                                                    format!(
                                                        "Message {id}\n\n{}",
                                                        "Retained conversation. ".repeat(30)
                                                    ),
                                                )
                                                .anchored(crate::model::ReaderKey::model(
                                                    id,
                                                    0,
                                                    Some(0),
                                                ))
                                            })
                                            .collect(),
                                        true,
                                        cx,
                                    )
                                });
                                v
                            })
                        },
                    )
                })
                .unwrap();
            let (editor, transcript) = cx.update(|cx| {
                (
                    view.read(cx).editor.clone(),
                    view.read(cx).transcript.clone(),
                )
            });
            let input = cx.update(|cx| editor.read(cx).shell_probe().0);
            settle(cx, h);
            let small = extent(cx, h, "composer-tray");
            assert_eq!(small, 76.);
            let compact = extent(cx, h, "conversation-editor");
            cx.update_window(h, |_, w, cx| {
                w.activate_window();
                w.scroll(
                    "viewport",
                    gpui_kit::ScrollDelta::Lines(point(0., 5000.)),
                    cx,
                );
            })
            .unwrap();
            frame(cx, h, 16);
            assert!(!cx.update(|cx| transcript.read(cx).history_probe_anchor(cx).2));
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "viewport",
                    gpui_kit::ScrollDelta::Lines(point(0., -5000.)),
                    cx,
                )
            })
            .unwrap();
            // Line-wheel input exercises follow without the separate
            // wall-clock ScrollBounce used by precise pixel gestures.
            settle(cx, h);
            let tail_gap = tail(cx, h, &transcript);
            let mut still_draws = Vec::new();
            for _ in 0..12 {
                cx.update(|cx| editor.update(cx, |_, cx| cx.notify()));
                still_draws.push(frame(cx, h, 16));
            }
            let before_renders = cx.update(|cx| {
                (
                    view.read(cx).render_count,
                    transcript.read(cx).probe_render_count(),
                )
            });
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, "Line one\nLine two\nLine three", w, cx);
                })
            })
            .unwrap();
            let retained = input_state(cx, h, &input);
            let mut editor_heights = Vec::new();
            let mut draws = Vec::new();
            for index in 0..18 {
                draws.push(frame(cx, h, 16));
                editor_heights.push(extent(cx, h, "composer-tray"));
                assert_eq!(
                    input_state(cx, h, &input),
                    retained,
                    "caret/text/preedit unchanged"
                );
                let gap = tail(cx, h, &transcript);
                assert!(
                    (gap - tail_gap).abs() < 1.,
                    "frame {index}: gap {gap}, baseline {tail_gap}, heights {editor_heights:?}"
                );
                assert_eq!(
                    extent(cx, h, "composer-input"),
                    70.,
                    "full-size child does not reflow during reveal"
                );
                if index == 4 {
                    capture(cx, h, format!("{width}-{dark}-editor-intermediate.png"));
                }
            }
            intermediate(&editor_heights, small, 112.);
            capture(cx, h, format!("{width}-{dark}-editor-final.png"));
            let after_renders = cx.update(|cx| {
                (
                    view.read(cx).render_count,
                    transcript.read(cx).probe_render_count(),
                )
            });
            // Shrinking and reopening before it finishes continue from shown geometry.
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.replace_text_in_range(
                        Some(0..i.value().encode_utf16().count()),
                        "Short",
                        w,
                        cx,
                    )
                })
            })
            .unwrap();
            frame(cx, h, 0);
            frame(cx, h, 64);
            let reversing = extent(cx, h, "composer-input-slot");
            assert!(reversing > 34. && reversing < 70.);
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.replace_text_in_range(Some(0..5), "Line one\nLine two\nLine three", w, cx);
                    i.set_selected_range(0..4, cx);
                })
            })
            .unwrap();
            frame(cx, h, 0);
            assert_eq!(extent(cx, h, "composer-input-slot"), reversing);
            let selection = input_state(cx, h, &input);
            for _ in 0..18 {
                frame(cx, h, 16);
                assert_eq!(
                    input_state(cx, h, &input),
                    selection,
                    "selection survives reversal"
                );
            }
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-c", cx);
                assert_eq!(
                    cx.read_from_clipboard()
                        .and_then(|item| item.text())
                        .as_deref(),
                    Some("Line")
                );
                input.update(cx, |i, cx| {
                    let end = i.value().len();
                    i.set_selected_range(end..end, cx);
                });
            })
            .unwrap();
            assert_eq!(extent(cx, h, "composer-tray"), 112.);
            // A retained preedit, not a replacement textarea, while both trays move.
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                })
            })
            .unwrap();
            settle(cx, h);
            let preedit = input_state(cx, h, &input);
            assert!(preedit.2.is_some());
            let candidate_bounds =
                candidate(cx, h, &input).expect("retained IME candidate geometry");
            queue(cx, &view, 2);
            todos(cx, &view, true);
            let mut queues = Vec::new();
            let mut tasks = Vec::new();
            for index in 0..18 {
                draws.push(frame(cx, h, 16));
                queues.push(extent(cx, h, "composer-queue-slot"));
                tasks.push(extent(cx, h, "session-todos-slot"));
                assert_eq!(input_state(cx, h, &input), preedit);
                assert_eq!(
                    candidate(cx, h, &input),
                    Some(candidate_bounds),
                    "trays must not move the preedit/candidate anchor"
                );
                assert!((tail(cx, h, &transcript) - tail_gap).abs() < 1.);
                if index == 4 {
                    capture(cx, h, format!("{width}-{dark}-trays-intermediate.png"));
                }
            }
            let queue_full = *queues.last().unwrap();
            let task_full = *tasks.last().unwrap();
            intermediate(&queues, 0., queue_full);
            intermediate(&tasks, 0., task_full);
            capture(cx, h, format!("{width}-{dark}-trays-final.png"));
            // Row-count changes ease too. Removed rows cannot be clicked while closing.
            queue(cx, &view, 1);
            frame(cx, h, 0);
            let one_row = sample(cx, h, "composer-queue-slot", 18);
            let one_full = *one_row.last().unwrap();
            intermediate(&one_row, queue_full, one_full);
            queue(cx, &view, 0);
            todos(cx, &view, false);
            frame(cx, h, 0);
            assert_eq!(extent(cx, h, "composer-queue-slot"), one_full);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("composer-queue-row-42").is_none());
                assert!(w.try_find("session-todos-toggle").is_none());
            })
            .unwrap();
            frame(cx, h, 64);
            let closing = extent(cx, h, "composer-queue-slot");
            assert!(closing > 0. && closing < one_full);
            queue(cx, &view, 2);
            todos(cx, &view, true);
            frame(cx, h, 0);
            assert_eq!(extent(cx, h, "composer-queue-slot"), closing);
            settle(cx, h);
            assert_eq!(extent(cx, h, "composer-queue-slot"), queue_full);
            assert_eq!(input_state(cx, h, &input), preedit);
            // Resize during a new collapse cancels motion, without changing
            // the full child or the retained input's composition.
            queue(cx, &view, 1);
            frame(cx, h, 0);
            frame(cx, h, 32);
            cx.update_window(h, |_, w, cx| {
                w.resize(size(px(width + 80.), px(840.)));
                w.bounds_changed(cx);
            })
            .unwrap();
            frame(cx, h, 0);
            assert_eq!(
                extent(cx, h, "composer-queue-slot"),
                one_full,
                "resize immediately uses full target"
            );
            assert_eq!(
                cx.update_window(h, |_, w, _| f32::from(w.viewport_size().width))
                    .unwrap(),
                width + 80.
            );
            assert_eq!(input_state(cx, h, &input), preedit);
            cx.update_window(h, |_, w, cx| {
                w.resize(size(px(width), px(840.)));
                w.bounds_changed(cx);
            })
            .unwrap();
            frame(cx, h, 0);
            // Reduced motion applies final geometry in the first rendered frame.
            cx.update(|cx| cx.set_reduce_motion(true));
            queue(cx, &view, 0);
            todos(cx, &view, false);
            frame(cx, h, 0);
            assert_eq!(extent(cx, h, "composer-queue-slot"), 0.);
            assert_eq!(extent(cx, h, "session-todos-slot"), 0.);
            assert_eq!(input_state(cx, h, &input), preedit);
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.unmark_text(w, cx);
                    i.replace_text_in_range(
                        Some(0..i.value().encode_utf16().count()),
                        "Short",
                        w,
                        cx,
                    );
                })
            })
            .unwrap();
            frame(cx, h, 0);
            assert_eq!(extent(cx, h, "composer-tray"), 76.);
            assert_eq!(
                extent(cx, h, "conversation-editor"),
                compact,
                "no empty tray gap"
            );
            // Reading above the tail is not forcibly repinned during a height change.
            cx.update_window(h, |_, w, cx| {
                w.scroll("viewport", gpui_kit::ScrollDelta::Lines(point(0., 12.)), cx)
            })
            .unwrap();
            frame(cx, h, 16);
            let anchor = cx.update(|cx| transcript.read(cx).reading_mark(cx).unwrap().message);
            assert!(!cx.update(|cx| transcript.read(cx).history_probe_anchor(cx).2));
            cx.update(|cx| cx.set_reduce_motion(false));
            queue(cx, &view, 2);
            for _ in 0..18 {
                frame(cx, h, 16);
                assert!(!cx.update(|cx| transcript.read(cx).history_probe_anchor(cx).2));
                assert_eq!(
                    cx.update(|cx| transcript.read(cx).reading_mark(cx).unwrap().message),
                    anchor
                );
            }
            frame(cx, h, 16);
            let scheduled = cx
                .update_window(h, |_, w, cx| w.simulate_next_frame(cx))
                .unwrap();
            assert_eq!(scheduled, 0, "no idle frame loop");
            assert!(writes.try_recv().is_err(), "motion must never send or stop");
            let sum: f64 = draws.iter().sum();
            let max = draws.iter().copied().fold(0., f64::max);
            eprintln!(
                "composer motion width={width} dark={dark} editor={editor_heights:?} queue={queues:?} todos={tasks:?}; CPU draw mean={:.3}ms max={max:.3}ms frames={} still-editor mean={:.3}ms viewer/transcript renders={}/{}. Reversal, reduced motion, preedit, wheel-follow and reading anchor passed. Offscreen only, not visible smoothness or GPU presentation.",
                sum / draws.len() as f64,
                draws.len(),
                still_draws.iter().sum::<f64>() / still_draws.len() as f64,
                after_renders.0 - before_renders.0,
                after_renders.1 - before_renders.1
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        }
    }
    cx.update(|cx| cx.set_reduce_motion(false));
}
