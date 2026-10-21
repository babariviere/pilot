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
            "Ran a script",
            "",
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
        tools.call(&id, n, "unknown", &json!({"value":"x".repeat(ARG_CAP*2)}));
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
