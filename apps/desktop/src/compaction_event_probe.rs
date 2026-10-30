//! Actual offscreen production reader, synthetic compaction markers only.
use super::*;
use gpui_kit::AppContext;
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions, point, size,
    test::{TestEventExt, TestWindowExt},
};
use serde_json::json;
use std::time::Duration;

const COMPACT: u64 = 128;
const RESET: u64 = 192;
const SUMMARY: &str =
    "## Goal\nShip the retry client.\n\n## Progress\n- [x] Read **worker.rs**\n- [ ] Run the tests";

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..8 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn stored(summary: &str) -> String {
    format!(
        "The conversation history before this point was compacted into the following summary:\n\n<summary>\n{summary}\n</summary>"
    )
}
fn compaction(summary: &str) -> Event {
    Event::read(&json!({
        "kind": "pi.compaction", "head": 1,
        "model": [{"role": "user", "content": [{"type": "text", "text": stored(summary)}], "timestamp": 1_800_000_000_000u64}],
        "data": {"reason": "threshold", "tokensBefore": 182_400, "tokensAfter": 31_950, "tokensEstimated": true}
    }))
    .unwrap()
}
fn rows(event: Event) -> Vec<Message> {
    vec![
        Message::live(64, "You".into(), "Add retries".into()).anchored(ReaderKey::model(
            1,
            0,
            Some(0),
        )),
        Message::compaction(COMPACT, event).anchored(ReaderKey::model(2, 0, None)),
        Message::compaction(
            RESET,
            Event::read(&json!({"kind": "pi.reset", "head": "self"})).unwrap(),
        )
        .anchored(ReaderKey::Entry {
            entry: 3,
            model: None,
            block: None,
        }),
        Message::live(256, "assistant".into(), "Continuing with the tests.".into())
            .anchored(ReaderKey::model(4, 0, Some(0))),
    ]
}
fn detail_shown(cx: &mut HeadlessAppContext, h: AnyWindowHandle) -> bool {
    cx.update_window(h, |_, w, _| {
        !w.find_all(("compaction-detail", COMPACT)).is_empty()
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

pub fn run_compaction_event_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_COMPACTION_DIR").map(std::path::PathBuf::from);
    if let Some(p) = &captures {
        std::fs::create_dir_all(p).unwrap();
    }
    let mut backgrounds = Vec::new();
    for (dark, width) in [(false, 680.), (true, 680.), (false, 1100.), (true, 1100.)] {
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
        let event = compaction(SUMMARY);
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
                t.replace_readonly(rows(event.clone()), true, cx)
            })
        });
        settle(cx, h);
        // Collapsed by default: each marker is one quiet line, rendered once,
        // never a user bubble, placeholder or work group.
        assert!(!detail_shown(cx, h), "compaction rows start collapsed");
        let toggle = cx
            .update_window(h, |_, w, _| {
                for id in [COMPACT, RESET] {
                    assert_eq!(
                        w.find_all(("compaction-sentence", id)).len(),
                        1,
                        "row {id} once"
                    );
                    assert!(w.find(("compaction-sentence", id)).visible());
                }
                // A plain reset has nothing to disclose or copy.
                assert!(w.find_all(("compaction-toggle", RESET)).is_empty());
                assert!(w.find_all(("compaction-copy", RESET)).is_empty());
                assert!(w.find(("compaction-line", RESET)).visible());
                let toggle = w.find(("compaction-toggle", COMPACT));
                assert!(toggle.visible());
                let sentence = w.find(("compaction-sentence", COMPACT)).bounds();
                assert!(
                    sentence.right() <= toggle.bounds().right(),
                    "sentence stays in its line"
                );
                assert!(toggle.bounds().right() <= px(width), "line fits the reader");
                toggle.bounds()
            })
            .unwrap();
        assert!(toggle.size.height < px(40.), "collapsed row is one line");
        let collapsed = cx.capture_screenshot(h).unwrap();
        assert!(
            region(&collapsed, toggle, width)
                .iter()
                .any(|p| *p != collapsed.get_pixel(2, 2).0),
            "the collapsed line paints its glyph and text"
        );
        backgrounds.push(collapsed.get_pixel(2, 2).0);
        if let Some(p) = &captures {
            collapsed
                .save(p.join(format!("collapsed-{dark}-{width}.png")))
                .unwrap();
        }
        // Pointer expands in place to the summary Markdown and its trigger.
        cx.update_window(h, |_, w, cx| w.click(("compaction-toggle", COMPACT), cx))
            .unwrap();
        settle(cx, h);
        assert!(detail_shown(cx, h));
        cx.update_window(h, |_, w, cx| {
            let detail = w.find(("compaction-detail", COMPACT)).bounds();
            assert!(detail.top() >= toggle.bottom(), "detail follows its line");
            assert!(detail.right() <= px(width));
            assert_eq!(w.find(("compaction-toggle", COMPACT)).bounds(), toggle);
            assert!(w.find(("compaction-reason", COMPACT)).visible());
            let text = t.read(cx).history_probe_row(COMPACT);
            assert_eq!(text.read(cx).rendered_text().source(), SUMMARY);
            // Copy is the exact stored text, revealed on hover.
            let copy = w.find(("compaction-copy", COMPACT)).bounds();
            w.pointer_move(copy.center(), None, cx);
            w.click(("compaction-copy", COMPACT), cx);
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().unwrap(),
                stored(SUMMARY)
            );
        })
        .unwrap();
        settle(cx, h);
        let expanded = cx.capture_screenshot(h).unwrap();
        if let Some(p) = &captures {
            expanded
                .save(p.join(format!("expanded-{dark}-{width}.png")))
                .unwrap();
        }
        // The summary is selectable and copies its own text.
        cx.update_window(h, |_, w, cx| {
            let b = t.read(cx).history_probe_row(COMPACT).read(cx).bounds();
            let from = point(b.left() + px(2.), b.top() + px(8.));
            w.drag(from, from + point(px(120.), px(0.)), cx);
        })
        .unwrap();
        settle(cx, h);
        cx.update_window(h, |_, w, cx| {
            let selected = t
                .read(cx)
                .history_probe_row(COMPACT)
                .read(cx)
                .selected_text();
            assert!(!selected.trim().is_empty() && SUMMARY.contains(selected.trim()));
            w.pointer_move(point(px(1.), px(1.)), None, cx);
            if w.focused(cx).is_none() {
                w.focus_next(cx);
            }
        })
        .unwrap();
        settle(cx, h);
        // History prepend and a newer row keep the choice and one row.
        let mut longer = rows(event.clone());
        longer.insert(
            0,
            Message::live(32, "assistant".into(), "Older history".into())
                .anchored(ReaderKey::model(0, 0, Some(0))),
        );
        longer.push(
            Message::live(320, "assistant".into(), "Tests pass.".into())
                .anchored(ReaderKey::model(5, 0, Some(0))),
        );
        cx.update(|cx| t.update(cx, |t, cx| t.replace_readonly(longer.clone(), false, cx)));
        settle(cx, h);
        assert!(detail_shown(cx, h), "updates keep the expanded summary");
        cx.update_window(h, |_, w, _| {
            assert_eq!(w.find_all(("compaction-sentence", COMPACT)).len(), 1)
        })
        .unwrap();
        // Keyboard: Tab reaches the disclosure; Enter and Space toggle it.
        let mut reached = false;
        for _ in 0..40 {
            reached = cx
                .update_window(h, |_, w, cx| {
                    w.press("tab", cx);
                    w.find(("compaction-toggle", COMPACT)).focused() == Some(true)
                })
                .unwrap();
            settle(cx, h);
            if reached {
                break;
            }
        }
        assert!(reached, "Tab must reach the compaction disclosure");
        for (key, shown) in [("enter", false), ("space", true), ("enter", false)] {
            cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
            settle(cx, h);
            assert_eq!(detail_shown(cx, h), shown, "{key}");
            cx.update_window(h, |_, w, _| {
                assert_eq!(
                    w.find(("compaction-toggle", COMPACT)).focused(),
                    Some(true),
                    "focus stays on the disclosure"
                )
            })
            .unwrap();
        }
        // Another chat's marker at the same entry never inherits expansion.
        cx.update(|cx| {
            t.update(cx, |t, cx| {
                t.replace_readonly(rows(event.clone()), true, cx)
            })
        });
        settle(cx, h);
        cx.update_window(h, |_, w, cx| w.click(("compaction-toggle", COMPACT), cx))
            .unwrap();
        settle(cx, h);
        assert!(detail_shown(cx, h));
        cx.update(|cx| {
            t.update(cx, |t, cx| {
                t.replace_readonly(rows(compaction("A different summary")), true, cx)
            })
        });
        settle(cx, h);
        assert!(!detail_shown(cx, h), "a different marker starts collapsed");
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        cx.run_until_parked();
        live_status(cx, dark, width, captures.as_deref());
    }
    assert_ne!(
        backgrounds[0], backgrounds[1],
        "light and dark both rendered"
    );
}

fn live_status(
    cx: &mut HeadlessAppContext,
    dark: bool,
    width: f32,
    captures: Option<&std::path::Path>,
) {
    let (h, editor) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(width), px(260.)),
                    ))),
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |w, cx| {
                    cx.new(|cx| {
                        let mut editor = crate::chat_editor::ChatEditor::new(None, w, cx);
                        editor.select("chat:synthetic".into(), false, false, w, cx);
                        editor
                    })
                },
            )
        })
        .unwrap();
    let mut model = crate::local_model::LiveTranscript::default();
    for event in [
        json!({"type":"snapshot","entries":[],"compactions":[{"taskId":1}]}),
        json!({"type":"compaction_end","taskId":1}),
        json!({"type":"compaction_start","taskId":2}),
    ] {
        model.apply(&event);
        cx.update(|cx| {
            editor.update(cx, |editor, cx| {
                editor.set_compacting(model.compacting(), cx)
            })
        });
        settle(cx, h);
        cx.update_window(h, |_, w, cx| {
            assert_eq!(
                w.find_all("activity-indicator").len(),
                usize::from(model.compacting())
            );
            assert_eq!(
                editor.read(cx).activity_label(),
                model.compacting().then_some("Compacting context…")
            );
            if model.compacting() {
                assert!(w.find("activity-indicator").visible());
                assert!(w.find("activity-indicator").bounds().right() <= px(width));
            }
            assert!(
                w.find_all("local-stop").is_empty(),
                "manual idle compaction never changes Stop admission"
            );
        })
        .unwrap();
    }
    if let Some(path) = captures {
        cx.capture_screenshot(h)
            .unwrap()
            .save(path.join(format!("live-status-{dark}-{width}.png")))
            .unwrap();
    }
    model.stale();
    cx.update(|cx| {
        editor.update(cx, |editor, cx| {
            editor.set_compacting(model.compacting(), cx)
        })
    });
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(
            w.find_all("activity-indicator").is_empty(),
            "disconnect clears live status"
        );
        w.remove_window();
    })
    .unwrap();
    cx.run_until_parked();
}
