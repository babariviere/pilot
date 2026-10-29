use super::*;
use crate::local_model::LiveTranscript;
use serde_json::json;
fn call_entry(id: u64, calls: Vec<Value>) -> Value {
    json!({"id":id,"head":1,"kind":"pi.assistant","model":[{"role":"assistant","content":calls}]})
}
fn call(id: &str, name: &str, args: Value) -> Value {
    json!({"type":"toolCall","id":id,"name":name,"arguments":args})
}
fn result_entry(id: u64, call: &str, error: bool, text: &str) -> Value {
    json!({"id":id,"kind":"pi.tool","model":[{"role":"toolResult","toolCallId":call,"isError":error,"content":[{"type":"text","text":text}]}]})
}
#[test]
fn known_unknown_and_codemode_summaries_are_semantic_not_execution() {
    let mut tools = Tools::default();
    for (id, name, args, title, subject) in [
        (
            "a",
            "read",
            json!({"path":"/work/src/main.rs"}),
            "Read",
            "main.rs",
        ),
        (
            "b",
            "bash",
            json!({"command":"cargo test\necho next"}),
            "Ran",
            "cargo test",
        ),
        (
            "c",
            "codemode",
            json!({"code":"await tools.read({path: \"/work/src/model.rs\"})"}),
            "Read",
            "model.rs",
        ),
        (
            "d",
            "codemode",
            json!({"code":"await tools.read({path: \"a\"}); await tools.bash({command: \"false\"})"}),
            "Ran",
            "false",
        ),
        (
            "patch-script",
            "codemode",
            json!({"code":r#"text(await tools.applyPatch({patch:"*** Begin Patch\n*** Update File: src/view.rs\n@@\n-old\n+new\n*** End Patch"}));"#}),
            "Edited",
            "view.rs",
        ),
        (
            "e",
            "mcp__example__lookup",
            json!({"query":"synthetic query"}),
            "Used mcp  example  lookup",
            "synthetic query",
        ),
    ] {
        tools.call(id, 1, name, &args);
        let tool = &tools.items[id];
        assert_eq!(tool.title, title);
        assert_eq!(tool.subject, subject);
    }
    assert_eq!(tools.items["d"].meta, "+1 more");
}
fn label(code: &str) -> (String, String, String, Kind) {
    let mut tools = Tools::default();
    tools.call("s", 1, "codemode", &json!({ "code": code }));
    let tool = &tools.items["s"];
    (
        tool.title.clone(),
        tool.subject.clone(),
        tool.meta.clone(),
        tool.kind,
    )
}
#[test]
fn scripts_are_named_from_literal_nested_calls_or_a_leading_comment_only() {
    let s = |t: &str| t.to_owned();
    // Same-kind literal calls name the script.
    assert_eq!(
        label(
            "const [a, b] = await Promise.all([tools.read({ path: \"src/a.rs\" }), tools.read({\"path\": 'src/b.rs'})]);"
        ),
        (s("Read"), s("a.rs, b.rs"), s(""), Kind::Read)
    );
    assert_eq!(
        label(
            "await tools.read({path:\"a.rs\"});await tools.read({path:\"b.rs\"});await tools.read({path:\"c.rs\"});"
        ),
        (s("Read"), s("a.rs, b.rs"), s("+1 more"), Kind::Read)
    );
    assert_eq!(
        label("await tools.bash({ command: \"rg -n nestedTools src\" })"),
        (
            s("Searched code for"),
            s("nestedTools"),
            s(""),
            Kind::Search
        )
    );
    // Mixed kinds use the leading comment, skipping @options; effects lead otherwise.
    assert_eq!(
        label(
            "// @options: {\"timeout_ms\": 60000}\n// Run the probe and show the failure\nconst run = await tools.bash({ command: \"cargo test\" });\nawait tools.read({ path: \"log.txt\" });"
        ),
        (
            s("Run the probe and show the failure"),
            s(""),
            s(""),
            Kind::Command
        )
    );
    assert_eq!(
        label(
            "await tools.read({path:\"a.rs\"}); await tools.applyPatch({patch:\"*** Begin Patch\\n*** Update File: src/v.rs\\n@@\\n-a\\n+b\\n*** End Patch\"});"
        ),
        (s("Edited"), s("v.rs"), s("+1 more"), Kind::Edit)
    );
    // Non-literal or interpolated arguments are never guessed.
    for code in [
        "const p = 'x.rs';\nawait tools.read({ path: p });",
        "await tools.bash({ command: `cargo test ${name}` });",
    ] {
        let (title, subject, _, kind) = label(code);
        assert_eq!(
            (title.as_str(), kind),
            ("Ran a script", Kind::Script),
            "{code}"
        );
        assert_eq!(subject, code.lines().next().unwrap().trim(), "{code}");
    }
    // Commented-out calls, lookalike receivers and plain code are not calls.
    assert_eq!(
        label(
            "const x = 1;\n// await tools.bash({ command: \"rm -rf /\" })\nawait mytools.read({ path: \"y\" });"
        ),
        (s("Ran a script"), s("const x = 1;"), s(""), Kind::Script)
    );
    assert_eq!(
        label("// Summarize the rows\nreturn rows.length;"),
        (s("Summarize the rows"), s(""), s(""), Kind::Script)
    );
    assert_eq!(label(""), (s("Ran a script"), s(""), s(""), Kind::Script));
}
#[test]
fn script_status_is_the_outer_call_only_never_a_nested_one() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"run_start"}));
    let code = "await tools.bash({ command: \"cargo test\" });";
    model.apply(&json!({"type":"entry_appended","entry":call_entry(1,vec![call("s","codemode",json!({"code":code}))])}));
    model.apply(&json!({"type":"tool_execution_start","toolCallId":"s","toolName":"codemode"}));
    let work = model.rows()[0].work_data().unwrap().clone();
    assert_eq!(work.mark(work.calls().next().unwrap()), Mark::Live);
    assert_eq!(work.line()[1].text, "ran cargo test");
    model.apply(&json!({"type":"tool_execution_end","toolCallId":"s","isError":true,"entry":result_entry(2,"s",true,"Error: Tool bash: exit code 101")}));
    model.apply(&json!({"type":"run_end"}));
    let work = model.rows()[0].work_data().unwrap().clone();
    assert_eq!(work.mark(work.calls().next().unwrap()), Mark::Failed);
    assert_eq!(work.title, "cargo test failed");
    assert_eq!(
        work.first_error(),
        Some((0, "Error: Tool bash: exit code 101".into()))
    );
}
fn read_done(model: &mut LiveTranscript, entry: u64, id: &str) {
    model.apply(&json!({"type":"entry_appended","entry":call_entry(entry,vec![call(id,"read",json!({"path":format!("src/{id}.rs")}))])}));
    model.apply(&json!({"type":"tool_execution_end","toolCallId":id,"entry":result_entry(entry + 1,id,false,"contents")}));
}
#[test]
fn steps_count_like_swift_with_consecutive_successful_reads_merged() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"run_start"}));
    assert!(model.rows().is_empty(), "zero steps: no work row");
    read_done(&mut model, 1, "r1");
    let units = |model: &mut LiveTranscript| model.rows()[0].work_data().unwrap().units();
    assert_eq!(
        units(&mut model),
        [Unit::Step(0)],
        "one read is a single step"
    );
    read_done(&mut model, 3, "r2");
    read_done(&mut model, 5, "r3");
    assert_eq!(units(&mut model), [Unit::Reads(vec![0, 1, 2])]);
    model.apply(&json!({"type":"entry_appended","entry":call_entry(7,vec![json!({"type":"text","text":"A note between steps."}),call("b","bash",json!({"command":"cargo test"})),call("r4","read",json!({"path":"src/r4.rs"}))])}));
    // A failed read never merges; a running read waits until it succeeds.
    model.apply(&json!({"type":"tool_execution_end","toolCallId":"b","isError":true,"entry":result_entry(8,"b",true,"synthetic failure")}));
    model.apply(&json!({"type":"tool_execution_start","toolCallId":"r4","toolName":"read"}));
    read_done(&mut model, 9, "r5");
    model.apply(&json!({"type":"entry_appended","entry":call_entry(11,vec![call("r6","read",json!({"path":"src/r6.rs"}))])}));
    model.apply(&json!({"type":"tool_execution_end","toolCallId":"r6","isError":true,"entry":result_entry(12,"r6",true,"missing")}));
    let rows = model.rows();
    let work = rows[0].work_data().unwrap();
    assert_eq!(
        work.units(),
        [
            Unit::Reads(vec![0, 1, 2]),
            Unit::Step(3),
            Unit::Step(4),
            Unit::Step(5),
            Unit::Step(6),
            Unit::Step(7),
        ],
        "six mixed steps: merged reads, note, failure, live read, read, failed read"
    );
    assert!(work.active);
    // Each call keeps its own outcome; failures stay distinct.
    assert_eq!(
        work.calls().map(|tool| work.mark(tool)).collect::<Vec<_>>(),
        [
            Mark::Done,
            Mark::Done,
            Mark::Done,
            Mark::Failed,
            Mark::Live,
            Mark::Done,
            Mark::Failed,
        ]
    );
    assert_eq!(work.failures, 2);
}
#[test]
fn working_follows_the_run_not_gaps_and_ends_on_reply_turn_or_staleness() {
    let active = |model: &mut LiveTranscript| {
        model
            .rows()
            .iter()
            .find_map(|row| row.work_data().map(|work| work.active))
            .unwrap()
    };
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"run_start"}));
    read_done(&mut model, 1, "a");
    assert!(
        active(&mut model),
        "between tool events the run is still working"
    );
    assert!(
        model.rows()[0]
            .work_data()
            .unwrap()
            .title
            .starts_with("Working")
    );
    model.apply(&json!({"type":"message_start","message":{"timestamp":5,"content":[{"type":"text","text":"Streaming reply"}]}}));
    assert!(
        active(&mut model),
        "a streaming reply does not end the work yet"
    );
    model.apply(&json!({"type":"message_end","entry":call_entry(3,vec![json!({"type":"text","text":"Committed reply"})])}));
    assert!(
        !active(&mut model),
        "a committed reply ends Working before run_end"
    );
    let title = model.rows()[0].work_data().unwrap().title.clone();
    assert_eq!(title, "Read 1 file");

    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"run_start"}));
    read_done(&mut model, 1, "a");
    model.apply(&json!({"type":"entry_appended","entry":{"id":5,"kind":"pi.user","model":[{"role":"user","content":[{"type":"text","text":"next turn"}]}]}}));
    assert!(
        !active(&mut model),
        "a new user turn ends the earlier group"
    );

    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"run_start"}));
    model.apply(&json!({"type":"entry_appended","entry":call_entry(1,vec![call("a","bash",json!({"command":"sleep 1"}))])}));
    model.apply(&json!({"type":"tool_execution_start","toolCallId":"a","toolName":"bash"}));
    assert!(active(&mut model));
    model.stale();
    assert!(model.presentation_dirty);
    let rows = model.rows();
    let work = rows[0].work_data().unwrap();
    assert!(!work.active, "a stale connection never keeps Working");
    assert_eq!(
        work.mark(work.calls().next().unwrap()),
        Mark::Unknown,
        "a live call off a live run is unknown"
    );
    assert_eq!(work.uncertain, 1);
    // Reconnect: a snapshot without a run is idle; with a run it works again.
    let entry = call_entry(1, vec![call("a", "bash", json!({"command":"sleep 1"}))]);
    model.apply(&json!({"type":"snapshot","entries":[entry.clone()],"tools":[{"callId":"a","name":"bash","status":"running","output":""}]}));
    assert!(!active(&mut model));
    model.apply(&json!({"type":"snapshot","run":{},"entries":[entry],"tools":[{"callId":"a","name":"bash","status":"running","output":""}]}));
    assert!(active(&mut model));
    model.apply(&json!({"type":"run_end"}));
    assert!(!active(&mut model));
}
#[test]
fn the_line_leads_with_effects_then_outcomes_then_faint_reads() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"run_start"}));
    model.apply(&json!({"type":"entry_appended","entry":call_entry(1,vec![
        call("r","read",json!({"path":"src/a.rs"})),
        call("p","applyPatch",json!({"patch":"*** Begin Patch\n*** Update File: src/work_view.rs\n@@\n-old\n-older\n+new\n*** End Patch"})),
        call("t","bash",json!({"command":"cargo test --test disclosure"})),
        call("w","web",json!({"action":"search","query":"gpui"})),
    ])}));
    for (entry, id) in [(2, "r"), (3, "p"), (4, "w")] {
        model.apply(&json!({"type":"tool_execution_end","toolCallId":id,"entry":result_entry(entry,id,false,"ok")}));
    }
    model.apply(&json!({"type":"tool_execution_start","toolCallId":"t","toolName":"bash"}));
    let line = model.rows()[0].work_data().unwrap().line();
    assert_eq!(
        line.iter()
            .map(|s| (s.text.as_str(), s.tone))
            .collect::<Vec<_>>(),
        [("Working", Tone::Muted), ("ran cargo test", Tone::Muted)]
    );
    model.apply(&json!({"type":"tool_execution_end","toolCallId":"t","isError":true,"entry":result_entry(5,"t",true,"assertion failed")}));
    model.apply(&json!({"type":"run_end"}));
    let line = model.rows()[0].work_data().unwrap().line();
    assert_eq!(
        line.iter()
            .map(|s| (s.text.as_str(), s.tone))
            .collect::<Vec<_>>(),
        [
            ("Edited work_view.rs", Tone::Strong),
            ("+1 −2", Tone::Muted),
            ("cargo test failed", Tone::Danger),
            ("read 1 file, made 1 search", Tone::Faint),
        ]
    );
}
#[test]
fn diffs_are_prepared_from_structured_edits_and_patch_not_from_output_claims() {
    let mut tools = Tools::default();
    tools.call(
        "edit",
        1,
        "edit",
        &json!({"path":"a.rs","oldText":"same\nold\nend","newText":"same\nnew\nend"}),
    );
    let edit = &tools.items["edit"];
    assert_eq!((edit.additions, edit.deletions), (1, 1));
    assert!(edit.diff.contains("-old\n+new"));
    tools.call("patch",2,"applyPatch",&json!({"patch":"*** Begin Patch\n*** Update File: src/b.rs\n@@\n-old\n+new\n*** End Patch"}));
    assert_eq!(tools.items["patch"].subject, "b.rs");
    assert_eq!(tools.items["patch"].additions, 1);
}
#[test]
fn parallel_out_of_order_events_deduplicate_calls_and_preserve_failures() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"entry_appended","entry":call_entry(1,vec![call("a","read",json!({"path":"a.rs"})),call("b","bash",json!({"command":"cargo test"}))])}));
    model.apply(&json!({"type":"tool_execution_start","toolCallId":"a","toolName":"read"}));
    model.apply(&json!({"type":"tool_execution_start","toolCallId":"b","toolName":"bash"}));
    model.apply(&json!({"type":"tool_execution_end","toolCallId":"b","isError":true,"entry":result_entry(2,"b",true,"synthetic failure")}));
    model.apply(&json!({"type":"tool_execution_update","toolCallId":"b","output":{"set":"late stale output"}}));
    model.apply(&json!({"type":"tool_execution_end","toolCallId":"a","entry":result_entry(3,"a",false,"read result")}));
    let rows = model.rows();
    assert_eq!(rows.len(), 1);
    let work = rows[0].work_data().unwrap();
    let calls: Vec<_> = work.calls().collect();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].id, "a");
    assert_eq!(calls[1].id, "b");
    assert!(calls[1].status == Status::Error);
    assert_eq!(calls[1].output.as_str(), "synthetic failure");
    assert_eq!(work.failures, 1);
    assert!(!work.active);
}
#[test]
fn streaming_commit_snapshot_and_prepend_keep_work_and_call_identity() {
    let mut model = LiveTranscript::default();
    let block = call("a", "read", json!({"path":"a.rs"}));
    model.apply(
        &json!({"type":"message_start","message":{"timestamp":10,"content":[block.clone()]}}),
    );
    let first = model.rows()[0].id();
    let entry = call_entry(20, vec![block]);
    model.apply(&json!({"type":"message_end","entry":entry.clone()}));
    assert_eq!(model.rows()[0].id(), first);
    model.apply(&json!({"type":"snapshot","entries":[entry],"tools":[{"callId":"a","name":"read","status":"running","output":""}]}));
    assert_eq!(model.rows()[0].id(), first);
    model.page(1, &json!({"entries":[],"more":false}));
    // An earlier adjacent call must merge into the existing group, not replace its anchor.
    model.apply(&json!({"type":"entry_appended","entry":call_entry(10,vec![call("older","read",json!({"path":"older.rs"}))])}));
    let rows = model.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id(), first);
    assert_eq!(rows[0].work_data().unwrap().calls().count(), 2);
}
#[test]
fn final_answer_is_outside_work_and_note_tool_order_is_not_rearranged() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"entry_appended","entry":call_entry(1,vec![json!({"type":"text","text":"before"}),call("a","read",json!({"path":"a"})),json!({"type":"text","text":"after"})])}));
    let rows = model.rows();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].source(), "after");
    let steps = &rows[0].work_data().unwrap().steps;
    assert!(matches!(&steps[0],Step::Note{text,..}if text.as_str()=="before"));
    assert!(matches!(&steps[1],Step::Tool(t)if t.id=="a"));
}
#[test]
fn tool_detail_budget_and_unicode_trim_are_bounded_without_terminal_regression() {
    let mut tools = Tools::default();
    for n in 0..400 {
        let id = format!("call-{n}");
        tools.call(&id, n, "unknown", &json!({"value":"x".repeat(24 * 1024)}));
        tools.start(&id, n, "unknown");
        tools.update(&id, n, &json!({"set":"日".repeat(OUTPUT_CAP)}));
        tools.end_unknown(&id, n, false);
        assert!(tools.items.len() <= TOOL_CAP);
        assert!(tools.items.values().map(|t| t.bytes()).sum::<usize>() <= DETAIL_CAP);
    }
    let mut tools = Tools::default();
    tools.start("a", 1, "bash");
    tools.update("a", 1, &json!({"set":"日a本"}));
    tools.update("a", 1, &json!({"trimStart":2,"append":"語"}));
    assert_eq!(tools.items["a"].output.as_str(), "本語");
    tools.result("a", 1, "bash", &json!({"content":"failed","isError":true}));
    tools.start("a", 1, "bash");
    tools.update("a", 1, &json!({"set":"stale"}));
    assert!(tools.items["a"].status == Status::Error);
    assert_eq!(tools.items["a"].output.as_str(), "failed");
}

#[test]
fn utf16_tool_output_and_partial_argument_paths_match_the_wire_contract() {
    let mut tools = Tools::default();
    tools.start("a", 1, "bash");
    tools.update("a", 1, &json!({"set":"😀a日本"}));
    tools.update("a", 1, &json!({"trimStart":3,"append":"語"}));
    assert_eq!(tools.items["a"].output.as_str(), "日本語");
    tools.update("a", 1, &json!({"set":"x".repeat(OUTPUT_CAP+1)}));
    let capped = tools.items["a"].output.clone();
    tools.update("a", 1, &json!({"append":"cannot reconstruct this delta"}));
    assert_eq!(tools.items["a"].output, capped);
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"message_start","message":{"timestamp":1,"content":[call("a","bash",json!({"command":"cargo "}))]}}));
    model.apply(&json!({"type":"message_update","changes":[{"type":"toolcall_delta","contentIndex":0,"path":["command"],"delta":"test"}]}));
    let rows = model.rows();
    assert_eq!(
        rows[0].work_data().unwrap().calls().next().unwrap().subject,
        "cargo test"
    );
}

#[test]
fn orphan_failure_and_interruption_stay_visible_until_authoritative_snapshot() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"tool_execution_start","toolCallId":"orphan","toolName":"bash"}));
    model.apply(&json!({"type":"tool_execution_end","toolCallId":"orphan","isError":true}));
    assert_eq!(model.rows()[0].work_data().unwrap().failures, 1);
    model.apply(&json!({"type":"snapshot","entries":[]}));
    assert!(model.rows().is_empty());
}

#[test]
fn out_of_order_progress_cannot_bypass_the_live_slot_bound() {
    let mut tools = Tools::default();
    for key in 0..32 {
        assert!(tools.start(&format!("call-{key}"), key, "bash"));
    }
    assert!(!tools.start("overflow", 33, "bash"));
    assert!(!tools.update("overflow", 33, &json!({"set":"no bypass"})));
    assert_eq!(tools.items.len(), 32);
}

#[test]
fn command_captions_are_conservative_display_only_and_keep_original_source() {
    for (source, expected) in [
        (
            "set -euo pipefail\ncd synthetic-workspace\ncargo test --locked --test parser",
            "cargo test",
        ),
        ("/usr/bin/git status --short", "git status"),
        ("printf '%s' '日本語 👩‍💻'", "printf"),
        ("cd repo && false", "cd repo && false"),
        ("cargo test | tee output", "cargo test | tee output"),
        ("FOO=1 cargo test", "FOO=1 cargo test"),
        ("'/tmp/a b' test", "'/tmp/a b' test"),
        ("\"unterminated", "\"unterminated"),
        ("false", "false"),
        ("echo synthetic", "echo synthetic"),
        ("cd /repo", "cd /repo"),
        ("# comment\n\n日本語 検証 --flag", "日本語 検証"),
        ("", ""),
    ] {
        assert_eq!(command_subject(source), expected);
        let mut tools = Tools::default();
        tools.call("a", 1, "bash", &json!({"command":source,"timeout":30}));
        let tool = &tools.items["a"];
        assert_eq!(tool.subject, expected);
        assert_eq!(
            serde_json::from_str::<Value>(&tool.arguments).unwrap()["timeout"],
            30
        );
        if !source.is_empty() {
            assert_eq!(tool.input.as_ref().unwrap().0, "Command");
            assert_eq!(tool.input.as_ref().unwrap().1.as_str(), source);
        }
    }
    assert!(command_subject(&"日".repeat(400)).len() <= 240);
}

#[test]
fn executable_input_is_prepared_once_and_survives_preview_pressure() {
    let mut tools = Tools::default();
    let source = "return '<日本語 👩‍💻>';";
    tools.call("a", 1, "codemode", &json!({"code":source}));
    let tool = &tools.items["a"];
    let (label, input) = tool.input.as_ref().unwrap();
    assert_eq!(*label, "Code");
    assert_eq!(input.as_str(), source);
    let input = input.clone();
    let mut without_input = tool.as_ref().clone();
    without_input.input = None;
    assert_eq!(tool.bytes(), without_input.bytes());
    tools.update("a", 1, &json!({"set":"progress"}));
    assert!(Arc::ptr_eq(
        &input,
        &tools.items["a"].input.as_ref().unwrap().1
    ));
    let large = "x".repeat(3 * 1024 * 1024);
    tools.call("a", 1, "codemode", &json!({"code":large}));
    assert_eq!(tools.items["a"].input.as_ref().unwrap().1.as_str(), large);
    assert!(!tools.items["a"].limited);
    for key in 0..300 {
        let id = format!("bounded-{key}");
        tools.call(&id, key, "bash", &json!({"command":"日".repeat(2000)}));
        tools.update(&id, key, &json!({"set":"o".repeat(OUTPUT_CAP)}));
        tools.end_unknown(&id, key, false);
        assert!(tools.items.values().map(|tool| tool.bytes()).sum::<usize>() <= DETAIL_CAP);
    }
    assert_eq!(tools.items["a"].input.as_ref().unwrap().1.as_str(), large);
    assert_eq!(
        serde_json::from_str::<Value>(&tools.items["a"].arguments).unwrap()["code"],
        large
    );
}

#[test]
fn codemode_output_splits_only_its_exact_header() {
    let script =
        script_output("Script completed\nWall time 0.1 seconds\nOutput:\n\n{\"a\":1}\nlast")
            .unwrap();
    assert!(script.ok);
    assert_eq!((script.wall, script.body), ("0.1", "{\"a\":1}\nlast"));
    let failed = script_output("Script failed\nWall time 12.0 seconds\nOutput:\n").unwrap();
    assert_eq!((failed.ok, failed.body), (false, ""));
    // Anything else is shown as is.
    for other in [
        "Script completed\nWall time soon seconds\nOutput:\n",
        "Script completed\nOutput:\n",
        "script completed\nWall time 0.1 seconds\nOutput:\n",
        "Ran it\nWall time 0.1 seconds\nOutput:\n",
    ] {
        assert!(script_output(other).is_none(), "{other}");
    }
}

#[test]
fn full_arguments_survive_history_live_deltas_commit_and_reconnect() {
    // Above both former thresholds, including the aggregate preview reserve.
    for source in [
        "small 日本語".to_owned(),
        "行 👩‍💻 e\u{301} <>&\n".repeat(1200),
        "行 👩‍💻 e\u{301} <>&\n".repeat(100_000),
    ] {
        let args = json!({"code":source,"options":{"timeout":60000}});
        let entry = call_entry(20, vec![call("full", "codemode", args.clone())]);
        let check = |model: &mut LiveTranscript, expected: &Value| {
            let rows = model.rows();
            let tool = rows
                .iter()
                .filter_map(|r| r.work_data())
                .flat_map(|w| w.calls())
                .find(|t| t.id == "full")
                .unwrap();
            assert_eq!(
                tool.arguments.as_str(),
                serde_json::to_string_pretty(expected).unwrap()
            );
            assert_eq!(
                tool.input.as_ref().unwrap().1.as_str(),
                expected["code"].as_str().unwrap()
            );
            assert!(!tool.limited);
        };
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"snapshot","entries":[entry.clone()]}));
        check(&mut model, &args);
        let mut tail = call_entry(21, vec![]);
        tail["head"] = json!(21);
        model.apply(&json!({"type":"snapshot","entries":[tail]}));
        assert_eq!(model.cursor, Some(21));
        model.page(21, &json!({"entries":[entry.clone()],"more":false}));
        check(&mut model, &args);

        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"run_start"}));
        model.apply(&json!({"type":"message_start","message":{"role":"assistant","content":[call("full", "codemode", json!({"code":"","options":{"timeout":60000}}))]}}));
        model.apply(&json!({"type":"message_update","changes":[{"type":"toolcall_delta","contentIndex":0,"path":["code"],"delta":source}]}));
        check(&mut model, &args);
        // Output-only updates must not erase the retained input.
        model.apply(
            &json!({"type":"tool_execution_update","toolCallId":"full","output":{"set":"ok"}}),
        );
        check(&mut model, &args);
        model.apply(&json!({"type":"message_end","entry":entry.clone()}));
        check(&mut model, &args);
        model.apply(&json!({"type":"snapshot","entries":[entry]}));
        check(&mut model, &args);
    }
}

#[test]
fn absent_or_upstream_omitted_arguments_are_not_fabricated() {
    for args in [
        Value::Null,
        json!({"viewerOmitted":"Arguments omitted upstream"}),
        json!({"code":"available prefix","truncated":true}),
    ] {
        let mut tools = Tools::default();
        tools.call("source", 1, "codemode", &args);
        let tool = &tools.items["source"];
        assert_eq!(
            serde_json::from_str::<Value>(&tool.arguments).unwrap(),
            args
        );
        assert_eq!(tool.limited, !args["viewerOmitted"].is_null());
        if args["code"].is_null() {
            assert!(tool.input.is_none());
        }
    }
}
