use super::*;
use serde_json::json;

#[test]
fn reads_the_protocol_fields_like_swift() {
    let record = Record::read(&json!({
        "question": "  Where should retries live?\u{200b} ",
        "context": " Only the worker needs them. ",
        "options": [
            {"label": "Shared client", "detail": " Every caller ", "suggested": true},
            {"label": "Sync worker", "detail": "  "},
            {"label": " "},
            {"detail": "no label"},
            {"label": 3}
        ],
        "multiSelect": true
    }))
    .unwrap();
    assert_eq!(record.question, "Where should retries live?");
    assert_eq!(
        record.context.as_deref(),
        Some("Only the worker needs them.")
    );
    assert_eq!(
        record.options,
        [
            Choice {
                label: "Shared client".into(),
                detail: Some("Every caller".into()),
                suggested: true
            },
            Choice {
                label: "Sync worker".into(),
                detail: None,
                suggested: false
            },
        ]
    );
    assert!(record.multi);
    assert_eq!(
        record.source(),
        "Where should retries live?\n\nOnly the worker needs them.\n\n\
         1. Shared client: Every caller (suggested)\n2. Sync worker\n\n\
         Several answers could be picked."
    );
}

#[test]
fn open_questions_and_access_requests_stay_truthful() {
    let open = Record::read(&json!({"question": "Anything else?", "options": []})).unwrap();
    assert_eq!(open.source(), "Anything else?");
    assert!(!open.multi);
    // Older or partial records may omit options entirely.
    assert_eq!(
        Record::read(&json!({"question": "Ready?"}))
            .unwrap()
            .source(),
        "Ready?"
    );
    let access = Record::read(&json!({
        "question": "Allow read access to prod?",
        "options": [{"label": "Allow"}, {"label": "Deny"}],
        "multiSelect": true,
        "databaseAccess": {"id": "r1", "env": "prod", "mode": "read"}
    }))
    .unwrap();
    assert!(!access.multi, "access requests are single choice");
    assert_eq!(
        access.source(),
        "Allow read access to prod?\n\n1. Allow\n2. Deny"
    );
    // A single answer is never described as multi-select.
    let one =
        Record::read(&json!({"question": "Q", "options": [{"label": "A"}], "multiSelect": true}));
    assert!(!one.unwrap().multi);
}

#[test]
fn keeps_at_most_nine_answers_in_order() {
    let options: Vec<_> = (1..=12)
        .map(|n| json!({"label": format!("A{n}")}))
        .collect();
    let record = Record::read(&json!({"question": "Pick", "options": options})).unwrap();
    assert_eq!(record.options.len(), 9);
    assert_eq!(record.options[8].label, "A9");
    assert!(record.source().ends_with("\n9. A9"));
}

#[test]
fn records_without_readable_text_are_not_questions() {
    for data in [
        json!(null),
        json!({}),
        json!({"question": ""}),
        json!({"question": " \n\u{200b} "}),
        json!({"question": 7, "options": [{"label": "A"}]}),
        json!("Which checks?"),
    ] {
        assert_eq!(Record::read(&data), None, "{data}");
    }
}

#[test]
fn preview_is_the_first_line_collapsed_and_bounded() {
    let record =
        Record::read(&json!({"question": "\n  Which   checks\tshould run?\n\nDetails follow."}))
            .unwrap();
    assert_eq!(record.preview(), "Which checks should run?");
    // The full text, with its line breaks, stays in the source.
    assert!(record.source().contains("\n\nDetails follow."));
    let long = Record::read(&json!({"question": "é".repeat(400)})).unwrap();
    assert_eq!(long.preview().chars().count(), 160);
    assert!(long.preview().ends_with('…'));
    let emoji = Record::read(&json!({"question": "👨‍👩‍👧 ok"})).unwrap();
    assert_eq!(emoji.preview(), "👨‍👩‍👧 ok");
}

#[test]
fn answered_reply_bookkeeping_is_not_transcript_content_live_or_cold() {
    use crate::{local_model::LiveTranscript, question::Projection};
    for answer in [
        "Everywhere",
        "東京 👨‍👩‍👧 e\u{301}\n\nKeep <exact> & **literal** text.\n",
    ] {
        let entries = fixture::answered(answer);
        let mut live = LiveTranscript::default();
        live.apply(&json!({"type":"snapshot", "entries":[entries[0]], "run":{"startedAt":1}}));
        assert!(live.question_awaited());
        for entry in &entries[1..] {
            live.apply(&json!({"type":"entry_appended", "entry":entry}));
        }
        live.apply(&json!({"type":"run_end"}));
        let mut cold = LiveTranscript::default();
        cold.apply(&json!({"type":"snapshot", "entries":entries}));
        for model in [&mut live, &mut cold] {
            let rows = model.rows();
            assert_eq!(
                rows.len(),
                2,
                "question + one exact answer, not edit markers"
            );
            assert!(rows[0].question_data().is_some());
            assert_eq!(rows[1].source(), answer);
            assert!(rows[1].label().starts_with("You"));
            assert!(
                rows[1].is_question_reply(),
                "canonical reply uses the custom block"
            );
            assert_eq!(
                rows[1].reader_key(),
                Some(crate::model::ReaderKey::model(3, 0, None))
            );
            assert!(matches!(model.question(), Projection::None));
            assert!(!model.question_awaited());
        }
        assert!(
            live.rows() == cold.rows(),
            "live and replay share presentation"
        );
    }
}

#[test]
fn reply_markers_alone_never_prove_an_answer_or_hide_cancellation() {
    use crate::local_model::LiveTranscript;
    let entries = fixture::answered("Everywhere");
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot", "entries":[entries[0], entries[2], entries[3]], "run":{"startedAt":1}}));
    assert!(
        model.question_awaited(),
        "bookkeeping is not accepted-reply evidence"
    );
    model.apply(&json!({"type":"run_end"}));
    assert!(matches!(
        model.question(),
        crate::question::Projection::Pending(_)
    ));
    // A cancelled/interrupted tool result remains findable, even if its model
    // context was later edited to include an accepted answer.
    let result = json!({"id":5,"head":1,"kind":"pi.tool-result","model":[{
        "role":"toolResult","toolCallId":"ask-call","toolName":"codemode",
        "isError":true,"content":[{"type":"text","text":"Question cancelled"}]
    }]});
    model.apply(&json!({"type":"entry_appended", "entry":result}));
    let rows = model.rows();
    assert!(
        rows.iter()
            .filter_map(|r| r.work_data())
            .flat_map(|work| work.calls())
            .any(|call| call.output.as_str() == "Question cancelled"
                && call.status == crate::tool_presentation::Status::Error)
    );
    assert!(rows.iter().all(|r| !r.label().contains("question-reply")));
}

#[test]
fn only_the_exact_omit_target_uses_the_custom_reply_presentation() {
    use crate::local_model::LiveTranscript;
    let entries = fixture::answered("Everywhere");
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[entries[0],entries[1],entries[3]]}));
    assert!(
        !model.rows()[1].is_question_reply(),
        "context edits never classify a user message"
    );
    model.apply(&json!({"type":"entry_appended","entry":entries[2]}));
    assert!(model.rows()[1].is_question_reply());
    let other =
        json!({"id":7,"head":1,"kind":"pi.user","model":[{"role":"user","content":"Everywhere"}]});
    model.apply(&json!({"type":"entry_appended","entry":other}));
    assert!(
        !model.rows()[2].is_question_reply(),
        "identical text is not reply identity"
    );
    // A retained prefix keeps its explicit target association across reconnect.
    let tail =
        json!({"id":10,"head":10,"kind":"pi.user","model":[{"role":"user","content":"Later"}]});
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[tail]}));
    model.page(10, &json!({"entries":entries,"more":false}));
    assert!(model.rows()[1].is_question_reply());
    model.apply(&json!({"type":"snapshot","entries":[tail]}));
    assert!(model.rows()[1].is_question_reply());
    // A replacement history without that marker must not inherit its styling.
    model.apply(&json!({"type":"snapshot","entries":[entries[0],entries[1]]}));
    assert!(!model.rows()[1].is_question_reply());
}

#[test]
fn malformed_or_unknown_records_and_actual_model_content_stay_visible() {
    use crate::local_model::LiveTranscript;
    let entries = fixture::answered("Everywhere");
    let mut cases = vec![
        json!({"id":4,"kind":"pilot.future-event","model":[]}),
        json!({"id":4,"kind":"pilot.question-reply","model":[]}),
        json!({"id":4,"kind":"pilot.question-reply-context","model":[]}),
    ];
    for (path, value) in [
        ("/edits/0/target", json!(null)),
        ("/edits/0/action", json!("unknown")),
        ("/edits/0/messages", json!([])),
        ("/edits/0/messages/1/content", json!(null)),
        ("/data", json!({"error":"Unknown outcome"})),
    ] {
        let mut bad = entries[3].clone();
        if path == "/data" {
            bad["data"] = value;
        } else {
            *bad.pointer_mut(path).unwrap() = value;
        }
        cases.push(bad);
    }
    for entry in cases {
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"snapshot", "entries":[entry]}));
        let rows = model.rows();
        assert_eq!(rows.len(), 1, "unrecognized records remain inspectable");
        assert!(rows[0].source().contains("Structured entry"));
    }
    let mut content = entries[2].clone();
    content["model"] = json!([{"role":"user","content":"Actual content"}]);
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot", "entries":[content]}));
    assert_eq!(model.rows()[0].source(), "Actual content");
}
