//! Hidden production-header cache reuse, invalidation, paint and resize regression.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, InputEvent, ScrollDelta, ScrollEvent,
    WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    point, size,
    test::TestWindowExt,
};
use serde_json::json;

fn draw(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
        .unwrap();
}
fn counts(cx: &mut HeadlessAppContext, v: &Entity<LocalViewer>) -> (u64, u64) {
    cx.update(|cx| {
        let v = v.read(cx);
        (
            v.chat_header.read(cx).renders,
            v.transcript.read(cx).probe_render_count(),
        )
    })
}

pub(crate) fn run(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (h, v) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(760.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| {
                            cx.new(|cx| {
                                let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                                v.state.chats = Arc::new(
                                    (0..240)
                                        .map(|ix| {
                                            crate::local_model::chat(
                                                &json!({"id":format!("scroll-{ix}"),
                        "title":format!("Résumé 日本 👩‍💻 {ix}"), "state":"idle"}),
                                            )
                                            .unwrap()
                                        })
                                        .collect(),
                                );
                                v.rebuild_nav(w, cx);
                                v
                            })
                        },
                    )
                })
                .unwrap();
            for _ in 0..4 {
                cx.advance_clock(Duration::from_millis(100));
                draw(cx, h);
            }
            let before_image = cx.capture_screenshot(h).expect("native header paint");
            let before = counts(cx, &v);
            let (focus, header, transcript, offset) = cx
                .update_window(h, |_, w, cx| {
                    assert_eq!(
                        w.find("chat-header").bounds().size.width,
                        w.find("conversation").bounds().size.width,
                        "header spans the actual conversation, not its intrinsic text width"
                    );
                    let offset = v.read(cx).chats.read(cx).scroll_handle().offset();
                    (
                        w.focused(cx),
                        w.find("chat-header").bounds(),
                        w.find("conversation-editor").bounds(),
                        offset,
                    )
                })
                .unwrap();
            assert_eq!(header.size.height, px(48.));
            for delta in [-40.; 12].into_iter().chain([40.; 6]) {
                cx.update_window(h, |_, w, cx| {
                    w.dispatch_event(
                        ScrollEvent {
                            position: w.find("chat-list-pane").bounds().center(),
                            delta: ScrollDelta::Pixels(point(px(0.), px(delta))),
                            ..Default::default()
                        }
                        .to_platform_input(),
                        cx,
                    );
                })
                .unwrap();
                draw(cx, h);
                assert_eq!(counts(cx, &v), before, "wheel reuses header and transcript");
            }
            cx.update_window(h, |_, w, cx| {
                assert_ne!(v.read(cx).chats.read(cx).scroll_handle().offset(), offset);
                assert_eq!(w.focused(cx), focus, "wheel preserves focus");
                assert_eq!(w.find("chat-header").bounds(), header);
                assert_eq!(w.find("conversation-editor").bounds(), transcript);
            })
            .unwrap();
            cx.update(|cx| {
                v.update(cx, |v, cx| {
                    v.title = "Updated 日本 👩‍💻 header".into();
                    cx.notify();
                })
            });
            draw(cx, h);
            let updated = counts(cx, &v);
            assert!(updated.0 > before.0, "owner update invalidates header");
            assert_eq!(updated.1, before.1, "header update keeps transcript cache");
            let after_image = cx.capture_screenshot(h).expect("updated header paint");
            let scale = after_image.width() as f32 / width;
            let changed = ((f32::from(header.top()) * scale) as u32
                ..(f32::from(header.bottom()) * scale) as u32)
                .flat_map(|y| {
                    ((f32::from(header.left()) * scale) as u32
                        ..(f32::from(header.right()) * scale) as u32)
                        .map(move |x| (x, y))
                })
                .filter(|&(x, y)| before_image.get_pixel(x, y) != after_image.get_pixel(x, y))
                .count();
            assert!(changed > 20, "updated title reaches native header pixels");
            if let Some(dir) = std::env::var_os("PILOT_NEXT_STYLE_DIR") {
                std::fs::create_dir_all(&dir).unwrap();
                after_image
                    .save(
                        std::path::PathBuf::from(dir)
                            .join(format!("header-cache-{width}-{}.png", mode.name())),
                    )
                    .unwrap();
            }
            for child in 0..3 {
                let before = counts(cx, &v);
                cx.update(|cx| {
                    let owner = v.read(cx);
                    let editor = owner.editor.clone();
                    let mission = owner.mission.clone();
                    let context = owner.mission_context.clone();
                    match child {
                        0 => editor.update(cx, |_, cx| cx.notify()),
                        1 => mission.update(cx, |_, cx| cx.notify()),
                        _ => context.update(cx, |_, cx| cx.notify()),
                    }
                });
                draw(cx, h);
                let after = counts(cx, &v);
                assert!(
                    after.0 > before.0,
                    "eligibility/context update invalidates header"
                );
                assert_eq!(after.1, before.1, "no nested transcript-cache invalidation");
            }
            cx.update_window(h, |_, w, cx| {
                w.resize(size(px(width - 40.), px(720.)));
                w.bounds_changed(cx);
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| {
                w.simulate_next_frame(cx);
                w.render_frame(cx);
            })
            .unwrap();
            cx.update_window(h, |_, w, _| {
                let after = w.find("chat-header").bounds();
                assert_eq!(after.size.height, px(48.));
                assert!(
                    after.size.width < header.size.width,
                    "cache follows resolved width: before={header:?}, after={after:?}, viewport={:?}",
                    w.viewport_size()
                );
                w.remove_window();
            })
            .unwrap();
        }
    }
    println!(
        "chat header cache: wheel, owner/child invalidation, native paint, focus and resize passed"
    );
}
