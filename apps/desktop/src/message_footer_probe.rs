//! Message footer (copy + sent time) in the actual offscreen production reader.
//! Synthetic rows only; no client actions, profile or runtime.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, Pixels, WindowBounds, WindowOptions, point, size,
    test::{TestEventExt, TestWindowExt},
};

const SENT: u64 = 1_793_178_307_250;
const REPLY: &str = "## Reply\n\nA calm answer with `code` and 👋.";

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..8 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn long_source() -> String {
    format!(
        "Long folded request\n\n{}HiddenNeedle exact tail\r\n",
        "Unicode e\u{301} 👩‍💻 日本 🇫🇷 source content.\n".repeat(50)
    )
}
fn row(id: u64, label: &str, text: String, sent: Option<u64>) -> Message {
    Message::live(id, label.into(), text)
        .anchored(crate::model::ReaderKey::model(id, 0, Some(0)))
        .with_sent(sent)
}
fn rows(reply: &str) -> Vec<Message> {
    vec![
        row(
            1,
            "You",
            "Short question 👋 e\u{301} 日本".into(),
            Some(SENT),
        ),
        row(2, "assistant", reply.into(), Some(SENT + 1_000)),
        row(3, "You", long_source(), Some(SENT + 2_000)),
        row(4, "assistant", "A reply without a sent time.".into(), None),
    ]
}
/// Pixels of a native capture inside logical bounds.
fn region(image: &image::RgbaImage, b: Bounds<Pixels>, width: f32) -> Vec<[u8; 4]> {
    let scale = image.width() as f32 / width;
    let mut pixels = Vec::new();
    for y in (f32::from(b.top()) * scale) as u32..(f32::from(b.bottom()) * scale) as u32 {
        for x in (f32::from(b.left()) * scale) as u32..(f32::from(b.right()) * scale) as u32 {
            pixels.push(image.get_pixel(x, y).0);
        }
    }
    pixels
}
fn uniform(pixels: &[[u8; 4]]) -> bool {
    !pixels.is_empty() && pixels.iter().all(|p| *p == pixels[0])
}

pub fn run_message_footer_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_FOOTER_DIR").map(std::path::PathBuf::from);
    if let Some(p) = &captures {
        std::fs::create_dir_all(p).unwrap();
    }
    for width in [560., 1100.] {
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
            let (client, _commands) = LocalClient::synthetic_commands();
            let (h, v) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(900.)),
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
                                v.transcript.update(cx, |t, cx| {
                                    t.fold_scope(Some(crate::session_todos::Source::new(
                                        LocalOptions::synthetic(9),
                                        "footer-chat".into(),
                                        1,
                                    )));
                                    t.replace_readonly(rows(REPLY), true, cx);
                                    t.restore_reading(
                                        crate::navigation::ReadingMark {
                                            message: Some(crate::model::ReaderKey::model(
                                                1,
                                                0,
                                                Some(0),
                                            )),
                                            offset: 0.,
                                            following: false,
                                        },
                                        cx,
                                    );
                                });
                                v
                            })
                        },
                    )
                })
                .unwrap();
            settle(cx, h);
            let t = cx.update(|cx| v.read(cx).transcript.clone());
            // Each footer follows its body (and Show more): trailing under the
            // user's bubbles, leading under replies, inside the viewport.
            let (copy, time, quiet) = cx
                .update_window(h, |_, w, cx| {
                    let viewport = w.find("viewport").bounds();
                    let text = |id: u64| t.read(cx).history_probe_row(id).read(cx).bounds();
                    let copy = |id: u64| w.find(("copy-source", id)).bounds();
                    let actions = |id: u64| w.find(("message-actions", id)).bounds();
                    let time = |id: u64| w.find(("sent-time", id)).bounds();
                    for id in 1..=4u64 {
                        assert!(
                            copy(id).top() >= text(id).bottom(),
                            "footer {id} below body"
                        );
                        assert!(copy(id).left() >= viewport.left());
                        assert!(copy(id).right() <= viewport.right());
                    }
                    for id in 1..4u64 {
                        assert!(actions(id).bottom() <= actions(id + 1).top(), "order kept");
                    }
                    for id in [1u64, 3] {
                        assert!((copy(id).right() - actions(id).right()).abs() <= px(1.));
                        assert!(time(id).right() <= copy(id).left());
                        assert!(time(id).left() >= viewport.left());
                    }
                    assert!((copy(2).left() - text(2).left()).abs() <= px(1.));
                    assert!(time(2).left() >= copy(2).right());
                    assert!(time(2).right() <= viewport.right());
                    assert!(
                        w.try_find(("sent-time", 4u64)).is_none(),
                        "no invented time"
                    );
                    assert!(
                        w.find(("message-fold", 3u64)).bounds().bottom() <= actions(3).top(),
                        "Show more stays after the body, before the footer"
                    );
                    assert_eq!(
                        w.find(("sent-time", 1u64)).label(),
                        Some(crate::message_time::label(SENT).as_str())
                    );
                    let rest = (copy(2), time(2), actions(1));
                    w.pointer_move(point(px(1.), px(1.)), None, cx);
                    rest
                })
                .unwrap();
            settle(cx, h);
            let hidden = cx.capture_screenshot(h).unwrap();
            assert!(
                uniform(&region(&hidden, copy, width)),
                "copy hidden at rest"
            );
            assert!(
                uniform(&region(&hidden, time, width)),
                "time hidden at rest"
            );
            // Pointer over the reply reveals its copy and time, without reflow.
            cx.update_window(h, |_, w, cx| {
                let b = t.read(cx).history_probe_row(2).read(cx).bounds();
                w.pointer_move(b.center(), None, cx);
            })
            .unwrap();
            settle(cx, h);
            let hovered = cx.capture_screenshot(h).unwrap();
            assert!(
                !uniform(&region(&hovered, copy, width)),
                "hover paints copy"
            );
            assert!(
                !uniform(&region(&hovered, time, width)),
                "hover paints time"
            );
            assert_eq!(
                region(&hovered, quiet, width),
                region(&hidden, quiet, width),
                "other messages stay quiet"
            );
            if let Some(p) = &captures {
                hovered
                    .save(p.join(format!("hover-{width}-{dark}.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find(("copy-source", 2u64)).bounds(), copy);
                assert_eq!(w.find(("message-actions", 1u64)).bounds(), quiet);
                crate::transcript_view::click_copy(w, 2, cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), REPLY);
                crate::transcript_view::click_copy(w, 3, cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    long_source()
                );
                w.pointer_move(point(px(1.), px(1.)), None, cx);
                if w.focused(cx).is_none() {
                    w.focus_next(cx);
                }
            })
            .unwrap();
            settle(cx, h);
            // Keyboard: Tab reaches the reply's copy action, which shows while focused.
            let mut reached = false;
            for _ in 0..80 {
                reached = cx
                    .update_window(h, |_, w, cx| {
                        w.press("tab", cx);
                        w.find(("copy-source", 2u64)).focused() == Some(true)
                    })
                    .unwrap();
                settle(cx, h);
                if reached {
                    break;
                }
            }
            assert!(reached, "Tab must reach the reply's copy action");
            let focused = cx.capture_screenshot(h).unwrap();
            assert!(
                !uniform(&region(&focused, copy, width)),
                "focus paints copy"
            );
            assert!(
                !uniform(&region(&focused, time, width)),
                "focus paints time beside copy"
            );
            assert_eq!(
                region(&focused, quiet, width),
                region(&hidden, quiet, width),
                "other messages stay quiet"
            );
            if let Some(p) = &captures {
                focused
                    .save(p.join(format!("focus-{width}-{dark}.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(String::new()));
                w.press("enter", cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), REPLY);
            })
            .unwrap();
            // A streamed extension keeps identity, sent time and a footer below.
            let identity = cx.update(|cx| t.read(cx).history_probe_row(2).entity_id());
            let longer = format!("{REPLY}\n\n{}", "More streamed text. ".repeat(40));
            cx.update(|cx| t.update(cx, |t, cx| t.replace_readonly(rows(&longer), false, cx)));
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let text = t.read(cx).history_probe_row(2);
                assert_eq!(text.entity_id(), identity);
                assert!(
                    w.find(("copy-source", 2u64)).bounds().top() >= text.read(cx).bounds().bottom()
                );
                assert_eq!(
                    w.find(("sent-time", 2u64)).label(),
                    Some(crate::message_time::label(SENT + 1_000).as_str())
                );
                crate::transcript_view::click_copy(w, 2, cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), longer);
            })
            .unwrap();
            println!("message_footer native {width} dark={dark}: passed");
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        }
    }
}
