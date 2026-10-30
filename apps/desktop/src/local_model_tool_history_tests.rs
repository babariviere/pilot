//! Historical tool reconstruction, without unbalanced intermediate row projections.
use super::*;
use crate::{model::ReaderKey, tool_presentation::Tool};
use serde_json::json;

fn call(entry: u64, id: &str) -> Value {
    json!({"id":entry,"head":1,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":id,"name":"read","arguments":{"path":format!("{id}.rs")}}]}]})
}

fn reply(entry: u64) -> Value {
    json!({"id":entry,"head":1,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":"Exact 日本 👩‍💻 e\u{301}"}]}]})
}

fn result(entry: u64, id: &str, error: bool) -> Value {
    json!({"id":entry,"head":1,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":id,"toolName":"read","isError":error,"content":[{"type":"text","text":format!("Exact result {id} 日本")}]}]})
}

fn tools(rows: &[Message]) -> Vec<&Tool> {
    rows.iter()
        .filter_map(|row| row.work_data())
        .flat_map(|work| work.calls().map(AsRef::as_ref))
        .collect()
}

fn status(model: &mut LiveTranscript, id: &str) -> &'static str {
    let rows = model.rows();
    tools(&rows)
        .into_iter()
        .find(|tool| tool.id == id)
        .expect("retained tool")
        .status
        .label()
}

#[test]
fn unresolved_prefix_matches_whole_snapshot_without_intermediate_rows() {
    let entries = vec![call(10, "first"), call(11, "second"), reply(12)];
    let mut whole = LiveTranscript::default();
    let mut split = LiveTranscript::default();
    whole.apply(&json!({"type":"snapshot","entries":entries}));
    split.apply(&json!({"type":"snapshot","entries":entries[1..],"prefixPending":true}));
    split.apply(&json!({"type":"snapshot_prefix","entries":entries[..1]}));
    // rows() allocates IDs and groups. Each reducer is projected once, only now.
    let whole = whole.rows();
    let split = split.rows();
    for rows in [&whole, &split] {
        assert_eq!(tools(rows).len(), 2);
        for tool in tools(rows) {
            assert_eq!(tool.status.label(), "Status unknown", "{}", tool.id);
        }
        for key in [
            ReaderKey::Tool("first".into()),
            ReaderKey::Tool("second".into()),
            ReaderKey::model(10, 0, Some(0)),
            ReaderKey::model(11, 0, Some(0)),
            ReaderKey::model(12, 0, Some(0)),
        ] {
            assert!(crate::model::reader_index(rows, &key).is_some(), "{key:?}");
        }
    }
    assert!(
        whole == split,
        "exact final projection, including presentation IDs"
    );
}

#[test]
fn older_pages_preserve_genuine_live_pending_and_running_calls() {
    for paged in [true, false] {
        let context = json!({"conversationId":0,"tail":20});
        let mut tail = reply(20);
        tail["head"] = json!(20);
        let mut snapshot = json!({"type":"snapshot","entries":[tail]});
        if paged {
            snapshot["history"] = json!({"context":context,"more":true,"before":20});
        }
        let mut model = LiveTranscript::default();
        model.apply(&snapshot);
        model.apply(&json!({"type":"run_start"}));
        model.apply(
            &json!({"type":"message_start","message":{"role":"assistant","timestamp":1,"content":[
                {"type":"toolCall","id":"pending","name":"read","arguments":{"path":"pending.rs"}},
                {"type":"toolCall","id":"running","name":"read","arguments":{"path":"running.rs"}}
            ]}}),
        );
        model.apply(
            &json!({"type":"tool_execution_start","toolCallId":"running","toolName":"read"}),
        );
        model.apply(&json!({"type":"tool_execution_update","toolCallId":"running","output":{"set":"live output 日本"}}));
        assert!(model.page(20, &json!({"context":context,"before":20,"entries":[call(10,"historical")],"more":false,"nextBefore":null})));
        let rows = model.rows();
        let calls = tools(&rows);
        for (id, expected) in [
            ("pending", "Pending"),
            ("running", "Running…"),
            ("historical", "Status unknown"),
        ] {
            let tool = calls.iter().find(|tool| tool.id == id).unwrap();
            assert_eq!(tool.status.label(), expected, "paged={paged}, {id}");
        }
        assert_eq!(
            calls
                .iter()
                .find(|tool| tool.id == "running")
                .unwrap()
                .output
                .as_str(),
            "live output 日本"
        );
        assert!(
            rows.iter()
                .filter_map(|row| row.work_data())
                .any(|work| work.active)
        );
    }
}

#[test]
fn historical_results_and_canonical_anchors_survive_all_snapshot_boundaries() {
    let entries = vec![
        call(10, "missing"),
        call(11, "done"),
        call(12, "failed"),
        result(13, "done", false),
        result(14, "failed", true),
        reply(15),
    ];
    let context = json!({"conversationId":0,"tail":15});
    for mode in ["whole", "split", "paged"] {
        let mut model = LiveTranscript::default();
        if mode == "whole" {
            model.apply(&json!({"type":"snapshot","entries":entries}));
        } else if mode == "split" {
            model.apply(&json!({"type":"snapshot","entries":entries[3..],"prefixPending":true}));
            model.apply(&json!({"type":"snapshot_prefix","entries":entries[..3]}));
        } else {
            model.apply(&json!({"type":"snapshot","entries":entries[3..],"history":{"context":context,"before":13,"more":true}}));
            assert!(model.page(13, &json!({"context":context,"before":13,"entries":entries[..3],"more":false,"nextBefore":null})));
        }
        let rows = model.rows();
        let calls = tools(&rows);
        assert_eq!(calls.len(), 3, "{mode}: no omitted or duplicated calls");
        for (id, expected) in [
            ("missing", "Status unknown"),
            ("done", ""),
            ("failed", "Failed"),
        ] {
            let tool = calls.iter().find(|tool| tool.id == id).unwrap();
            assert_eq!(tool.status.label(), expected, "{mode}: {id}");
            assert_eq!(
                tool.arguments.as_str(),
                serde_json::to_string_pretty(&json!({"path":format!("{id}.rs")})).unwrap()
            );
            if id != "missing" {
                assert_eq!(tool.output.as_str(), format!("Exact result {id} 日本"));
            }
            assert!(crate::model::reader_index(&rows, &ReaderKey::Tool(id.into())).is_some());
        }
        for entry in 10..=12 {
            assert!(
                crate::model::reader_index(&rows, &ReaderKey::model(entry, 0, Some(0))).is_some()
            );
        }
        assert!(crate::model::reader_index(&rows, &ReaderKey::model(15, 0, Some(0))).is_some());
        assert_eq!(rows.last().unwrap().source(), "Exact 日本 👩‍💻 e\u{301}");
        let ids: Vec<_> = rows.iter().map(Message::id).collect();
        let again = model.rows();
        assert!(rows == again, "{mode}: stable repeated projection");
        assert_eq!(ids, again.iter().map(Message::id).collect::<Vec<_>>());
    }
}

#[test]
fn prefix_hydrates_known_live_calls_without_interrupting_or_losing_results() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[reply(20)],"prefixPending":true}));
    model.apply(&json!({"type":"run_start"}));
    let live = call(21, "pending")["model"][0].clone();
    model.apply(&json!({"type":"message_start","message":live}));
    model.apply(&json!({"type":"tool_execution_start","toolCallId":"running","toolName":"read"}));
    model.apply(&json!({"type":"tool_execution_update","toolCallId":"running","output":{"set":"partial output"}}));
    model.apply(&json!({"type":"snapshot_prefix","entries":[call(10,"historical"),call(11,"pending"),call(12,"running")]}));
    assert_eq!(status(&mut model, "historical"), "Status unknown");
    assert_eq!(status(&mut model, "pending"), "Pending");
    assert_eq!(status(&mut model, "running"), "Running…");
    let before = model.rows();
    model.stale();
    model.compaction_stream(true); // Same verified stream resumes, without a replacement snapshot.
    assert_eq!(status(&mut model, "pending"), "Pending");
    assert_eq!(status(&mut model, "running"), "Running…");
    model.apply(&json!({"type":"tool_execution_end","toolCallId":"running","entry":result(22,"running",false)}));
    model.apply(&json!({"type":"message_end","entry":call(21,"pending")}));
    model.apply(&json!({"type":"tool_execution_start","toolCallId":"pending","toolName":"read"}));
    model.apply(&json!({"type":"tool_execution_end","toolCallId":"pending","isError":true,"entry":result(23,"pending",true)}));
    model.apply(&json!({"type":"run_end"}));
    assert_eq!(status(&mut model, "running"), "");
    assert_eq!(status(&mut model, "pending"), "Failed");
    let after = model.rows();
    assert_eq!(tools(&after).len(), 3);
    for id in ["historical", "pending", "running"] {
        let old = tools(&before).into_iter().find(|t| t.id == id).unwrap();
        let new = tools(&after).into_iter().find(|t| t.id == id).unwrap();
        assert_eq!(old.key, new.key, "stable live tool identity");
        assert_eq!(old.arguments, new.arguments);
    }
    assert_eq!(
        tools(&after)
            .into_iter()
            .find(|t| t.id == "running")
            .unwrap()
            .output
            .as_str(),
        "Exact result running 日本"
    );
}

#[test]
fn replacement_snapshot_rejects_old_prefix_and_page_but_retains_reported_live_tool() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[reply(20)],"prefixPending":true,"run":{"startedAt":1},"tools":[{"callId":"running","name":"read","status":"running","output":"snapshot output"}]}));
    model.apply(
        &json!({"type":"snapshot_prefix","entries":[call(10,"missing"),call(11,"running")]}),
    );
    assert_eq!(status(&mut model, "missing"), "Status unknown");
    assert_eq!(status(&mut model, "running"), "Running…");
    let running_key = model.tools.key("running").unwrap();
    let context = json!({"conversationId":1,"tail":50});
    model.apply(&json!({"type":"snapshot","entries":[reply(50)],"history":{"context":context,"more":true,"before":50},"run":{"startedAt":1},"tools":[{"callId":"running","name":"read","status":"running","output":"new output"}]}));
    model.apply(&json!({"type":"snapshot_prefix","entries":[call(10,"stale-prefix")]}));
    assert!(!model.page(50,&json!({"context":{"conversationId":0,"tail":20},"before":50,"entries":[call(10,"stale-page")],"more":false,"nextBefore":null})));
    assert!(model.page(50,&json!({"context":context,"before":50,"entries":[call(30,"new-missing"),call(31,"running")],"more":false,"nextBefore":null})));
    let rows = model.rows();
    let calls = tools(&rows);
    assert_eq!(
        calls.len(),
        2,
        "replaced history and rejected deliveries are absent"
    );
    let running = calls.iter().find(|t| t.id == "running").unwrap();
    assert_eq!(running.status.label(), "Running…");
    assert_eq!(running.key, running_key);
    assert_eq!(running.output.as_str(), "new output");
    assert_eq!(
        calls
            .iter()
            .find(|t| t.id == "new-missing")
            .unwrap()
            .status
            .label(),
        "Status unknown"
    );
    model.apply(&json!({"type":"run_end"}));
    assert_eq!(status(&mut model, "running"), "Status unknown");
}
