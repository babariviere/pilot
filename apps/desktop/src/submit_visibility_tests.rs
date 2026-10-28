use super::*;
use crate::local_model::LiveTranscript;
use serde_json::{Value, json};

fn user(id: u64, text: &str) -> Value {
    json!({"id":id,"kind":"pi.user","model":[{"role":"user","content":text}]})
}
fn sending(key: u64, text: &str, status: &'static str) -> Option<(String, Sending)> {
    Some((
        "a".into(),
        Sending {
            key: SENDING_KEY | key,
            text: text.into(),
            status,
        },
    ))
}
fn tail(rows: &[Message]) -> Vec<(&str, Option<&'static str>)> {
    rows.iter().map(|r| (r.source(), r.pending())).collect()
}

#[test]
fn unresolved_send_shows_once_until_its_own_echo_arrives() {
    let mut model = LiveTranscript::default();
    // The same words were sent before: older history is never this send's echo.
    model.apply(&json!({"type":"snapshot","entries":[user(1, "yes")],"run":{"startedAt":1}}));
    model.apply(
        &json!({"type":"queue_update","items":[{"id":40,"mode":"followUp","content":"yes"}]}),
    );
    let mut view = SendingView::default();
    let rows = project(&mut view, model.rows(), sending(5, "yes", "Sending…"));
    assert_eq!(
        tail(&rows),
        [
            ("yes", None),
            ("yes", Some("Queued")),
            ("yes", Some("Sending…"))
        ]
    );
    assert!(is_sending_row(rows.last().unwrap()));
    // Re-projection replaces, never stacks, and keeps the row identity.
    let again = project(&mut view, rows.clone(), sending(5, "yes", "Not confirmed"));
    assert_eq!(again.len(), 3);
    assert_eq!(again[2].id(), rows[2].id());
    assert_eq!(again[2].pending(), Some("Not confirmed"));

    // Its own admitted queue row replaces it, even before the acknowledgment.
    model.apply(&json!({"type":"queue_update","items":[
        {"id":40,"mode":"followUp","content":"yes"},
        {"id":41,"mode":"steer","content":"yes"}
    ]}));
    let rows = project(&mut view, model.rows(), sending(5, "yes", "Not confirmed"));
    assert_eq!(
        tail(&rows),
        [
            ("yes", None),
            ("yes", Some("Queued")),
            ("yes", Some("Queued to steer"))
        ]
    );
    // Or its history entry, when consumption wins the race.
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[user(1, "Earlier")]}));
    let mut view = SendingView::default();
    project(&mut view, model.rows(), sending(6, "Now", "Sending…"));
    model.apply(&json!({"type":"message_end","entry":user(2, "Now")}));
    let rows = project(&mut view, model.rows(), sending(6, "Now", "Sending…"));
    assert_eq!(tail(&rows), [("Earlier", None), ("Now", None)]);
}

#[test]
fn settled_or_other_chat_sends_are_not_projected() {
    let mut view = SendingView::default();
    let rows = vec![Message::live(1, "You · entry 1".into(), "Hi".into())];
    let shown = project(&mut view, rows.clone(), sending(7, "Next", "Sending…"));
    assert_eq!(shown.len(), 2);
    // Accepted/refused (or another chat selected): nothing remains.
    let cleared = project(&mut view, shown, None);
    assert_eq!(tail(&cleared), [("Hi", None)]);
    assert_eq!(view.shown, None);
}
