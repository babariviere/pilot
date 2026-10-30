//! Hidden production composer paste/remove/send and parent/child identity checks.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, ClipboardItem, HeadlessAppContext, Image, ImageFormat, WindowBounds,
    WindowOptions, size, test::TestWindowExt,
};
use std::{
    io::Cursor,
    sync::Arc,
    time::{Duration, Instant},
};
struct Fixture(Entity<ChatEditor>);
impl Render for Fixture {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .v_flex()
            .size_full()
            .bg(cx.theme().background)
            .child(div().flex_1())
            .child(self.0.clone())
    }
}
fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.advance_clock(Duration::from_millis(16));
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
}
fn wait(cx: &mut HeadlessAppContext, h: AnyWindowHandle, e: &Entity<ChatEditor>) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        frame(cx, h);
        if cx.update(|cx| {
            e.read(cx).attachments.importing.is_none() && e.read(cx).attachments.task.is_none()
        }) {
            break;
        }
        assert!(Instant::now() < deadline, "attachment settle");
        std::thread::yield_now();
    }
    frame(cx, h);
}
fn incoming() -> ClipboardItem {
    let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(320, 200, |x, y| {
        image::Rgba([x as u8, y as u8, 219, 255])
    }));
    let mut bytes = Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Tiff)
        .unwrap();
    ClipboardItem::new_image(&Image::from_bytes(ImageFormat::Tiff, bytes.into_inner()))
}
pub(super) fn run(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for dark in [false, true] {
            let root =
                std::env::temp_dir().join(format!("native-attachments-{}", uuid::Uuid::new_v4()));
            let mut store = crate::delivery_store::Store::open(
                root.clone(),
                crate::LocalOptions::synthetic(1).host(),
            )
            .unwrap();
            let (mut writer, commands) = Interaction::recording();
            writer.attachment_root = Some(root.clone());
            let state = WriteState {
                book: Some(Arc::new(store.book.clone())),
                ..Default::default()
            };
            let (h, editor) = cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                );
                let mut editor = None;
                let (h, _) = gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(700.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        w.set_rem_size(px(14.));
                        let e = cx.new(|cx| {
                            let mut e = ChatEditor::new(Some(writer), w, cx);
                            e.accept(state, w, cx);
                            e.select("chat:a".into(), true, false, w, cx);
                            e
                        });
                        editor = Some(e.clone());
                        cx.new(|_| Fixture(e))
                    },
                )
                .unwrap();
                (h, editor.unwrap())
            });
            frame(cx, h);
            let permit = crate::artifact_image::Permit::acquire().unwrap();
            cx.update_window(h, |_, w, cx| {
                w.activate_window();
                editor.update(cx, |e, cx| e.text.update(cx, |s, cx| s.focus(w, cx)));
                cx.write_to_clipboard(incoming());
                w.press("secondary-v", cx);
            })
            .unwrap();
            let early_child = crate::session_subagents::Target {
                parent: "a".into(),
                name: "early".into(),
                created_at: 1,
            }
            .key();
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.select(early_child.clone(), true, false, w, cx)
                })
            })
            .unwrap();
            drop(permit);
            wait(cx, h, &editor);
            assert!(cx.update(|cx| editor.read(cx).cache[&early_child].attachments.is_empty()));
            let images = cx.update(|cx| editor.read(cx).cache["chat:a"].attachments.clone());
            assert_eq!(images.len(), 1, "real Paste action imports a native image");
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.select("chat:a".into(), true, false, w, cx))
            })
            .unwrap();
            wait(cx, h, &editor);
            let id = images[0].id.clone();
            cx.update_window(h, |_, w, _| {
                let preview = w.find("composer-attachments").bounds();
                assert!(preview.bottom() <= w.find("composer-tray").bounds().top());
                assert!(preview.size.height >= px(104.));
                assert!(w.find(format!("attachment:{id}")).visible());
            })
            .unwrap();
            // A named child shares the composer, never the parent's image draft.
            let child_key = crate::session_subagents::Target {
                parent: "a".into(),
                name: "worker".into(),
                created_at: 1,
            }
            .key();
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.select(child_key.clone(), true, false, w, cx))
            })
            .unwrap();
            frame(cx, h);
            assert!(cx.update(|cx| editor.read(cx).draft().unwrap().attachments.is_empty()));
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.text.update(cx, |s, cx| s.focus(w, cx)));
                cx.write_to_clipboard(ClipboardItem::new_string("Child draft 日本語 👩‍💻".into()));
                w.press("secondary-v", cx);
            })
            .unwrap();
            frame(cx, h);
            assert_eq!(
                cx.update(|cx| editor.read(cx).draft().unwrap().text.clone()),
                "Child draft 日本語 👩‍💻"
            );
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.select("chat:a".into(), true, false, w, cx))
            })
            .unwrap();
            wait(cx, h, &editor);
            if let Some(dir) = std::env::var_os("PILOT_NEXT_COMPOSER_DIR") {
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(
                        std::path::PathBuf::from(dir)
                            .join(format!("attachments-{width}-{dark}.png")),
                    )
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                w.click(format!("remove-attachment:{id}"), cx);
            })
            .unwrap();
            frame(cx, h);
            assert!(cx.update(|cx| editor.read(cx).draft().unwrap().attachments.is_empty()));
            assert!(
                images[0].path.exists(),
                "removal cannot invalidate a possible historical reference"
            );
            cx.update_window(h, |_, w, cx| {
                use gpui_kit::InputEvent as _;
                let position = w.find("composer-input").bounds().center();
                w.dispatch_event(
                    gpui_kit::FileDropEvent::Entered {
                        position,
                        paths: gpui_kit::ExternalPaths(vec![images[0].path.clone()].into()),
                    }
                    .to_platform_input(),
                    cx,
                );
                w.dispatch_event(
                    gpui_kit::FileDropEvent::Submit { position }.to_platform_input(),
                    cx,
                );
            })
            .unwrap();
            wait(cx, h, &editor);
            let dropped = cx.update(|cx| editor.read(cx).draft().unwrap().attachments.clone());
            assert_eq!(dropped.len(), 1, "native external-file drop");
            assert_ne!(dropped[0].id, id, "drop adopts its own immutable identity");
            cx.update_window(h, |_, w, cx| {
                w.click(format!("remove-attachment:{}", dropped[0].id), cx)
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                use gpui_kit::test::{TestInput, TestQueryExt};
                editor.update(cx, |e, cx| e.text.update(cx, |s, cx| s.focus(w, cx)));
                let handler = gpui_kit::ElementInputHandler::new(
                    w.find_by_label("Message to Pilot").bounds(),
                    editor.read(cx).text.clone(),
                );
                TestInput::new(handler, w).compose_text(None, "にほん", Some(3..3), cx);
                cx.write_to_clipboard(incoming());
                w.press("secondary-v", cx);
                assert!(editor.update(cx, |e, cx| e.marked(w, cx)));
                assert!(editor.read(cx).draft().unwrap().attachments.is_empty());
                editor.update(cx, |e, cx| {
                    e.text.update(cx, |s, cx| {
                        s.unmark_text(w, cx);
                        s.set_value("", w, cx);
                    });
                    e.changed(cx);
                });
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| {
                cx.write_to_clipboard(incoming());
                w.press("secondary-v", cx);
            })
            .unwrap();
            wait(cx, h, &editor);
            cx.update_window(h, |_, w, cx| w.click("local-send", cx))
                .unwrap();
            let WriteCommand::Submit {
                draft, key, stop, ..
            } = commands.try_recv().unwrap()
            else {
                panic!("send");
            };
            assert_eq!(key, "chat:a");
            assert!(!stop);
            assert!(draft.text.is_empty());
            assert_eq!(draft.attachments.len(), 1);
            let intent = store.prepare(&key, &draft, false, false).unwrap();
            let payload: serde_json::Value =
                serde_json::from_str(&intent.operation.unwrap().payload).unwrap();
            assert_eq!(
                payload["message"],
                crate::image_attachments::message("", &draft.attachments)
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            drop(store);
            std::fs::remove_dir_all(root).unwrap();
            println!(
                "composer_attachments {width} {dark} passed: TIFF paste/preview/remove/send/parent-child draft identity"
            );
        }
    }
}
