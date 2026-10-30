//! Offscreen production transcript motion. No Local transport or live actions.
use super::*;
use gpui_kit::{AnyWindowHandle, ElementId};
use std::time::Instant;

fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle, ms: u64) -> (f64, f64) {
    cx.advance_clock(Duration::from_millis(ms));
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.simulate_next_frame(cx))
        .unwrap();
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| {
        let start = Instant::now();
        w.draw(cx).clear(cx);
        let draw = start.elapsed().as_secs_f64() * 1000.;
        let start = Instant::now();
        // Actual offscreen renderer + synchronous RGBA readback, not merely
        // TestWindowExt::render_frame (which only refreshes and draws a scene).
        w.render_to_image().expect("native offscreen renderer");
        (draw, start.elapsed().as_secs_f64() * 1000.)
    })
    .unwrap()
}

fn extent(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: impl Into<ElementId>) -> f32 {
    let id = id.into();
    cx.update_window(h, |_, w, _| f32::from(w.find(id).bounds().size.height))
        .unwrap()
}

fn work(cx: &mut HeadlessAppContext, width: f32, dark: bool) {
    use crate::local_model::LiveTranscript;
    use serde_json::json;
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[
        {"type":"toolCall","id":"a","name":"read","arguments":{"path":"a.rs"}},
        {"type":"toolCall","id":"b","name":"bash","arguments":{"command":"echo synthetic"}},
        {"type":"toolCall","id":"c","name":"edit","arguments":{"path":"日本.rs","oldText":"old\n","newText":"new\n"}}
    ]}]}}));
    for (i, id) in ["a", "b", "c"].into_iter().enumerate() {
        model.apply(&json!({"type":"tool_execution_end","toolCallId":id,"entry":{"id":21+i,"kind":"pi.tool","model":[{"role":"toolResult","toolCallId":id,"content":[{"type":"text","text":"synthetic output\n".repeat(5)}]}]}}));
    }
    let mut rows = model.rows();
    let group = rows[0].id();
    let diff = rows[0]
        .work_data()
        .unwrap()
        .calls()
        .find(|t| t.id == "c")
        .unwrap()
        .diff
        .clone();
    rows.push(row(999, "Following row".into()));
    let (h, t) = cx.update(|cx| {
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
                    let mut t = TranscriptView::readonly(w, cx);
                    t.replace_readonly(rows, true, cx);
                    t.hold_for_history(cx);
                    t
                })
            },
        )
        .unwrap()
    });
    for _ in 0..3 {
        frame(cx, h, 100);
    }
    let key = SharedString::from(format!("work-toggle-{group}"));
    let initial = extent(cx, h, ("work-height", group));
    cx.update_window(h, |_, w, cx| w.click(key.clone(), cx))
        .unwrap();
    frame(cx, h, 0);
    frame(cx, h, 64);
    let opening = extent(cx, h, ("work-height", group));
    frame(cx, h, 240);
    let opened = extent(cx, h, ("work-height", group));
    assert!(
        initial < opening && opening < opened,
        "work {initial}/{opening}/{opened}"
    );

    let step = "step-height-call:b";
    let before = extent(cx, h, step);
    let top = |cx: &mut HeadlessAppContext, id: &str| {
        cx.update_window(h, |_, w, _| {
            f32::from(w.find(SharedString::from(id.to_owned())).bounds().top())
        })
        .unwrap()
    };
    let above = top(cx, "step-toggle-call:a");
    let below = top(cx, "step-toggle-call:c");
    cx.update_window(h, |_, w, cx| w.click("step-toggle-call:b", cx))
        .unwrap();
    frame(cx, h, 0);
    let mut frames = Vec::new();
    for _ in 0..7 {
        let (draw, render) = frame(cx, h, 32);
        frames.push(json!({"height":extent(cx,h,step),"draw_ms":draw,"render_ms":render}));
        assert_eq!(
            top(cx, "step-toggle-call:a"),
            above,
            "above the changing call stays still"
        );
    }
    let after = extent(cx, h, step);
    let middle = frames[1]["height"].as_f64().unwrap() as f32;
    assert!(
        before < middle && middle < after,
        "call {before}/{middle}/{after}"
    );
    assert!((top(cx, "step-toggle-call:c") - below - (after - before)).abs() <= 1.);
    // Collapsing immediately removes the output and its copy action, while
    // only the now-empty slot shrinks. Reverse from that displayed extent.
    cx.update_window(h, |_, w, cx| w.click("step-toggle-call:b", cx))
        .unwrap();
    frame(cx, h, 0);
    cx.update_window(h, |_, w, _| {
        assert!(w.find_all("copy-call:b-Output").is_empty())
    })
    .unwrap();
    frame(cx, h, 64);
    let closing = extent(cx, h, step);
    assert!(before < closing && closing < after);
    cx.update_window(h, |_, w, cx| w.click("step-toggle-call:b", cx))
        .unwrap();
    frame(cx, h, 0);
    assert!((extent(cx, h, step) - closing).abs() <= 1.);
    frame(cx, h, 240);
    assert_eq!(extent(cx, h, step), after);

    // Parent reversal must not resurrect a hidden child's unfinished motion.
    cx.update_window(h, |_, w, cx| w.click("step-toggle-call:b", cx))
        .unwrap();
    frame(cx, h, 64);
    cx.update_window(h, |_, w, cx| w.click(key.clone(), cx))
        .unwrap();
    frame(cx, h, 0);
    frame(cx, h, 64);
    let parent_closing = extent(cx, h, ("work-height", group));
    cx.update_window(h, |_, w, cx| w.click(key.clone(), cx))
        .unwrap();
    frame(cx, h, 0);
    assert!((extent(cx, h, ("work-height", group)) - parent_closing).abs() <= 1.);
    frame(cx, h, 240);
    assert_eq!(extent(cx, h, step), before);

    // The inline patch section belongs to this same measured call disclosure.
    let patch_before = extent(cx, h, "step-height-call:c");
    cx.update_window(h, |_, w, cx| w.click("step-toggle-call:c", cx))
        .unwrap();
    frame(cx, h, 0);
    frame(cx, h, 64);
    let patch_middle = extent(cx, h, "step-height-call:c");
    frame(cx, h, 240);
    let patch_after = extent(cx, h, "step-height-call:c");
    assert!(patch_before < patch_middle && patch_middle < patch_after);
    cx.update_window(h, |_, w, cx| {
        w.click("copy-call:c-Replacement / patch preview", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), *diff);
        assert!(!t.read(cx).reading_mark(cx).unwrap().following);
    })
    .unwrap();
    cx.update(|cx| cx.set_reduce_motion(true));
    cx.update_window(h, |_, w, cx| w.click(key.clone(), cx))
        .unwrap();
    frame(cx, h, 0);
    assert_eq!(extent(cx, h, ("work-height", group)), initial);
    cx.update_window(h, |_, w, cx| w.click(key, cx)).unwrap();
    frame(cx, h, 0);
    assert_eq!(extent(cx, h, "step-height-call:c"), patch_after);
    cx.update(|cx| cx.set_reduce_motion(false));
    println!(
        "{}",
        json!({"motion":"work-call-patch", "width":width,"dark":dark,
        "group":[initial,opening,opened],"call":[before,middle,after],
        "patch":[patch_before,patch_middle,patch_after],"frames":frames})
    );
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    cx.run_until_parked();
}

fn reads(cx: &mut HeadlessAppContext, width: f32, dark: bool) {
    use crate::local_model::LiveTranscript;
    use serde_json::json;
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"run_start"}));
    model.apply(&json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[
        {"type":"toolCall","id":"ra","name":"read","arguments":{"path":"a.rs"}},
        {"type":"toolCall","id":"rb","name":"read","arguments":{"path":"b.rs"}}
    ]}]}}));
    for (i, id) in ["ra", "rb"].into_iter().enumerate() {
        model.apply(&json!({"type":"tool_execution_end","toolCallId":id,"entry":{"id":21+i,"kind":"pi.tool","model":[{"role":"toolResult","toolCallId":id,"content":[{"type":"text","text":"read source"}]}]}}));
    }
    let (h, t) = cx.update(|cx| {
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
                    let mut t = TranscriptView::readonly(w, cx);
                    t.replace_readonly(model.rows(), true, cx);
                    t
                })
            },
        )
        .unwrap()
    });
    frame(cx, h, 300);
    let before = extent(cx, h, "reads-height-call:ra");
    cx.update_window(h, |_, w, cx| w.click("reads-toggle-call:ra", cx))
        .unwrap();
    frame(cx, h, 0);
    frame(cx, h, 64);
    let middle = extent(cx, h, "reads-height-call:ra");
    frame(cx, h, 240);
    let end = extent(cx, h, "reads-height-call:ra");
    assert!(
        before < middle && middle < end,
        "merged reads {before}/{middle}/{end}"
    );
    cx.update_window(h, |_, w, cx| w.click("reads-toggle-call:ra", cx))
        .unwrap();
    frame(cx, h, 0);
    cx.update_window(h, |_, w, _| {
        assert!(w.find_all("step-toggle-call:ra").is_empty())
    })
    .unwrap();
    frame(cx, h, 240);
    assert_eq!(extent(cx, h, "reads-height-call:ra"), before);
    cx.update(|cx| cx.set_reduce_motion(true));
    cx.update_window(h, |_, w, cx| w.click("reads-toggle-call:ra", cx))
        .unwrap();
    frame(cx, h, 0);
    assert_eq!(extent(cx, h, "reads-height-call:ra"), end);
    cx.update(|cx| cx.set_reduce_motion(false));
    frame(cx, h, 1000);
    let _ = t;
    for _ in 0..3 {
        // Explicit draw always renders this root fixture, even when clean.
        // Count actual scheduled work, not renders forced by the probe.
        assert_eq!(
            cx.update_window(h, |_, w, cx| w.simulate_next_frame(cx))
                .unwrap(),
            0,
            "settled disclosure must not schedule another frame"
        );
        frame(cx, h, 1000);
    }
    println!(
        "{}",
        json!({"motion":"merged-reads","width":width,"dark":dark,"height":[before,middle,end],"idle_frame_callbacks":0})
    );
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    cx.run_until_parked();
}

pub(super) fn run(cx: &mut HeadlessAppContext) {
    cx.update(|cx| cx.set_reduce_motion(false));
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
                );
            });
            let (h, t) = cx.update(|cx| {
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
                            let mut t = TranscriptView::readonly(w, cx);
                            t.replace_readonly(
                                vec![
                                    row(1, "Unicode e\u{301} 👩‍💻 日本\n".repeat(18)),
                                    row(2, "Below the changing message".into()),
                                ],
                                true,
                                cx,
                            );
                            t.restore_reading(
                                crate::navigation::ReadingMark {
                                    message: Some(crate::model::ReaderKey::model(1, 0, Some(0))),
                                    offset: 0.,
                                    following: false,
                                },
                                cx,
                            );
                            t
                        })
                    },
                )
                .unwrap()
            });
            for _ in 0..3 {
                frame(cx, h, 100);
            }
            let geometry = |cx: &mut HeadlessAppContext| {
                cx.update_window(h, |_, _, cx| {
                    let v = t.read(cx);
                    let top = v.history_probe_row(1).read(cx).bounds().top();
                    let below = v.history_probe_row(2).read(cx).bounds().top();
                    (top, below)
                })
                .unwrap()
            };
            let before = geometry(cx);
            cx.update_window(h, |_, w, cx| w.click(("message-fold", 1u64), cx))
                .unwrap();
            frame(cx, h, 0);
            let cost = frame(cx, h, 64);
            let middle = geometry(cx);
            if width == 680.
                && let Some(dir) = std::env::var_os("PILOT_NEXT_DISCLOSURE_MOTION_DIR")
            {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("message-middle-{dark}.png")))
                    .unwrap();
            }
            // Keyboard reverses the very same disclosure while it is moving.
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            frame(cx, h, 0);
            let reversed = geometry(cx);
            assert!(
                (f32::from(reversed.1 - middle.1)).abs() <= 1.,
                "reversal jumped"
            );
            frame(cx, h, 64);
            let closing = geometry(cx);
            assert!(closing.1 < reversed.1 && closing.1 > before.1);
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            frame(cx, h, 0);
            assert!((f32::from(geometry(cx).1 - closing.1)).abs() <= 1.);
            frame(cx, h, 64);
            // Select/copy while the full-size text is being revealed. Repeated
            // remeasurement must not replace the parser or clear the selection.
            let (parser, selected) = cx
                .update_window(h, |_, w, cx| {
                    let parser = t.read(cx).history_probe_row(1);
                    let b = parser.read(cx).bounds();
                    w.drag(
                        b.origin + point(px(3.), px(9.)),
                        b.origin + point(px(100.), px(9.)),
                        cx,
                    );
                    w.press("secondary-c", cx);
                    let selected = cx.read_from_clipboard().unwrap().text().unwrap();
                    assert!(!selected.is_empty());
                    (parser, selected)
                })
                .unwrap();
            frame(cx, h, 240);
            let end = geometry(cx);
            assert_eq!(before.0, middle.0, "content above must stay still");
            assert_eq!(middle.0, end.0);
            assert!(
                before.1 < middle.1 && middle.1 < end.1,
                "message must ease downward: {before:?}, {middle:?}, {end:?}"
            );
            cx.update_window(h, |_, w, cx| {
                assert_eq!(t.read(cx).history_probe_row(1), parser);
                w.press("secondary-c", cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), selected);
                assert!(!t.read(cx).reading_mark(cx).unwrap().following);
            })
            .unwrap();
            cx.update(|cx| cx.set_reduce_motion(true));
            // Pointer collapse also drops the old full-source parser at once.
            cx.update_window(h, |_, w, cx| w.click(("message-fold", 1u64), cx))
                .unwrap();
            frame(cx, h, 0);
            assert_eq!(geometry(cx), before, "reduced motion collapses immediately");
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            frame(cx, h, 0);
            assert_eq!(geometry(cx), end, "end geometry matches instant disclosure");
            cx.update(|cx| cx.set_reduce_motion(false));
            println!(
                "{}",
                serde_json::json!({"motion":"message-fold", "width":width,
                "dark":dark, "before":f32::from(before.1), "middle":f32::from(middle.1),
                "end":f32::from(end.1), "draw_ms":cost.0, "render_ms":cost.1})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            work(cx, width, dark);
            reads(cx, width, dark);
        }
    }
}
