//! Mounted production images, FIFO admission and reader geometry. Synthetic only.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use gpui_kit::test::TestEventExt;
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
fn wait(cx: &mut HeadlessAppContext, h: AnyWindowHandle, check: impl Fn(&App) -> bool) {
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        frame(cx, h);
        if cx.update(|cx| check(cx)) {
            break;
        }
        assert!(Instant::now() < end, "image settle");
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
fn composer_reader_guards(
    cx: &mut HeadlessAppContext,
    options: &crate::LocalOptions,
    source: &Arc<crate::conversation_images::Source>,
    width: f32,
) {
    use gpui_kit::{EntityInputHandler, Focusable};
    let rows = vec![
        Message::live(
            10,
            "Assistant".into(),
            "Readable selected conversation text, retained while inspecting an image.".into(),
        ),
        Message::image(100, "Stored image".into(), (**source).clone())
            .anchored(crate::model::ReaderKey::model(1, 0, Some(0))),
    ];
    let (h, viewer) = cx.update(|cx| {
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
                cx.new(|cx| crate::LocalViewer::inline_visual_fixture(options.clone(), rows, w, cx))
            },
        )
        .unwrap()
    });
    let (t, input) = cx.update(|cx| {
        let v = viewer.read(cx);
        (v.inline_probe_transcript(), v.inline_probe_input(cx))
    });
    wait(cx, h, |cx| {
        t.read(cx)
            .images
            .entries
            .get(&100)
            .is_some_and(|e| e.raster.is_some())
    });
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| {
            i.focus(w, cx);
            i.replace_text_in_range(None, "draft 👩🏽‍💻", w, cx);
            i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx);
        });
    })
    .unwrap();
    for _ in 0..4 {
        frame(cx, h);
    }
    cx.update_window(h, |_, w, cx| {
        w.click(("conversation-image-viewport", 100u64), cx);
        assert!(
            input.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()),
            "image click keeps preedit"
        );
        assert!(
            w.try_find("reader-fit").is_none(),
            "preedit blocks reader opening"
        );
        input.update(cx, |i, cx| {
            let marked = i.marked_text_range(w, cx).unwrap();
            i.replace_text_in_range(Some(marked), "", w, cx);
        });
    })
    .unwrap();
    for _ in 0..4 {
        frame(cx, h);
    }
    let text = cx.update(|cx| t.read(cx).history_probe_row(10));
    let selection = cx
        .update_window(h, |_, w, cx| {
            let b = text.read(cx).bounds();
            w.drag(
                point(b.left() + px(2.), b.center().y),
                point(b.left() + px(160.), b.center().y),
                cx,
            );
            text.read(cx).selected_source_range().unwrap()
        })
        .unwrap();
    cx.update_window(h, |_, w, cx| {
        assert!(selection.start < selection.end);
        input.update(cx, |i, cx| {
            i.focus(w, cx);
            i.set_selected_range(0..5, cx);
        });
        w.click(("conversation-image-expand", 100u64), cx);
    })
    .unwrap();
    for _ in 0..4 {
        frame(cx, h);
    }
    cx.update_window(h, |_, w, cx| {
        w.press("secondary-1", cx);
    })
    .unwrap();
    frame(cx, h);
    cx.update_window(h, |_, w, cx| {
        let b = w.find("artifact-raster-pixels").bounds();
        assert!(
            (f32::from(b.size.width) - 1600. / w.scale_factor()).abs() < 1.,
            "keyboard actual size"
        );
        w.press("secondary-+", cx);
    })
    .unwrap();
    frame(cx, h);
    cx.update_window(h, |_, w, cx| {
        w.press("secondary-0", cx);
        w.press("escape", cx);
    })
    .unwrap();
    wait(cx, h, |cx| input.read(cx).value().contains("draft"));
    for _ in 0..24 {
        frame(cx, h);
    }
    cx.update_window(h, |_, w, cx| {
        assert!(
            input.focus_handle(cx).is_focused(w),
            "close restores mounted composer"
        );
        assert_eq!(input.read(cx).selected_range(), 0..5);
        assert_eq!(input.read(cx).value().as_ref(), "draft 👩🏽‍💻");
    })
    .unwrap();
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    cx.run_until_parked();
}
pub fn run_conversation_images_probe(cx: &mut HeadlessAppContext) {
    let server = crate::conversation_images::fixture::Server::start(encoded([24, 110, 220]));
    let capture = crate::local_client::read_local_capture(server.options.clone(), "owner").unwrap();
    let original = capture.state.rows;
    let base = original
        .iter()
        .find_map(|r| r.image_data())
        .unwrap()
        .clone();
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
            composer_reader_guards(cx, &server.options, &base, width);
            let rows: Vec<_> = (0..3)
                .map(|n| {
                    let mut source = (*base).clone();
                    source.block = n as usize;
                    Message::image(100 + n, format!("Stored image {}", n + 1), source)
                        .anchored(crate::model::ReaderKey::model(1, 0, Some(n as usize)))
                })
                .collect();
            let permit = crate::artifact_image::Permit::acquire().unwrap();
            let (h, host) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(1200.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        let view = cx.new(|cx| {
                            let mut t = TranscriptView::readonly(w, cx);
                            t.history_scope(1);
                            t.replace_readonly(rows.clone(), true, cx);
                            t
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
            assert_eq!(
                cx.update(|cx| view.read(cx).images.entries.len()),
                3,
                "all visible rows queued"
            );
            assert!(cx.update(|cx| {
                view.read(cx)
                    .images
                    .entries
                    .values()
                    .all(|e| e.raster.is_none() && e.error.is_none())
            }));
            drop(permit);
            wait(cx, h, |cx| {
                view.read(cx).images.entries.len() == 3
                    && view
                        .read(cx)
                        .images
                        .entries
                        .values()
                        .all(|e| e.raster.is_some())
            });
            let anchor = cx.update(|cx| view.read(cx).history_probe_anchor(cx));
            cx.update_window(h, |_, w, cx| {
                for id in 100u64..103 {
                    let b = w.find(("conversation-image-pixels", id)).bounds();
                    assert_eq!(b, w.find(("conversation-image-viewport", id)).bounds());
                    assert!(b.size.width > px(300.) && b.right() <= px(width));
                }
                w.click(("conversation-image-source", 100u64), cx);
                assert!(
                    cx.read_from_clipboard()
                        .unwrap()
                        .text()
                        .unwrap()
                        .contains("test-lineage")
                );
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{width}-{dark}-three.png")))
                    .unwrap();
            }
            // Composition admission guard blocks expanded sibling intent.
            cx.update(|cx| view.update(cx, |v, _| v.history_guard = Some(Rc::new(|_, _| false))));
            cx.update_window(h, |_, w, cx| {
                w.click(("conversation-image-expand", 100u64), cx)
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, _| assert!(w.try_find("reader-fit").is_none()))
                .unwrap();
            cx.update(|cx| view.update(cx, |v, _| v.history_guard = None));
            cx.update_window(h, |_, w, cx| {
                w.click(("conversation-image-expand", 100u64), cx)
            })
            .unwrap();
            for _ in 0..6 {
                frame(cx, h);
            }
            cx.update_window(h, |_, w, cx| {
                let b = w.find("reader-viewport").bounds();
                assert!(b.size.width > px(400.) && b.size.height > px(400.));
                w.click("reader-actual", cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                let before = w.find("artifact-raster-pixels").bounds();
                assert!((f32::from(before.size.width) - 1600. / w.scale_factor()).abs() < 1.);
                w.click("reader-in", cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                let before = w.find("artifact-raster-pixels").bounds();
                assert!((f32::from(before.size.width) - 2000. / w.scale_factor()).abs() < 1.);
                w.scroll(
                    "reader-viewport",
                    ScrollDelta::Pixels(point(px(-80.), px(0.))),
                    cx,
                );
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                for _ in 0..4 {
                    w.click("reader-in", cx);
                }
            })
            .unwrap();
            frame(cx, h);
            let before_pan = cx
                .update_window(h, |_, w, cx| {
                    let before = w.find("artifact-raster-pixels").bounds();
                    let start = w.find("reader-viewport").bounds().center();
                    w.pointer_down(start, gpui_kit::MouseButton::Middle, cx);
                    w.pointer_move(
                        start - point(px(64.), px(48.)),
                        Some(gpui_kit::MouseButton::Middle),
                        cx,
                    );
                    w.pointer_up(
                        start - point(px(64.), px(48.)),
                        gpui_kit::MouseButton::Middle,
                        cx,
                    );
                    before
                })
                .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, _| {
                let after = w.find("artifact-raster-pixels").bounds();
                assert_eq!(after.size, before_pan.size, "pan never changes scale");
                assert!(
                    after.origin.x < before_pan.origin.x && after.origin.y < before_pan.origin.y
                );
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{width}-{dark}-zoom-pan.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                w.click("reader-fit", cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    w.find("artifact-raster-pixels").bounds(),
                    w.find("reader-viewport").bounds()
                );
                w.click("reader-actual", cx);
                w.click("reader-reset", cx);
                w.click("conversation-reader-copy", cx);
            })
            .unwrap();
            wait(cx, h, |cx| {
                cx.read_from_clipboard()
                    .and_then(|c| c.text())
                    .is_some_and(|s| s.starts_with("data:image/png;base64,"))
            });
            assert!(
                cx.update(|cx| cx.read_from_clipboard().unwrap().text().unwrap()
                    == format!("data:{};base64,{}", base.mime, base.data.as_ref().unwrap()))
            );
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            frame(cx, h);
            assert_eq!(
                anchor,
                cx.update(|cx| view.read(cx).history_probe_anchor(cx))
            );
            // Replacing same presentation ID fences source and automatically loads new bytes.
            let mut changed = rows.clone();
            let mut source = crate::conversation_images::Source::read(
                0,
                &serde_json::json!({"mimeType":"image/png","data":encoded([220,90,30])}),
                &mut crate::conversation_images::INLINE_CAP.clone(),
            );
            source.owner = base.owner.clone();
            changed[0] = Message::image(100, "Changed".into(), source)
                .anchored(crate::model::ReaderKey::model(1, 0, Some(0)));
            cx.update_window(h, |_, w, cx| {
                w.click(("conversation-image-expand", 100u64), cx)
            })
            .unwrap();
            frame(cx, h);
            cx.update(|cx| view.update(cx, |v, cx| v.replace_readonly(changed.clone(), false, cx)));
            for _ in 0..4 {
                frame(cx, h);
            }
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("conversation-reader-copy").is_none(),
                    "retired source is inert"
                );
                w.press("escape", cx);
            })
            .unwrap();
            wait(cx, h, |cx| {
                view.read(cx).images.entries.len() == 3
                    && view
                        .read(cx)
                        .images
                        .entries
                        .values()
                        .all(|e| e.raster.is_some())
            });
            // Offscreen retirement, then revisit. No whole-history decoding.
            let mut history = changed.clone();
            history.extend(
                (200..240)
                    .map(|id| Message::live(id, "Assistant".into(), "Plain content\n".repeat(10))),
            );
            cx.update(|cx| {
                view.update(cx, |v, cx| {
                    v.replace_readonly(history, false, cx);
                    v.scroller.update(cx, |s, cx| s.scroll_to_item(30, cx));
                })
            });
            wait(cx, h, |cx| view.read(cx).images.entries.is_empty());
            cx.update(|cx| {
                view.update(cx, |v, cx| {
                    v.scroller.update(cx, |s, cx| s.scroll_to_item(0, cx))
                })
            });
            wait(cx, h, |cx| {
                view.read(cx)
                    .images
                    .entries
                    .values()
                    .any(|e| e.raster.is_some())
            });
            // Unsupported and malformed sources stay truthful, not blank.
            for (mime, data) in [("image/webp", "AAAA"), ("image/png", "AAAA")] {
                let mut s = crate::conversation_images::Source::read(
                    0,
                    &serde_json::json!({"mimeType":mime,"data":data}),
                    &mut crate::conversation_images::INLINE_CAP.clone(),
                );
                s.owner = base.owner.clone();
                cx.update(|cx| {
                    view.update(cx, |v, cx| {
                        v.replace_readonly(
                            vec![
                                Message::image(100, "Bad".into(), s)
                                    .anchored(crate::model::ReaderKey::model(1, 0, Some(0))),
                            ],
                            true,
                            cx,
                        )
                    })
                });
                for _ in 0..8 {
                    frame(cx, h);
                }
                if mime == "image/png" {
                    wait(cx, h, |cx| {
                        view.read(cx)
                            .images
                            .entries
                            .get(&100)
                            .is_some_and(|e| e.error.is_some())
                    });
                }
                cx.update_window(h, |_, w, _| {
                    assert!(
                        w.find((
                            if mime == "image/png" {
                                "conversation-image-status"
                            } else {
                                "conversation-image-problem"
                            },
                            100u64
                        ))
                        .visible()
                    )
                })
                .unwrap();
            }
            cx.update(|cx| {
                view.update(cx, |v, cx| {
                    v.history_scope(2);
                    v.replace_readonly(Vec::new(), true, cx);
                })
            });
            frame(cx, h);
            assert!(cx.update(|cx| view.read(cx).images.entries.is_empty()));
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
}
