//! Assistant text around tool calls stays a visible message (D128). With the
//! finished groups folded and more than five later steps, the plan, the text
//! between calls and the recommendation before ask_user all paint in order,
//! select and copy exactly, and keep their documents when the run settles.
//! Synthetic rows and the production LocalViewer; no transport.
use super::*;
use gpui_kit::component::{Theme, ThemeMode};

const PLAN: &str = "Plan:\n\n- **first** step 日本語\n- second step";
const BETWEEN: &str = "Between calls: the reads agree.";
const RECOMMEND: &str = "I recommend option B. It keeps the sidebar calm and readable.";

fn entry(id: u64, content: serde_json::Value) -> serde_json::Value {
    json!({"id":id,"kind":"pi.assistant","model":[{"role":"assistant","content":content}]})
}
fn result(id: u64, call: &str) -> serde_json::Value {
    json!({"id":id,"kind":"pi.tool","model":[{"role":"toolResult","toolCallId":call,"isError":false,"content":[{"type":"text","text":"contents"}]}]})
}
fn read(model: &mut LiveTranscript, id: u64, call: &str) {
    model.apply(&json!({"type":"entry_appended","entry":entry(id,json!([{"type":"toolCall","id":call,"name":"read","arguments":{"path":format!("src/{call}.rs")}}]))}));
    model.apply(
        &json!({"type":"tool_execution_end","toolCallId":call,"entry":result(id + 1, call)}),
    );
}

pub(super) fn run(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_VISIBLE_TEXT_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let mut model = LiveTranscript::default();
            model.apply(&json!({"type":"run_start"}));
            model.apply(&json!({"type":"entry_appended","entry":entry(1,json!([{"type":"text","text":PLAN},{"type":"toolCall","id":"a","name":"read","arguments":{"path":"src/a.rs"}}]))}));
            model.apply(
                &json!({"type":"tool_execution_end","toolCallId":"a","entry":result(2, "a")}),
            );
            read(&mut model, 3, "b");
            model.apply(&json!({"type":"entry_appended","entry":entry(5,json!([{"type":"text","text":BETWEEN}]))}));
            for n in 0..7 {
                read(&mut model, 10 + 2 * n, &format!("r{n}"));
            }
            model.apply(&json!({"type":"entry_appended","entry":entry(30,json!([{"type":"text","text":RECOMMEND},{"type":"toolCall","id":"q","name":"ask_user","arguments":{"question":"Which option?"}}]))}));
            model.apply(
                &json!({"type":"tool_execution_start","toolCallId":"q","toolName":"ask_user"}),
            );
            model.apply(&json!({"type":"entry_appended","entry":{"id":31,"kind":"pilot.question","model":[],"data":{
                "question":"Which option?","options":[{"label":"A"},{"label":"B","suggested":true}],
                "multiSelect":false,"blocking":true}}}));
            let rows = model.rows();
            let texts: Vec<_> = rows
                .iter()
                .filter(|row| row.is_assistant() && row.work_data().is_none())
                .map(|row| (row.id(), row.source().to_owned()))
                .collect();
            assert_eq!(
                texts.iter().map(|(_, s)| s.as_str()).collect::<Vec<_>>(),
                [PLAN, BETWEEN, RECOMMEND],
                "each text is its own message, in order"
            );
            let groups: Vec<_> = rows
                .iter()
                .filter_map(|row| row.work_data().map(|work| work.id))
                .collect();
            assert_eq!(groups.len(), 3, "text splits the calls into three groups");
            let ix = |id: u64| rows.iter().position(|row| row.id() == id).unwrap();
            let recommend = texts[2].0;
            let question = rows.last().unwrap().id();
            assert_eq!(
                ix(groups[2]),
                ix(recommend) + 1,
                "ask_user follows its text"
            );
            assert_eq!(
                ix(question),
                ix(recommend) + 2,
                "the question follows its call"
            );
            let (handle, view) = cx
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
                        |window, cx| {
                            cx.new(|cx| {
                                let v = LocalViewer::synthetic(window, cx);
                                v.transcript
                                    .update(cx, |v, cx| v.replace_readonly(rows, true, cx));
                                v
                            })
                        },
                    )
                })
                .unwrap();
            cx.run_until_parked();
            cx.update_window(handle, |_, _, cx| {
                view.update(cx, |v, cx| v.transcript.update(cx, |t, cx| t.latest(cx)))
            })
            .unwrap();
            cx.run_until_parked();
            let mut documents = Vec::new();
            let copied = cx
                .update_window(handle, |_, window, cx| {
                    window.draw(cx).clear(cx);
                    let viewport = window.find("viewport").bounds();
                    let transcript = view.read(cx).transcript.clone();
                    for group in &groups[..2] {
                        let open = transcript.read(cx).disclosure_probe_state(*group, cx).3;
                        assert!(!open, "finished groups stay folded");
                    }
                    let mut previous = viewport.top();
                    for (id, _) in &texts {
                        let state = transcript.read(cx).history_probe_row(*id);
                        let b = state.read(cx).bounds();
                        assert!(b.size.height > px(0.) && b.size.width > px(0.));
                        assert!(
                            b.top() >= viewport.top() && b.bottom() <= viewport.bottom(),
                            "text is visible without opening work: {b:?} in {viewport:?}"
                        );
                        assert!(b.right() <= viewport.right());
                        assert!(b.top() >= previous, "text keeps its order");
                        previous = b.bottom();
                        documents.push(state);
                    }
                    let text = documents[2].read(cx).bounds();
                    let call = window
                        .find(SharedString::from(format!("work-toggle-{}", groups[2])))
                        .bounds();
                    let asked = window.find(("question-preview", question)).bounds();
                    assert!(text.bottom() <= call.top() && call.top() - text.bottom() < px(64.));
                    assert!(call.bottom() <= asked.top() && asked.top() - call.bottom() < px(96.));
                    let start = text.origin + point(px(3.), px(10.));
                    window.drag(start, start + point(px(120.), px(0.)), cx);
                    window.press("secondary-c", cx);
                    let copied = cx.read_from_clipboard().unwrap().text().unwrap();
                    assert!(
                        !copied.is_empty() && RECOMMEND.contains(&copied),
                        "copied {copied:?} from {text:?}"
                    );
                    println!(
                        "{}",
                        json!({"probe":"visible_text","phase":"live","width":width,"mode":format!("{mode:?}"),
                            "text_rows":texts.len(),"groups":groups.len(),
                            "text_to_call":f32::from(call.top() - text.bottom()),
                            "call_to_question":f32::from(asked.top() - call.bottom()),
                            "copied_bytes":copied.len(),"native_production_root":true})
                    );
                    copied
                })
                .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(handle)
                    .expect("native renderer required")
                    .save(dir.join(format!("{}-{mode:?}-live.png", width as u32)))
                    .unwrap();
            }
            // The answer settles the run: the same rows keep their documents and selection.
            model.apply(
                &json!({"type":"tool_execution_end","toolCallId":"q","entry":result(32, "q")}),
            );
            model.apply(&json!({"type":"run_end"}));
            let done = model.rows();
            assert_eq!(
                done.iter().map(Message::id).collect::<Vec<_>>(),
                model.rows().iter().map(Message::id).collect::<Vec<_>>()
            );
            cx.update_window(handle, |_, window, cx| {
                view.update(cx, |v, cx| {
                    v.transcript
                        .update(cx, |t, cx| t.replace_readonly(done, false, cx))
                });
                window.draw(cx).clear(cx);
                let transcript = view.read(cx).transcript.clone();
                for ((id, _), document) in texts.iter().zip(&documents) {
                    let state = transcript.read(cx).history_probe_row(*id);
                    assert_eq!(state.entity_id(), document.entity_id(), "same document");
                }
                assert!(documents[2].read(cx).selected_source_range().is_some());
                window.press("secondary-c", cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), copied);
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(handle)
                    .expect("native renderer required")
                    .save(dir.join(format!("{}-{mode:?}-done.png", width as u32)))
                    .unwrap();
            }
            cx.update_window(handle, |_, window, _| window.remove_window())
                .unwrap();
            cx.run_until_parked();
        }
    }
    cx.update(|cx| Theme::change(ThemeMode::Light, None, cx));
}
