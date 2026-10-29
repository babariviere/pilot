//! Swift-equivalent synthetic audits: `GitHubAction.event`, `canCollapse` and
//! `rebuildDisplayedEntries` placement, through the actual Local projection.
use super::*;
use crate::local_model::LiveTranscript;
use serde_json::json;

fn push(id: &str, after: u64, exit: Value) -> Value {
    json!({"id":id,"kind":"push","branch":"feat/inline-events","summary":"jj git push",
        "description":"pushed branch feat/inline-events","target":"feat/inline-events",
        "toolCallId":"call-1","afterEntryId":after,"conversationId":"1","missionId":"mission-A",
        "at":1_700_000_000_000u64 + after,"exitCode":exit})
}
fn opened(id: &str, after: u64, exit: Value) -> Value {
    json!({"id":id,"kind":"pr_opened","prNumber":42,"title":"Show pushes inline 👋",
        "summary":"gh pr create","description":"created PR #42","toolCallId":"call-2",
        "afterEntryId":after,"at":1_700_000_000_500u64,"exitCode":exit})
}
fn entry(id: u64, text: &str, at: u64) -> Value {
    json!({"id":id,"kind":"pi.assistant","model":[{"role":"assistant","timestamp":at,"content":[{"type":"text","text":text}]}]})
}
fn lines(rows: &[Message]) -> Vec<String> {
    rows.iter()
        .map(|r| match r.github_event() {
            Some(e) => format!("[{}]", e.line()),
            None => r.source().to_owned(),
        })
        .collect()
}
fn event(value: Value) -> Event {
    Event::new(&Action::read(&value).unwrap())
}

#[test]
fn sentences_match_swift_and_unknown_or_failed_never_read_as_success() {
    let ok = event(push("a", 1, json!(0)));
    assert_eq!(ok.sentence(), "Agent pushed");
    assert_eq!(ok.branch.as_deref(), Some("feat/inline-events"));
    assert_eq!((ok.detail(), ok.uncertainty()), (None, None));
    let pr = event(opened("b", 1, json!(0)));
    assert_eq!(pr.sentence(), "Agent created PR #42");
    assert_eq!(pr.title.as_deref(), Some("Show pushes inline 👋"));
    assert_eq!(pr.line(), "Agent created PR #42 Show pushes inline 👋");

    let failed = event(push("c", 1, json!(128)));
    assert_eq!(failed.sentence(), "Agent could not push");
    assert!(failed.failed());
    assert_eq!(
        failed.detail().as_deref(),
        Some("Command exited with status 128.")
    );
    let unknown = event(push("d", 1, Value::Null));
    assert_eq!(unknown.sentence(), "Agent attempted to push");
    assert_eq!(
        unknown.uncertainty(),
        Some("The command's exit status is unknown.")
    );
    assert!(unknown.help().contains("exit status is unknown"));
    let mut missing = push("e", 1, json!(0));
    missing.as_object_mut().unwrap().remove("exitCode");
    assert_eq!(event(missing).outcome, Outcome::Unknown);
    let pr_unknown = event(opened("f", 1, Value::Null));
    assert_eq!(pr_unknown.sentence(), "Agent attempted to create PR #42");
    let pr_failed = event(opened("g", 1, json!(1)));
    assert_eq!(pr_failed.sentence(), "Agent could not create PR #42");
    let mut no_number = opened("h", 1, json!(0));
    no_number.as_object_mut().unwrap().remove("prNumber");
    assert_eq!(event(no_number).sentence(), "Agent created a PR");
    for (kind, text) in [
        ("pr_ready", "Agent marked PR #42 ready"),
        ("pr_draft", "Agent marked PR #42 draft"),
        ("pr_edited", "Agent edited PR #42"),
        ("pr_reopened", "Agent reopened PR #42"),
    ] {
        let mut v = opened("i", 1, json!(0));
        v["kind"] = json!(kind);
        assert_eq!(event(v).sentence(), text);
    }
    // Older kernels: no kind, the recorded description is the sentence.
    let legacy = event(
        json!({"id":"l","summary":"git push","description":"pushed branch main","at":1,"exitCode":0}),
    );
    assert_eq!(
        (legacy.kind, legacy.sentence().as_str()),
        (None, "pushed branch main")
    );
    let legacy_failed = event(
        json!({"id":"l","summary":"git push","description":"pushed branch main","at":1,"exitCode":2}),
    );
    assert_eq!(legacy_failed.sentence(), "GitHub action failed");
}

#[test]
fn pr_link_is_only_a_confirmed_creations_own_exact_url() {
    let url = "https://github.com/acme/app/pull/42";
    let with = |mut v: Value, url: &str| {
        v["url"] = json!(url);
        Action::read(&v).unwrap()
    };
    let confirmed = with(opened("a", 1, json!(0)), url);
    assert_eq!(confirmed.url.as_deref(), Some(url));
    let event = Event::new(&confirmed);
    assert_eq!(event.url.as_deref(), Some(url));
    assert!(
        event.help().contains(url),
        "the exact link is in the row help"
    );
    // Never for a failed, unknown, other-kind, other-number or non-HTTPS record.
    assert_eq!(with(opened_with_exit(json!(1)), url).url, None);
    assert_eq!(with(opened_with_exit(Value::Null), url).url, None);
    assert_eq!(with(push("p", 1, json!(0)), url).url, None);
    assert_eq!(
        with(
            opened("b", 1, json!(0)),
            "https://github.com/acme/app/pull/7"
        )
        .url,
        None
    );
    assert_eq!(
        with(
            opened("c", 1, json!(0)),
            "http://github.com/acme/app/pull/42"
        )
        .url,
        None
    );
    assert_eq!(
        with(
            opened("d", 1, json!(0)),
            "https://github.com/acme/app/pull/42 x"
        )
        .url,
        None
    );
    assert_eq!(
        Action::read(&opened_with_exit(json!(0))).unwrap().url,
        None,
        "older kernels"
    );
}
fn opened_with_exit(exit: Value) -> Value {
    opened("e", 1, exit)
}

#[test]
fn audit_snapshot_is_bounded_deduplicated_and_skips_unreadable_items() {
    let mut items = vec![
        json!({"kind":"push"}),
        json!({"id":""}),
        push("a", 1, json!(0)),
        push("a", 2, json!(1)),
    ];
    items.extend((0..CAP + 5).map(|i| push(&format!("n{i}"), 3, json!(0))));
    let read = Action::read_all(&json!(items));
    assert_eq!(read.len(), CAP);
    assert_eq!(read.last().unwrap().id, format!("n{}", CAP + 4));
    assert!(
        read.iter().all(|a| a.id != "a"),
        "oldest dropped by the bound"
    );
    let small = Action::read_all(&json!([push("a", 1, json!(0)), push("a", 2, json!(1))]));
    assert_eq!(small.len(), 1);
    assert_eq!(small[0].outcome, Outcome::Succeeded, "first copy wins");
    assert!(Action::read_all(&json!(null)).is_empty());
}

#[test]
fn chat_rows_place_events_after_their_entry_and_collapse_like_swift() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[
        entry(1, "Pushing now", 1_000), entry(2, "Opening the PR", 2_000), entry(3, "Done", 3_000)]}));
    model.apply(&json!({"type":"github_actions_update","actions":[
        push("a", 1, json!(0)), push("b", 1, json!(0)), opened("c", 2, json!(0)),
        push("d", 2, Value::Null), push("e", 2, json!(1)), push("hidden", 99, json!(0))]}));
    let rows = model.rows();
    assert_eq!(
        lines(&rows),
        [
            "Pushing now",
            "[Agent pushed 2 times to feat/inline-events]",
            "Opening the PR",
            "[Agent created PR #42 Show pushes inline 👋]",
            "[Agent attempted to push feat/inline-events]",
            "[Agent could not push feat/inline-events]",
            "Done",
        ]
    );
    let collapsed = rows[1].github_event().unwrap();
    assert_eq!(
        (collapsed.count, collapsed.end),
        (2, Some(1_700_000_000_001))
    );
    // Reconnect: the kernel resends its whole audit after a new snapshot.
    let ids: Vec<_> = rows.iter().map(Message::id).collect();
    model.apply(&json!({"type":"snapshot","entries":[
        entry(1, "Pushing now", 1_000), entry(2, "Opening the PR", 2_000), entry(3, "Done", 3_000)]}));
    model.apply(&json!({"type":"github_actions_update","actions":[
        push("a", 1, json!(0)), push("b", 1, json!(0)), opened("c", 2, json!(0)),
        push("d", 2, Value::Null), push("e", 2, json!(1)), push("hidden", 99, json!(0))]}));
    let again = model.rows();
    assert_eq!(lines(&again), lines(&rows), "no duplicates on reload");
    assert_eq!(
        again.iter().map(Message::id).collect::<Vec<_>>(),
        ids,
        "stable row identity"
    );
    // The once-hidden action appears when its entry arrives; existing keys stay.
    model.apply(&json!({"type":"entry_appended","entry":entry(99, "Later", 9_000)}));
    let later = model.rows();
    assert_eq!(
        lines(&later).last().unwrap(),
        "[Agent pushed feat/inline-events]"
    );
    assert_eq!(later[1].id(), ids[1]);
}

#[test]
fn mission_and_plain_chats_show_the_same_attribution_and_failures_do_not_merge() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[entry(1, "Work", 1_000)]}));
    let mut plain = push("plain", 1, json!(0));
    plain.as_object_mut().unwrap().remove("missionId");
    model.apply(&json!({"type":"github_actions_update","actions":[
        push("mission", 1, json!(0)), plain, push("f1", 1, json!(1)), push("f2", 1, json!(1)),
        push("u", 1, Value::Null)]}));
    assert_eq!(
        lines(&model.rows()),
        [
            "Work",
            "[Agent pushed 2 times to feat/inline-events]",
            "[Agent could not push · 2 times feat/inline-events]",
            "[Agent attempted to push feat/inline-events]",
        ]
    );
    // A different branch never joins the run.
    let mut other = push("o", 1, json!(0));
    other["branch"] = json!("main");
    model.apply(&json!({"type":"github_actions_update","actions":[push("x", 1, json!(0)), other]}));
    assert_eq!(
        lines(&model.rows()),
        [
            "Work",
            "[Agent pushed feat/inline-events]",
            "[Agent pushed main]"
        ]
    );
    model.apply(&json!({"type":"github_actions_update","actions":[]}));
    assert_eq!(lines(&model.rows()), ["Work"]);
}

#[test]
fn tool_call_fallback_and_legacy_time_placement() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[
        {"id":1,"kind":"pi.assistant","model":[{"role":"assistant","timestamp":1_000,"content":[
            {"type":"text","text":"Calling"},{"type":"toolCall","id":"call-1","name":"bash","arguments":{}}]}]},
        entry(2, "Second", 5_000)]}));
    let mut by_call = push("call", 7, json!(0));
    by_call.as_object_mut().unwrap().remove("afterEntryId");
    let legacy = json!({"id":"old","description":"pushed branch main","summary":"git push","at":4_000,"exitCode":0});
    let early = json!({"id":"early","description":"pushed branch dev","summary":"git push","at":10,"exitCode":0});
    model.apply(&json!({"type":"github_actions_update","actions":[by_call, legacy, early]}));
    let rows = model.rows();
    let text = lines(&rows);
    assert_eq!(text[0], "[pushed branch dev]", "before every loaded entry");
    let call = text
        .iter()
        .position(|t| t == "[Agent pushed feat/inline-events]")
        .unwrap();
    let old = text
        .iter()
        .position(|t| t == "[pushed branch main]")
        .unwrap();
    let second = text.iter().position(|t| t == "Second").unwrap();
    assert!(call < second && old < second && call > 0);
}

/// Chat ee4aeca7's shape: a push script, then a note with a script and two
/// identical memory calls (the first failing), with the push audit placed
/// after the push call's entry.
fn split_run() -> Vec<Value> {
    let call = |id: u64, text: Option<&str>, call: &str, name: &str, args: Value| {
        let mut content = Vec::new();
        if let Some(text) = text {
            content.push(json!({"type":"text","text":text}));
        }
        content.push(json!({"type":"toolCall","id":call,"name":name,"arguments":args}));
        json!({"id":id,"kind":"pi.assistant","model":[{"role":"assistant","timestamp":id,"content":content}]})
    };
    let result = |id: u64, call: &str, name: &str, error: bool| {
        json!({"id":id,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":call,
            "toolName":name,"isError":error,"content":[{"type":"text","text":"out"}]}]})
    };
    let note = json!({"action":"note","text":"same"});
    vec![
        json!({"id":275,"kind":"pi.user","model":[{"role":"user","content":"Finished background jobs"}]}),
        call(286, None, "push", "codemode", json!({"code":"jj git push"})),
        result(288, "push", "codemode", false),
        call(
            290,
            Some("Pushed and confirmed."),
            "complete",
            "codemode",
            json!({"code":"mission complete"}),
        ),
        result(292, "complete", "codemode", false),
        call(295, None, "memory-1", "memory", note.clone()),
        result(297, "memory-1", "memory", true),
        call(299, None, "memory-2", "memory", note),
        result(301, "memory-2", "memory", false),
    ]
}
fn audit() -> Value {
    json!({"type":"github_actions_update","actions":[{"id":"push/1:0","toolCallId":"push",
        "summary":"jj git push","description":"pushed branch main","kind":"push","target":"main",
        "branch":"main","at":1,"exitCode":null,"afterEntryId":286}]})
}
/// Each row as text; a work group lists its steps once, by call ID or note.
fn shape(rows: &[Message]) -> Vec<String> {
    use crate::tool_presentation::Step;
    rows.iter()
        .map(|row| match row.work_data() {
            Some(work) => format!(
                "work{}[{}]",
                if work.active { "*" } else { "" },
                work.steps
                    .iter()
                    .map(|step| match step {
                        Step::Tool(tool) => tool.id.clone(),
                        Step::Note { text, .. } => text.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            None => lines(std::slice::from_ref(row)).remove(0),
        })
        .collect()
}
fn assert_split(rows: &[Message]) {
    assert_eq!(
        shape(rows),
        [
            "Finished background jobs",
            "work[push]",
            "[Agent attempted to push main]",
            "work*[Pushed and confirmed., complete, memory-1, memory-2]",
        ]
    );
    let ids: std::collections::BTreeSet<_> = rows.iter().map(Message::id).collect();
    assert_eq!(ids.len(), rows.len(), "every row has its own identity");
}

#[test]
fn an_event_inside_a_grouped_run_splits_it_into_distinct_groups() {
    // Reopen or reconnect: the kernel sends history, then its audit.
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","run":{},"entries":split_run()}));
    let whole = model.rows();
    assert_eq!(
        shape(&whole)[1],
        "work*[push, Pushed and confirmed., complete, memory-1, memory-2]"
    );
    let whole_id = whole[1].id();
    model.apply(&audit());
    let rows = model.rows();
    assert_split(&rows);
    assert_eq!(
        rows[1].id(),
        whole_id,
        "the first part keeps its disclosure"
    );
    let lower = rows[3].id();
    assert_eq!(
        model.rows().iter().map(Message::id).collect::<Vec<_>>(),
        rows.iter().map(Message::id).collect::<Vec<_>>(),
        "stable while unchanged"
    );
    // The run settles: same groups, same identities.
    model.apply(&json!({"type":"run_end"}));
    let settled = model.rows();
    assert_eq!(
        shape(&settled)[3],
        "work[Pushed and confirmed., complete, memory-1, memory-2]"
    );
    assert_eq!((settled[1].id(), settled[3].id()), (whole_id, lower));

    // Live order: the audit lands mid-run, before the later calls.
    let mut live = LiveTranscript::default();
    let entries = split_run();
    live.apply(&json!({"type":"snapshot","run":{},"entries":entries[..3]}));
    live.rows();
    live.apply(&audit());
    live.rows();
    for entry in &entries[3..] {
        live.apply(&json!({"type":"entry_appended","entry":entry}));
        live.rows();
    }
    assert_split(&live.rows());
}

#[test]
fn unknown_actions_and_grouped_rows_keep_uncertainty_in_help() {
    for (kind, verb) in [
        ("push", "Agent attempted to push"),
        ("pr_opened", "Agent attempted to create PR #42"),
        ("pr_ready", "Agent attempted to mark PR #42 ready"),
        ("pr_draft", "Agent attempted to mark PR #42 draft"),
        ("pr_edited", "Agent attempted to edit PR #42"),
        ("pr_reopened", "Agent attempted to reopen PR #42"),
        ("github_updated", "Agent attempted a GitHub update"),
    ] {
        let mut value = opened("x", 1, Value::Null);
        value["kind"] = json!(kind);
        let e = event(value);
        assert_eq!(e.sentence(), verb);
        assert!(!e.line().contains("Outcome unknown"));
        assert_eq!(e.outcome, Outcome::Unknown);
        assert!(e.help().contains("exit status is unknown"));
        assert!(!e.help().contains("may have"));
    }
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[entry(1, "Work", 1_000)]}));
    model.apply(&json!({"type":"github_actions_update","actions":[
        push("a", 1, Value::Null), push("b", 1, Value::Null),
        opened("c", 1, Value::Null), opened("d", 1, Value::Null),
        opened("e", 1, json!(0)), opened("f", 1, json!(0))]}));
    let rows = model.rows();
    assert_eq!(
        lines(&rows),
        [
            "Work",
            "[Agent attempted to push · 2 times feat/inline-events]",
            "[Agent attempted to create PR #42 · 2 times Show pushes inline 👋]",
            "[Agent created PR #42 · 2 times Show pushes inline 👋]"
        ]
    );
    for row in &rows[1..3] {
        let e = row.github_event().unwrap();
        assert_eq!(e.outcome, Outcome::Unknown);
        assert!(e.help().contains("exit status is unknown"));
    }
}
