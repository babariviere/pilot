//! Hidden production Jump phases. GPU/readback timings are not presentation FPS.
use super::*;
use gpui_kit::{AnyWindowHandle, Pixels};
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
fn bounds(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) -> Bounds<Pixels> {
    cx.update_window(h, |_, w, _| w.find(id).bounds()).unwrap()
}
fn search(cx: &mut HeadlessAppContext, h: AnyWindowHandle, text: &str) {
    cx.update_window(h, |_, w, cx| {
        w.press("secondary-a", cx);
        if text.is_empty() {
            w.press("backspace", cx);
        } else {
            w.input(text, cx);
        }
    })
    .unwrap();
    frame(cx, h, 0);
}
pub(super) fn run(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| {
                cx.set_reduce_motion(false);
                Theme::change(mode, None, cx);
            });
            let (writer, writes) = Interaction::recording();
            let (h, v) = cx.update(|cx| gpui_kit::open_window(WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(Default::default(), size(px(width), px(600.))))),
                show: false, focus: false, ..Default::default()
            }, cx, |w, cx| cx.new(|cx| {
                let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                v.editor.update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                v.transcript.update(cx, |t, cx| t.replace_readonly(rows(), true, cx));
                v.state.chats = Arc::new((0..20).map(|i| crate::local_model::chat(&json!({"id":format!("motion-{i}"),"title":format!("Motion result {i}"),"state":"idle","createdAt":20-i})).unwrap()).collect());
                v.state.projects = Arc::new((0..8).map(|i| crate::local_model::Project { id:format!("p{i}"),name:format!("Project {i}"), ..Default::default() }).collect());
                v.state.list_loaded = true;
                v
            }))).unwrap();
            settle(cx, h);
            let editor = cx.update(|cx| v.read(cx).editor.read(cx).shell_probe().0);
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.set_value("Keep draft 👩‍💻", w, cx);
                    e.focus(w, cx);
                });
                w.press("secondary-k", cx);
            })
            .unwrap();
            settle(cx, h);
            let q = cx.update(|cx| query(&v, cx));
            let full = bounds(cx, h, "jump-shell");
            assert_eq!(
                full.size.height,
                px(480.),
                "large result list keeps existing maximum"
            );
            let query_top = cx
                .update_window(h, |_, _, cx| q.read(cx).input_bounds())
                .unwrap();
            let baseline = frame(cx, h, 240);
            search(cx, h, "Motion result 19");
            frame(cx, h, 240);
            assert!(
                bounds(cx, h, "jump-shell").size.height < full.size.height,
                "one result fits instead of retaining the maximum shell"
            );
            search(cx, h, "");
            frame(cx, h, 240);
            search(cx, h, "zz-no-resource");
            assert_eq!(
                bounds(cx, h, "jump-shell"),
                full,
                "start at old displayed geometry"
            );
            cx.update_window(h, |_, w, _| {
                assert!(
                    w.try_find("jump-row-page:home").is_none(),
                    "removed results cannot remain interactive"
                )
            })
            .unwrap();
            let mut costs = vec![frame(cx, h, 64)];
            let partial = bounds(cx, h, "jump-shell").size.height;
            if let Some(dir) = std::env::var_os("PILOT_NEXT_JUMP_DIR") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("motion-partial-{width}-{}.png", mode.name())))
                    .unwrap();
            }
            let target = bounds(cx, h, "jump-palette").size.height + px(2.);
            assert!(
                target < partial && partial < full.size.height,
                "empty result shrink: {target:?} < {partial:?} < {:?}",
                full.size.height
            );
            assert_eq!(
                cx.update_window(h, |_, w, cx| {
                    assert!(q.focus_handle(cx).is_focused(w));
                    q.read(cx).input_bounds().top()
                })
                .unwrap(),
                query_top.top(),
                "query stays still while shell eases"
            );
            // Reverse before shrink completes. Both result list and query are retained.
            search(cx, h, "Motion");
            assert_eq!(bounds(cx, h, "jump-shell").size.height, partial);
            costs.push(frame(cx, h, 64));
            let growing = bounds(cx, h, "jump-shell").size.height;
            assert!(growing > partial);
            cx.update_window(h, |_, w, cx| {
                w.press("down", cx);
                let p = v.read(cx).jump.as_ref().unwrap();
                assert_eq!(p.read(cx).probe(cx).3.as_deref(), Some("chat:motion-1"));
                q.update(cx, |q, cx| {
                    q.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx)
                });
                w.press("escape", cx);
                assert!(v.read(cx).jump.is_some());
            })
            .unwrap();
            let preedit = cx
                .update_window(h, |_, w, cx| {
                    q.update(cx, |q, cx| {
                        (
                            q.value().to_string(),
                            q.selected_range(),
                            q.marked_text_range(w, cx),
                        )
                    })
                })
                .unwrap();
            costs.push(frame(cx, h, 136));
            cx.update_window(h, |_, w, cx| {
                assert!(q.focus_handle(cx).is_focused(w));
                let now = q.update(cx, |q, cx| {
                    (
                        q.value().to_string(),
                        q.selected_range(),
                        q.marked_text_range(w, cx),
                    )
                });
                assert_eq!(now, preedit);
                q.update(cx, |q, cx| {
                    q.unmark_text(w, cx);
                    q.set_value("Motion", w, cx);
                });
            })
            .unwrap();
            // Resize mid-shrink applies natural geometry in this very draw.
            search(cx, h, "zz-no-resource");
            frame(cx, h, 64);
            cx.update_window(h, |_, w, cx| {
                w.resize(size(px(width + 80.), px(600.)));
                w.bounds_changed(cx);
            })
            .unwrap();
            frame(cx, h, 0);
            assert_eq!(
                bounds(cx, h, "jump-shell").size.height,
                bounds(cx, h, "jump-palette").size.height + px(2.)
            );
            search(cx, h, "Motion");
            frame(cx, h, 64);
            cx.update_window(h, |_, w, cx| {
                w.resize(size(px(width + 80.), px(360.)));
                w.bounds_changed(cx);
            })
            .unwrap();
            frame(cx, h, 0);
            assert_eq!(
                bounds(cx, h, "jump-shell").size.height,
                px(328.),
                "height resize immediately updates the viewport cap"
            );
            cx.update(|cx| cx.set_reduce_motion(true));
            search(cx, h, "zz-no-resource");
            assert_eq!(
                bounds(cx, h, "jump-shell").size.height,
                bounds(cx, h, "jump-palette").size.height + px(2.)
            );
            search(cx, h, "Motion");
            assert_eq!(
                bounds(cx, h, "jump-shell").size.height,
                bounds(cx, h, "jump-palette").size.height + px(2.)
            );
            assert_eq!(
                cx.update(|cx| v.read(cx).jump.as_ref().unwrap().read(cx).probe(cx).1),
                crate::jump::GROUP_LIMIT
            );
            for _ in 1..crate::jump::GROUP_LIMIT {
                cx.update_window(h, |_, w, cx| w.press("down", cx)).unwrap();
                frame(cx, h, 0);
            }
            cx.update_window(h, |_, _, cx| {
                let palette = v.read(cx).jump.as_ref().unwrap().read(cx);
                assert_eq!(
                    palette.probe(cx).3.as_deref(),
                    Some("chat:motion-5"),
                    "keyboard selected the final result"
                );
            })
            .unwrap();
            frame(cx, h, 240);
            if let Some(dir) = std::env::var_os("PILOT_NEXT_JUMP_DIR") {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(
                        std::path::PathBuf::from(dir)
                            .join(format!("motion-last-{width}-{}.png", mode.name())),
                    )
                    .unwrap();
            }
            let selected = bounds(cx, h, "jump-row-chat:motion-5");
            let viewport = bounds(cx, h, "jump-results");
            assert!(
                selected.top() >= viewport.top() && selected.bottom() <= viewport.bottom(),
                "keyboard selection must scroll the last result fully into its actual viewport: {selected:?} in {viewport:?}"
            );
            assert!(
                viewport.bottom() < bounds(cx, h, "jump-footer").top(),
                "footer never overlays results"
            );
            if let Some(dir) = std::env::var_os("PILOT_NEXT_JUMP_DIR") {
                let dir = std::path::PathBuf::from(dir);
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("motion-small-{width}-{}.png", mode.name())))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                w.press("escape", cx);
            })
            .unwrap();
            frame(cx, h, 0);
            cx.update_window(h, |_, w, cx| {
                assert!(v.read(cx).jump.is_none());
                assert!(editor.focus_handle(cx).is_focused(w));
                assert_eq!(editor.read(cx).value().as_str(), "Keep draft 👩‍💻");
            })
            .unwrap();
            assert!(writes.try_recv().is_err());
            println!(
                "{}",
                json!({"jump_motion":true,"width":width,"mode":mode.name(),"maximum":f32::from(full.size.height),"empty_target":f32::from(target),"partial":f32::from(partial),"draw_renderer_readback_ms":costs,"idle_draw_renderer_readback_ms":baseline,"visible_smoothness":false,"os_ime_qualified":false})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
    cx.update(|cx| cx.set_reduce_motion(false));
}
