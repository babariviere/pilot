use super::*;
use crate::local_model::LiveTranscript;
use crate::work_view::{Mode, TAIL};
use gpui_kit::{ScrollDelta, TestAppContext, point, px, test::TestWindowExt};
use serde_json::json;
use std::time::Duration;
fn end(model: &mut LiveTranscript, id: &str, entry: u64, error: bool, text: &str) {
    model.apply(&json!({"type":"tool_execution_end","toolCallId":id,"isError":error,"entry":{"id":entry,"kind":"pi.tool","model":[{"role":"toolResult","toolCallId":id,"isError":error,"content":[{"type":"text","text":text}]}]}}));
}
/// A live run with `calls` commands; every call but the last has finished.
fn live(calls: u64) -> LiveTranscript {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"run_start"}));
    for i in 0..calls {
        model.apply(&json!({"type":"entry_appended","entry":{"id":20+2*i,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":format!("c{i}"),"name":"bash","arguments":{"command":format!("echo step-{i}")}}]}]}}));
        model.apply(
            &json!({"type":"tool_execution_start","toolCallId":format!("c{i}"),"toolName":"bash"}),
        );
        if i + 1 < calls {
            end(&mut model, &format!("c{i}"), 21 + 2 * i, false, "done");
        }
    }
    model
}
fn shape(
    cx: &mut TestAppContext,
    handle: gpui_kit::AnyWindowHandle,
    view: &Entity<TranscriptView>,
    id: u64,
) -> (Mode, Vec<Vec<usize>>) {
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        view.read(cx).work_ui.group_shape(id, cx)
    })
    .unwrap()
}
fn publish(
    cx: &mut TestAppContext,
    handle: gpui_kit::AnyWindowHandle,
    view: &Entity<TranscriptView>,
    model: &mut LiveTranscript,
) {
    let rows = model.rows();
    cx.update_window(handle, |_, _, cx| {
        view.update(cx, |view, cx| view.replace_readonly(rows, false, cx))
    })
    .unwrap();
    cx.run_until_parked();
}

#[gpui_kit::test]
fn a_live_group_previews_its_latest_five_steps_until_the_user_chooses(cx: &mut TestAppContext) {
    // Exactly five steps fit; a sixth moves the oldest behind Show earlier.
    for (calls, hidden) in [(5u64, false), (6, true)] {
        let rows = live(calls).rows();
        let id = rows[0].id();
        let (handle, view) = super::readonly_tests::setup(cx, rows);
        let last = calls as usize;
        assert_eq!(
            shape(cx, handle, &view, id),
            (Mode::Tail, (last - TAIL..last).map(|i| vec![i]).collect())
        );
        cx.update_window(handle, |_, window, _| {
            assert_eq!(!window.find_all(("work-earlier", id)).is_empty(), hidden);
        })
        .unwrap();
    }
    let mut model = live(7);
    let rows = model.rows();
    let id = rows[0].id();
    let (handle, view) = super::readonly_tests::setup(cx, rows);
    assert_eq!(
        shape(cx, handle, &view, id),
        (Mode::Tail, (7 - TAIL..7).map(|i| vec![i]).collect())
    );
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert!(
            !view.read(cx).work_ui.group_open(id, cx),
            "the passive preview is not an explicit open"
        );
        assert!(window.find_all("step-toggle-call:c1").is_empty());
        assert!(window.find("step-toggle-call:c6").bounds().size.height > px(0.));
        // Earlier calls are one click away, behind Show earlier.
        assert!(window.find_all(("work-ribbon", id)).is_empty());
        let header = window.find(SharedString::from(format!("work-toggle-{id}")));
        assert!(
            header
                .label()
                .unwrap()
                .starts_with("Working · ran echo step-6")
        );
        assert_eq!(
            view.read(cx).work_ui.step_info("c6", cx),
            (false, 0),
            "no detailed code or output opens on its own"
        );
        window.click(("work-earlier", id), cx);
    })
    .unwrap();
    cx.run_until_parked();
    assert_eq!(
        shape(cx, handle, &view, id),
        (Mode::List, (0..7).map(|i| vec![i]).collect())
    );
    end(&mut model, "c6", 40, false, "done");
    model.apply(&json!({"type":"run_end"}));
    publish(cx, handle, &view, &mut model);
    assert_eq!(
        shape(cx, handle, &view, id).0,
        Mode::List,
        "explicit open outlives the run"
    );
}

#[gpui_kit::test]
fn the_tail_folds_when_the_run_ends_and_the_first_error_stays_visible(cx: &mut TestAppContext) {
    let mut model = live(3);
    let rows = model.rows();
    let id = rows[0].id();
    let (handle, view) = super::readonly_tests::setup(cx, rows);
    assert_eq!(
        shape(cx, handle, &view, id).1.len(),
        3,
        "fewer than five: all shown"
    );
    end(&mut model, "c2", 40, true, "noise\nError: synthetic exit 1");
    // Between the result and run_end the run is still working.
    publish(cx, handle, &view, &mut model);
    assert_eq!(shape(cx, handle, &view, id).0, Mode::Tail);
    model.apply(&json!({"type":"run_end"}));
    publish(cx, handle, &view, &mut model);
    assert_eq!(shape(cx, handle, &view, id), (Mode::Folded, vec![]));
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert!(window.find_all("step-toggle-call:c0").is_empty());
        let header = window.find(SharedString::from(format!("work-toggle-{id}")));
        assert!(
            header
                .label()
                .unwrap()
                .starts_with("echo step-2 failed · ran 2 commands"),
            "{:?}",
            header.label()
        );
        let error = window.find(("work-first-error", id));
        assert!(error.bounds().size.height > px(0.));
        window.click(("work-first-error", id), cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        // Just that call opens; the group itself stays folded.
        assert_eq!(view.read(cx).work_ui.step_info("c2", cx), (true, 2));
        assert!(window.find("step-toggle-call:c2").bounds().size.height > px(0.));
        assert!(window.find_all("step-toggle-call:c1").is_empty());
        assert!(!view.read(cx).work_ui.group_open(id, cx));
    })
    .unwrap();
}

#[gpui_kit::test]
fn an_explicit_choice_overrides_the_live_tail_through_activity(cx: &mut TestAppContext) {
    let mut model = live(2);
    let rows = model.rows();
    let id = rows[0].id();
    let (handle, view) = super::readonly_tests::setup(cx, rows);
    assert_eq!(shape(cx, handle, &view, id).0, Mode::Tail);
    let key = SharedString::from(format!("work-toggle-{id}"));
    cx.update_window(handle, |_, window, cx| window.click(key.clone(), cx))
        .unwrap();
    cx.run_until_parked();
    assert_eq!(shape(cx, handle, &view, id), (Mode::Folded, vec![]));
    end(&mut model, "c1", 30, false, "done");
    model.apply(&json!({"type":"entry_appended","entry":{"id":31,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"c2","name":"bash","arguments":{"command":"echo more"}}]}]}}));
    model.apply(&json!({"type":"tool_execution_start","toolCallId":"c2","toolName":"bash"}));
    publish(cx, handle, &view, &mut model);
    assert_eq!(
        shape(cx, handle, &view, id).0,
        Mode::Folded,
        "activity never reopens"
    );
    cx.update_window(handle, |_, window, cx| window.click(key.clone(), cx))
        .unwrap();
    cx.run_until_parked();
    assert_eq!(shape(cx, handle, &view, id).1.len(), 3);
    // A new user turn ends Working for this group without run_end.
    model.apply(&json!({"type":"entry_appended","entry":{"id":40,"kind":"pi.user","model":[{"role":"user","content":[{"type":"text","text":"next"}]}]}}));
    let rows = model.rows();
    assert!(!rows[0].work_data().unwrap().active);
}

#[gpui_kit::test]
fn many_calls_read_as_one_line_and_only_the_running_call_bounces(cx: &mut TestAppContext) {
    // Screenshot scale: dozens of mixed calls, a few failed, the last running.
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"run_start"}));
    for i in 0..60u64 {
        let (name, args) = match i % 3 {
            0 => ("bash", json!({"command": format!("echo step-{i}")})),
            1 => ("read", json!({"path": format!("src/f{i}.rs")})),
            _ => (
                "edit",
                json!({"path": format!("src/e{i}.rs"), "oldText": "a", "newText": "b"}),
            ),
        };
        model.apply(&json!({"type":"entry_appended","entry":{"id":20+2*i,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":format!("c{i}"),"name":name,"arguments":args}]}]}}));
        model.apply(
            &json!({"type":"tool_execution_start","toolCallId":format!("c{i}"),"toolName":name}),
        );
        if i < 59 {
            end(
                &mut model,
                &format!("c{i}"),
                21 + 2 * i,
                i % 17 == 4,
                "done",
            );
        }
    }
    let rows = model.rows();
    let id = rows[0].id();
    let (handle, view) = super::readonly_tests::setup(cx, rows);
    let tops = |cx: &mut TestAppContext, ms: u64| -> Vec<f32> {
        cx.executor().advance_clock(Duration::from_millis(ms));
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.draw(cx).clear(cx);
            (0..3usize)
                .map(|i| {
                    f32::from(
                        window
                            .within("work-dots-call:c59")
                            .find(("work-dot", i))
                            .bounds()
                            .top(),
                    )
                })
                .collect()
        })
        .unwrap()
    };
    cx.update_window(handle, |_, window, cx| {
        window.draw(cx).clear(cx);
        // No ribbon or icon grid: one line, then the latest five steps.
        assert!(window.find_all(("work-ribbon", id)).is_empty());
        assert!(window.find_all("work-cell-call:c0").is_empty());
        let header = window.find(SharedString::from(format!("work-toggle-{id}")));
        assert!(header.label().unwrap().starts_with("Working"));
        assert!(header.bounds().size.height < px(40.), "one line");
        // Only the running call has dots; finished and failed ones keep glyphs.
        assert!(window.find("work-dots-call:c59").bounds().size.width > px(0.));
        assert!(window.find_all("work-dots-call:c58").is_empty());
        assert!(view.read(cx).work_ui.step_pulse("c59", cx));
        assert!(!view.read(cx).work_ui.step_pulse("c58", cx));
    })
    .unwrap();
    assert_eq!(shape(cx, handle, &view, id).1.len(), TAIL);
    let frames: Vec<_> = [0, 150, 150, 150, 150].map(|ms| tops(cx, ms)).into();
    let base = frames.iter().flatten().fold(f32::MIN, |a, b| a.max(*b));
    assert!(
        frames.windows(2).any(|pair| pair[0] != pair[1]),
        "the dots move between frames: {frames:?}"
    );
    assert!(
        frames.iter().flatten().all(|top| base - top <= 3.),
        "a small bounce within the glyph slot: {frames:?}"
    );
    // Reduced motion: still dots, no frame requests.
    cx.update(|cx| cx.set_reduce_motion(true));
    let still: Vec<_> = [0, 150, 150].map(|ms| tops(cx, ms)).into();
    assert!(still.windows(2).all(|pair| pair[0] == pair[1]), "{still:?}");
    assert!(still[0].iter().all(|top| *top == still[0][0]));
    cx.update(|cx| {
        assert!(!view.read(cx).work_ui.step_pulse("c59", cx));
        cx.set_reduce_motion(false)
    });
    // Open the full list, then finish the call: its dots settle into a glyph.
    let key = SharedString::from(format!("work-toggle-{id}"));
    for _ in 0..2 {
        cx.update_window(handle, |_, window, cx| window.click(key.clone(), cx))
            .unwrap();
        cx.run_until_parked();
    }
    assert_eq!(shape(cx, handle, &view, id).0, Mode::List);
    end(&mut model, "c59", 200, true, "Error: synthetic");
    publish(cx, handle, &view, &mut model);
    cx.update_window(handle, |_, window, cx| {
        window.draw(cx).clear(cx);
        assert!(window.find_all("work-dots-call:c59").is_empty());
        assert!(!view.read(cx).work_ui.step_pulse("c59", cx));
        let status = window
            .within("step-toggle-call:c59")
            .find("disclosure-status")
            .bounds();
        assert!(status.size.width > px(0.));
    })
    .unwrap();
}

#[gpui_kit::test]
fn a_stale_run_settles_running_dots(cx: &mut TestAppContext) {
    let mut model = live(2);
    let rows = model.rows();
    let id = rows[0].id();
    let (handle, view) = super::readonly_tests::setup(cx, rows);
    cx.update_window(handle, |_, window, cx| {
        window.draw(cx).clear(cx);
        assert!(window.find("work-dots-call:c1").bounds().size.width > px(0.));
        let key = SharedString::from(format!("work-toggle-{id}"));
        window.click(key.clone(), cx);
        window.click(key, cx);
    })
    .unwrap();
    cx.run_until_parked();
    model.stale();
    publish(cx, handle, &view, &mut model);
    cx.update_window(handle, |_, window, cx| {
        window.draw(cx).clear(cx);
        assert!(window.find("step-toggle-call:c1").bounds().size.height > px(0.));
        assert!(window.find_all("work-dots-call:c1").is_empty());
        assert!(!view.read(cx).work_ui.step_pulse("c1", cx));
        assert!(
            window
                .find("step-toggle-call:c1")
                .label()
                .unwrap()
                .contains("Status unknown")
        );
    })
    .unwrap();
}

#[gpui_kit::test]
fn a_script_shows_output_first_and_opens_code_separately_with_exact_copy(cx: &mut TestAppContext) {
    let code = "// Count rows\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;\nreturn a + b;";
    let printed = format!(
        "{{\"output\":\"rg: {}missing.js: No such file or directory (os error 2)\\n785\",\"exit_code\":2}}",
        "packages/kernel/node_modules/".repeat(6)
    );
    let error = "Error: Tool bash: exit code 2 日本語 👩‍💻";
    let output = format!(
        "Script failed\nWall time 0.4 seconds\nOutput:\n\n{printed}\nScript error:\n{error}"
    );
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"run_start"}));
    let calls = json!([
        {"type":"toolCall","id":"r1","name":"read","arguments":{"path":"src/a.rs"}},
        {"type":"toolCall","id":"r2","name":"read","arguments":{"path":"src/b.rs"}},
        {"type":"toolCall","id":"s","name":"codemode","arguments":{"code":code}}
    ]);
    model.apply(&json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":calls}]}}));
    end(&mut model, "r1", 21, false, "a");
    end(&mut model, "r2", 22, false, "b");
    end(&mut model, "s", 23, true, &output);
    model.apply(&json!({"type":"run_end"}));
    let rows = model.rows();
    let id = rows[0].id();
    assert_eq!(
        rows[0].work_data().unwrap().first_error(),
        Some((2, error.to_owned())),
        "the fold names the script's error, not its raw printed JSON"
    );
    let (handle, view) = super::readonly_tests::setup(cx, rows);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        let viewport = window.find("viewport").bounds();
        let first = window.find(("work-first-error", id)).bounds();
        assert!(first.right() <= viewport.right() && first.size.height < px(24.));
        window.click(("work-first-error", id), cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        let step = window.find("step-toggle-call:s");
        assert!(step.label().unwrap().starts_with("Count rows"));
        // Code and output both show at once; output drops only the wrapper.
        assert_eq!(view.read(cx).work_ui.step_info("s", cx), (true, 2));
        let shown = view.read(cx).work_ui.body_state("s", "Output", cx);
        let shown = shown.read(cx).rendered_text().source().to_string();
        assert!(!shown.contains("Wall time") && !shown.contains("Script failed"));
        assert!(shown.contains("os error 2") && shown.contains("日本語"));
        let block = window.find("body-call:s-Output").bounds();
        let viewport = window.find("viewport").bounds();
        assert!(block.right() <= viewport.right(), "long lines stay inside");
        assert!(window.find("body-call:s-Code").bounds().bottom() <= block.top());
        // Nothing to fold: no section toggles, and no arguments that only
        // repeat the script.
        assert!(window.find_all("show-call:s-Code").is_empty());
        assert!(window.find_all("copy-call:s-Arguments").is_empty());
        window.click("copy-call:s-Output", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), output);
        window.click("copy-call:s-Code", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), code);
        let code_state = view.read(cx).work_ui.body_state("s", "Code", cx);
        let source = code_state.read(cx).rendered_text().source().to_string();
        assert!(source.contains("const e = 5;") && source.contains("return a + b;"));
        window.click(SharedString::from(format!("work-toggle-{id}")), cx);
    })
    .unwrap();
    cx.run_until_parked();
    // The chosen full list keeps every call on its own row.
    assert_eq!(
        shape(cx, handle, &view, id).1,
        vec![vec![0], vec![1], vec![2]]
    );
    // A tool without code shows its arguments, open, with exact copy.
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.click("step-toggle-call:r1", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert!(window.find("body-call:r1-Arguments").bounds().size.height > px(0.));
        window.click("copy-call:r1-Arguments", cx);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &cx.read_from_clipboard().unwrap().text().unwrap()
            )
            .unwrap(),
            json!({"path":"src/a.rs"})
        );
    })
    .unwrap();
}

#[gpui_kit::test]
fn the_live_tail_merges_successful_reads_into_one_openable_step(cx: &mut TestAppContext) {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"run_start"}));
    let calls = json!([
        {"type":"toolCall","id":"r1","name":"read","arguments":{"path":"src/a.rs"}},
        {"type":"toolCall","id":"r2","name":"read","arguments":{"path":"src/b.rs"}},
        {"type":"toolCall","id":"r3","name":"read","arguments":{"path":"src/c.rs"}},
        {"type":"toolCall","id":"t","name":"bash","arguments":{"command":"cargo test"}}
    ]);
    model.apply(&json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":calls}]}}));
    for (entry, id) in [(21, "r1"), (22, "r2"), (23, "r3")] {
        end(&mut model, id, entry, false, "contents");
    }
    model.apply(&json!({"type":"tool_execution_start","toolCallId":"t","toolName":"bash"}));
    let rows = model.rows();
    let id = rows[0].id();
    let (handle, view) = super::readonly_tests::setup(cx, rows);
    assert_eq!(
        shape(cx, handle, &view, id),
        (Mode::Tail, vec![vec![0, 1, 2], vec![3]])
    );
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        let reads = window.find("reads-toggle-call:r1");
        assert!(
            reads
                .label()
                .unwrap()
                .starts_with("Read · a.rs, b.rs · +1 more"),
            "{:?}",
            reads.label()
        );
        assert!(window.find_all("step-toggle-call:r1").is_empty());
        window.click("reads-toggle-call:r1", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        for read in ["r1", "r2", "r3"] {
            let key = SharedString::from(format!("step-toggle-call:{read}"));
            assert!(window.find(key).bounds().size.height > px(0.));
        }
        assert!(!view.read(cx).work_ui.group_open(id, cx));
    })
    .unwrap();
}
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
        assert!(header.label().unwrap().starts_with("Read failed"));
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
            // The command is the input; its JSON envelope only repeats it.
            assert!(window.find_all("copy-call:a-Arguments").is_empty());
            window.draw(cx).clear(cx);
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
