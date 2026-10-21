use super::*;
use crate::local_model::LiveTranscript;
use gpui_kit::{ScrollDelta, TestAppContext, point, px, test::TestWindowExt};
use serde_json::json;
fn model() -> LiveTranscript {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"entry_appended","entry":{"id":20,"head":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"a","name":"bash","arguments":{"command":"printf synthetic"}}]}]}}));
    model.apply(&json!({"type":"tool_execution_start","toolCallId":"a","toolName":"bash"}));
    model.apply(&json!({"type":"tool_execution_update","toolCallId":"a","output":{"set":"synthetic output 日本語\nsecond line"}}));
    model
}
#[gpui_kit::test]
fn tool_details_are_lazy_copyable_and_do_not_parse_hidden_updates(cx: &mut TestAppContext) {
    let mut model = model();
    let rows = model.rows();
    let id = rows[0].id();
    let (handle, view) = super::readonly_tests::setup(cx, rows);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(view.read(cx).work_ui.step_info("a", cx), (false, 0));
        assert!(view.read(cx).scroller.read(cx).is_following_tail());
        window.click("step-toggle-call:a", cx);
    })
    .unwrap();
    cx.run_until_parked();
    let text = cx
        .update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(view.read(cx).work_ui.step_info("a", cx), (true, 2));
            assert_eq!(
                view.read(cx).scroller.read(cx).logical_scroll_top().item_ix,
                0,
                "a disclosure that still fits has no scroll jump"
            );
            window.click("copy-call:a-Output", cx);
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().unwrap(),
                "synthetic output 日本語\nsecond line"
            );
            let text = view.read(cx).work_ui.body_state("a", "Output", cx);
            window.click("step-toggle-call:a", cx);
            text
        })
        .unwrap();
    cx.run_until_parked();
    let prior = cx.update(|cx| text.read(cx).rendered_text().source().to_string());
    model.apply(&json!({"type":"tool_execution_update","toolCallId":"a","output":{"append":"\nnew output"}}));
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.replace_readonly(model.rows(), false, cx)
        });
        window.render_frame(cx);
        assert_eq!(text.read(cx).rendered_text().source(), prior);
        assert_eq!(view.read(cx).work_ui.step_info("a", cx), (false, 2));
        window.click(SharedString::from(format!("work-toggle-{id}")), cx);
    })
    .unwrap();
    cx.run_until_parked();
    model.apply(&json!({"type":"run_end"}));
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.replace_readonly(model.rows(), false, cx)
        });
        window.render_frame(cx);
        assert!(
            !view.read(cx).work_ui.group_open(id, cx),
            "explicit group choice survives terminal status"
        );
    })
    .unwrap();
}
#[gpui_kit::test]
fn tool_output_selection_and_expansion_survive_real_unmount_and_prepend_regroup(
    cx: &mut TestAppContext,
) {
    let mut model = model();
    let work = model.rows();
    let mut rows: Vec<_> = (100..150)
        .map(|id| Message::live(id, "assistant".into(), crate::model::REPLY.into()))
        .collect();
    rows.extend(work.clone());
    let (handle, view) = super::readonly_tests::setup(cx, rows);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.click("step-toggle-call:a", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, _, cx| {
        view.update(cx, |view, cx| view.latest(cx))
    })
    .unwrap();
    cx.run_until_parked();
    let (text, range, copied) = cx
        .update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let text = view.read(cx).work_ui.body_state("a", "Output", cx);
            let start = text.read(cx).bounds().origin + point(px(18.), px(24.));
            window.drag(start, start + point(px(90.), px(0.)), cx);
            // HTML/pre does not have raw HTML source spans. Assert the actual
            // rendered selection and clipboard, not a fabricated source offset.
            let range = gpui_kit::base::TextSelection::selected_text(window, cx);
            assert!(!range.is_empty());
            window.press("secondary-c", cx);
            let copied = cx.read_from_clipboard().unwrap().text().unwrap();
            assert!(!copied.is_empty());
            window.scroll(
                "viewport",
                ScrollDelta::Pixels(point(px(0.), px(10000.))),
                cx,
            );
            (text, range, copied)
        })
        .unwrap();
    cx.run_until_parked();
    model.apply(&json!({"type":"entry_appended","entry":{"id":10,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"older","name":"read","arguments":{"path":"older.rs"}}]}]}}));
    let mut next: Vec<_> = (80..150)
        .map(|id| Message::live(id, "assistant".into(), crate::model::REPLY.into()))
        .collect();
    next.extend(model.rows());
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| view.replace_readonly(next, false, cx));
        window.render_frame(cx);
        assert_eq!(view.read(cx).work_ui.body_state("a", "Output", cx), text);
        assert!(view.read(cx).work_ui.step_info("a", cx).0);
        assert_eq!(
            gpui_kit::base::TextSelection::selected_text(window, cx),
            range
        );
        window.press("secondary-c", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), copied);
        window.scroll(
            "viewport",
            ScrollDelta::Pixels(point(px(0.), px(-10000.))),
            cx,
        );
        window.render_frame(cx);
        window.press("secondary-c", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), copied);
    })
    .unwrap();
}
