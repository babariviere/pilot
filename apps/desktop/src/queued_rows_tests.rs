use super::*;
use serde_json::json;

fn user(id: u64, content: Value) -> Value {
    json!({"id":id,"kind":"pi.user","model":[{"role":"user","content":content}]})
}
fn queue(items: Value) -> Value {
    json!({"type":"queue_update","items":items,"automatic":[]})
}
fn view(model: &mut LiveTranscript) -> Vec<(String, Option<&'static str>)> {
    model
        .rows()
        .iter()
        .map(|row| (row.source().to_owned(), row.pending()))
        .collect()
}
fn started() -> LiveTranscript {
    let mut model = LiveTranscript::default();
    model.apply(
        &json!({"type":"snapshot","entries":[user(1, json!("Earlier"))],"run":{"startedAt":1}}),
    );
    model.apply(&queue(json!([])));
    model
}
fn earlier() -> (String, Option<&'static str>) {
    ("Earlier".into(), None)
}

#[test]
fn admitted_queue_rows_show_after_history_with_their_mode() {
    let mut model = started();
    model.apply(&queue(json!([
        {"id":7,"mode":"steer","content":"Check the tests"},
        {"id":8,"mode":"followUp","content":[{"type":"text","text":"Then ship"},{"type":"image","data":"AA","mimeType":"image/png"}]}
    ])));
    let rows = model.rows();
    assert_eq!(
        rows.iter()
            .map(|r| (r.source(), r.pending()))
            .collect::<Vec<_>>(),
        [
            ("Earlier", None),
            ("Check the tests", Some("Queued to steer")),
            ("Then ship\n\n[1 image attached]", Some("Queued")),
        ]
    );
    assert!(rows[1].label().starts_with("You"));
    assert_eq!(queued_submission(&rows[1]), Some(7));
    assert_eq!(queued_submission(&rows[0]), None);
    // An edit keeps the row's identity; only its text changes.
    model.apply(&queue(json!([
        {"id":7,"mode":"steer","content":"Check the unit tests"},
        {"id":8,"mode":"followUp","content":"Then ship"}
    ])));
    let edited = model.rows();
    assert_eq!(edited[1].id(), rows[1].id());
    assert_eq!(edited[1].source(), "Check the unit tests");
    assert!(model.departed.is_empty());
}

#[test]
fn history_entry_before_queue_update_never_shows_twice() {
    let mut model = started();
    model.apply(&queue(
        json!([{"id":7,"mode":"steer","content":"Steer now"}]),
    ));
    model.apply(&json!({"type":"message_end","entry":user(2, json!("Steer now"))}));
    assert_eq!(view(&mut model), [earlier(), ("Steer now".into(), None)]);
    model.apply(&queue(json!([])));
    assert_eq!(view(&mut model), [earlier(), ("Steer now".into(), None)]);
    assert!(model.departed.is_empty());
}

#[test]
fn queue_update_before_history_entry_keeps_the_row_without_a_gap() {
    let mut model = started();
    model.apply(&queue(
        json!([{"id":7,"mode":"steer","content":"Steer now"}]),
    ));
    model.apply(&queue(json!([])));
    assert_eq!(
        view(&mut model),
        [earlier(), ("Steer now".into(), Some("Queued to steer"))]
    );
    model.apply(&json!({"type":"entry_appended","entry":user(2, json!("Steer now"))}));
    assert_eq!(view(&mut model), [earlier(), ("Steer now".into(), None)]);
    assert!(model.departed.is_empty());
}

#[test]
fn identical_queued_messages_reconcile_one_at_a_time() {
    let mut model = started();
    model.apply(&queue(json!([
        {"id":7,"mode":"followUp","content":"yes"},
        {"id":8,"mode":"followUp","content":"yes"}
    ])));
    model.apply(&json!({"type":"message_end","entry":user(2, json!("yes"))}));
    assert_eq!(
        view(&mut model),
        [
            earlier(),
            ("yes".into(), None),
            ("yes".into(), Some("Queued"))
        ]
    );
    model.apply(&queue(json!([{"id":8,"mode":"followUp","content":"yes"}])));
    let rows = model.rows();
    assert_eq!(rows.len(), 3);
    assert_eq!(queued_submission(&rows[2]), Some(8));
}

#[test]
fn removed_or_withdrawn_rows_leave_at_settle_or_run_end() {
    let mut model = started();
    model.apply(&queue(
        json!([{"id":7,"mode":"followUp","content":"Later"}]),
    ));
    model.apply(&queue(json!([])));
    assert_eq!(model.departed.len(), 1);
    model.settle_departed();
    assert_eq!(view(&mut model), [earlier()]);

    model.apply(&queue(
        json!([{"id":9,"mode":"followUp","content":"Withdrawn"}]),
    ));
    model.apply(&queue(json!([])));
    model.apply(&json!({"type":"run_end"}));
    assert_eq!(view(&mut model), [earlier()]);
}

#[test]
fn automatic_input_and_snapshots_are_not_queue_reconciliation() {
    let mut model = started();
    model.apply(&queue(
        json!([{"id":7,"mode":"followUp","content":"Same words"}]),
    ));
    let mut automatic = user(2, json!("Same words"));
    automatic["origin"] = json!("job");
    model.apply(&json!({"type":"entry_appended","entry":automatic}));
    assert_eq!(view(&mut model).last().unwrap().1, Some("Queued"));
    // A fresh snapshot and its queue are a new baseline, not departures.
    model.apply(&json!({"type":"snapshot","entries":[user(1, json!("Earlier"))]}));
    model.apply(&queue(json!([])));
    assert!(model.departed.is_empty());
    assert_eq!(view(&mut model), [earlier()]);
    // An unreadable queue shows nothing rather than guessing.
    model.apply(&queue(json!([{"id":0,"mode":"steer","content":"bad"}])));
    assert_eq!(view(&mut model), [earlier()]);
}
