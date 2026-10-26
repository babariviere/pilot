use super::*;
use crate::local_model::LiveTranscript;
use gpui_kit::{ScrollDelta, TestAppContext, point, px, test::TestWindowExt};
use serde_json::json;
fn model() -> LiveTranscript {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"entry_appended","entry":{"id":20,"head":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"a","name":"bash","arguments":{"command":"printf synthetic","timeout":30}}]}]}}));
    model.apply(&json!({"type":"tool_execution_start","toolCallId":"a","toolName":"bash"}));
    model.apply(&json!({"type":"tool_execution_update","toolCallId":"a","output":{"set":"synthetic output 日本語\nsecond line"}}));
    model
}

#[gpui_kit::test]
fn an_early_failure_is_findable_without_expanding_all_work(cx: &mut TestAppContext) {
    let mut model = LiveTranscript::default();
    let calls: Vec<_> = (0..8).map(|i| json!({"type":"toolCall","id":format!("task-{i}"),"name":"read","arguments":{"path":format!("synthetic-long-path-{i}.rs")}})).collect();
    model.apply(&json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":calls}]}}));
    model.apply(&json!({"type":"tool_execution_end","toolCallId":"task-0","isError":true}));
    let rows = model.rows();
    let group = rows[0].id();
    assert_eq!(rows[0].work_data().unwrap().failures, 1);
    let (handle, view) = super::readonly_tests::setup(cx, rows);
    let group_key = SharedString::from(format!("work-toggle-{group}"));
    cx.update_window(handle, |_, window, cx| {
        window.draw(cx).clear(cx);
        assert!(!view.read(cx).work_ui.group_open(group, cx));
        assert!(window.find_all("step-toggle-call:task-0").is_empty());
        let header = window.find(group_key.clone());
        assert!(header.label().unwrap().contains("1 failed"));
        window.click(group_key.clone(), cx);
        window.render_frame(cx);
        let row = window.find("step-toggle-call:task-0").bounds();
        let status = window
            .within("step-toggle-call:task-0")
            .find("disclosure-status")
            .bounds();
        assert!(row.size.height > px(0.));
        assert!(status.size.width > px(0.) && status.right() <= row.right());
        let header = window.find(group_key.clone()).bounds();
        let header_status = window
            .within(group_key.clone())
            .find("disclosure-status")
            .bounds();
        assert!(header_status.right() <= header.right());
        window.click(group_key.clone(), cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| {
        window.draw(cx).clear(cx);
        assert!(!view.read(cx).work_ui.group_open(group, cx));
        // Failure count stays visible even when explicit choice hides all steps.
        assert!(
            window
                .within(group_key.clone())
                .find("disclosure-status")
                .bounds()
                .size
                .width
                > px(0.)
        );
        window.click(group_key.clone(), cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| {
        window.draw(cx).clear(cx);
        // Explicit expansion is complete, not the automatic bounded preview.
        for i in 0..8 {
            assert!(
                window
                    .find(SharedString::from(format!("step-toggle-call:task-{i}")))
                    .bounds()
                    .size
                    .height
                    > px(0.)
            );
        }
    })
    .unwrap();
}
#[gpui_kit::test]
fn working_disclosure_mounted_frame_diagnosis(cx: &mut TestAppContext) {
    let mut model = LiveTranscript::default();
    let calls:Vec<_>=(0..24).map(|i|json!({"type":"toolCall","id":format!("jitter-{i}"),"name":"read","arguments":{"path":format!("synthetic-{i}.rs")}})).collect();
    model.apply(&json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":calls}]}}));
    for i in 0..24 {
        model.apply(&json!({"type":"tool_execution_start","toolCallId":format!("jitter-{i}"),"toolName":"read"}));
    }
    let mut rows: Vec<_> = (100..120)
        .map(|i| Message::live(i, "assistant".into(), crate::model::REPLY.into()))
        .collect();
    rows.extend(model.rows());
    let id = rows.last().unwrap().id();
    let (handle, view) = super::readonly_tests::setup(cx, rows);
    let key = SharedString::from(format!("work-toggle-{id}"));
    let mut collapsed_y = None;
    for action in ["initial", "open", "collapse", "expand"] {
        if action != "initial" {
            cx.update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                window.click(key.clone(), cx);
            })
            .unwrap();
        }
        let mut trace = Vec::new();
        for frame in 0..12 {
            let sample=cx.update_window(handle,|_,window,cx|{window.render_frame(cx);let h=window.find(key.clone()).bounds();let t=window.within(key.clone()).find("disclosure-text").bounds();let s=view.read(cx).scroller.read(cx);let p=s.logical_scroll_top();json!({"frame":frame,"header_y":f32::from(h.top()),"relative_text_x":f32::from(t.left()-h.left()),"item":p.item_ix,"offset":f32::from(p.offset_in_item),"following":s.is_following_tail(),"open":view.read(cx).work_ui.group_open(id,cx)})}).unwrap();
            trace.push(sample);
            cx.run_until_parked();
        }
        // Sample multiple mounted frames, not just the settled final offset.
        if action == "collapse" {
            collapsed_y = trace.last().and_then(|s| s["header_y"].as_f64());
        }
        if action == "expand" {
            let expected = collapsed_y.unwrap();
            assert!(
                trace
                    .iter()
                    .all(|s| (s["header_y"].as_f64().unwrap() - expected).abs() <= 1.),
                "expanding must retain the clicked header instead of following the new bottom: {}",
                json!(trace)
            );
        }
    }
}
#[gpui_kit::test]
fn a_fitting_disclosure_can_resume_following_with_a_real_bottom_wheel(cx: &mut TestAppContext) {
    let mut model = model();
    let rows = model.rows();
    let id = rows[0].id();
    let (handle, view) = super::readonly_tests::setup(cx, rows);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.click(SharedString::from(format!("work-toggle-{id}")), cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert!(!view.read(cx).scroller.read(cx).is_following_tail());
        window.scroll("viewport", ScrollDelta::Pixels(point(px(0.), px(-80.))), cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update(|cx| assert!(view.read(cx).scroller.read(cx).is_following_tail()));
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
        assert!(!view.read(cx).work_ui.group_open(id, cx));
        window.click(SharedString::from(format!("work-toggle-{id}")), cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        let button = window.find("step-toggle-call:a").bounds();
        let label = window
            .within("step-toggle-call:a")
            .find("disclosure-text")
            .bounds();
        let leading = window
            .within("step-toggle-call:a")
            .find("disclosure-leading")
            .bounds();
        // Small chevron + quarter-rem gap + inline kind icon consume two rem.
        // Check actual slots, not a one-icon pixel bound or a wider allowance.
        let rem = window.rem_size();
        assert_eq!(leading.size.width, rem * 2.);
        assert!((label.left() - leading.right() - rem * 0.25).abs() < px(0.1));
        assert!(
            leading.left() >= button.left()
                && leading.left() - button.left() < rem
                && label.right() <= button.right(),
            "semantic work text must be leading-aligned, not centered in the row"
        );
        assert!(!view.read(cx).scroller.read(cx).is_following_tail());
        window.click("step-toggle-call:a", cx);
    })
    .unwrap();
    cx.run_until_parked();
    let text = cx
        .update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(view.read(cx).work_ui.step_info("a", cx), (true, 2));
            window.click("copy-call:a-Command", cx);
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().unwrap(),
                "printf synthetic"
            );
            window.click("arguments-toggle-call:a", cx);
            window.draw(cx).clear(cx);
            assert_eq!(
                view.read(cx).work_ui.step_info("a", cx),
                (true, 3),
                "raw arguments get a parser only on their own intentional expansion"
            );
            window.click("copy-call:a-Arguments", cx);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(
                    &cx.read_from_clipboard().unwrap().text().unwrap()
                )
                .unwrap(),
                json!({"command":"printf synthetic","timeout":30})
            );
            window.click("arguments-toggle-call:a", cx);
            window.draw(cx).clear(cx);
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
        assert_eq!(view.read(cx).work_ui.step_info("a", cx), (false, 3));
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
    let group = work[0].id();
    let mut rows: Vec<_> = (100..150)
        .map(|id| Message::live(id, "assistant".into(), crate::model::REPLY.into()))
        .collect();
    rows.extend(work.clone());
    let (handle, view) = super::readonly_tests::setup(cx, rows);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.click(SharedString::from(format!("work-toggle-{group}")), cx);
    })
    .unwrap();
    cx.run_until_parked();
    // Opening retains the header at the viewport bottom. Explicitly navigate
    // to the newly revealed child before interacting with it.
    cx.update_window(handle, |_, _, cx| {
        view.update(cx, |view, cx| view.latest(cx));
    })
    .unwrap();
    cx.run_until_parked();
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

#[gpui_kit::test]
fn a_selected_assistant_note_keeps_its_document_when_it_folds_into_work(cx: &mut TestAppContext) {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":"Selected note 日本語 stays owned."}]}]}}));
    let (handle, view) = super::readonly_tests::setup(cx, model.rows());
    let (text, copied) = cx
        .update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let text = view.read(cx).text_states[0].clone().unwrap();
            let start = text.read(cx).bounds().origin + point(px(3.), px(10.));
            window.drag(start, start + point(px(90.), px(0.)), cx);
            window.press("secondary-c", cx);
            let copied = cx.read_from_clipboard().unwrap().text().unwrap();
            assert!(!copied.is_empty());
            (text, copied)
        })
        .unwrap();
    model.apply(&json!({"type":"entry_appended","entry":{"id":21,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"a","name":"read","arguments":{"path":"a.rs"}}]}]}}));
    model.apply(&json!({"type":"tool_execution_end","toolCallId":"a","result":{"content":[{"type":"text","text":"complete"}]}}));
    let group = model.rows()[0].id();
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.replace_readonly(model.rows(), false, cx)
        });
        window.render_frame(cx);
        window.press("secondary-c", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), copied);
        assert!(text.read(cx).selected_source_range().is_some());
        assert!(
            view.read(cx).work_ui.group_open(group, cx),
            "grouping must not auto-hide the selected note even when work is complete"
        );
    })
    .unwrap();
}

#[gpui_kit::test]
fn explicit_closed_work_survives_virtualization_and_canonical_regroup(cx: &mut TestAppContext) {
    let mut model = model();
    let work = model.rows();
    let group = work[0].id();
    let mut rows: Vec<_> = (100..150)
        .map(|id| Message::live(id, "assistant".into(), crate::model::REPLY.into()))
        .collect();
    rows.extend(work);
    let (handle, view) = super::readonly_tests::setup(cx, rows);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        let key = SharedString::from(format!("work-toggle-{group}"));
        window.click(key.clone(), cx);
        window.render_frame(cx);
        assert!(view.read(cx).work_ui.group_open(group, cx));
        window.click(key, cx);
        window.render_frame(cx);
        assert!(!view.read(cx).work_ui.group_open(group, cx));
        window.scroll(
            "viewport",
            ScrollDelta::Pixels(point(px(0.), px(100000.))),
            cx,
        );
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert!(
            window
                .find_all(SharedString::from(format!("work-toggle-{group}")))
                .is_empty(),
            "group must actually unmount"
        );
    })
    .unwrap();
    // An earlier canonical call joins the existing group while it is offscreen.
    model.apply(&json!({"type":"entry_appended","entry":{"id":10,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"earlier","name":"read","arguments":{"path":"older.rs"}}]}]}}));
    model.apply(
        &json!({"type":"tool_execution_update","toolCallId":"a","output":{"append":"late output"}}),
    );
    let mut rows: Vec<_> = (80..150)
        .map(|id| Message::live(id, "assistant".into(), crate::model::REPLY.into()))
        .collect();
    let work = model.rows();
    let next_group = work[0].id();
    assert_eq!(work[0].work_data().unwrap().calls().count(), 2);
    rows.extend(work);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |v, cx| v.replace_readonly(rows, false, cx));
        window.render_frame(cx);
        assert!(!view.read(cx).work_ui.group_open(next_group, cx));
        window.scroll(
            "viewport",
            ScrollDelta::Pixels(point(px(0.), px(-100000.))),
            cx,
        );
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        let key = SharedString::from(format!("work-toggle-{next_group}"));
        assert!(window.find(key.clone()).bounds().size.height > px(0.));
        assert!(!view.read(cx).work_ui.group_open(next_group, cx));
        assert!(window.find_all("step-toggle-call:a").is_empty());
        assert_eq!(view.read(cx).work_ui.step_info("a", cx), (false, 0));
        window.click(key, cx);
        window.render_frame(cx);
        assert!(view.read(cx).work_ui.group_open(next_group, cx));
        assert!(window.find("step-toggle-call:a").bounds().size.height > px(0.));
    })
    .unwrap();
}
