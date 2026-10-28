use super::*;
use crate::local_model::LiveTranscript;
use serde_json::{Value, json};

fn user(id: u64, text: &str) -> Value {
    json!({"id":id,"kind":"pi.user","model":[{"role":"user","content":text}]})
}
fn sending(key: u64, text: &str, status: &'static str) -> Option<Sending> {
    Some(Sending {
        key: SENDING_KEY | key,
        text: text.into(),
        status,
    })
}
fn tail(rows: &[Message]) -> Vec<(&str, Option<&'static str>)> {
    rows.iter().map(|r| (r.source(), r.pending())).collect()
}
/// An idle chat: a fresh send shows at the end of the conversation.
fn run(view: &mut SendingView, rows: Vec<Message>, current: Option<Sending>) -> Vec<Message> {
    project(view, rows, Some("a"), current, false).0
}
/// A busy chat: unresolved sends show above the editor.
fn busy(view: &mut SendingView, model: &mut LiveTranscript, current: Option<Sending>) -> bool {
    project(view, model.rows(), Some("a"), current, true).1
}
fn tray(view: &SendingView) -> Vec<(&str, Option<&'static str>)> {
    tail(view.pending_rows(Some("a")))
}
fn queue(model: &mut LiveTranscript, items: Value) {
    model.apply(&json!({"type":"queue_update","items":items}));
}

#[test]
fn unresolved_send_shows_once_until_its_own_echo_arrives() {
    let mut model = LiveTranscript::default();
    // The same words were sent before: older history is never this send's echo.
    model.apply(&json!({"type":"snapshot","entries":[user(1, "yes")],"run":{"startedAt":1}}));
    queue(
        &mut model,
        json!([{"id":40,"mode":"followUp","content":"yes"}]),
    );
    let mut view = SendingView::default();
    let rows = run(&mut view, model.rows(), sending(5, "yes", "Sending…"));
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
    let again = run(&mut view, rows.clone(), sending(5, "yes", "Not confirmed"));
    assert_eq!(again.len(), 3);
    assert_eq!(again[2].id(), rows[2].id());
    assert_eq!(again[2].pending(), Some("Not confirmed"));

    // Its own admitted queue row replaces it, even before the acknowledgment.
    queue(
        &mut model,
        json!([
            {"id":40,"mode":"followUp","content":"yes"},
            {"id":41,"mode":"steer","content":"yes"}
        ]),
    );
    let rows = run(&mut view, model.rows(), sending(5, "yes", "Not confirmed"));
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
    run(&mut view, model.rows(), sending(6, "Now", "Sending…"));
    model.apply(&json!({"type":"message_end","entry":user(2, "Now")}));
    let rows = run(&mut view, model.rows(), sending(6, "Now", "Sending…"));
    assert_eq!(tail(&rows), [("Earlier", None), ("Now", None)]);
}

#[test]
fn busy_send_stays_above_the_editor_until_its_queue_row() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[user(1, "Hi")],"run":{"startedAt":1}}));
    let mut view = SendingView::default();
    busy(&mut view, &mut model, sending(7, "Go", "Sending…"));
    assert_eq!(tray(&view), [("Go", Some("Sending…"))]);
    // The run ends before the acknowledgment: the send does not move.
    let rows = run(&mut view, model.rows(), sending(7, "Go", "Sent"));
    assert_eq!(tail(&rows), [("Hi", None)]);
    assert_eq!(tray(&view), [("Go", Some("Sent"))]);
    // Its queue row takes its place above the editor.
    queue(&mut model, json!([{"id":4,"mode":"steer","content":"Go"}]));
    let rows = run(&mut view, model.rows(), sending(7, "Go", "Sent"));
    assert_eq!(tail(&rows), [("Hi", None), ("Go", Some("Queued to steer"))]);
    assert!(tray(&view).is_empty());
}

#[test]
fn idle_send_stays_in_the_conversation() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[user(1, "Hi")]}));
    let mut view = SendingView::default();
    let rows = run(&mut view, model.rows(), sending(3, "Go", "Sending…"));
    assert_eq!(tail(&rows), [("Hi", None), ("Go", Some("Sending…"))]);
    // The chat turns busy: the row stays where it was first shown.
    let (rows, _) = project(
        &mut view,
        model.rows(),
        Some("a"),
        sending(3, "Go", "Sent"),
        true,
    );
    assert_eq!(tail(&rows)[1..], [("Go", Some("Sent"))]);
    assert!(tray(&view).is_empty());
    model.apply(&json!({"type":"message_end","entry":user(2, "Go")}));
    let rows = run(&mut view, model.rows(), sending(3, "Go", "Sent"));
    assert_eq!(tail(&rows), [("Hi", None), ("Go", None)]);
}

#[test]
fn accepted_send_stays_until_its_own_echo() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[user(1, "Hi")]}));
    let mut view = SendingView::default();
    assert!(!busy(&mut view, &mut model, sending(8, "Go", "Sent")));
    // Delayed queue: unrelated updates, empty or not, are not its echo.
    queue(&mut model, json!([]));
    assert!(!busy(&mut view, &mut model, sending(8, "Go", "Sent")));
    queue(
        &mut model,
        json!([{"id":9,"mode":"followUp","content":"Other"}]),
    );
    assert!(!busy(&mut view, &mut model, sending(8, "Go", "Sent")));
    assert_eq!(tray(&view), [("Go", Some("Sent"))]);
    // Its own row replaces it, and the editor may forget the accepted text.
    queue(
        &mut model,
        json!([{"id":9,"mode":"followUp","content":"Other"},{"id":10,"mode":"steer","content":"Go"}]),
    );
    assert!(busy(&mut view, &mut model, sending(8, "Go", "Sent")));
    assert!(tray(&view).is_empty());
    // Replaced sends never come back, whatever the conversation shows.
    project(&mut view, vec![], Some("a"), sending(8, "Go", "Sent"), true);
    assert!(tray(&view).is_empty());
}

#[test]
fn unrelated_queue_update_is_not_an_accepted_sends_echo() {
    let mut model = LiveTranscript::default();
    let mut view = SendingView::default();
    busy(&mut view, &mut model, sending(9, "steer", "Sent"));
    queue(&mut model, json!([]));
    let forgotten = busy(&mut view, &mut model, sending(9, "steer", "Sent"));
    assert_eq!(tray(&view), [("steer", Some("Sent"))]);
    assert!(
        !forgotten,
        "only a matching row can replace this presentation"
    );
}

#[test]
fn identical_sends_each_wait_for_their_own_echo() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[user(1, "yes")],"run":{"startedAt":1}}));
    let mut view = SendingView::default();
    busy(&mut view, &mut model, sending(1, "yes", "Sent"));
    // A second "yes" before the first one's queue row: both stay, in order.
    busy(&mut view, &mut model, sending(2, "yes", "Sending…"));
    assert_eq!(
        tray(&view),
        [("yes", Some("Sent")), ("yes", Some("Sending…"))]
    );
    // The first echo belongs to the first send only.
    queue(&mut model, json!([{"id":5,"mode":"steer","content":"yes"}]));
    busy(&mut view, &mut model, sending(2, "yes", "Not confirmed"));
    assert_eq!(tray(&view), [("yes", Some("Not confirmed"))]);
    // It becomes a newer history entry: still not the second send's echo.
    model.apply(&json!({"type":"message_end","entry":user(2, "yes")}));
    queue(&mut model, json!([]));
    busy(&mut view, &mut model, sending(2, "yes", "Not confirmed"));
    assert_eq!(tray(&view), [("yes", Some("Not confirmed"))]);
    // Only the second echo replaces the second send. Unknown is never settled.
    queue(&mut model, json!([{"id":6,"mode":"steer","content":"yes"}]));
    assert!(!busy(
        &mut view,
        &mut model,
        sending(2, "yes", "Not confirmed")
    ));
    assert!(tray(&view).is_empty());
    // Three identical rows, one per message.
    let rows = model.rows();
    assert_eq!(rows.iter().filter(|r| r.source() == "yes").count(), 3);
}

#[test]
fn next_send_first_shown_with_the_earlier_echo() {
    let mut model = LiveTranscript::default();
    let mut view = SendingView::default();
    busy(&mut view, &mut model, sending(1, "ok", "Sent"));
    // One publication: the first send's queue row, and the second send's first projection.
    queue(&mut model, json!([{"id":1,"mode":"steer","content":"ok"}]));
    busy(&mut view, &mut model, sending(2, "ok", "Sending…"));
    assert_eq!(tray(&view), [("ok", Some("Sending…"))]);
    queue(
        &mut model,
        json!([{"id":1,"mode":"steer","content":"ok"},{"id":2,"mode":"steer","content":"ok"}]),
    );
    busy(&mut view, &mut model, sending(2, "ok", "Sent"));
    assert!(tray(&view).is_empty());
}

#[test]
fn departed_echo_does_not_strand_the_next_identical_send() {
    let mut model = LiveTranscript::default();
    let mut view = SendingView::default();
    busy(&mut view, &mut model, sending(1, "go", "Sent"));
    busy(&mut view, &mut model, sending(2, "go", "Sending…"));
    queue(&mut model, json!([{"id":1,"mode":"steer","content":"go"}]));
    busy(&mut view, &mut model, sending(2, "go", "Sending…"));
    assert_eq!(tray(&view), [("go", Some("Sending…"))]);
    // The first message leaves the queue with no history entry in time.
    queue(&mut model, json!([]));
    model.settle_departed();
    busy(&mut view, &mut model, sending(2, "go", "Sending…"));
    assert_eq!(tray(&view), [("go", Some("Sending…"))]);
    // The second message's own row still replaces it.
    queue(&mut model, json!([{"id":2,"mode":"steer","content":"go"}]));
    busy(&mut view, &mut model, sending(2, "go", "Sending…"));
    assert!(tray(&view).is_empty());
}

#[test]
fn unaccepted_sends_owe_no_echo_and_recovered_sends_wait_above_the_editor() {
    let mut model = LiveTranscript::default();
    let mut view = SendingView::default();
    // Seen first as Unknown (a reconnect or restart): above the editor, even idle.
    let (rows, forget) = project(
        &mut view,
        model.rows(),
        Some("a"),
        sending(1, "yes", "Not confirmed"),
        false,
    );
    assert!(rows.is_empty() && !forget);
    assert_eq!(tray(&view), [("yes", Some("Not confirmed"))]);
    queue(&mut model, json!([{"id":3,"mode":"steer","content":"no"}]));
    assert!(!busy(
        &mut view,
        &mut model,
        sending(1, "yes", "Not confirmed")
    ));
    assert_eq!(tray(&view), [("yes", Some("Not confirmed"))]);
    // Rejected, then sent again: the rejected send leaves and claims nothing.
    busy(&mut view, &mut model, sending(1, "yes", "Not sent"));
    busy(&mut view, &mut model, sending(2, "yes", "Sending…"));
    assert_eq!(tray(&view), [("yes", Some("Sending…"))]);
    queue(
        &mut model,
        json!([{"id":3,"mode":"steer","content":"no"},{"id":4,"mode":"steer","content":"yes"}]),
    );
    busy(&mut view, &mut model, sending(2, "yes", "Sending…"));
    assert!(tray(&view).is_empty());
}

#[test]
fn settled_or_other_chat_sends_are_not_projected() {
    let mut view = SendingView::default();
    let rows = vec![Message::live(1, "You · entry 1".into(), "Hi".into())];
    let shown = run(&mut view, rows.clone(), sending(7, "Next", "Sending…"));
    assert_eq!(shown.len(), 2);
    // Refused (or rejected and recovered): nothing remains.
    let cleared = run(&mut view, shown, None);
    assert_eq!(tail(&cleared), [("Hi", None)]);
    assert_eq!(view.shown, None);
    // Another chat never shows this chat's accepted send, which waits for it.
    project(
        &mut view,
        rows.clone(),
        Some("a"),
        sending(8, "Accepted", "Sent"),
        true,
    );
    let (other, _) = project(&mut view, rows.clone(), Some("b"), None, true);
    assert_eq!(tail(&other), [("Hi", None)]);
    assert!(view.pending_rows(Some("b")).is_empty());
    assert!(view.pending_rows(Some("a")).is_empty());
    project(&mut view, rows, Some("a"), None, true);
    assert_eq!(tray(&view), [("Accepted", Some("Sent"))]);
}

#[test]
fn a_queue_echo_keeps_its_own_queue_id() {
    let mut model = LiveTranscript::default();
    let mut view = SendingView::default();
    busy(&mut view, &mut model, sending(1, "yes", "Sent"));
    busy(&mut view, &mut model, sending(2, "yes", "Sending…"));
    queue(&mut model, json!([{"id":1,"mode":"steer","content":"yes"}]));
    busy(&mut view, &mut model, sending(2, "yes", "Sending…"));
    assert_eq!(tray(&view), [("yes", Some("Sending…"))]);
    // One update replaces the first message's row with the second's, and the
    // first leaves the conversation: the second row is the second send's echo.
    queue(&mut model, json!([{"id":2,"mode":"steer","content":"yes"}]));
    model.settle_departed();
    busy(&mut view, &mut model, sending(2, "yes", "Sending…"));
    assert!(
        tray(&view).is_empty(),
        "the first send took another queue row"
    );
}

#[test]
fn a_queue_echo_continues_as_the_next_history_entry() {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[user(1, "Hi")],"run":{"startedAt":1}}));
    let mut view = SendingView::default();
    busy(&mut view, &mut model, sending(1, "yes", "Sent"));
    busy(&mut view, &mut model, sending(2, "yes", "Sending…"));
    queue(&mut model, json!([{"id":1,"mode":"steer","content":"yes"}]));
    busy(&mut view, &mut model, sending(2, "yes", "Sending…"));
    // History arrives while the old queue row is still queued: it is that row's
    // consumption (exact content only), not the second send's echo.
    model.apply(&json!({"type":"message_end","entry":user(5, "yes")}));
    busy(&mut view, &mut model, sending(2, "yes", "Sending…"));
    assert_eq!(tray(&view), [("yes", Some("Sending…"))]);
    queue(&mut model, json!([]));
    busy(&mut view, &mut model, sending(2, "yes", "Sending…"));
    assert_eq!(tray(&view), [("yes", Some("Sending…"))]);
    queue(&mut model, json!([{"id":2,"mode":"steer","content":"yes"}]));
    busy(&mut view, &mut model, sending(2, "yes", "Sending…"));
    assert!(tray(&view).is_empty());
    assert_eq!(
        model.rows().iter().filter(|r| r.source() == "yes").count(),
        2
    );
}

#[test]
fn identical_queue_and_history_echoes_arriving_together() {
    let start = |view: &mut SendingView, model: &mut LiveTranscript| {
        model.apply(&json!({"type":"snapshot","entries":[user(1, "Hi")],"run":{"startedAt":1}}));
        busy(view, model, sending(1, "yes", "Sent"));
        busy(view, model, sending(2, "yes", "Sending…"));
    };
    // Neither echo seen before: the older send takes the history entry.
    let (mut model, mut view) = (LiveTranscript::default(), SendingView::default());
    start(&mut view, &mut model);
    model.apply(&json!({"type":"message_end","entry":user(5, "yes")}));
    queue(&mut model, json!([{"id":2,"mode":"steer","content":"yes"}]));
    busy(&mut view, &mut model, sending(2, "yes", "Sending…"));
    assert!(tray(&view).is_empty());
    // The first was queued: its row becomes history as the second is queued.
    let (mut model, mut view) = (LiveTranscript::default(), SendingView::default());
    start(&mut view, &mut model);
    queue(&mut model, json!([{"id":1,"mode":"steer","content":"yes"}]));
    busy(&mut view, &mut model, sending(2, "yes", "Sending…"));
    model.apply(&json!({"type":"message_end","entry":user(5, "yes")}));
    queue(&mut model, json!([{"id":2,"mode":"steer","content":"yes"}]));
    busy(&mut view, &mut model, sending(2, "yes", "Sending…"));
    assert!(tray(&view).is_empty());
    assert_eq!(
        model.rows().iter().filter(|r| r.source() == "yes").count(),
        2
    );
}

#[test]
fn a_replaced_send_is_released_once_the_editor_lets_go() {
    let mut model = LiveTranscript::default();
    let mut view = SendingView::default();
    busy(&mut view, &mut model, sending(1, "Go", "Not confirmed"));
    queue(&mut model, json!([{"id":3,"mode":"steer","content":"Go"}]));
    assert!(!busy(
        &mut view,
        &mut model,
        sending(1, "Go", "Not confirmed")
    ));
    // Its echo leaves; the editor still shows it: it never shows again.
    project(
        &mut view,
        vec![],
        Some("a"),
        sending(1, "Go", "Not confirmed"),
        true,
    );
    assert!(tray(&view).is_empty());
    // The editor resolves it: nothing is kept for the chat.
    project(&mut view, vec![], Some("a"), None, true);
    assert!(view.chats.is_empty());
}
