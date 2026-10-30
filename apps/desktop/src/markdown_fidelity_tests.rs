//! Keyboard-copy regressions on the production TranscriptView in both feature paths.
use super::*;
use gpui_kit::{TestAppContext, component::text::SelectionFormat, test::TestWindowExt};

fn check_copy(cx: &mut TestAppContext, source: &str, expected: &str, format: SelectionFormat) {
    let (h, view) = readonly_tests::setup(
        cx,
        vec![Message::live(20, "assistant".into(), source.into())],
    );
    cx.update_window(h, |_, w, cx| {
        w.render_frame(cx);
        let text = view.read(cx).text_states[0].as_ref().unwrap().clone();
        text.update(cx, |t, cx| t.set_selection_format(format, cx));
        let focus = text.read(cx).focus_handle().clone();
        focus.focus(w, cx);
        w.press("secondary-a", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| {
        w.render_frame(cx);
        w.press("secondary-c", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), expected);
        click_copy(w, 20, cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), source);
    })
    .unwrap();
}

#[gpui_kit::test]
fn fenced_code_keyboard_copy_preserves_indentation_entities_and_final_blank_line(
    cx: &mut TestAppContext,
) {
    check_copy(
        cx,
        "```text\n  <b>&amp;</b> \\ * _\n\t日本語 👩🏽‍💻 e\u{301}\n\n```\n",
        "  <b>&amp;</b> \\ * _\n\t日本語 👩🏽‍💻 e\u{301}\n",
        SelectionFormat::Plain,
    );
}

#[gpui_kit::test]
fn fenced_whitespace_is_copyable_not_an_empty_prose_selection(cx: &mut TestAppContext) {
    check_copy(cx, "```\n \t  \n```", " \t  ", SelectionFormat::Plain);
}

#[gpui_kit::test]
fn explicit_markdown_source_selection_still_copies_fences(cx: &mut TestAppContext) {
    use gpui_kit::component::text::{TextView, TextViewState};
    struct SourceView(Entity<TextViewState>);
    impl Render for SourceView {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            TextView::new(&self.0).selection_format(SelectionFormat::Source)
        }
    }
    const SOURCE: &str = "```text\n  <tag>\n```";
    let (h, view) = cx.update(|cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(
            gpui_kit::WindowOptions {
                show: false,
                ..Default::default()
            },
            cx,
            |_, cx| {
                let text = cx.new(|cx| TextViewState::markdown(SOURCE, cx));
                cx.new(|_| SourceView(text))
            },
        )
        .unwrap()
    });
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| {
        w.render_frame(cx);
        let focus = view.read(cx).0.read(cx).focus_handle().clone();
        focus.focus(w, cx);
        w.press("secondary-a", cx);
        w.press("secondary-c", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), SOURCE);
    })
    .unwrap();
}

#[gpui_kit::test]
fn mixed_selection_keeps_existing_plain_markdown_transformations(cx: &mut TestAppContext) {
    check_copy(
        cx,
        "Before **bold** &amp; \\*.\n\n```text\n  <tag>\n```\n\n- café\n- `é`\n",
        "Before bold & *.\n  <tag>\ncafé\né",
        SelectionFormat::Plain,
    );
}

#[gpui_kit::test]
fn real_live_entry_promotion_retains_code_selection_but_not_new_canonical_readers(
    cx: &mut TestAppContext,
) {
    use gpui_kit::{point, px};
    use serde_json::json;
    let source = "```text\n  <tag> literal 日本語\n```";
    let mut model = crate::local_model::LiveTranscript::default();
    model.apply(&json!({"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":source}]}}));
    let live = model.rows();
    let id = live[0].id();
    assert!(live[0].reader_key().is_none());
    let (h, view) = readonly_tests::setup(cx, live);
    let (text, range, copied) = cx
        .update_window(h, |_, w, cx| {
            w.render_frame(cx);
            let text = view.read(cx).text_states[0].as_ref().unwrap().clone();
            let b = text.read(cx).bounds();
            w.drag(
                b.origin + point(px(16.), px(38.)),
                b.origin + point(px(140.), px(38.)),
                cx,
            );
            w.press("secondary-c", cx);
            let range = text.read(cx).selected_source_range().unwrap();
            let copied = cx.read_from_clipboard().unwrap().text().unwrap();
            assert!(!copied.is_empty());
            (text, range, copied)
        })
        .unwrap();
    model.apply(&json!({"type":"message_end","entry":{"id":30,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":source}]}]}}));
    let committed = model.rows();
    assert_eq!(committed[0].id(), id);
    assert!(committed[0].reader_key().is_some());
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| v.replace_readonly(committed, false, cx));
        w.render_frame(cx);
        assert_eq!(view.read(cx).text_states[0].as_ref(), Some(&text));
        assert_eq!(text.read(cx).selected_source_range(), Some(range));
        w.press("secondary-c", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), copied);
        view.update(cx, |v, cx| {
            v.replace_readonly(
                vec![
                    Message::live(id, "assistant".into(), source.into())
                        .anchored(crate::model::ReaderKey::model(31, 0, Some(0))),
                ],
                false,
                cx,
            )
        });
        assert_ne!(view.read(cx).text_states[0].as_ref(), Some(&text));
        assert!(
            view.read(cx).text_states[0]
                .as_ref()
                .unwrap()
                .read(cx)
                .selected_source_range()
                .is_none()
        );
    })
    .unwrap();
}
