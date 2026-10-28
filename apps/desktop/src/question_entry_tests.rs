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
