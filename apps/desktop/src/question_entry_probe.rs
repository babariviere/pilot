//! Actual offscreen production reader, synthetic question records only.
use super::*;
use crate::model::ReaderKey;
use gpui_kit::AppContext;
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions, point, size,
    test::{TestEventExt, TestWindowExt},
};
use std::time::Duration;

const QUESTION: u64 = 128;

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..8 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn record(question: &str) -> Record {
    Record::read(&serde_json::json!({
        "question": question,
        "context": "The worker retries **three** times; callers never do.",
        "options": [
            {"label": "Shared client", "detail": "Every caller retries", "suggested": true},
            {"label": "Sync worker"}
        ]
    }))
    .unwrap()
}
fn rows(question: Record) -> Vec<Message> {
    vec![
        Message::live(64, "You".into(), "Add retries".into()).anchored(ReaderKey::model(
            1,
            0,
            Some(0),
        )),
        Message::question(QUESTION, question).anchored(ReaderKey::Entry {
            entry: 2,
            model: None,
            block: None,
        }),
        Message::live(192, "You".into(), "Shared client".into()).anchored(ReaderKey::model(
            3,
            0,
            Some(0),
        )),
    ]
}
fn detail_shown(cx: &mut HeadlessAppContext, h: AnyWindowHandle) -> bool {
    cx.update_window(h, |_, w, _| {
        !w.find_all(("question-detail", QUESTION)).is_empty()
    })
    .unwrap()
}
fn region(image: &image::RgbaImage, b: Bounds<gpui_kit::Pixels>, width: f32) -> Vec<[u8; 4]> {
    let scale = image.width() as f32 / width;
    let mut pixels = Vec::new();
    for y in (f32::from(b.top()) * scale) as u32..(f32::from(b.bottom()) * scale) as u32 {
        for x in (f32::from(b.left()) * scale) as u32..(f32::from(b.right()) * scale) as u32 {
            pixels.push(image.get_pixel(x, y).0);
        }
    }
    pixels
}

pub fn run_question_entry_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_QUESTION_DIR").map(std::path::PathBuf::from);
    if let Some(p) = &captures {
        std::fs::create_dir_all(p).unwrap();
    }
    let width = 760.;
    let mut backgrounds = Vec::new();
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
        let asked = record("Where should retries live?\n\nPick one before I continue.");
        let (h, t) = cx
            .update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(600.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| cx.new(|cx| TranscriptView::readonly(w, cx)),
                )
            })
            .unwrap();
        cx.update(|cx| {
            t.update(cx, |t, cx| {
                t.replace_readonly(rows(asked.clone()), true, cx)
            })
        });
        settle(cx, h);
        // Collapsed by default: one line, no detail, no generic placeholder.
        assert!(!detail_shown(cx, h), "question rows start collapsed");
        let toggle = cx
            .update_window(h, |_, w, _| {
                let toggle = w.find(("question-toggle", QUESTION));
                assert!(toggle.visible());
                assert!(w.find(("question-preview", QUESTION)).visible());
                toggle.bounds()
            })
            .unwrap();
        assert!(toggle.size.height < px(40.), "collapsed row is one line");
        let collapsed = cx.capture_screenshot(h).unwrap();
        assert!(
            region(&collapsed, toggle, width)
                .iter()
                .any(|p| *p != collapsed.get_pixel(2, 2).0),
            "the collapsed line paints its icon and text"
        );
        backgrounds.push(collapsed.get_pixel(2, 2).0);
        if let Some(p) = &captures {
            collapsed
                .save(p.join(format!("collapsed-{dark}.png")))
                .unwrap();
        }
        // Pointer expands in place to the formatted, selectable question.
        cx.update_window(h, |_, w, cx| w.click(("question-toggle", QUESTION), cx))
            .unwrap();
        settle(cx, h);
        assert!(detail_shown(cx, h));
        cx.update_window(h, |_, w, cx| {
            let detail = w.find(("question-detail", QUESTION)).bounds();
            assert!(detail.top() >= toggle.bottom(), "detail follows its line");
            assert_eq!(w.find(("question-toggle", QUESTION)).bounds(), toggle);
            let text = t.read(cx).history_probe_row(QUESTION);
            assert_eq!(text.read(cx).rendered_text().source(), asked.source());
            // Copy is the exact formatted question, revealed on hover.
            let copy = w.find(("question-copy", QUESTION)).bounds();
            w.pointer_move(copy.center(), None, cx);
            w.click(("question-copy", QUESTION), cx);
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().unwrap(),
                asked.source()
            );
        })
        .unwrap();
        settle(cx, h);
        let expanded = cx.capture_screenshot(h).unwrap();
        if let Some(p) = &captures {
            expanded
                .save(p.join(format!("expanded-{dark}.png")))
                .unwrap();
        }
        // Expanded content is selectable and copies its own text.
        cx.update_window(h, |_, w, cx| {
            let b = t.read(cx).history_probe_row(QUESTION).read(cx).bounds();
            let from = point(b.left() + px(2.), b.top() + px(8.));
            w.drag(from, from + point(px(160.), px(0.)), cx);
        })
        .unwrap();
        settle(cx, h);
        cx.update_window(h, |_, w, cx| {
            let text = t.read(cx).history_probe_row(QUESTION);
            let selected = text.read(cx).selected_text();
            assert!(!selected.is_empty() && asked.source().contains(selected.trim()));
            w.press("secondary-c", cx);
            assert!(
                asked
                    .source()
                    .contains(cx.read_from_clipboard().unwrap().text().unwrap().trim())
            );
            w.pointer_move(point(px(1.), px(1.)), None, cx);
            if w.focused(cx).is_none() {
                w.focus_next(cx);
            }
        })
        .unwrap();
        settle(cx, h);
        // A history update (newer row, same record) keeps the choice and anchor.
        let mut longer = rows(asked.clone());
        longer.push(
            Message::live(256, "assistant".into(), "Using the shared client.".into())
                .anchored(ReaderKey::model(4, 0, Some(0))),
        );
        cx.update(|cx| t.update(cx, |t, cx| t.replace_readonly(longer.clone(), false, cx)));
        settle(cx, h);
        assert!(detail_shown(cx, h), "updates keep the expanded question");
        // Keyboard: Tab reaches the disclosure; Enter and Space toggle it.
        let mut reached = false;
        for _ in 0..40 {
            reached = cx
                .update_window(h, |_, w, cx| {
                    w.press("tab", cx);
                    w.find(("question-toggle", QUESTION)).focused() == Some(true)
                })
                .unwrap();
            settle(cx, h);
            if reached {
                break;
            }
        }
        assert!(reached, "Tab must reach the question disclosure");
        for (key, shown) in [("enter", false), ("space", true), ("enter", false)] {
            cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
            settle(cx, h);
            assert_eq!(detail_shown(cx, h), shown, "{key}");
            cx.update_window(h, |_, w, _| {
                assert_eq!(
                    w.find(("question-toggle", QUESTION)).focused(),
                    Some(true),
                    "focus stays on the disclosure"
                )
            })
            .unwrap();
        }
        // Another chat's record at the same entry never inherits expansion.
        cx.update(|cx| {
            t.update(cx, |t, cx| {
                t.replace_readonly(rows(asked.clone()), true, cx)
            })
        });
        settle(cx, h);
        cx.update_window(h, |_, w, cx| w.click(("question-toggle", QUESTION), cx))
            .unwrap();
        settle(cx, h);
        assert!(detail_shown(cx, h));
        cx.update(|cx| {
            t.update(cx, |t, cx| {
                t.replace_readonly(rows(record("A different question?")), true, cx)
            })
        });
        settle(cx, h);
        assert!(!detail_shown(cx, h), "a different record starts collapsed");
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        cx.run_until_parked();
    }
    assert_ne!(
        backgrounds[0], backgrounds[1],
        "light and dark both rendered"
    );
    answered_replies(cx, captures.as_deref());
}

fn answered_replies(cx: &mut HeadlessAppContext, captures: Option<&std::path::Path>) {
    use crate::{local_model::LiveTranscript, question_entry::fixture};
    use serde_json::json;
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
        for width in [680., 1100.] {
            for (name, answer) in [
                ("short", "Everywhere"),
                (
                    "unicode",
                    "東京 👨‍👩‍👧 e\u{301}\n\nKeep <exact> & **literal** text.\n",
                ),
            ] {
                let (h, t) = open_reader(cx, width);
                let entries = fixture::answered(answer);
                let mut model = LiveTranscript::default();
                model.apply(
                    &json!({"type":"snapshot","entries":[entries[0]],"run":{"startedAt":1}}),
                );
                cx.update(|cx| t.update(cx, |t, cx| t.replace_readonly(model.rows(), true, cx)));
                settle(cx, h);
                assert!(model.question_awaited());
                // A real disclosure choice survives the live -> answered update.
                cx.update_window(h, |_, w, cx| w.click(("question-toggle", QUESTION), cx))
                    .unwrap();
                settle(cx, h);
                for entry in &entries[1..] {
                    model.apply(&json!({"type":"entry_appended","entry":entry}));
                    let rows = model.rows();
                    assert_eq!(rows.len(), 2, "bookkeeping adds no UI rows");
                    cx.update(|cx| t.update(cx, |t, cx| t.replace_readonly(rows, false, cx)));
                    settle(cx, h);
                    assert!(detail_shown(cx, h), "answer does not reset disclosure");
                }
                // Cold history must yield the same two rows and default disclosure.
                let mut cold = LiveTranscript::default();
                cold.apply(&json!({"type":"snapshot","entries":entries}));
                assert!(model.rows() == cold.rows());
                let answer_row = cold.rows()[1].clone();
                cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                cx.run_until_parked();
                let (h, t) = open_reader(cx, width);
                cx.update(|cx| t.update(cx, |t, cx| t.replace_readonly(cold.rows(), true, cx)));
                settle(cx, h);
                assert!(!detail_shown(cx, h));
                cx.update_window(h, |_, w, _| {
                    assert!(w.find(("question-reply", 192_u64)).visible());
                })
                .unwrap();
                if let Some(path) = captures {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(path.join(format!("answered-{name}-{width}-{dark}.png")))
                        .unwrap();
                }
                cx.update_window(h, |_, w, cx| {
                    let toggle = w.find(("question-toggle", QUESTION)).bounds();
                    assert!(toggle.size.height < px(40.));
                    let text = t.read(cx).history_probe_row(192);
                    assert_eq!(text.read(cx).rendered_text().source(), answer_row.source());
                    let bounds = text.read(cx).bounds();
                    assert!(bounds.top() > toggle.bottom());
                    assert!(bounds.left() >= px(0.) && bounds.right() <= px(width));
                    assert!(
                        bounds.bottom() < px(600.),
                        "answer fits without placeholder rows"
                    );
                    crate::transcript_view::click_copy(w, 192, cx);
                    assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), answer);
                    let start = point(bounds.left() + px(2.), bounds.top() + px(8.));
                    w.drag(start, start + point(px(70.), px(0.)), cx);
                })
                .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    let text = t.read(cx).history_probe_row(192);
                    let selected = text.read(cx).selected_text();
                    assert!(!selected.is_empty() && answer.contains(selected.trim()));
                    w.press("secondary-c", cx);
                    assert!(
                        answer.contains(cx.read_from_clipboard().unwrap().text().unwrap().trim())
                    );
                    w.pointer_move(point(px(1.), px(1.)), None, cx);
                })
                .unwrap();
                settle(cx, h);
                let mut copy_focused = false;
                for _ in 0..16 {
                    copy_focused = cx
                        .update_window(h, |_, w, cx| {
                            w.press("tab", cx);
                            w.find(("copy-source", 192_u64)).focused() == Some(true)
                        })
                        .unwrap();
                    settle(cx, h);
                    if copy_focused {
                        break;
                    }
                }
                assert!(copy_focused, "Tab reaches the inline reply Copy action");
                cx.update_window(h, |_, w, cx| {
                    w.press("enter", cx);
                    assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), answer);
                })
                .unwrap();
                cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                cx.run_until_parked();
            }
        }
    }
}

fn open_reader(
    cx: &mut HeadlessAppContext,
    width: f32,
) -> (AnyWindowHandle, gpui_kit::Entity<TranscriptView>) {
    cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(width), px(600.)),
                ))),
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |w, cx| cx.new(|cx| TranscriptView::readonly(w, cx)),
        )
    })
    .unwrap()
}
