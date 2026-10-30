//! Hidden actual GPUI reference, with a synthetic Local owner and no client or writer.
use super::*;
use crate::{LocalViewer, TranscriptView};
use gpui_kit::{
    AnyWindowHandle, AppContext, Bounds, EntityInputHandler, HeadlessAppContext, WindowBounds,
    WindowOptions,
    base::TextSelection,
    component::{Theme, ThemeMode},
    point, size,
    test::TestWindowExt,
};
use std::time::Duration;

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| {
            w.draw(cx).clear(cx);
        })
        .unwrap();
    }
}

pub fn run_shortcuts_probe(cx: &mut HeadlessAppContext) {
    cx.update(|cx| {
        LocalViewer::bind_keys(cx);
        // Fixture-only key exercises the Help action through real keyboard dispatch.
        cx.bind_keys([KeyBinding::new("f1", OpenShortcuts, None)]);
        TranscriptView::bind_keys(cx);
        #[cfg(target_os = "macos")]
        crate::app_menu::init(cx);
    });
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let (main, owner) = cx.update(|cx| {
                Theme::change(mode, None, cx);
                gpui_kit::open_window(
                    WindowOptions {
                        show: false,
                        focus: false,
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(800.)),
                        ))),
                        ..Default::default()
                    },
                    cx,
                    |w, cx| cx.new(|cx| LocalViewer::build(None, None, w, cx)),
                )
                .unwrap()
            });
            settle(cx, main);
            let query = cx.update(|cx| owner.read(cx).chats.read(cx).query_input());
            cx.update_window(main, |_, w, cx| {
                w.activate_window();
                query.update(cx, |q, cx| {
                    q.focus(w, cx);
                    q.replace_and_mark_text_in_range(None, "にほん👩‍💻", Some(0..0), w, cx);
                });
            })
            .unwrap();
            settle(cx, main);
            cx.update_window(main, |_, w, cx| w.press("f1", cx))
                .unwrap();
            settle(cx, main);
            assert!(
                cx.update(|cx| owner.read(cx).shortcuts_window.is_none()),
                "Help does not interrupt marked text"
            );
            cx.update_window(main, |_, w, cx| {
                query.update(cx, |q, cx| q.unmark_text(w, cx))
            })
            .unwrap();
            settle(cx, main);
            let before = cx
                .update_window(main, |_, w, cx| {
                    owner.update(cx, |v, cx| v.chats.update(cx, |l, cx| l.focus(w, cx)));
                    let focus = w.focused(cx).unwrap();
                    // The same action dispatched by Help > Keyboard Shortcuts, no new hotkey.
                    w.press("f1", cx);
                    focus
                })
                .unwrap();
            settle(cx, main);
            let help = cx.update(|cx| {
                owner
                    .read(cx)
                    .shortcuts_window
                    .expect("Help action opened reference")
            });
            cx.update_window(help, |_, w, cx| {
                // Production follow_appearance synchronizes system mode on open.
                // Pin only this isolated in-memory fixture after that hook ran.
                Theme::change(mode, None, cx);
                w.resize(size(px(width), px(800.)));
                w.bounds_changed(cx);
                w.activate_window();
            })
            .unwrap();
            settle(cx, help);
            cx.update_window(help, |_, w, cx| {
                assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark);
                assert!(w.focused(cx).is_some());
                for id in ["shortcuts-title", "shortcuts-copy", "shortcuts-close"] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.size.width > px(0.) && b.left() >= px(0.) && b.right() <= px(width),
                        "{id} at {width}"
                    );
                }
                // Real native selection and Copy, including the platform's Unicode glyph.
                let b = w.find("keys-Command Palette").bounds();
                w.drag(
                    point(b.left(), b.center().y),
                    point(b.right(), b.center().y),
                    cx,
                );
                let selected = TextSelection::selected_text(w, cx);
                assert!(!selected.is_empty(), "literal key text is selectable");
                w.press("secondary-c", cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), selected);
                for _ in 0..4 {
                    if w.find("shortcuts-copy").focused() == Some(true) {
                        break;
                    }
                    w.press("tab", cx);
                }
                assert_eq!(w.find("shortcuts-copy").focused(), Some(true));
                w.press("enter", cx);
                let text = cx.read_from_clipboard().unwrap().text().unwrap();
                assert!(text.contains("Command Palette: ⌘K"));
                assert!(text.contains("Sidebar list\nWith the chat list focused"));
                assert!(text.contains("outside text fields"));
                assert!(!text.contains("Stop:") && !text.contains("Terminal:"));
            })
            .unwrap();
            if let Some(dir) = std::env::var_os("PILOT_NEXT_SHORTCUTS_DIR") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(help)
                    .unwrap()
                    .save(dir.join(format!("{width}-{mode:?}.png")))
                    .unwrap();
            }
            cx.update_window(help, |_, w, cx| {
                w.scroll(
                    "shortcuts-root",
                    gpui_kit::ScrollDelta::Pixels(point(px(0.), px(-4000.))),
                    cx,
                )
            })
            .unwrap();
            settle(cx, help);
            cx.update_window(help, |_, w, _| {
                for id in [
                    "keys-Save changes",
                    "keys-Copy",
                    "keys-Close reference",
                    "keys-Hide other apps",
                ] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.left() >= px(0.) && b.right() <= px(width),
                        "{id} fits at {width}"
                    );
                }
                let last = w.find("keys-Hide other apps").bounds();
                assert!(
                    last.top() >= px(0.) && last.bottom() <= px(800.),
                    "last section is reachable by wheel"
                );
            })
            .unwrap();
            if let Some(dir) = std::env::var_os("PILOT_NEXT_SHORTCUTS_DIR") {
                cx.capture_screenshot(help)
                    .unwrap()
                    .save(
                        std::path::PathBuf::from(dir).join(format!("{width}-{mode:?}-bottom.png")),
                    )
                    .unwrap();
            }
            cx.update_window(help, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, main);
            assert!(cx.update(|cx| owner.read(cx).shortcuts_window.is_none()));
            cx.update_window(main, |_, w, cx| {
                assert!(before.is_focused(w), "exact originating focus restored");
                w.press("f1", cx);
            })
            .unwrap();
            settle(cx, main);
            let help = cx.update(|cx| owner.read(cx).shortcuts_window.unwrap());
            settle(cx, help);
            cx.update_window(help, |_, w, cx| {
                w.activate_window();
                w.press("secondary-w", cx);
            })
            .unwrap();
            settle(cx, main);
            assert!(cx.update(|cx| owner.read(cx).shortcuts_window.is_none()));
            cx.update_window(main, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
}
