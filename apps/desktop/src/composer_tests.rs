use super::{TranscriptView, tests::setup};
use gpui_kit::{
    App, AppContext, ElementInputHandler, Entity, Focusable, TestAppContext, Window,
    test::{TestInput, TestQueryExt, TestWindowExt},
};

fn enter_text(text: &str, view: &Entity<TranscriptView>, window: &mut Window, cx: &mut App) {
    window.press("secondary-l", cx);
    window.press("secondary-a", cx);
    let bounds = window.find_by_label("Local echo composer").bounds();
    let handler = ElementInputHandler::new(bounds, view.read(cx).composer.clone());
    TestInput::new(handler, window).commit_text(text, cx);
}

fn value(view: &Entity<TranscriptView>, cx: &App) -> String {
    view.read(cx).composer.read(cx).value().to_string()
}

fn range(view: &Entity<TranscriptView>, cx: &App) -> std::ops::Range<usize> {
    view.read(cx).composer.read(cx).selected_range()
}

#[gpui_kit::test]
fn composer_grapheme_arrows_shift_selection_delete_and_undo(cx: &mut TestAppContext) {
    let (handle, view) = setup(cx);
    let clusters = ["e\u{301}", "👨‍👩‍👧", "🇫🇷", "👍🏽", "한", "한", "क्‍ष", "\r\n"];
    for cluster in clusters {
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let text = format!("A{cluster}B");
            enter_text(&text, &view, window, cx);
            window.press("left", cx);
            assert_eq!(
                range(&view, cx),
                1 + cluster.len()..1 + cluster.len(),
                "before B: {cluster}"
            );
            window.press("left", cx);
            assert_eq!(
                range(&view, cx),
                1..1,
                "Left must cross one grapheme: {cluster}"
            );
            window.press("shift-right", cx);
            assert_eq!(
                range(&view, cx),
                1..1 + cluster.len(),
                "Shift-Right selects one grapheme: {cluster}"
            );
            window.press("secondary-c", cx);
            assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), cluster);
            window.press("shift-left", cx);
            assert_eq!(range(&view, cx), 1..1);
            window.press("right", cx);
            window.press("backspace", cx);
            assert_eq!(value(&view, cx), "AB", "Backspace: {cluster}");
            window.press("secondary-z", cx);
            assert_eq!(
                value(&view, cx),
                text,
                "Undo must restore the complete grapheme"
            );
            #[cfg(target_os = "macos")]
            window.press("secondary-shift-z", cx);
            #[cfg(target_os = "linux")]
            window.press("ctrl-y", cx);
            assert_eq!(value(&view, cx), "AB");
            window.press("secondary-z", cx);
            window.press("secondary-a", cx);
            window.press("left", cx);
            window.press("right", cx);
            assert_eq!(range(&view, cx), 1..1);
            window.press("delete", cx);
            assert_eq!(value(&view, cx), "AB", "Forward delete: {cluster}");
            window.press("secondary-z", cx);
            assert_eq!(value(&view, cx), text);
            window.press("secondary-a", cx);
            window.press("right", cx);
            window.press("left", cx);
            window.press("shift-left", cx);
            assert_eq!(
                range(&view, cx),
                1..1 + cluster.len(),
                "reverse selection: {cluster}"
            );
            window.press("backspace", cx);
            assert_eq!(value(&view, cx), "AB");
        })
        .unwrap();
        cx.run_until_parked();
    }
}

#[gpui_kit::test]
fn composer_graphemes_cross_real_rope_chunks(cx: &mut TestAppContext) {
    let (handle, view) = setup(cx);
    let cluster = "👨‍👩‍👧";
    let count = 200;
    let text = format!("x{}", cluster.repeat(count));
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        enter_text(&text, &view, window, cx);
        let mut offset = 0;
        let split = view
            .read(cx)
            .composer
            .read(cx)
            .text()
            .chunks()
            .any(|chunk| {
                offset += chunk.len();
                offset < text.len() && offset > 1 && !(offset - 1).is_multiple_of(cluster.len())
            });
        assert!(
            split,
            "fixture must put a grapheme across a real rope chunk boundary"
        );
        for remaining in (0..count).rev() {
            window.press("left", cx);
            let expected = 1 + remaining * cluster.len();
            assert_eq!(range(&view, cx), expected..expected);
        }
        window.press("left", cx);
        assert_eq!(range(&view, cx), 0..0);
        window.press("right", cx);
        for step in 1..=count {
            window.press("right", cx);
            let expected = 1 + step * cluster.len();
            assert_eq!(range(&view, cx), expected..expected);
        }
    })
    .unwrap();
}

#[gpui_kit::test]
fn composer_marked_text_cancel_commit_undo_and_enter(cx: &mut TestAppContext) {
    let (handle, view) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        enter_text("prefix ", &view, window, cx);
        let bounds = window.find_by_label("Local echo composer").bounds();
        let handler = ElementInputHandler::new(bounds, view.read(cx).composer.clone());
        let mut input = TestInput::new(handler, window);
        input.compose_text(None, "に", Some(1..1), cx);
        input.compose_text(None, "にほん", Some(3..3), cx);
        assert_eq!(input.marked_text_range(cx), Some(7..10));
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| {
        window.press("enter", cx);
        window.press("shift-enter", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| {
        assert_eq!(
            view.read(cx).transcript.messages().len(),
            24,
            "marked text cannot submit"
        );
        assert_eq!(
            value(&view, cx),
            "prefix にほん",
            "raw Enter paths must not mutate marked text"
        );
        let bounds = window.find_by_label("Local echo composer").bounds();
        let handler = ElementInputHandler::new(bounds, view.read(cx).composer.clone());
        let mut input = TestInput::new(handler, window);
        input.compose_text(None, "", Some(0..0), cx);
        assert!(input.marked_text_range(cx).is_none());
        assert_eq!(value(&view, cx), "prefix ");
        input.compose_text(None, "にほん", Some(3..3), cx);
        input.commit_text("日本", cx);
        assert!(input.marked_text_range(cx).is_none());
        assert_eq!(value(&view, cx), "prefix 日本");
        window.press("secondary-z", cx);
        assert_eq!(
            value(&view, cx),
            "prefix ",
            "preedit must be one undo transaction"
        );
        #[cfg(target_os = "macos")]
        window.press("secondary-shift-z", cx);
        #[cfg(target_os = "linux")]
        window.press("ctrl-y", cx);
        assert_eq!(value(&view, cx), "prefix 日本");
        window.press("enter", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update(|cx| {
        assert_eq!(view.read(cx).transcript.messages().len(), 26);
        assert_eq!(
            view.read(cx).transcript.messages()[24].source(),
            "prefix 日本"
        );
        assert_eq!(value(&view, cx), "");
    });
}

#[gpui_kit::test]
fn composer_utf16_preedit_hangul_rewrite_and_focus(cx: &mut TestAppContext) {
    let (handle, view) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        enter_text("😀 ", &view, window, cx);
        let composer = view.read(cx).composer.clone();
        let bounds = window.find_by_label("Local echo composer").bounds();
        let handler = ElementInputHandler::new(bounds, composer.clone());
        let mut input = TestInput::new(handler, window);
        for preedit in ["ㅎ", "하", "한"] {
            input.compose_text(None, preedit, Some(1..1), cx);
            assert_eq!(
                input.marked_text_range(cx),
                Some(3..4),
                "UTF-16 prefix includes a surrogate pair"
            );
            assert_eq!(input.selected_text_range(cx).unwrap().range, 4..4);
        }
        input.commit_text("한", cx);
        assert!(input.marked_text_range(cx).is_none());
        assert_eq!(value(&view, cx), "😀 한");
        assert_eq!(
            range(&view, cx),
            8..8,
            "ordinary editor coordinates are UTF-8 bytes"
        );
        assert!(composer.read(cx).focus_handle(cx).is_focused(window));
        window.press("left", cx);
        assert_eq!(range(&view, cx), 5..5);
        window.press("right", cx);
        window.press("backspace", cx);
        assert_eq!(value(&view, cx), "😀 ");
        window.press("secondary-z", cx);
        assert_eq!(value(&view, cx), "😀 한");
    })
    .unwrap();
}

#[gpui_kit::test]
fn composer_regional_indicator_context_across_rope_chunks(cx: &mut TestAppContext) {
    let (handle, view) = setup(cx);
    let text = "🇫🇷".repeat(300);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        enter_text(&text, &view, window, cx);
        assert!(view.read(cx).composer.read(cx).text().chunks().count() > 1);
        for remaining in (0..300).rev() {
            window.press("left", cx);
            let expected = remaining * 8;
            assert_eq!(
                range(&view, cx),
                expected..expected,
                "RI pairing needs preceding chunk context"
            );
        }
        for step in 1..=300 {
            window.press("right", cx);
            let expected = step * 8;
            assert_eq!(range(&view, cx), expected..expected);
        }
    })
    .unwrap();
}
