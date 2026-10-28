//! Header … and sidebar row menus copy the exact chat's cached session path/link.
use super::*;
use gpui_kit::{
    Bounds, InputEvent, MouseButton, MouseDownEvent, MouseUpEvent, TestAppContext, WindowBounds,
    WindowOptions, component::menu::PopupMenu, size, test::TestWindowExt,
};
use serde_json::json;

const A: &str = "0f8e3c2a-9b1d-4e7f-a5c6-1d2e3f4a5b6c";
const B: &str = "AB12CD34-0000-4000-8000-00000000000F";
const C: &str = "c0ffee00-1111-4222-8333-444455556666";

fn setup(cx: &mut TestAppContext) -> (gpui_kit::AnyWindowHandle, Entity<LocalViewer>) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init_appearance(cx);
        LocalViewer::bind_keys(cx);
    });
    let (h, v) = cx.update(|cx| {
        let bounds = Bounds::new(Default::default(), size(px(1100.), px(800.)));
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            show: false,
            focus: false,
            ..Default::default()
        };
        gpui_kit::open_window(options, cx, |w, cx| {
            cx.new(|cx| LocalViewer::preview(PreviewState::Conversation, w, cx))
        })
        .unwrap()
    });
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.state.chats = Arc::new(vec![
                crate::local_model::chat(&json!({"id":A,"title":"Alpha","cwd":"/synthetic/project","sessionPath":"/data/sessions/alpha 私","state":"idle"})).unwrap(),
                crate::local_model::chat(&json!({"id":B,"title":"Bravo","cwd":"/synthetic/project","state":"idle"})).unwrap(),
                crate::local_model::chat(&json!({"id":C,"title":"Charlie","cwd":"/synthetic/project","sessionPath":"/data/sessions/charlie","state":"idle"})).unwrap(),
            ]);
            v.selected = Some(A.into());
            v.rebuild_nav(w, cx);
        });
        w.render_frame(cx);
    })
    .unwrap();
    (h, v)
}

fn settle(cx: &mut TestAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}

fn click_label(cx: &mut TestAppContext, h: gpui_kit::AnyWindowHandle, label: &str) {
    cx.update_window(h, |_, w, cx| {
        let position = w
            .within("popup-menu")
            .find_by_label(label)
            .bounds()
            .center();
        w.dispatch_event(
            MouseDownEvent {
                button: MouseButton::Left,
                position,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }
            .to_platform_input(),
            cx,
        );
        w.render_frame(cx);
        w.dispatch_event(
            MouseUpEvent {
                button: MouseButton::Left,
                position,
                modifiers: Default::default(),
                click_count: 1,
            }
            .to_platform_input(),
            cx,
        );
    })
    .unwrap();
    settle(cx, h);
}

fn clipboard(cx: &mut TestAppContext) -> Option<String> {
    cx.update(|cx| cx.read_from_clipboard().and_then(|c| c.text()))
}

fn open_header(cx: &mut TestAppContext, h: gpui_kit::AnyWindowHandle) {
    cx.update_window(h, |_, w, cx| w.click("history-menu", cx))
        .unwrap();
    settle(cx, h);
}

/// A disabled Kit item ignores activation: the menu stays open and nothing is copied.
fn assert_unavailable(cx: &mut TestAppContext, h: gpui_kit::AnyWindowHandle, label: &str) {
    let before = clipboard(cx);
    click_label(cx, h, label);
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("popup-menu").is_some(), "{label}")
    })
    .unwrap();
    assert_eq!(clipboard(cx), before, "{label}");
}

#[gpui_kit::test]
fn header_menu_copies_the_selected_chat_by_keyboard_and_pointer(cx: &mut TestAppContext) {
    let (h, v) = setup(cx);
    // Keyboard: open the header menu, arrow to Copy session path, Enter.
    open_header(cx, h);
    for _ in 0..8 {
        let on = cx
            .update_window(h, |_, w, _| {
                w.within("popup-menu")
                    .find_by_label("Copy session path")
                    .selected()
                    == Some(true)
            })
            .unwrap();
        if on {
            break;
        }
        cx.update_window(h, |_, w, cx| w.press("down", cx)).unwrap();
        settle(cx, h);
    }
    cx.update_window(h, |_, w, cx| w.press("enter", cx))
        .unwrap();
    settle(cx, h);
    assert_eq!(clipboard(cx).as_deref(), Some("/data/sessions/alpha 私"));
    cx.update_window(h, |_, w, _| assert!(w.try_find("popup-menu").is_none()))
        .unwrap();
    open_header(cx, h);
    click_label(cx, h, "Copy session link");
    assert_eq!(
        clipboard(cx).as_deref(),
        Some(format!("pilot://chat/{A}").as_str())
    );
    v.read_with(cx, |v, _| assert_eq!(v.selected.as_deref(), Some(A)));

    // After navigating, the header names the new selection.
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, _| v.selected = Some(C.into()));
        w.render_frame(cx);
    })
    .unwrap();
    open_header(cx, h);
    click_label(cx, h, "Copy session link");
    assert_eq!(
        clipboard(cx).as_deref(),
        Some(format!("pilot://chat/{C}").as_str())
    );
    open_header(cx, h);
    click_label(cx, h, "Copy session path");
    assert_eq!(clipboard(cx).as_deref(), Some("/data/sessions/charlie"));

    // Missing path and a non-canonical ID stay unavailable; nothing is copied.
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, _| v.selected = Some(B.into()));
        w.render_frame(cx);
    })
    .unwrap();
    open_header(cx, h);
    assert_unavailable(cx, h, "Copy session path (Unavailable)");
    assert_unavailable(cx, h, "Copy session link (Unavailable)");
    assert_eq!(clipboard(cx).as_deref(), Some("/data/sessions/charlie"));
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
    v.read_with(cx, |v, _| assert_eq!(v.selected.as_deref(), Some(B)));
}

#[gpui_kit::test]
fn row_menu_copies_its_own_chat_without_selecting_it(cx: &mut TestAppContext) {
    let (h, v) = setup(cx);
    let (transcript, editor) = v.read_with(cx, |v, _| (v.transcript.clone(), v.editor.clone()));
    cx.update_window(h, |_, w, cx| {
        w.right_click(SharedString::from(format!("chat-row-{C}")), cx)
    })
    .unwrap();
    settle(cx, h);
    // Copying needs no action inspection: this preview has no Local connection.
    click_label(cx, h, "Copy session path");
    assert_eq!(clipboard(cx).as_deref(), Some("/data/sessions/charlie"));
    cx.update_window(h, |_, w, cx| {
        w.right_click(SharedString::from(format!("chat-row-{C}")), cx)
    })
    .unwrap();
    settle(cx, h);
    click_label(cx, h, "Copy session link");
    assert_eq!(
        clipboard(cx).as_deref(),
        Some(format!("pilot://chat/{C}").as_str())
    );
    cx.update_window(h, |_, w, cx| {
        w.right_click(SharedString::from(format!("chat-row-{B}")), cx)
    })
    .unwrap();
    settle(cx, h);
    assert_unavailable(cx, h, "Copy session path (Unavailable)");
    assert_unavailable(cx, h, "Copy session link (Unavailable)");
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
    v.read_with(cx, |v, _| {
        assert_eq!(v.selected.as_deref(), Some(A));
        assert_eq!(v.transcript, transcript);
        assert_eq!(v.editor, editor);
    });
}

#[gpui_kit::test]
fn drafts_get_no_copy_actions_and_missing_summaries_are_unavailable(cx: &mut TestAppContext) {
    let (h, v) = setup(cx);
    let mut draft = v.read_with(cx, |v, _| v.state.chats[0].clone());
    draft.local_draft = true;
    cx.update_window(h, |_, w, cx| {
        let empty = PopupMenu::build(w, cx, |m, _, _| {
            crate::session_clipboard::items(m, Some(&draft))
        });
        assert!(empty.read(cx).is_empty());
        let none = PopupMenu::build(w, cx, |m, _, _| crate::session_clipboard::items(m, None));
        assert!(!none.read(cx).is_empty());
    })
    .unwrap();
    // A selected ID without its summary offers only unavailable copies.
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, _| v.selected = Some("unlisted".into()));
        w.render_frame(cx);
    })
    .unwrap();
    open_header(cx, h);
    assert_unavailable(cx, h, "Copy session path (Unavailable)");
    assert_unavailable(cx, h, "Copy session link (Unavailable)");
}
