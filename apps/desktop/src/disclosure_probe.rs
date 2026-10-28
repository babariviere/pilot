//! Native production-root disclosure geometry, synthetic state and no transport.
use super::LocalViewer;
use crate::{local_model::LiveTranscript, model::Message};
use gpui_kit::{
    AppContext, Bounds, HeadlessAppContext, ScrollDelta, SharedString, WindowBounds, WindowOptions,
    point, px, size, test::TestWindowExt,
};
use serde_json::json;
use std::time::Duration;

pub fn run_disclosure_probe(cx: &mut HeadlessAppContext) {
    run_final_reply_follow_probe(cx);
    run_working_stability_probe(cx);
    if std::env::var_os("PILOT_NEXT_TOOL_PRESENTATION_DIR").is_some() {
        run_tool_presentation_probe(cx);
        return;
    }
    let captures = std::env::var_os("PILOT_NEXT_DISCLOSURE_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [620., 1100.] {
        let mut model = LiveTranscript::default();
        let calls:Vec<_>=(0..24).map(|i|json!({"type":"toolCall","id":format!("disclosure-{i}"),"name":"read","arguments":{"path":format!("synthetic-{i}.rs")}})).collect();
        model.apply(&json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":calls}]}}));
        for i in 0..24 {
            model.apply(&json!({"type":"tool_execution_start","toolCallId":format!("disclosure-{i}"),"toolName":"read"}));
        }
        let mut rows: Vec<_> = (100..120)
            .map(|i| Message::live(i, "assistant".into(), crate::model::REPLY.into()))
            .collect();
        rows.extend(model.rows());
        let id = rows.last().unwrap().id();
        let (handle, view) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        point(px(0.), px(0.)),
                        size(px(width), px(760.)),
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
            .unwrap()
        });
        cx.run_until_parked();
        assert!(cx.update(|cx| view.read(cx).text_parsers_ready(cx)));
        let key = SharedString::from(format!("work-toggle-{id}"));
        let mut identity = None;
        let mut collapsed_y = 0.;
        for action in [
            "initial",
            "open",
            "collapse",
            "expand",
            "stream",
            "prepend",
            "rapid-collapse",
            "rapid-expand",
            "rapid-burst",
            "manual",
            "detail",
            "detail-stream",
            "detail-close",
            "wheel-bottom",
            "remount-top",
            "remount-bottom",
            "reveal-header",
            "hold-again",
            "latest",
        ] {
            if matches!(
                action,
                "open" | "collapse" | "expand" | "rapid-collapse" | "rapid-expand" | "hold-again"
            ) {
                cx.update_window(handle, |_, window, cx| {
                    window.render_frame(cx);
                    window.click(key.clone(), cx);
                })
                .unwrap();
            }
            if matches!(action, "stream" | "detail-stream") {
                for frame in 0..6 {
                    model.apply(&json!({"type":"tool_execution_update","toolCallId":"disclosure-0","output":{"set":format!("synthetic update {frame}\n{}", "tall bounded output 日本語\n".repeat(if action == "detail-stream" {120} else {8}))}}));
                    let mut rows: Vec<_> = ((if action == "detail-stream" { 98 } else { 100 })
                        ..120)
                        .map(|i| Message::live(i, "assistant".into(), crate::model::REPLY.into()))
                        .collect();
                    rows.extend(model.rows());
                    cx.update_window(handle, |_, window, cx| {
                        view.update(cx, |v, cx| {
                            v.transcript
                                .update(cx, |v, cx| v.replace_readonly(rows, false, cx))
                        });
                        window.render_frame(cx);
                    })
                    .unwrap();
                    cx.advance_clock(Duration::from_millis(16));
                    cx.run_until_parked();
                }
            }
            if action == "prepend" {
                let mut rows: Vec<_> = (98..120)
                    .map(|i| Message::live(i, "assistant".into(), crate::model::REPLY.into()))
                    .collect();
                rows.extend(model.rows());
                cx.update_window(handle, |_, _, cx| {
                    view.update(cx, |v, cx| {
                        v.transcript
                            .update(cx, |v, cx| v.replace_readonly(rows, false, cx))
                    })
                })
                .unwrap();
            }
            if matches!(
                action,
                "manual" | "wheel-bottom" | "remount-top" | "remount-bottom" | "reveal-header"
            ) {
                cx.update_window(handle, |_, window, cx| {
                    window.render_frame(cx);
                    window.scroll(
                        "viewport",
                        ScrollDelta::Pixels(point(
                            px(0.),
                            px(match action {
                                "manual" => -300.,
                                "remount-top" => 100000.,
                                "reveal-header" => 300.,
                                _ => -100000.,
                            }),
                        )),
                        cx,
                    );
                })
                .unwrap();
            }
            if matches!(action, "detail" | "detail-close") {
                cx.update_window(handle, |_, window, cx| {
                    window.render_frame(cx);
                    window.click("step-toggle-call:disclosure-0", cx);
                })
                .unwrap();
            }
            if action == "latest" {
                cx.update_window(handle, |_, window, cx| {
                    window.render_frame(cx);
                    window.click("latest", cx);
                })
                .unwrap();
            }
            let mut samples = Vec::new();
            for frame in 0..20 {
                let sample=cx.update_window(handle,|_,window,cx|{
                    window.render_frame(cx);
                    if action=="rapid-burst" && frame<12 {
                        window.click(key.clone(),cx);
                        window.render_frame(cx);
                    }
                    let h=window.find_all(key.clone()).first().map(|e|e.bounds());
                    let t=h.map(|_|window.within(key.clone()).find("disclosure-text").bounds());
                    let(i,offset,following,open,entity)=view.read(cx).transcript.read(cx).disclosure_probe_state(id,cx);
                    let (detail_open,body_states)=view.read(cx).transcript.read(cx).disclosure_probe_step("disclosure-0",cx);
                    if matches!(action,"detail"|"detail-stream") { assert!(detail_open,"{action}: native pointer must actually expand the detail"); }
                    if action=="detail-close" { assert!(!detail_open); }
                    if let Some(prior)=identity{assert_eq!(entity,prior);}else{identity=Some(entity);}
                    json!({"frame":frame,"header_x":h.map(|h|f32::from(h.left())),"header_y":h.map(|h|f32::from(h.top())),"header_height":h.map(|h|f32::from(h.size.height)),"relative_text_x":h.zip(t).map(|(h,t)|f32::from(t.left()-h.left())),"relative_text_y":h.zip(t).map(|(h,t)|f32::from(t.top()-h.top())),"item":i,"offset":offset,"following":following,"open":open,"detail_open":detail_open,"detail_body_states":body_states})
                }).unwrap();
                samples.push(sample);
                cx.advance_clock(Duration::from_millis(16));
                cx.run_until_parked();
            }
            let y = samples.last().unwrap()["header_y"]
                .as_f64()
                .unwrap_or_default();
            if matches!(action, "collapse" | "rapid-collapse") {
                collapsed_y = y;
            }
            if matches!(
                action,
                "expand" | "stream" | "prepend" | "rapid-expand" | "rapid-burst"
            ) {
                assert!(
                    samples
                        .iter()
                        .all(|s| (s["header_y"].as_f64().unwrap() - collapsed_y).abs() <= 1.),
                    "{action}: disclosure lost its reading anchor"
                );
                assert!(samples.iter().all(|s| s["following"] == false));
            }
            if matches!(action, "wheel-bottom" | "remount-bottom" | "latest") {
                assert_eq!(
                    samples.last().unwrap()["following"],
                    true,
                    "{action} must resume following"
                );
            }
            if action != "remount-top" {
                let first = samples[0]["relative_text_x"].as_f64().unwrap();
                assert!(
                    samples
                        .iter()
                        .all(|s| (s["relative_text_x"].as_f64().unwrap() - first).abs() < 0.1),
                    "text/icon alignment oscillated"
                );
            }
            println!(
                "{}",
                json!({"width":width,"phase":action,"samples":samples,"native_production_root":true})
            );
            if let Some(dir) = &captures {
                cx.capture_screenshot(handle)
                    .expect("native renderer required")
                    .save(dir.join(format!("{}-{action}.png", width as u32)))
                    .unwrap();
            }
        }
        cx.capture_screenshot(handle)
            .expect("native renderer required");
        cx.update_window(handle, |_, window, _| window.remove_window())
            .unwrap();
        cx.run_until_parked();
    }
    run_thinking_probe(cx, captures.as_deref());
    run_tool_presentation_probe(cx);
}

// Same immutable synthetic fixture before/after presentation changes. The
// capture-only selector above avoids repeating the unrelated long anchor matrix.
// This function constructs the real production LocalViewer; no transport exists.
fn run_tool_presentation_probe(cx: &mut HeadlessAppContext) {
    use gpui_kit::component::{Theme, ThemeMode};
    let captures =
        std::env::var_os("PILOT_NEXT_TOOL_PRESENTATION_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let mut model = LiveTranscript::default();
            let calls = json!([
                {"type":"toolCall","id":"failed-early","name":"bash","arguments":{"command":"cargo test --test parser"}},
                {"type":"toolCall","id":"read","name":"read","arguments":{"path":"src/synthetic_parser_with_a_deliberately_long_name.rs","offset":20,"limit":80}},
                {"type":"toolCall","id":"command","name":"bash","arguments":{"command":"set -euo pipefail\ncd synthetic-workspace\ncargo test --locked --test parser","timeout":30}},
                {"type":"toolCall","id":"patch","name":"applyPatch","arguments":{"patch":"*** Begin Patch\n*** Update File: src/parser.rs\n@@\n-old_line\n+new_line\n*** End Patch"}},
                {"type":"toolCall","id":"search","name":"web","arguments":{"action":"search","query":"synthetic 日本語 parser behavior"}},
                {"type":"toolCall","id":"script","name":"codemode","arguments":{"code":"const result = { note: 'synthetic only' };\nreturn result;"}}
            ]);
            model.apply(&json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":calls}]}}));
            for id in [
                "failed-early",
                "read",
                "command",
                "patch",
                "search",
                "script",
            ] {
                model.apply(
                    &json!({"type":"tool_execution_start","toolCallId":id,"toolName":"tool"}),
                );
            }
            for id in ["read", "patch", "search"] {
                model.apply(&json!({"type":"tool_execution_end","toolCallId":id,"result":{"content":[{"type":"text","text":"Synthetic completed result."}]}}));
            }
            // Match the real event envelope: isError is top-level and the
            // committed result lives in entry.model, not an ignored result key.
            model.apply(&json!({"type":"tool_execution_end","toolCallId":"failed-early","isError":true,"entry":{"id":21,"kind":"pi.tool","model":[{"role":"toolResult","toolCallId":"failed-early","isError":true,"content":[{"type":"text","text":"Synthetic assertion failed: expected a parser result."}]}]}}));
            let output = format!(
                "Synthetic output 日本語 👩‍💻\n{}",
                "bounded output line\n".repeat(60)
            );
            model.apply(&json!({"type":"tool_execution_update","toolCallId":"command","output":{"set":output}}));
            let rows = model.rows();
            assert_eq!(
                rows.last().unwrap().work_data().unwrap().failures,
                1,
                "fixture must contain a real failed tool before testing its visibility"
            );
            let group = rows.last().unwrap().id();
            let key = SharedString::from(format!("work-toggle-{group}"));
            let (handle, view) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(1040.)),
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
            let mut entity = None;
            for phase in [
                "live",
                "collapsed",
                "expanded",
                "detail",
                "stream",
                "copy",
                "settled",
            ] {
                cx.update_window(handle, |_, window, cx| {
                    if phase=="expanded" { window.click(key.clone(),cx); }
                    if phase=="detail" { window.click("step-toggle-call:command",cx); }
                    if phase=="stream" {
                        model.apply(&json!({"type":"tool_execution_update","toolCallId":"command","output":{"append":"last synthetic line\n"}}));
                        view.update(cx,|v,cx|v.transcript.update(cx,|v,cx|v.replace_readonly(model.rows(),false,cx)));
                    }
                    if phase=="settled" {
                        for id in ["command","script"] { model.apply(&json!({"type":"tool_execution_end","toolCallId":id,"result":{"content":[{"type":"text","text":"Synthetic completed result."}]}})); }
                        model.apply(&json!({"type":"run_end"}));
                        view.update(cx,|v,cx|v.transcript.update(cx,|v,cx|v.replace_readonly(model.rows(),false,cx)));
                    }
                }).unwrap();
                cx.run_until_parked();
                cx.update_window(handle,|_,window,cx| {
                    window.draw(cx).clear(cx);
                    let viewport=window.find("viewport").bounds();
                    assert!(viewport.right()<=px(width) && viewport.size.width>px(0.));
                    let (_,_,_,open,current)=view.read(cx).transcript.read(cx).disclosure_probe_state(group,cx);
                    if let Some(old)=entity { assert_eq!(current,old,"canonical group entity must survive"); } else { entity=Some(current); }
                    assert_eq!(open,!matches!(phase,"live"|"collapsed"));
                    if matches!(phase,"detail"|"stream"|"copy"|"settled") { assert!(view.read(cx).transcript.read(cx).disclosure_probe_step("command",cx).0); }
                    if phase=="copy" {
                        window.click("copy-call:command-Output",cx);
                        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(),format!("{output}last synthetic line\n"));
                    }
                    println!("{}",json!({"tool_fixture":"semantic-work-v2","phase":phase,"width":width,"appearance":mode.name(),"open":open,"synthetic_only":true,"production_root":true}));
                }).unwrap();
                cx.run_until_parked();
                if let Some(dir) = &captures {
                    cx.capture_screenshot(handle)
                        .unwrap()
                        .save(dir.join(format!(
                            "tools-{}-{}-{phase}.png",
                            width as u32,
                            mode.name()
                        )))
                        .unwrap();
                }
            }
            cx.update_window(handle, |_, window, _| window.remove_window())
                .unwrap();
            cx.run_until_parked();
        }
    }
}

fn run_thinking_probe(cx: &mut HeadlessAppContext, captures: Option<&std::path::Path>) {
    for width in [620., 1100.] {
        let mut model = LiveTranscript::default();
        let (handle, view) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        point(px(0.), px(0.)),
                        size(px(width), px(760.)),
                    ))),
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |window, cx| {
                    cx.new(|cx| {
                        let v = LocalViewer::synthetic(window, cx);
                        v.editor.update(cx, |v, cx| {
                            v.select("chat:synthetic".into(), false, true, window, cx)
                        });
                        v
                    })
                },
            )
            .unwrap()
        });
        let mut viewport_height: Option<f32> = None;
        for phase in [
            "history",
            "thinking",
            "thinking-delta",
            "tools",
            "text",
            "done",
            "reconnect",
            "stop",
        ] {
            match phase {
                "history"=>model.apply(&json!({"type":"entry_appended","entry":{"id":1,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"thinking","thinking":"synthetic historical reasoning"},{"type":"text","text":" \n"}]}]}})),
                "thinking"=>model.apply(&json!({"type":"message_start","message":{"content":[{"type":"thinking","thinking":"synthetic"}]}})),
                "thinking-delta"=>{
                    for _ in 0..32 {model.apply(&json!({"type":"message_update","changes":[{"type":"thinking_delta","contentIndex":0,"delta":"synthetic"}]}));}
                }
                "tools"=>model.apply(&json!({"type":"tool_execution_start","toolCallId":"thinking-tool","toolName":"read"})),
                "text"=>model.apply(&json!({"type":"message_update","changes":[{"type":"text_start","contentIndex":1,"block":{"type":"text","text":"An ordinary substantive assistant note 日本語."}}]})),
                "done"=>model.apply(&json!({"type":"run_end"})),
                "reconnect"=>model.apply(&json!({"type":"snapshot","entries":[],"generation":{"message":{"content":[{"type":"thinking","thinking":"historical reconnect body"}]}}})),
                "stop"=>{
                    model.stop_thinking();
                    model.apply(&json!({"type":"message_update","changes":[{"type":"thinking_delta","contentIndex":0,"delta":"late"}]}));
                }
                _=>unreachable!(),
            }
            let rows = model.rows();
            let thinking = model.thinking;
            cx.update_window(handle, |_, window, cx| {
                view.update(cx, |v, cx| {
                    let mut state = v.state.clone();
                    state.rows = rows;
                    state.thinking = thinking;
                    let chats = std::sync::Arc::make_mut(&mut state.chats);
                    chats[0].busy = phase != "done";
                    v.accept(state, window, cx);
                })
            })
            .unwrap();
            cx.run_until_parked();
            let sample=cx.update_window(handle,|_,window,cx|{
                window.render_frame(cx);
                let (rows,text_states)=view.read(cx).transcript.read(cx).presentation_probe_counts();
                let editor=view.read(cx).editor.read(cx);
                let label=editor.activity_label();
                let expected=match phase {"thinking"|"thinking-delta"=>Some("Thinking..."),"done"=>None,_=>Some("Working...")};
                assert_eq!(label,expected);
                let indicators=window.find_all("activity-indicator");
                assert_eq!(indicators.len(),usize::from(expected.is_some()),"single activity indicator");
                if matches!(phase,"history"|"thinking"|"thinking-delta"|"reconnect"|"stop") {
                    assert_eq!((rows,text_states),(0,0),"reasoning must not construct a transcript view/parser");
                }
                let height=f32::from(window.find("viewport").bounds().size.height);
                if matches!(phase,"history"|"thinking"|"thinking-delta") {
                    if let Some(before)=viewport_height {assert!((height-before).abs()<0.1);} else {viewport_height=Some(height);}
                }
                json!({"phase":phase,"width":width,"rows":rows,"text_states":text_states,"activity":label,"indicators":indicators.len(),"viewport_height":height,"native_production_root":true})
            }).unwrap();
            println!("{sample}");
            let shot = cx
                .capture_screenshot(handle)
                .expect("native renderer required");
            if let Some(dir) = captures {
                shot.save(dir.join(format!("{}-activity-{phase}.png", width as u32)))
                    .unwrap();
            }
        }
        cx.update_window(handle, |_, window, _| window.remove_window())
            .unwrap();
        cx.run_until_parked();
    }
}

// Exercise actual production disclosure handlers across status and streaming
// updates. No Local transport or operation is constructed by this fixture.
fn run_working_stability_probe(cx: &mut HeadlessAppContext) {
    use gpui_kit::component::{ActiveTheme, Theme, ThemeMode};
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            for choice in ["unopened", "open", "closed"] {
                let mut model = LiveTranscript::default();
                model.apply(&json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"stable-a","name":"bash","arguments":{"command":"printf synthetic 日本語"}}]}]}}));
                let rows = model.rows();
                let group = rows[0].id();
                let key = SharedString::from(format!("work-toggle-{group}"));
                let (handle, view) = cx.update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(840.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |window, cx| {
                            cx.new(|cx| {
                                let view = LocalViewer::synthetic(window, cx);
                                view.transcript
                                    .update(cx, |v, cx| v.replace_readonly(rows, true, cx));
                                view
                            })
                        },
                    )
                    .unwrap()
                });
                cx.update(|cx| Theme::change(mode, None, cx));
                cx.run_until_parked();
                cx.update_window(handle, |_, window, cx| {
                    window.render_frame(cx);
                    assert!(
                        !view
                            .read(cx)
                            .transcript
                            .read(cx)
                            .disclosure_probe_state(group, cx)
                            .3,
                        "unopened Working must start collapsed, not follow activity"
                    );
                    if choice != "unopened" {
                        window.click(key.clone(), cx);
                    }
                })
                .unwrap();
                cx.run_until_parked();
                if choice == "closed" {
                    cx.update_window(handle, |_, window, cx| {
                        window.render_frame(cx);
                        window.click(key.clone(), cx);
                    })
                    .unwrap();
                    cx.run_until_parked();
                }
                let mut entity = None;
                let mut header_y: Option<f32> = None;
                for phase in [
                    "active",
                    "stream",
                    "success",
                    "next-tool",
                    "failure-unknown",
                    "settled",
                ] {
                    match phase {
                        "active" => model.apply(&json!({"type":"tool_execution_start","toolCallId":"stable-a","toolName":"bash"})),
                        "stream" => model.apply(&json!({"type":"tool_execution_update","toolCallId":"stable-a","output":{"set":"synthetic output 日本語"}})),
                        "success" => model.apply(&json!({"type":"tool_execution_end","toolCallId":"stable-a","entry":{"id":21,"kind":"pi.tool","model":[{"role":"toolResult","toolCallId":"stable-a","content":[{"type":"text","text":"synthetic result 日本語"}]}]}})),
                        "next-tool" => {
                            model.apply(&json!({"type":"entry_appended","entry":{"id":22,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"stable-b","name":"read","arguments":{"path":"synthetic.rs"}},{"type":"toolCall","id":"stable-c","name":"read","arguments":{"path":"unknown.rs"}}]}]}}));
                            model.apply(&json!({"type":"tool_execution_start","toolCallId":"stable-b","toolName":"read"}));
                        }
                        "failure-unknown" => {
                            model.apply(&json!({"type":"tool_execution_end","toolCallId":"stable-b","isError":true,"entry":{"id":23,"kind":"pi.tool","model":[{"role":"toolResult","toolCallId":"stable-b","isError":true,"content":[{"type":"text","text":"synthetic failure"}]}]}}));
                            model.apply(&json!({"type":"run_end"}));
                        }
                        "settled" => model.apply(&json!({"type":"run_end"})),
                        _ => unreachable!(),
                    }
                    let rows = model.rows();
                    let work = rows[0].work_data().unwrap();
                    assert_eq!(work.id, group);
                    if phase == "active" {
                        assert!(work.active);
                    }
                    if phase == "success" {
                        assert!(!work.active);
                    }
                    if matches!(phase, "failure-unknown" | "settled") {
                        assert_eq!((work.failures, work.uncertain), (1, 1));
                    }
                    cx.update_window(handle, |_, _, cx| {
                        view.update(cx, |v, cx| {
                            v.transcript
                                .update(cx, |v, cx| v.replace_readonly(rows, false, cx))
                        })
                    })
                    .unwrap();
                    cx.run_until_parked();
                    cx.update_window(handle, |_, window, cx| {
                        window.render_frame(cx);
                        assert_eq!(cx.theme().mode, mode);
                        let (_, _, following, open, current) = view.read(cx).transcript.read(cx).disclosure_probe_state(group, cx);
                        assert_eq!(open, choice == "open", "{choice}/{phase}: updates changed disclosure");
                        if let Some(old) = entity { assert_eq!(current, old); } else { entity = Some(current); }
                        let header = window.find(key.clone());
                        let bounds = header.bounds();
                        let y = f32::from(bounds.top());
                        if let Some(old) = header_y { assert!((y-old).abs() <= 1., "header anchor moved during {phase}"); } else { header_y = Some(y); }
                        assert!(header.label().unwrap().contains(if work_active_label(phase) { "Working" } else { "Worked" }));
                        if matches!(phase, "failure-unknown" | "settled") {
                            let label = header.label().unwrap();
                            assert!(label.contains("1 failed") && label.contains("1 status unknown"));
                            let status = window.within(key.clone()).find("disclosure-status").bounds();
                            assert!(status.size.width > px(0.) && status.right() <= bounds.right());
                        }
                        assert_eq!(view.read(cx).transcript.read(cx).disclosure_probe_step("stable-a", cx), (false, 0), "group opening must not open/parse child details");
                        println!("{}", json!({"probe":"working-stability", "width":width,"mode":mode.name(),"choice":choice,"phase":phase,"open":open,"following":following,"header_y":y}));
                    }).unwrap();
                }
                if choice == "unopened"
                    && let Some(dir) = std::env::var_os("PILOT_NEXT_WORKING_STABILITY_DIR")
                {
                    let dir = std::path::PathBuf::from(dir);
                    std::fs::create_dir_all(&dir).unwrap();
                    cx.capture_screenshot(handle)
                        .expect("native renderer required")
                        .save(dir.join(format!("working-{}-{}.png", width as u32, mode.name())))
                        .unwrap();
                }
                // Warnings never force expansion, but their exact detail remains reachable.
                cx.update_window(handle, |_, window, cx| {
                    if choice != "open" {
                        window.click(key.clone(), cx);
                    }
                })
                .unwrap();
                cx.run_until_parked();
                cx.update_window(handle, |_, window, cx| {
                    window.render_frame(cx);
                    window.click("step-toggle-call:stable-b", cx);
                })
                .unwrap();
                cx.run_until_parked();
                cx.update_window(handle, |_, window, cx| {
                    window.render_frame(cx);
                    assert!(
                        view.read(cx)
                            .transcript
                            .read(cx)
                            .disclosure_probe_step("stable-b", cx)
                            .0
                    );
                    window.click("copy-call:stable-b-Output", cx);
                    assert_eq!(
                        cx.read_from_clipboard().unwrap().text().unwrap(),
                        "synthetic failure"
                    );
                })
                .unwrap();
                cx.update_window(handle, |_, window, _| window.remove_window())
                    .unwrap();
                cx.run_until_parked();
            }
        }
    }
}

fn work_active_label(phase: &str) -> bool {
    matches!(phase, "active" | "stream" | "next-tool")
}

// Use the production reader publication path and actual native row bounds. A
// follow flag alone cannot prove that a reply below a tall work row is visible.
fn run_final_reply_follow_probe(cx: &mut HeadlessAppContext) {
    use crate::local_client::LocalClient;
    fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
        for _ in 0..12 {
            cx.advance_clock(Duration::from_millis(16));
            cx.run_until_parked();
            cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
        }
    }
    for choice in [
        "expanded-scrollbar",
        "expanded-output",
        "expanded-bottom",
        "expanded-older",
        "collapsed",
    ] {
        let mut model = LiveTranscript::default();
        let calls: Vec<_> = (0..32).map(|i| json!({"type":"toolCall","id":format!("follow-{i}"),"name":"read","arguments":{"path":format!("file-{i}.rs")}})).collect();
        model.apply(&json!({"type":"entry_appended","entry":{"id":200,"kind":"pi.assistant","model":[{"role":"assistant","content":calls}]}}));
        for i in 0..32 {
            model.apply(&json!({"type":"tool_execution_start","toolCallId":format!("follow-{i}"),"toolName":"read"}));
        }
        model.apply(&json!({"type":"tool_execution_update","toolCallId":"follow-31","output":{"set":"Initial output\n".repeat(4)}}));
        let group = model.rows()[0].id();
        let (client, commands) = LocalClient::synthetic_commands();
        let (h, v) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(1100.), px(760.)),
                    ))),
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |w, cx| {
                    cx.new(|cx| {
                        let mut v = LocalViewer::synthetic(w, cx);
                        v.client = Some(client);
                        v.generation = 10;
                        v.state.generation = 10;
                        v.state.cursor = None;
                        v.state.limited = true;
                        v
                    })
                },
            )
            .unwrap()
        });
        let publish = |cx: &mut HeadlessAppContext, model: &mut LiveTranscript, start| {
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let mut state = v.state.clone();
                    state.rows = (start..130)
                        .map(|id| Message::live(id, "assistant".into(), crate::model::REPLY.into()))
                        .chain(model.rows())
                        .collect();
                    v.accept(state, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
        };
        publish(cx, &mut model, 100);
        if choice != "collapsed" {
            cx.update_window(h, |_, w, cx| {
                w.click(SharedString::from(format!("work-toggle-{group}")), cx)
            })
            .unwrap();
            settle(cx, h);
            // Opening retains the clicked header. The user then genuinely
            // scrolls to the bottom of all the expanded calls, without Latest.
            if choice == "expanded-output" {
                cx.update_window(h, |_, w, cx| {
                    w.scroll(
                        "viewport",
                        ScrollDelta::Pixels(point(px(0.), px(-100_000.))),
                        cx,
                    );
                })
                .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| w.click("step-toggle-call:follow-31", cx))
                    .unwrap();
                settle(cx, h);
            }
            if matches!(choice, "expanded-scrollbar" | "expanded-output") {
                cx.update_window(h, |_, w, cx| {
                    let viewport = w.find("viewport").bounds();
                    w.scroll("viewport", ScrollDelta::Pixels(point(px(0.), px(-1.))), cx);
                    w.render_frame(cx);
                    w.drag(
                        point(viewport.right() - px(6.), viewport.bottom() - px(20.)),
                        point(viewport.right() - px(6.), viewport.bottom() + px(100.)),
                        cx,
                    );
                })
                .unwrap();
                settle(cx, h);
            } else {
                for _ in 0..4 {
                    cx.update_window(h, |_, w, cx| {
                        w.scroll(
                            "viewport",
                            ScrollDelta::Pixels(point(px(0.), px(-100_000.))),
                            cx,
                        )
                    })
                    .unwrap();
                    settle(cx, h);
                }
            }
        }
        if choice == "expanded-older" {
            cx.update_window(h, |_, w, cx| {
                w.scroll("viewport", ScrollDelta::Pixels(point(px(0.), px(80.))), cx)
            })
            .unwrap();
            settle(cx, h);
        }
        if choice == "expanded-scrollbar" {
            cx.update_window(h, |_, w, _| {
                let viewport = w.find("viewport").bounds();
                let last = w.find("step-toggle-call:follow-31").bounds();
                println!("scrollbar bottom: last={last:?}, viewport={viewport:?}");
                assert!(
                    last.bottom() <= viewport.bottom() + px(1.) && last.bottom() >= viewport.top(),
                    "the real drag must reach expanded content bottom before completion"
                );
            })
            .unwrap();
        }
        let before = cx.update(|cx| v.read(cx).transcript.read(cx).history_probe_anchor(cx));
        println!("final-follow {choice}/before: {before:?}");
        let reading = cx.update(|cx| v.read(cx).transcript.read(cx).reading_mark(cx).unwrap());
        let entity = cx.update(|cx| {
            v.read(cx)
                .transcript
                .read(cx)
                .disclosure_probe_state(group, cx)
                .4
        });
        let reply = "Final assistant reply must be visible without Latest.";
        for phase in [
            "incremental",
            "complete",
            "live",
            "final",
            "replaced",
            "settled",
            "slide",
        ] {
            match phase {
                "incremental" => model.apply(&json!({"type":"tool_execution_update","toolCallId":"follow-31","output":{"set":"incremental synthetic result\n".repeat(80)}})),
                "complete" => { for i in 0..32 { model.apply(&json!({"type":"tool_execution_end","toolCallId":format!("follow-{i}"),"entry":{"id":201+i,"kind":"pi.tool","model":[{"role":"toolResult","toolCallId":format!("follow-{i}"),"content":[{"type":"text","text":"Completed result"}]}]}})); } }
                "live" => model.apply(&json!({"type":"message_start","message":{"role":"assistant","timestamp":1000,"content":[{"type":"text","text":""}]}})),
                "final" => model.apply(&json!({"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":reply}]})),
                "replaced" => model.apply(&json!({"type":"message_end","entry":{"id":300,"kind":"pi.assistant","model":[{"role":"assistant","timestamp":1000,"content":[{"type":"text","text":reply}]}]}})),
                "settled" => model.apply(&json!({"type":"run_end"})),
                "slide" => {},
                _ => unreachable!(),
            }
            publish(cx, &mut model, if phase == "slide" { 104 } else { 100 });
            cx.update_window(h, |_, w, cx| {
                let t = v.read(cx).transcript.read(cx);
                let (_, _, following, open, current) = t.disclosure_probe_state(group, cx);
                assert_eq!(open, choice != "collapsed", "{choice}/{phase}: preserve explicit expansion");
                assert_eq!(entity, current);
                assert_eq!(t.disclosure_probe_step("follow-31", cx).0, choice == "expanded-output");
                println!("final-follow {choice}/{phase}: following={following}, anchor={:?}", t.history_probe_anchor(cx));
                if choice == "expanded-older" {
                    assert!(!following, "never follow while intentionally reading older tools");
                    let after = t.history_probe_anchor(cx);
                    assert_eq!(after.0, before.0 - usize::from(phase == "slide") * 4);
                    assert!((after.1 - before.1).abs() <= 1., "retain offset inside expanded tools");
                    assert_eq!(t.reading_mark(cx).unwrap().message, reading.message, "canonical reading identity survives sliding");
                } else if matches!(phase, "final" | "replaced" | "settled" | "slide") {
                    let row = model.rows().last().unwrap().id();
                    let viewport = w.find("viewport").bounds();
                    let footer = w.try_find(("message-actions", row)).map(|q| q.bounds());
                    assert!(footer.is_some_and(|b| b.top() >= viewport.top() && b.bottom() <= viewport.bottom() + px(1.)),
                        "{choice}/{phase}: actual final reply must be visible without Latest: footer={footer:?}, viewport={viewport:?}, following={following}");
                    assert!(following);
                    let body = t.history_probe_row(row);
                    assert_eq!(body.read(cx).rendered_text().source(), reply);
                    let bounds = body.read(cx).bounds();
                    assert!(bounds.top() >= viewport.top() && bounds.bottom() <= viewport.bottom(), "{choice}/{phase}: final reply text itself must be visible: {bounds:?}");
                }
            }).unwrap();
        }
        assert!(
            commands.try_recv().is_err(),
            "no reload loop for a current sliding window"
        );
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        cx.run_until_parked();
    }
}
