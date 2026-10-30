//! Hidden native phases and renderer/readback cost, not visible smoothness.
use super::*;
use gpui_kit::{Focusable, component::input::InputState};
use std::time::Instant;

fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle, ms: u64) -> (f64, f64) {
    cx.advance_clock(Duration::from_millis(ms));
    cx.update_window(h, |_, w, cx| w.simulate_next_frame(cx))
        .unwrap();
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| {
        let start = Instant::now();
        w.draw(cx).clear(cx);
        let draw = start.elapsed().as_secs_f64() * 1000.;
        let start = Instant::now();
        w.render_to_image().expect("native renderer/readback");
        (draw, start.elapsed().as_secs_f64() * 1000.)
    })
    .unwrap()
}
fn height(cx: &mut HeadlessAppContext, h: AnyWindowHandle) -> f32 {
    cx.update_window(h, |_, w, _| {
        w.try_find("transcript-find-slot")
            .map_or(0., |e| f32::from(e.bounds().size.height))
    })
    .unwrap()
}
fn editing(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    q: &Entity<InputState>,
) -> (
    String,
    std::ops::Range<usize>,
    Option<std::ops::Range<usize>>,
) {
    cx.update_window(h, |_, w, cx| {
        assert!(q.focus_handle(cx).is_focused(w));
        let marked = q.update(cx, |q, cx| q.marked_text_range(w, cx));
        (
            q.read(cx).value().to_string(),
            q.read(cx).selected_range(),
            marked,
        )
    })
    .unwrap()
}
pub(super) fn run(cx: &mut HeadlessAppContext) {
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
                                let v = LocalViewer::preview(PreviewState::Conversation, w, cx);
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
            let (t, editor) = cx.update(|cx| {
                (
                    v.read(cx).transcript.clone(),
                    v.read(cx).editor.read(cx).shell_probe().0,
                )
            });
            let baseline = frame(cx, h, 240);
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.set_value("Retained 👩‍💻 draft", w, cx);
                    e.focus(w, cx);
                });
                w.press("secondary-f", cx);
            })
            .unwrap();
            frame(cx, h, 0);
            assert_eq!(height(cx, h), 0., "first frame must not pop open");
            let q = cx.update(|cx| t.read(cx).find_probe_input());
            cx.update_window(h, |_, w, cx| {
                q.update(cx, |q, cx| {
                    q.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                })
            })
            .unwrap();
            let preedit = editing(cx, h, &q);
            let mut costs = vec![];
            costs.push(frame(cx, h, 64));
            let partial = height(cx, h);
            if let Some(dir) = std::env::var_os("PILOT_NEXT_FIND_DIR") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("motion-partial-{width}-{dark}.png")))
                    .unwrap();
            }
            let natural = cx
                .update_window(h, |_, w, _| {
                    f32::from(w.find("transcript-find").bounds().size.height)
                })
                .unwrap();
            assert!(partial > 0. && partial < natural, "{partial} / {natural}");
            cx.update_window(h, |_, w, _| {
                let slot = w.find("transcript-find-slot").bounds();
                let child = w.find("transcript-find").bounds();
                assert!(
                    (f32::from(slot.bottom() - child.bottom())).abs() < 0.1,
                    "full child slides down into slot"
                );
            })
            .unwrap();
            assert_eq!(editing(cx, h, &q), preedit);
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            assert_eq!(
                editing(cx, h, &q),
                preedit,
                "marked Escape must not dismiss"
            );
            costs.push(frame(cx, h, 136));
            assert_eq!(height(cx, h), natural);
            cx.update_window(h, |_, w, cx| {
                q.update(cx, |q, cx| {
                    q.unmark_text(w, cx);
                    q.set_value("日本", w, cx);
                });
            })
            .unwrap();
            frame(cx, h, 0);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("find-status").label(), Some("1 of 3"));
                w.press("enter", cx);
                assert_eq!(w.find("find-status").label(), Some("2 of 3"));
                w.press("shift-enter", cx);
                assert_eq!(w.find("find-status").label(), Some("1 of 3"));
                w.press("escape", cx);
            })
            .unwrap();
            frame(cx, h, 0);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("transcript-find-query").is_none(),
                    "closing content is removed immediately"
                );
                assert!(
                    editor.focus_handle(cx).is_focused(w),
                    "Escape returns focus to trigger"
                );
                assert_eq!(editor.read(cx).value().as_str(), "Retained 👩‍💻 draft");
            })
            .unwrap();
            costs.push(frame(cx, h, 64));
            let closing = height(cx, h);
            assert!(closing > 0. && closing < natural);
            cx.update_window(h, |_, w, cx| w.press("secondary-f", cx))
                .unwrap();
            frame(cx, h, 0);
            assert_eq!(
                height(cx, h),
                closing,
                "reopening starts at displayed height"
            );
            costs.push(frame(cx, h, 64));
            assert!(height(cx, h) > closing && height(cx, h) < natural);
            cx.update_window(h, |_, w, cx| {
                w.resize(size(px(width + 80.), px(840.)));
                w.bounds_changed(cx);
            })
            .unwrap();
            frame(cx, h, 0);
            assert_eq!(height(cx, h), natural, "resize snaps immediately");
            cx.update(|cx| cx.set_reduce_motion(true));
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            frame(cx, h, 0);
            assert_eq!(height(cx, h), 0.);
            cx.update_window(h, |_, w, cx| w.press("secondary-f", cx))
                .unwrap();
            frame(cx, h, 0);
            assert_eq!(height(cx, h), natural);
            if let Some(dir) = std::env::var_os("PILOT_NEXT_FIND_DIR") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("motion-{width}-{dark}.png")))
                    .unwrap();
            }
            assert!(writes.try_recv().is_err());
            println!(
                "{}",
                serde_json::json!({"find_motion":true,"width":width,"dark":dark,"height":natural,"partial":partial,"closing":closing,"draw_renderer_readback_ms":costs,"idle_draw_renderer_readback_ms":baseline,"visible_smoothness":false,"os_ime_qualified":false})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
    cx.update(|cx| cx.set_reduce_motion(false));
}
