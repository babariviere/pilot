//! Actual offscreen transcript painting, using the production faux Local reader.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, ScrollDelta, WindowBounds, WindowOptions, point,
    size, test::TestWindowExt,
};
use std::{
    io::Cursor,
    time::{Duration, Instant},
};

struct ResizeHost {
    view: Entity<TranscriptView>,
    width: f32,
}
impl Render for ResizeHost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(
            div()
                .w(px(self.width))
                .h_full()
                .min_w_0()
                .child(self.view.clone()),
        )
    }
}
fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.advance_clock(Duration::from_millis(16));
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
}
fn loaded(cx: &mut HeadlessAppContext, h: AnyWindowHandle, view: &Entity<TranscriptView>) {
    let end = Instant::now() + Duration::from_secs(6);
    loop {
        frame(cx, h);
        if cx.update(|cx| view.read(cx).images.stop.is_none()) {
            break;
        }
        assert!(Instant::now() < end, "bounded image completion");
        std::thread::yield_now();
    }
    frame(cx, h);
}
fn encoded(color: [u8; 3]) -> String {
    let image =
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(1600, 800, image::Rgb(color)));
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    STANDARD.encode(bytes.into_inner())
}
pub fn run_conversation_images_probe(cx: &mut HeadlessAppContext) {
    let server = crate::conversation_images::fixture::Server::start(encoded([24, 110, 220]));
    let capture = crate::local_client::read_local_capture(server.options.clone(), "owner").unwrap();
    let original = capture.state.rows;
    let image_id = original
        .iter()
        .find(|r| r.image_data().is_some())
        .unwrap()
        .id();
    let captures =
        std::env::var_os("PILOT_NEXT_CONVERSATION_IMAGES_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
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
            let (h, host) = cx.update(|cx| {
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
                        let view = cx.new(|cx| {
                            let mut view = TranscriptView::readonly(w, cx);
                            view.history_scope(1);
                            view.replace_readonly(original.clone(), true, cx);
                            view
                        });
                        cx.new(|_| ResizeHost { view, width })
                    },
                )
                .unwrap()
            });
            let view = cx.update(|cx| host.read(cx).view.clone());
            for _ in 0..8 {
                frame(cx, h);
            }
            let selection_id = original
                .iter()
                .find(|r| r.is_assistant() && r.image_data().is_none())
                .unwrap()
                .id();
            let (before, selection, range) = cx
                .update_window(h, |_, w, cx| {
                    let b = w.find(("conversation-image-viewport", image_id)).bounds();
                    assert!(b.size.width > px(300.) && b.size.width < px(width));
                    let text_id = original
                        .iter()
                        .find(|r| r.image_data().is_none())
                        .unwrap()
                        .id();
                    w.click(("copy-source", text_id), cx);
                    assert_eq!(
                        cx.read_from_clipboard().unwrap().text().unwrap(),
                        "Stored conversation image"
                    );
                    w.click(("conversation-image-source", image_id), cx);
                    let text = cx.read_from_clipboard().unwrap().text().unwrap();
                    assert!(
                        text.contains("test-daemon")
                            && text.contains("test-lineage")
                            && text.contains("owner")
                            && text.contains("block: Some(1)")
                    );
                    assert!(!text.contains("iVBOR"));
                    cx.write_to_clipboard(ClipboardItem::new_string("sentinel".into()));
                    w.click(("conversation-image-preview", image_id), cx);
                    assert!(view.read(cx).images.stop.is_some());
                    assert!(view.read(cx).images.raster.is_none());
                    let selection = view.read(cx).history_probe_row(selection_id);
                    let text_bounds = selection.read(cx).bounds();
                    let from = point(text_bounds.left() + px(3.), text_bounds.center().y);
                    let to = point(from.x + px(150.), from.y);
                    assert!(w.find("viewport").bounds().contains(&from));
                    w.drag(from, to, cx);
                    let range = selection
                        .read(cx)
                        .selected_source_range()
                        .unwrap_or_else(|| {
                            panic!("actual visible text drag at {from:?} within {text_bounds:?}")
                        });
                    assert!(range.start < range.end);
                    (b, selection, range)
                })
                .unwrap();
            loaded(cx, h, &view);
            let bounds = cx
                .update_window(h, |_, w, cx| {
                    assert_eq!(
                        cx.read_from_clipboard().unwrap().text().unwrap(),
                        "sentinel"
                    );
                    assert!(view.read(cx).images.raster.is_some());
                    assert_eq!(
                        selection.read(cx).selected_source_range(),
                        Some(range.clone())
                    );
                    let b = w.find(("conversation-image-pixels", image_id)).bounds();
                    assert_eq!(
                        b,
                        w.find(("conversation-image-viewport", image_id)).bounds()
                    );
                    assert_eq!(b, before, "decoding does not resize the row");

                    b
                })
                .unwrap();
            let shot = cx.capture_screenshot(h).unwrap();
            let scale = shot.width() as f32 / width;
            let pixel = shot
                .get_pixel(
                    (f32::from(bounds.center().x) * scale) as u32,
                    (f32::from(bounds.center().y) * scale) as u32,
                )
                .0;
            for (a, b) in pixel[..3].iter().zip([24u8, 110, 220]) {
                assert!(a.abs_diff(b) < 5, "actual BGRA paint: {pixel:?}");
            }
            if let Some(dir) = &captures {
                shot.save(dir.join(format!(
                    "{}-{}.png",
                    width as u32,
                    if dark { "dark" } else { "light" }
                )))
                .unwrap();
            }
            // The mounted parent really shrinks and grows. Headless Window::resize
            // is not used as evidence: Kit's test platform does not implement it.
            let pixels =
                cx.update(|cx| view.read(cx).images.raster.as_ref().unwrap().image.clone());
            cx.update(|cx| {
                host.update(cx, |host, cx| {
                    host.width = width - 120.;
                    cx.notify();
                })
            });
            for _ in 0..8 {
                frame(cx, h);
            }
            cx.update_window(h, |_, w, cx| {
                let b = w.find(("conversation-image-viewport", image_id)).bounds();
                assert!(b.size.width < before.size.width - px(100.));
                assert_eq!(b, w.find(("conversation-image-pixels", image_id)).bounds());
                assert_eq!(
                    selection.read(cx).selected_source_range(),
                    Some(range.clone())
                );
                assert!(Arc::ptr_eq(
                    &pixels,
                    &view.read(cx).images.raster.as_ref().unwrap().image
                ));
            })
            .unwrap();
            drop(pixels);
            cx.update(|cx| {
                host.update(cx, |host, cx| {
                    host.width = width;
                    cx.notify();
                })
            });
            for _ in 0..8 {
                frame(cx, h);
            }
            // Same entry/block/presentation ID, different exact bytes: retire old pixels.
            let old = cx
                .update(|cx| Arc::downgrade(&view.read(cx).images.raster.as_ref().unwrap().image));
            let mut switched = original.clone();
            let mut source = crate::conversation_images::Source::read(
                1,
                &serde_json::json!({"mimeType":"image/png","data":encoded([220,90,30])}),
                &mut crate::conversation_images::INLINE_CAP.clone(),
            );
            source.owner = switched
                .iter()
                .find_map(|r| r.image_data())
                .unwrap()
                .owner
                .clone();
            let ix = switched.iter().position(|r| r.id() == image_id).unwrap();
            switched[ix] = Message::image(image_id, "Stored image · user".into(), source)
                .anchored(crate::model::ReaderKey::model(1, 0, Some(1)));
            cx.update(|cx| {
                view.update(cx, |v, cx| v.replace_readonly(switched.clone(), false, cx))
            });
            frame(cx, h);
            assert!(old.upgrade().is_none(), "retired decoded pixels released");
            cx.update_window(h, |_, w, cx| {
                w.click(("conversation-image-preview", image_id), cx)
            })
            .unwrap();
            loaded(cx, h, &view);
            assert!(cx.update(|cx| view.read(cx).images.raster.is_some()));
            let switched_shot = cx.capture_screenshot(h).unwrap();
            let switched_pixel = switched_shot
                .get_pixel(
                    (f32::from(bounds.center().x) * scale) as u32,
                    (f32::from(bounds.center().y) * scale) as u32,
                )
                .0;
            for (a, b) in switched_pixel[..3].iter().zip([220u8, 90, 30]) {
                assert!(
                    a.abs_diff(b) < 5,
                    "source replacement pixels: {switched_pixel:?}"
                );
            }
            // Component Button deliberately avoids taking focus on pointer press.
            // Traverse the bounded fixture's actual tab stops instead of assuming
            // that clicking Copy source moved keyboard focus.
            for _ in 0..8 {
                if cx
                    .update_window(h, |_, w, _| {
                        w.find(("conversation-image-preview", image_id)).focused() == Some(true)
                    })
                    .unwrap()
                {
                    break;
                }
                cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
                frame(cx, h);
            }
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    w.find(("conversation-image-preview", image_id)).focused(),
                    Some(true)
                );
                w.press("space", cx);
            })
            .unwrap();
            frame(cx, h);
            assert!(cx.update(|cx| view.read(cx).images.raster.is_none()));
            cx.update_window(h, |_, w, cx| w.press("space", cx))
                .unwrap();
            loaded(cx, h, &view);
            assert!(cx.update(|cx| view.read(cx).images.raster.is_some()));
            // Add a tall message and keep the image reader anchor while streaming text changes.
            let mut tall = switched.clone();
            tall.push(Message::live(
                777,
                "assistant".into(),
                "long content\n".repeat(300),
            ));
            cx.update(|cx| {
                view.update(cx, |v, cx| {
                    v.replace_readonly(tall.clone(), false, cx);
                    v.scroller
                        .update(cx, |s, cx| s.restore_anchor(1, px(0.), cx));
                })
            });
            for _ in 0..8 {
                frame(cx, h);
            }
            let anchor = cx.update(|cx| view.read(cx).history_probe_anchor(cx));
            *tall.last_mut().unwrap() =
                Message::live(777, "assistant".into(), "streamed content\n".repeat(320));
            cx.update(|cx| view.update(cx, |v, cx| v.replace_readonly(tall, false, cx)));
            for _ in 0..8 {
                frame(cx, h);
            }
            let after = cx.update(|cx| view.read(cx).history_probe_anchor(cx));
            assert_eq!(anchor.0, after.0);
            assert!((anchor.1 - after.1).abs() < 1.);
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "viewport",
                    ScrollDelta::Pixels(point(px(0.), px(-100.))),
                    cx,
                )
            })
            .unwrap();
            frame(cx, h);
            cx.update(|cx| view.update(cx, |v, cx| v.clear_image(cx)));
            let busy_permit = crate::artifact_image::Permit::acquire().unwrap();
            cx.update(|cx| view.update(cx, |v, cx| v.open_image(image_id, cx)));
            frame(cx, h);
            assert!(
                cx.update(|cx| view.read(cx).images.error.is_some()
                    && view.read(cx).images.stop.is_none())
            );
            drop(busy_permit);
            // Truthful unsupported/overlimit/malformed states are mounted, not only modeled.
            for (mime, data, decode_error) in [
                ("image/webp", "AAAA".to_owned(), false),
                (
                    "image/png",
                    "A".repeat(crate::conversation_images::INLINE_CAP + 1),
                    false,
                ),
                ("image/png", "AAAA".to_owned(), true),
            ] {
                let mut source = crate::conversation_images::Source::read(
                    1,
                    &serde_json::json!({"mimeType":mime,"data":data}),
                    &mut crate::conversation_images::INLINE_CAP.clone(),
                );
                source.owner = original
                    .iter()
                    .find_map(|r| r.image_data())
                    .unwrap()
                    .owner
                    .clone();
                let row = Message::image(image_id, "Stored image · You".into(), source)
                    .anchored(crate::model::ReaderKey::model(1, 0, Some(1)));
                cx.update(|cx| view.update(cx, |v, cx| v.replace_readonly(vec![row], true, cx)));
                for _ in 0..4 {
                    frame(cx, h);
                }
                cx.update_window(h, |_, w, cx| {
                    if decode_error {
                        w.click(("conversation-image-preview", image_id), cx);
                    } else {
                        assert!(w.find(("conversation-image-problem", image_id)).visible());
                        assert!(
                            w.try_find(("conversation-image-preview", image_id))
                                .is_none()
                        );
                    }
                })
                .unwrap();
                if decode_error {
                    loaded(cx, h, &view);
                    assert!(cx.update(|cx| view.read(cx).images.error.is_some()
                        && view.read(cx).images.raster.is_none()));
                    cx.update_window(h, |_, w, _| {
                        assert!(w.find(("conversation-image-status", image_id)).visible())
                    })
                    .unwrap();
                }
                if let Some(dir) = &captures {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(dir.join(format!(
                            "{}-{}-{}.png",
                            width as u32,
                            if dark { "dark" } else { "light" },
                            if decode_error {
                                "error"
                            } else if mime == "image/webp" {
                                "unsupported"
                            } else {
                                "overlimit"
                            }
                        )))
                        .unwrap();
                }
            }
            cx.update(|cx| view.update(cx, |v, cx| v.replace_readonly(original.clone(), true, cx)));
            for _ in 0..4 {
                frame(cx, h);
            }
            // A chat/generation reset cancels outstanding work and clears even identical rows.
            cx.update(|cx| {
                view.update(cx, |v, cx| {
                    v.open_image(image_id, cx);
                    v.history_scope(2);
                    v.replace_readonly(Vec::new(), true, cx);
                })
            });
            loaded(cx, h, &view);
            assert!(cx.update(|cx| view.read(cx).images.raster.is_none()
                && view.read(cx).images.selected.is_none()));
            let end = Instant::now() + Duration::from_secs(6);
            loop {
                frame(cx, h);
                if let Ok(permit) = crate::artifact_image::Permit::acquire() {
                    drop(permit);
                    break;
                }
                assert!(Instant::now() < end, "cancelled codec releases admission");
                std::thread::yield_now();
            }
            assert!(cx.update(|cx| view.read(cx).images.raster.is_none()));
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        }
    }
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.starts_with("GET "))
    );
    println!(
        "conversation_images: actual 680/1100 light/dark pixels, source identity, source switch, scroll anchor, cancellation passed"
    );
}
